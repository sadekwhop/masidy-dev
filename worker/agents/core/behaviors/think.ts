import { RpcTarget } from 'cloudflare:workers';
import { getAgentByName } from 'agents';
import type { UIMessage } from 'ai';
import { ThinkState } from '../state';
import { AgentInitArgs, DeploymentTarget } from '../types';
import { BaseCodingBehavior } from './base';
import { WebSocketMessageResponses } from '../../constants';
import { ICodingAgent } from '../../services/interfaces/ICodingAgent';
import { OperationOptions } from '../../operations/common';
import { GenerationContext, AgenticGenerationContext } from '../../domain/values/GenerationContext';
import { ImageAttachment, ProcessedImageAttachment } from 'worker/types/image-attachment';
import { ImageType, uploadImage } from 'worker/utils/images';
import { IdGenerator } from '../../utils/idGenerator';
import { generateNanoId } from '../../../utils/idGenerator';
import { generateProjectName } from '../../utils/templateCustomizer';
import { deriveShortTitle } from '../../utils/titleGenerator';
import { PreviewType, TemplateDetails } from 'worker/services/sandbox/sandboxTypes';
import {
	buildSpacePreviewPath,
	getPreviewDomain,
	isSeparatePreviewDomain,
	resolvePreviewHost,
} from 'worker/utils/urls';
import { isDev } from 'worker/utils/envs';
import { signSpacePreviewToken } from 'worker/utils/spacePreviewToken';
import { signOwnerPreviewToken, OWNER_PREVIEW_QUERY_PARAM } from 'worker/utils/ownerPreviewToken';
import { AppService } from 'worker/database/services/AppService';
import type { ThinkAgentConfig } from '../../think/ThinkAgent';
import { withDurableObjectResetRetry } from '../../think/space-workspace-ops';
import { THINK_MODEL_CONFIG, THINK_MODEL_ID } from '../../think/model-config';
import { resolveAgent } from '../../router/agents';
import type { BranchDeploymentBundle } from '@space-do/space';
import { CloudflareAccountService } from '../../../services/cloudflare/CloudflareAccountService';
import { deployThinkBundleToUserAccount } from '../../../services/deployer/think-user-deploy';
import { buildManagedAppDeploymentId, buildManagedAppUrl } from '../../../utils/urls';
import { resolveCloudflareAccessToken } from '../../../services/rate-limit/usageChecker';
import type { CloudflareDeploymentErrorCode } from '../../../api/websocketTypes';
import { getDeployFailureMessage, parseDeployResult } from './deploy-result';

/**
 * Minimal stub shape for the `ThinkAgent` DO (see `worker/agents/think/ThinkAgent.ts`).
 * Driven via DO RPC from this behavior, which runs inside `CodeGeneratorAgent`.
 */
type ThinkAgentStub = {
	configureVibe: (config: ThinkAgentConfig) => Promise<void>;
	chat: (userMessage: string, callback: RpcTarget) => Promise<void>;
	cancelAllChats: () => void;
	getMessages: () => Promise<UIMessage[]>;
	clearMessages: () => Promise<void>;
	finalizeTurn: () => Promise<{ verified: boolean; message?: string; refunded?: number }>;
};

/** SpaceDO RPC surface this behavior drives (see `space/src/space/durable-object.ts`). */
type SpaceRpcStub = {
	writeFile: (path: string, content: string) => Promise<unknown>;
	readFile: (path: string, opts?: { offset?: number; limit?: number }) => Promise<string>;
	gitCommit: (
		msg: string,
		author?: { name: string; email: string },
	) => Promise<{ sha?: string }>;
	gitCommitLocal: (msg: string, author?: { name: string; email: string }) => Promise<unknown>;
	deploy: (
		branch: string,
	) => Promise<{ preview_url?: string; commit_hash?: string; error?: string; details?: string }>;
	getDeploymentBundle: (branch: string) => Promise<BranchDeploymentBundle>;
	publish: (branch: string) => Promise<{ commitHash: string; sizeBytes: number }>;
	rollbackToCommit: (branch: string, commitHash: string) => Promise<unknown>;
};

/** Subset of AI-SDK `UIMessageChunk` shapes this behavior reacts to. */
type ThinkChunk =
	| { type: 'text-delta'; id: string; delta: string }
	| { type: 'reasoning-start'; id: string }
	| { type: 'reasoning-delta'; id: string; delta: string }
	| { type: 'reasoning-end'; id: string }
	| { type: 'tool-input-start'; toolCallId: string; toolName: string }
	| { type: 'tool-input-available'; toolCallId: string; toolName: string; input: unknown }
	| { type: 'tool-output-available'; toolCallId: string; output: unknown }
	| { type: 'tool-output-error'; toolCallId: string; errorText: string }
	| { type: 'finish' }
	| { type: string; [key: string]: unknown };

/**
 * `RpcTarget` forwarder passed to `ThinkAgent.chat()`. Think streams
 * `UIMessageChunk` JSON frames into `onEvent`; we hand each to the behavior's
 * translator which maps them onto VibeSDK WebSocket events.
 */
class ThinkStreamForwarder extends RpcTarget {
	constructor(
		private readonly onChunkJson: (json: string) => void | Promise<void>,
		private readonly onErrorCb: (message: string) => void,
	) {
		super();
	}
	onStart(_event: { requestId: string }): void {}
	async onEvent(json: string): Promise<void> {
		await this.onChunkJson(json);
	}
	onDone(): void {}
	onError(error: string): void {
		this.onErrorCb(error);
	}
	onInterrupted(): void {}
}

/**
 * ThinkCodingBehavior — agentic coding harness built on `@cloudflare/think`.
 *
 * - Owns one `ThinkAgent` DO (agentic loop + message persistence) and one
 *   `SpaceDO` (git-backed files + preview/deploy) per app, both named by agentId.
 * - Pushes the resolved AI Gateway model config into the ThinkAgent via
 *   `configureVibe()`, then drives each turn with `ThinkAgent.chat()` and
 *   translates the streamed `UIMessageChunk`s into VibeSDK WS events.
 * - File mutations land directly in SpaceDO (the ThinkAgent's workspace tools
 *   are SpaceDO-backed) and are mirrored into `FileManager` for the editor pane.
 */
export class ThinkCodingBehavior
	extends BaseCodingBehavior<ThinkState>
	implements ICodingAgent {
	protected static readonly PROJECT_NAME_PREFIX_MAX_LENGTH = 20;

	override getBehavior(): 'think' { return 'think'; }

	// ──────────────────────────────────────────────────────────────
	// DO stubs

	/**
	 * Resolve the ThinkAgent DO via the agents framework helper (NOT a raw
	 * `ns.get(idFromName())`). `getAgentByName` performs the agents `_init`
	 * handshake that sets `this.name` and wires the message/session manager;
	 * a raw stub leaves those undefined and `chat()` throws on `appendMessage`.
	 */
	private async getThinkStub(): Promise<ThinkAgentStub> {
		const ns = (this.env as unknown as { THINK_DO: DurableObjectNamespace }).THINK_DO;
		const name = this.state.thinkAgentName || this.getAgentId();
		const stub = await getAgentByName(ns as never, name);
		return stub as unknown as ThinkAgentStub;
	}

	private getSpaceStub(): DurableObjectStub {
		// One space per session: always keyed by the agent (session) id.
		const ns = (this.env as unknown as { SPACE_DO: DurableObjectNamespace }).SPACE_DO;
		return ns.get(ns.idFromName(this.getAgentId()));
	}

	/**
	 * SpaceDO RPC with a single retry on "Durable Object reset" — the transient
	 * error thrown on in-flight calls when the worker version changes (deploy /
	 * dev rebuild). The stub is re-resolved so the retry hits the new instance.
	 */
	private callSpace<T>(call: (space: SpaceRpcStub) => Promise<T>): Promise<T> {
		return withDurableObjectResetRetry(
			() => this.getSpaceStub() as unknown as SpaceRpcStub,
			call,
		);
	}

	// ──────────────────────────────────────────────────────────────
	// Initialize

	async initialize(
		initArgs: AgentInitArgs<ThinkState>,
		..._args: unknown[]
	): Promise<ThinkState> {
		await super.initialize(initArgs);
		// Think projects are template-free: SpaceDO + the agent's own file tools
		// own scaffolding entirely. We intentionally ignore `templateInfo`.
		const { query, hostname, inferenceContext, sandboxSessionId } = initArgs;

		const baseName = (query || 'project').toString();
		const projectName = generateProjectName(
			baseName,
			generateNanoId(),
			ThinkCodingBehavior.PROJECT_NAME_PREFIX_MAX_LENGTH,
		);

		// `agentId` is the canonical name for both the ThinkAgent and SpaceDO.
		const agentName = inferenceContext.metadata.agentId;

		this.setState({
			...this.state,
			projectName,
			query,
			blueprint: {
				title: deriveShortTitle(baseName),
				projectName,
				description: query,
				colorPalette: ['#1e1e1e'],
				frameworks: [],
				plan: [],
			},
			templateName: 'think',
			sandboxInstanceId: undefined,
			commandsHistory: [],
			sessionId: sandboxSessionId!,
			hostname,
			metadata: inferenceContext.metadata,
			projectType: this.projectType,
			behaviorType: 'think',
			thinkAgentName: agentName,
			currentBranch: 'main',
		});

		const configureStartedAt = performance.now();
		await this.configureThinkAgent();
		const configureDurationMs = performance.now() - configureStartedAt;

		const seedStartedAt = performance.now();
		await this.seedEmptySpace();
		const seedDurationMs = performance.now() - seedStartedAt;

		this.logger.info(
			`Think agent ${this.getAgentId()} initialized (space=${agentName})`,
			{ configureDurationMs, seedDurationMs },
		);
		return this.state;
	}

	/** Push the Workers AI model and gateway configuration into the ThinkAgent DO. */
	private async configureThinkAgent(): Promise<void> {
		const userId = this.state.metadata.userId;
		const gatewayId = this.env.CLOUDFLARE_AI_GATEWAY;
		if (!gatewayId) {
			this.logger.error('CLOUDFLARE_AI_GATEWAY is required to configure ThinkAgent');
			return;
		}

		// Use the multi-agent router to pick the right dynamic route.
		// state.query is the user's original request for a new project;
		// for follow-up turns, grab the last pending input if available.
		const lastUserMsg =
			this.state.pendingUserInputs?.at(-1) ??
			this.state.query ??
			'';

		const agent = resolveAgent(typeof lastUserMsg === 'string' ? lastUserMsg : '');

		const rawRoute = this.env.CLOUDFLARE_AI_GATEWAY_ROUTE?.trim();
		// If CLOUDFLARE_AI_GATEWAY_ROUTE was set to "yes", "true", or "1", treat it as a boolean flag
		// and use the intelligent agent route (masidy-code, masidy-chat, etc.) instead of literal "yes".
		const dynamicRouteName =
			rawRoute && rawRoute !== 'yes' && rawRoute !== 'true' && rawRoute !== '1'
				? rawRoute
				: agent.routeName;
		const modelName = agent.primaryModelId || THINK_MODEL_ID;

		const config: ThinkAgentConfig = {
			userId,
			model: {
				modelName,
				gatewayId,
				...(dynamicRouteName ? { dynamicRouteName } : {}),
				contextSize: THINK_MODEL_CONFIG.contextSize,
			},
			systemPrompt: this.buildSystemPrompt(modelName),
			previewUrl: await this.getBrowserPreviewURL(0).catch(() => undefined),
		};

		try {
			const stub = await this.getThinkStub();
			await stub.configureVibe(config);
		} catch (e) {
			this.logger.warn('ThinkAgent.configureVibe failed (continuing)', e);
		}
	}

	/**
	 * Per-app context appended AFTER the file-based base prompt (the persona /
	 * engineering guidance comes from `worker/agents/think/prompts/*.txt` via
	 * `selectSystemPrompt`). This block only carries the dynamic project context
	 * and the VibeSDK-specific deploy→verify workflow, which the generic prompt
	 * files don't know about — the environment and custom instructions for the run.
	 */
	private buildSystemPrompt(modelName: string): string {
		const lastUserMsg =
			this.state.pendingUserInputs?.at(-1) ??
			this.state.query ??
			'';
		const hasUserAnswered =
			/here are my answers|q:.*a:|answer/i.test(typeof lastUserMsg === 'string' ? lastUserMsg : '') ||
			this.isMVPGenerated();

		const clarifyInstruction = hasUserAnswered
			? 'The user has ALREADY provided their requirements and answers. DO NOT call `ask_questions` under any circumstances. Proceed IMMEDIATELY to plan, create files, implement the solution, and deploy.'
			: 'If the user states a desired product or concept (e.g. "landing page", "dashboard", "contact form", "portfolio", "store", "calculator"), DO NOT ask clarifying questions — make attractive, modern, state-of-the-art design choices and start building immediately. Only call `ask_questions` if the request is completely blank or just punctuation (like "?"), and call it at most ONCE. If you already asked questions once, never ask again.';

		return [
			`You are powered by the model named ${modelName}.`,
			'<env>',
			`  Platform: Cloudflare Workers (SpaceDO preview — no shell, no local filesystem)`,
			'  Use cloudflare_stack_search to check current Cloudflare and supported framework documentation before implementing their APIs.',
			`  Today's date: ${new Date().toDateString()}`,
			'</env>',
			'',
			`# Project: ${this.state.projectName || 'app'}`,
			'',
			'## User request',
			this.state.query,
			'',
			'## Naming',
			'If this project does not yet have a clear name (e.g. the request is a long or vague description rather than a concise product name), call the `set_title` tool once, early, with a short human-friendly title (Title Case, under ~60 characters). Skip it if a good title already exists; do not rename on every turn.',
			'',
			'## Clarify before building',
			clarifyInstruction,
			'If the request is already clear or answers are present, skip this and go straight to building.',
			'',
			'## Deploy & verify workflow (VibeSDK-specific)',
			'Once you are actively building (the scope is clear or the user confirmed), this app is previewed on Cloudflare Workers via SpaceDO — there is no shell. In a building turn, do NOT end after only writing files:',
			'For a request to fix, restart, or diagnose an existing preview, preserve the existing project. First inspect its files and deployment/preview error, then make the smallest necessary correction. Do not replace the project or invent a new scaffold. This platform uses the JavaScript/TypeScript `@cloudflare/worker-bundler`; never add Rust, Cargo, `build.rs`, or a `cargo-bundle` step. Do not claim a deploy or preview succeeded unless `deploy_space` and `get_browser_console_logs` confirm it. If the connection is lost, stop and report that accurately instead of repeating file operations.',
			'Every project must follow the SpaceDO app contract: the configured `main` module must export a named `App` class that extends `DurableObject` imported from `cloudflare:workers`. Implement request handling in `App.fetch(request)`. Do not use `export default { fetch }` as the server entry. Static assets do not remove this requirement; configure `[assets]` and still provide the `App` class for API/fallback handling. Load the `cloudflare-bundler-apps` skill before creating or changing project files.',
			'1. After writing or editing files, call `deploy_space` to commit and deploy so the preview rebuilds.',
			'2. Then call `get_browser_console_logs` to inspect the running preview for client-side errors (JS exceptions, failed fetches, missing assets, hydration errors).',
			'3. Then call `audit_dom` to check for visual issues: low-contrast CTAs or links, interactive elements with zero size, forms without a submit button, content touching the viewport edge, horizontal overflow, and broken images. **This step is mandatory whenever the project has a `public/` directory (i.e. static frontend files).** Fix every reported issue before reporting success.',
			'4. Deployment validates the SpaceDO runtime contract before publishing. If deployment reports a build or runtime-validation error, treat it as your responsibility: read the full error and details, fix the project (including converting an ordinary Worker default export to the required `App extends DurableObject` entry when needed), then retry from step 1. Make at most 3 fix-and-deploy attempts per user turn; if still failing, stop and report the latest exact error and what remains. Do not ask the user to explain or restate platform requirements. If the browser preview fails, inspect the specific preview error before retrying; do not report success while the preview returns an error.',
			'A building turn should finish with a successful `deploy_space`, a clean `get_browser_console_logs` check, and a passing `audit_dom` (required for any app with static frontend files).',
			'Note: a 402 response on `/mcp` in the browser console is a platform-level probe (WebMCP browser spec), not an app error — ignore it.',
			'',
			'## Commits & restore points',
			'Each commit is a restore point the user can roll back to, and YOU decide when to create them. Use the `commit` tool to snapshot a coherent unit of work with a short, descriptive message (e.g. before a risky refactor, or after finishing a feature). You do not need to `commit` right before `deploy_space` — deploying already commits. Do not commit after every tiny edit; group related changes into meaningful restore points.',
			'',
			'## Professional Full-Stack Builder Standards (CRITICAL)',
			'You are an expert, state-of-the-art full-stack web builder (like Lovable, Bolt, v0). Users expect complete, interactive, living web applications:',
			'1. **INTEGRATE DIRECTLY INTO THE PRIMARY UI**: When the user requests features (e.g. database, authentication, OAuth, forms, shopping cart, dashboard, etc.), ALWAYS build them directly into the primary application files (`/src/index.ts` and `/public/index.html` or client components). NEVER create separate documentation files like `README.md`, `docker-compose.yml`, or standalone test harnesses like `test-api.html` or `oauth-login.html` instead of integrating into the real project.',
			'2. **CLOUDFLARE DATABASE (Durable Objects SQLite) - CONSTRUCTOR INITIALIZATION**: Generated apps have direct, zero-latency access to Cloudflare SQLite via `this.ctx.storage.sql` inside the `App extends DurableObject` class. ALWAYS initialize your database tables in the `constructor(ctx: DurableObjectState, env: Env)` of `App` via `this.initDatabase()`. Do NOT defer table creation only to specific API routes—when the user opens the IDE Database tab, it inspects SQLite tables immediately. Create tables with `CREATE TABLE IF NOT EXISTS` (e.g. users, sessions, leads), expose API endpoints (`/api/leads`, `/api/auth/session`), and connect frontend forms/buttons to them.',
			'3. **OAUTH & AUTHENTICATION INTEGRATION**: When authentication or OAuth is requested: add a prominent "Sign In" button in the navigation header, and a sleek modal with Google and email options. In `/src/index.ts`, support real OAuth callback handling AND an immediate 1-click Demo Sign-In ("Sign in with Google (Demo)") that stores a user and session in SQLite, saves the session token to localStorage, transitions the UI to a logged-in state showing the user avatar/name, and provides a "Sign Out" button. This ensures auth works immediately in the browser preview without external API keys!',
			'4. **SPECIALIST AGENT DELEGATION**: You have the `consult_specialist_agent` tool. Before implementing complex database schemas, backend APIs, security rules, or UI layouts, call `consult_specialist_agent` with "database", "backend", "frontend", "security", or "architect" to get expert implementations via Cloudflare AI Gateway.',
			'5. **SELF-CONTAINED JS & RELATIVE PATHS**: In browser JavaScript, always use relative paths like `fetch("./api/...")` (or `fetch("api/...")`), never root-relative `fetch("/api/...")`. NEVER reference external scripts that do not exist (like `backend-voting.js`). All script tags in `/public/index.html` must be completely self-contained or reference files you actually created.',
			'6. **ZERO BROWSER ERRORS BEFORE DECLARING SUCCESS**: If `get_browser_console_logs` reports errors (401, uncaught JS exceptions, missing files, 404s), you MUST inspect the error, fix the code, redeploy, and verify until the browser runs cleanly. NEVER declare victory or say "all done" while browser console errors exist.',
			'7. **NO DEAD BUTTONS & NO RAW PREVIEW URLS**: Connect all CTA buttons ("Get Started", "Start building", "Sign In") to real functional actions, modals, or API calls so the page feels alive and fully production-ready. Do NOT output raw markdown links to `/space/.../preview/...` in your final chat message; the user already views the live app in the embedded preview panel in the IDE.',
			'8. **NO FRONTEND BUILD STEP - NEVER USE JSX OR BUILD SCRIPTS**: The space deploy pipeline serves files in `public/` directly as static assets. There is NO `npm run build`, `vite`, `esbuild`, or shell compiler. NEVER write raw JSX inside `.js` files (browsers die with `SyntaxError: Unexpected token '<'`), NEVER put `.ts`/`.tsx` in `public/`, and NEVER create `vite.config.ts` or add frontend bundlers to `package.json`. For UI, use `htm` tagged template literals (`htm/preact`), `React.createElement`, or modern Vanilla JS via CDN importmaps.',
			'9. **ANTI-THRASHING & CLEANUP INVARIANT**: If `get_browser_console_logs` shows the same class of error twice, STOP and change your fundamental approach immediately. If you added any temporary, failing, or unused config files (like `vite.config.ts` or extra dependencies in `package.json`), DELETE them before completing the turn.',
			'10. **VERIFIED FINAL REPORTING**: Never conclude a turn with "Next steps: verify it works". A building turn MUST conclude with an active `deploy_space` and a verified `get_browser_console_logs` check showing zero errors.',
		].join('\n');
	}

	/**
	 * Bootstrap an empty SpaceDO: write a marker file and commit so the DO is
	 * instantiated with a `main` branch and a valid HEAD.
	 */
	private async seedEmptySpace(): Promise<void> {
		const marker = JSON.stringify(
			{ agentId: this.getAgentId(), createdAt: new Date().toISOString(), seededBy: 'vibesdk-think' },
			null,
			2,
		);
		try {
			await this.callSpace((space) => space.writeFile('.think/space.json', marker));
			await this.callSpace((space) => space.gitCommitLocal('chore: initialize think space'));
		} catch (e) {
			this.logger.warn('SpaceDO empty-seed failed (continuing)', e);
		}
	}

	// ──────────────────────────────────────────────────────────────
	// Generation orchestration

	/**
	 * The `preview` WS action / preview controller route here. Think has no
	 * sandbox — previews run on Workers via SpaceDO — so deploy the current
	 * SpaceDO branch and return its preview URL.
	 */
	async deployToSandbox(): Promise<PreviewType | null> {
		const url = await this.deployCurrentBranch();
		return url ? { previewURL: url } : null;
	}

	private async getPublicOrigin(): Promise<string> {
		if (isDev(this.env)) return 'http://localhost:5173';
		if (isSeparatePreviewDomain(this.env)) {
			return `https://${getPreviewDomain(this.env)}`;
		}
		const host = resolvePreviewHost(this.env, this.state.wsOrigin);
		return `https://${host}`;
	}

	public async getBrowserPreviewURL(previewVersionOverride?: number): Promise<string> {
		const spaceName = this.getAgentId();
		const branch = this.state.currentBranch || 'main';
		const previewBaseUrl = `${await this.getPublicOrigin()}${buildSpacePreviewPath(spaceName, branch)}`;
		// Always append a signed, branch-scoped preview token. It bootstraps the
		// path-scoped HttpOnly preview cookie on first load (so iframe sub-resources
		// authenticate), and authenticates machine clients like the headless
		// `get_browser_console_logs` browser, which carry no cookie.
		// Embed the app's current preview-token revocation epoch so a later
		// visibility toggle (which bumps it) invalidates this token.
		const previewVersion = previewVersionOverride ??
			(await new AppService(this.env).getPreviewVersion(spaceName)) ?? 0;
		const token = await signSpacePreviewToken(this.env, {
			spaceName,
			branch,
			userId: this.state.metadata.userId,
			previewVersion,
		});
		return `${previewBaseUrl}?t=${encodeURIComponent(token)}`;
	}

	public getTemplateDetails(): TemplateDetails {
		if (!this.templateDetailsCache) {
			this.templateDetailsCache = {
				name: 'think',
				description: { selection: 'think', usage: 'think (template-free)' },
				fileTree: { path: '/', type: 'directory', children: [] },
				allFiles: {},
				deps: {},
				language: 'typescript',
				projectType: 'general',
				frameworks: [],
				importantFiles: [],
				dontTouchFiles: [],
				redactedFiles: [],
				disabled: false,
				renderMode: 'sandbox',
			};
		}
		return this.templateDetailsCache;
	}

	public override async ensureTemplateDetails(): Promise<TemplateDetails> {
		return this.getTemplateDetails();
	}

	getOperationOptions(): OperationOptions<AgenticGenerationContext> {
		const agenticLike = {
			...this.state,
			behaviorType: 'agentic' as const,
			currentPlan: '',
		};
		const context = GenerationContext.from(
			agenticLike as unknown as Parameters<typeof GenerationContext.from>[0],
			this.getTemplateDetails(),
			this.logger,
		);
		return {
			env: this.env,
			agentId: this.getAgentId(),
			context: context as AgenticGenerationContext,
			logger: this.logger,
			inferenceContext: this.getInferenceContext(),
			agent: this,
		};
	}

	async handleUserInput(userMessage: string, images?: ImageAttachment[]): Promise<void> {
		let processedImages: ProcessedImageAttachment[] | undefined;
		if (images && images.length > 0) {
			processedImages = await Promise.all(
				images.map((image) => uploadImage(this.env, image, ImageType.UPLOADS)),
			);
		}
		await this.queueUserRequest(userMessage, processedImages);

		if (this.isCodeGenerating()) {
			this.broadcast(WebSocketMessageResponses.CONVERSATION_RESPONSE, {
				message: '',
				conversationId: IdGenerator.generateConversationId(),
				isStreaming: false,
				tool: {
					name: 'Message Queued',
					status: 'success',
					args: { userMessage, images: processedImages },
				},
			});
		}
	}

	async stopGeneration(): Promise<boolean> {
		this.setState({
			...this.state,
			shouldBeGenerating: false,
			pendingUserInputs: [],
		});
		const thinkAgent = await this.getThinkStub();
		thinkAgent.cancelAllChats();
		return true;
	}

	/** Main loop: drain pendingUserInputs by driving the ThinkAgent. */
	async build(): Promise<void> {
		if (!this.isMVPGenerated() && this.state.query && this.state.pendingUserInputs.length === 0) {
			this.setState({ ...this.state, pendingUserInputs: [this.state.query] });
		}

		while (this.state.pendingUserInputs.length > 0) {
			const pending = this.state.pendingUserInputs.slice();
			this.setState({ ...this.state, pendingUserInputs: [] });

			const compiled = pending.join('\n');
			try {
				await this.configureThinkAgent();
				await this.runPrompt(compiled);
			} catch (e) {
				this.logger.error('Think prompt failed', e);
				this.broadcast(WebSocketMessageResponses.ERROR, {
					error: e instanceof Error ? e.message : String(e),
				});
				break;
			}

			if (!this.isMVPGenerated()) {
				this.setMVPGenerated();
			}

			// Commits (and deploys) are driven entirely by the model: it calls the
			// `commit` tool to snapshot a restore point when it decides, and
			// `deploy_space` to build/preview. The harness does neither on its own.
		}
	}

	/**
	 * Submit a prompt to the ThinkAgent and translate its streamed
	 * `UIMessageChunk`s into VibeSDK WebSocket events.
	 */
	private async runPrompt(text: string): Promise<void> {
		const conversationId = IdGenerator.generateConversationId();
		this.broadcast(WebSocketMessageResponses.CONVERSATION_RESPONSE, {
			message: '',
			conversationId,
			isStreaming: true,
		});

		const accumulated = { text: '' };
		const seenWrittenFiles = new Set<string>();
		const toolNames = new Map<string, string>();
		const toolInputs = new Map<string, Record<string, unknown>>();

		const forwarder = new ThinkStreamForwarder(
			(json) => {
				let chunk: ThinkChunk;
				try {
					chunk = JSON.parse(json) as ThinkChunk;
				} catch {
					return;
				}
				return this.translateChunk(chunk, conversationId, accumulated, seenWrittenFiles, toolNames, toolInputs);
			},
			(err) => this.broadcast(WebSocketMessageResponses.ERROR, { error: err }),
		);

		const stub = await this.getThinkStub();
		let finalize: { verified: boolean; message?: string; refunded?: number } | null = null;
		try {
			await stub.chat(text, forwarder);
			// End-of-turn gate (enforced in code, not just the prompt): if the
			// build turn deployed but the preview was NOT verified (clean browser
			// console after the last deploy AND the preview returning HTTP 200),
			// the ThinkAgent returns a plain "not working" message and refunds
			// the turn's credits. Override the model's final text with it so the
			// user sees the real status instead of a false "done".
			try {
				finalize = await stub.finalizeTurn();
			} catch (e) {
				this.logger.warn('ThinkAgent.finalizeTurn failed', e);
			}
		} finally {
			this.broadcast(WebSocketMessageResponses.USAGE_UPDATED, {
				message: 'Usage data updated',
			});
			const disposeSymbol = (Symbol as unknown as { dispose?: symbol }).dispose;
			if (disposeSymbol) {
				const dispose = (forwarder as unknown as Record<symbol, unknown>)[disposeSymbol];
				if (typeof dispose === 'function') dispose.call(forwarder);
			}
			// Think's non-streaming finalize: the FE replaces content with this
			// terminal payload. If the end-of-turn gate failed verification, show
			// the plain "not working" message instead of the model's summary.
			if (finalize && !finalize.verified && finalize.message) {
				this.broadcast(WebSocketMessageResponses.CONVERSATION_RESPONSE, {
					message: finalize.message,
					conversationId,
					isStreaming: false,
				});
			} else if (accumulated.text && !isLeakedToolCallText(accumulated.text)) {
				this.broadcast(WebSocketMessageResponses.CONVERSATION_RESPONSE, {
					message: accumulated.text,
					conversationId,
					isStreaming: false,
				});
			}
		}
	}

	private async translateChunk(
		chunk: ThinkChunk,
		conversationId: string,
		accumulated: { text: string },
		seenWrittenFiles: Set<string>,
		toolNames: Map<string, string>,
		toolInputs: Map<string, Record<string, unknown>>,
	): Promise<void> {
		switch (chunk.type) {
			case 'text-delta': {
				const delta = (chunk as { delta?: string }).delta;
				if (typeof delta === 'string' && delta.length > 0) {
					accumulated.text += delta;
					if (!isLeakedToolCallText(accumulated.text) && !isLeakedToolCallText(delta)) {
						this.broadcast(WebSocketMessageResponses.CONVERSATION_RESPONSE, {
							message: delta,
							conversationId,
							isStreaming: true,
							isDelta: true,
						});
					}
				}
				return;
			}
			case 'reasoning-delta': {
				const delta = (chunk as { delta?: string }).delta;
				if (typeof delta === 'string' && delta.length > 0) {
					this.broadcast(WebSocketMessageResponses.CONVERSATION_RESPONSE, {
						message: '',
						conversationId,
						isStreaming: true,
						reasoning: { delta },
					});
				}
				return;
			}
			case 'reasoning-end': {
				this.broadcast(WebSocketMessageResponses.CONVERSATION_RESPONSE, {
					message: '',
					conversationId,
					isStreaming: true,
					reasoning: { done: true },
				});
				return;
			}
			case 'tool-input-start': {
				const { toolCallId, toolName } = chunk as { toolCallId: string; toolName: string };
				toolNames.set(toolCallId, toolName);
				this.broadcast(WebSocketMessageResponses.CONVERSATION_RESPONSE, {
					message: '',
					conversationId,
					isStreaming: true,
					tool: this.buildToolBroadcastPayload(toolName, undefined, 'start', toolCallId),
				});
				return;
			}
			case 'tool-input-available': {
				const { toolCallId, toolName, input } = chunk as {
					toolCallId: string; toolName: string; input: unknown;
				};
				toolNames.set(toolCallId, toolName);
				const args = (input && typeof input === 'object') ? (input as Record<string, unknown>) : {};
				toolInputs.set(toolCallId, args);
				if (isFileWriteTool(toolName)) {
					const filePath = pickStringField(args, 'path', 'filePath', 'file');
					if (filePath && !seenWrittenFiles.has(filePath)) {
						const displayPath = filePath.replace(/^\/+/, '');
						this.broadcast(WebSocketMessageResponses.FILE_GENERATING, {
							message: `Writing ${displayPath}`,
							filePath: displayPath,
							filePurpose: 'Generated by think',
						});
					}
				}
				return;
			}
			case 'tool-output-available': {
				const { toolCallId, output } = chunk as { toolCallId: string; output: unknown };
				const toolName = toolNames.get(toolCallId) || 'tool';
				const args = toolInputs.get(toolCallId) || {};
				this.broadcast(WebSocketMessageResponses.CONVERSATION_RESPONSE, {
					message: '',
					conversationId,
					isStreaming: false,
					tool: this.buildToolBroadcastPayload(toolName, { input: args, output }, 'success', toolCallId),
				});
				if (toolName === 'deploy_space') {
					await this.handleDeploySpaceOutput(output);
				} else if (toolName === 'set_title') {
					await this.handleSetTitleOutput(args, output);
				} else if (isFileDeleteTool(toolName)) {
					await this.maybeDeleteFile(toolName, args, seenWrittenFiles);
				} else {
					await this.maybeMirrorFile(toolName, args, seenWrittenFiles);
				}
				return;
			}
			case 'tool-output-error': {
				const { toolCallId, errorText } = chunk as { toolCallId: string; errorText: string };
				const toolName = toolNames.get(toolCallId) || 'tool';
				const args = toolInputs.get(toolCallId) || {};
				this.broadcast(WebSocketMessageResponses.CONVERSATION_RESPONSE, {
					message: '',
					conversationId,
					isStreaming: false,
					tool: this.buildToolBroadcastPayload(toolName, { input: args, error: errorText }, 'error', toolCallId),
				});
				return;
			}
			default:
				return;
		}
	}

	private buildToolBroadcastPayload(
		toolName: string,
		state: { input?: Record<string, unknown>; output?: unknown; error?: string } | undefined,
		status: 'start' | 'success' | 'error',
		id?: string,
	): { name: string; status: 'start' | 'success' | 'error'; args?: Record<string, unknown>; result?: string; id?: string } {
		const payload: { name: string; status: 'start' | 'success' | 'error'; args?: Record<string, unknown>; result?: string; id?: string } = {
			name: toolName,
			status,
			args: state?.input,
			id,
		};
		if (status === 'success') {
			if (typeof state?.output === 'string') payload.result = state.output;
			else if (state?.output !== undefined) payload.result = JSON.stringify(state.output);
		} else if (status === 'error') {
			if (typeof state?.error === 'string') payload.result = state.error;
		}
		return payload;
	}

	private async maybeMirrorFile(
		toolName: string,
		args: Record<string, unknown>,
		seen: Set<string>,
	): Promise<void> {
		if (!isFileWriteTool(toolName)) return;
		const filePath = pickStringField(args, 'path', 'filePath', 'file');
		if (!filePath) return;
		seen.add(filePath);

		let contents = '';
		try {
			contents = await this.callSpace((space) => space.readFile(filePath));
		} catch {
			contents = pickStringField(args, 'content', 'contents', 'new_string') || '';
		}

		// SpaceDO uses absolute paths (leading slash); the editor pane and the
		// FILE_GENERATING placeholder use slash-stripped paths. Mirror under the
		// stripped path so the content lands on the same file the UI displays.
		const displayPath = filePath.replace(/^\/+/, '');
		try {
			const saved = await this.fileManager.saveGeneratedFile(
				{ filePath: displayPath, fileContents: contents, filePurpose: 'Generated by think' },
				undefined,
				true,
			);
			this.broadcast(WebSocketMessageResponses.FILE_GENERATED, {
				message: `Updated ${displayPath}`,
				file: saved,
			});
		} catch (e) {
			this.logger.warn('Failed to mirror think file write', { filePath: displayPath, e });
		}
	}

	/**
	 * Mirror a SpaceDO file deletion into the editor pane: drop it from
	 * FileManager and tell the FE to remove it from the file list. Without this,
	 * a file deleted by the model lingers in the tree even though it is gone from
	 * the workspace and the preview.
	 */
	private async maybeDeleteFile(
		toolName: string,
		args: Record<string, unknown>,
		seen: Set<string>,
	): Promise<void> {
		if (!isFileDeleteTool(toolName)) return;
		const filePath = pickStringField(args, 'path', 'filePath', 'file');
		if (!filePath) return;
		// SpaceDO uses absolute paths; the editor pane uses slash-stripped paths.
		const displayPath = filePath.replace(/^\/+/, '');
		seen.delete(filePath);
		try {
			this.fileManager.deleteFiles([displayPath]);
			this.broadcast(WebSocketMessageResponses.FILE_DELETED, {
				filePath: displayPath,
			});
		} catch (e) {
			this.logger.warn('Failed to mirror think file delete', { filePath: displayPath, e });
		}
	}

	/**
	 * The model deployed the SpaceDO itself via the `deploy_space` tool. Reflect
	 * that into VibeSDK: parse the tool's JSON result, and on success surface the
	 * preview to the FE (the same `DEPLOYMENT_COMPLETED { previewURL }` event
	 * `deployCurrentBranch` emits). On a reported build error, emit
	 * `DEPLOYMENT_FAILED`.
	 */
	private async handleDeploySpaceOutput(output: unknown): Promise<void> {
		const parsed = parseDeployResult(output);

		const failureMessage = getDeployFailureMessage(parsed);
		if (failureMessage) {
			this.broadcast(WebSocketMessageResponses.DEPLOYMENT_FAILED, { error: failureMessage });
			return;
		}

		const commitHash = parsed && typeof parsed.commit_hash === 'string' ? parsed.commit_hash : undefined;
		if (commitHash) {
			this.setState({ ...this.state, lastDeployedCommit: commitHash });
		}
		try {
			const url = await this.getBrowserPreviewURL();
			this.broadcast(WebSocketMessageResponses.DEPLOYMENT_COMPLETED, { previewURL: url });
		} catch (e) {
			this.logger.warn('Failed to surface preview after deploy_space', e);
		}
	}

	/**
	 * Restore the SpaceDO to a prior commit and redeploy. Driven by the FE
	 * "Rollback" control on a commit/deploy tool event. Refuses while a
	 * generation turn is active, then reuses `handleDeploySpaceOutput` so the
	 * preview + deploy status surface exactly like a model-driven deploy.
	 */
	async rollbackToCommit(commitHash: string): Promise<void> {
		const hash = (commitHash ?? '').trim();
		if (!hash) {
			this.broadcast(WebSocketMessageResponses.DEPLOYMENT_FAILED, { error: 'Missing commit hash for rollback' });
			return;
		}
		if (this.isCodeGenerating()) {
			this.broadcast(WebSocketMessageResponses.DEPLOYMENT_FAILED, {
				error: 'Cannot roll back while a turn is in progress. Stop generation first.',
			});
			return;
		}

		const branch = this.state.currentBranch || 'main';
		try {
			const output = await this.callSpace((space) => space.rollbackToCommit(branch, hash));
			await this.handleDeploySpaceOutput(output);
			this.broadcast(WebSocketMessageResponses.CONVERSATION_RESPONSE, {
				message: `Rolled back to commit \`${hash.slice(0, 8)}\` and redeployed.`,
				conversationId: IdGenerator.generateConversationId(),
				isStreaming: false,
			});
		} catch (e) {
			this.logger.warn('SpaceDO.rollbackToCommit failed', e);
			this.broadcast(WebSocketMessageResponses.DEPLOYMENT_FAILED, {
				error: e instanceof Error ? e.message : String(e),
			});
		}
	}

	/**
	 * The model named the project via the `set_title` tool. Pull the chosen
	 * title from the tool output (falling back to its input), then persist it to
	 * the app state + database via {@link setTitle}.
	 */
	private async handleSetTitleOutput(
		args: Record<string, unknown>,
		output: unknown,
	): Promise<void> {
		let title: string | undefined;
		if (typeof output === 'string') {
			try {
				const parsed = JSON.parse(output) as Record<string, unknown>;
				if (typeof parsed.title === 'string') title = parsed.title;
			} catch {
				// Non-JSON output — fall back to the tool input below.
			}
		} else if (output && typeof output === 'object') {
			const parsed = output as Record<string, unknown>;
			if (typeof parsed.title === 'string') title = parsed.title;
		}
		if (!title) title = pickStringField(args, 'title');
		if (!title) return;
		await this.setTitle(title);
	}

	/**
	 * Update the project's short display title: sanitize, store it on the
	 * blueprint (drives the preview header) and persist to the app record (drives
	 * the app list). DB failures are logged, never thrown (AppService contract).
	 */
	async setTitle(title: string): Promise<void> {
		const shortTitle = deriveShortTitle(title);
		const updatedBlueprint = { ...this.state.blueprint, title: shortTitle };
		this.setState({
			...this.state,
			blueprint: updatedBlueprint,
		});
		try {
			await new AppService(this.env).updateApp(this.getAgentId(), { title: shortTitle });
		} catch (error) {
			this.logger.warn('Failed to persist project title', { title: shortTitle, error });
		}
		this.broadcast(WebSocketMessageResponses.BLUEPRINT_UPDATED, {
			message: 'Project title updated',
			updatedKeys: ['title'],
			blueprint: updatedBlueprint,
		});
	}

	private async deployCurrentBranch(): Promise<string | null> {
		try {
			const branch = this.state.currentBranch || 'main';
			this.broadcast(WebSocketMessageResponses.DEPLOYMENT_STARTED, {});

			// SpaceDO.deploy reads files from the committed git branch, so commit
			// the working-tree changes the ThinkAgent's tools just made first.
			try {
				await this.callSpace((space) => space.gitCommit('chore: think turn changes'));
			} catch (e) {
				this.logger.debug('gitCommit before deploy (no-op or failed)', e);
			}

			const result = await this.callSpace((space) => space.deploy(branch));

			// SpaceDO.deploy reports build/config failures in the payload rather
			// than throwing (and still fills in preview_url). Surface those as a
			// real deployment failure so the FE/agent sees the build error (e.g.
			// a syntax error in the generated code) instead of a broken preview.
			if (result?.error) {
				const message = result.details ? `${result.error}: ${result.details}` : result.error;
				this.logger.warn('SpaceDO.deploy reported a build failure', { branch, error: message });
				this.broadcast(WebSocketMessageResponses.DEPLOYMENT_FAILED, { error: message });
				return null;
			}

			if (result?.commit_hash) {
				this.setState({ ...this.state, lastDeployedCommit: result.commit_hash });
			}

			const url = await this.getBrowserPreviewURL();
			this.broadcast(WebSocketMessageResponses.DEPLOYMENT_COMPLETED, { previewURL: url });
			return url;
		} catch (e) {
			this.logger.warn('SpaceDO.deploy failed', e);
			this.broadcast(WebSocketMessageResponses.DEPLOYMENT_FAILED, {
				error: e instanceof Error ? e.message : String(e),
			});
			return null;
		}
	}

	async deployToCloudflare(
		target: DeploymentTarget = 'user',
	): Promise<{ deploymentUrl?: string; workersUrl?: string } | null> {
		const userAccountDeployEnabled = this.env.ENABLE_USER_ACCOUNT_DEPLOY === 'true';

		if (!userAccountDeployEnabled) {
			return this.deployThinkAppToMasidy();
		}

		if (target !== 'user') {
			this.broadcast(WebSocketMessageResponses.CLOUDFLARE_DEPLOYMENT_ERROR, {
				message: 'Think apps can only be deployed to your Cloudflare account',
				error: `Unsupported deployment target "${target}"`,
				instanceId: this.getAgentId(),
			});
			return null;
		}

		const instanceId = this.getAgentId();
		let gateCode: CloudflareDeploymentErrorCode | undefined;
		this.broadcast(WebSocketMessageResponses.CLOUDFLARE_DEPLOYMENT_STARTED, {
			message: 'Starting deployment to your Cloudflare account...',
			instanceId,
		});
		try {
			const token = await resolveCloudflareAccessToken(
				this.env,
				this.state.metadata.userId,
				this.state.cloudflareToken,
				this.state.wsOrigin,
			);
			if (token.refreshedBlob) {
				this.setState({ ...this.state, cloudflareToken: token.refreshedBlob });
			}
			if (!token.accessToken) {
				gateCode = 'cloudflare_not_connected';
				throw new Error('Reconnect Cloudflare to grant Worker deployment access');
			}

			// Deploying only needs an account ID — no AI Gateway selection.
			// getDeployAccount falls back to the user's sole connected account
			// and only returns null when the target account is ambiguous.
			const account = await new CloudflareAccountService(this.env)
				.getDeployAccount(this.state.metadata.userId);
			if (!account) {
				gateCode = 'cloudflare_not_configured';
				throw new Error('Select a Cloudflare account in Settings before deploying');
			}

			const branch = this.state.currentBranch || 'main';
			try {
				await this.callSpace((space) => space.gitCommit('deploy: publish to user account'));
			} catch (error) {
				this.logger.debug('No new workspace changes to commit before publishing', error);
			}
			const bundle = await this.callSpace((space) => space.getDeploymentBundle(branch));
			const result = await deployThinkBundleToUserAccount({
				accountId: account.accountId,
				accessToken: token.accessToken,
				appName: this.state.blueprint.title || this.state.projectName || `vibe-${instanceId}`,
				bundle,
			});
			await new AppService(this.env).updateDeploymentId(instanceId, result.deploymentId);
			this.setState({ ...this.state, cloudflareDeploymentUrl: result.deploymentUrl });
			this.broadcast(WebSocketMessageResponses.CLOUDFLARE_DEPLOYMENT_COMPLETED, {
				message: 'Successfully deployed to your Cloudflare account',
				instanceId,
				deploymentUrl: result.deploymentUrl,
				workersUrl: result.deploymentUrl,
			});
			return { deploymentUrl: result.deploymentUrl, workersUrl: result.deploymentUrl };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.logger.error('Think user-account deployment failed', error);
			this.broadcast(WebSocketMessageResponses.CLOUDFLARE_DEPLOYMENT_ERROR, {
				message: 'Deployment failed',
				instanceId,
				error: message,
				...(gateCode ? { code: gateCode } : {}),
			});
			return null;
		}
	}

	/**
	 * Default Think deployment: publish the SpaceDO snapshot through Masidy's
	 * Dynamic Workers runtime without uploading a separate Worker script.
	 */
	private async deployThinkAppToMasidy(): Promise<{ deploymentUrl?: string; workersUrl?: string } | null> {
		const instanceId = this.getAgentId();
		this.broadcast(WebSocketMessageResponses.CLOUDFLARE_DEPLOYMENT_STARTED, {
			message: 'Publishing on Masidy...',
			instanceId,
		});
		try {
			const branch = this.state.currentBranch || 'main';
			try {
				await this.callSpace((space) => space.gitCommit('deploy: publish on Masidy'));
			} catch (error) {
				this.logger.debug('No new workspace changes to commit before publishing', error);
			}
			await this.callSpace((space) => space.publish(branch));

			const deploymentId = buildManagedAppDeploymentId(
				this.state.blueprint.title || this.state.projectName || 'app',
				instanceId,
			);
			let deploymentUrl = buildManagedAppUrl(this.env, deploymentId);
			const appService = new AppService(this.env);
			const updated = await appService.updateDeploymentId(instanceId, deploymentId);
			if (!updated) {
				throw new Error('The app was published, but Masidy could not save its public URL');
			}

			// If the app is private, attach the owner preview token so the owner can view it immediately without 404
			const ownership = await appService.getAppOwnershipByDeploymentId(deploymentId);
			if (ownership?.visibility === 'private' && ownership.userId && this.env.JWT_SECRET) {
				try {
					const token = await signOwnerPreviewToken(this.env, {
						userId: ownership.userId,
						deploymentId,
					});
					deploymentUrl = `${deploymentUrl}/?${OWNER_PREVIEW_QUERY_PARAM}=${encodeURIComponent(token)}`;
				} catch (tokenErr) {
					this.logger.warn('Failed to sign owner preview token for published app', tokenErr);
				}
			}

			this.setState({ ...this.state, cloudflareDeploymentUrl: deploymentUrl });
			this.broadcast(WebSocketMessageResponses.CLOUDFLARE_DEPLOYMENT_COMPLETED, {
				message: 'Successfully published on Masidy',
				instanceId,
				deploymentUrl,
				workersUrl: deploymentUrl,
			});
			return { deploymentUrl, workersUrl: deploymentUrl };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.logger.error('Think managed deployment failed', error);
			this.broadcast(WebSocketMessageResponses.CLOUDFLARE_DEPLOYMENT_ERROR, {
				message: 'Masidy publishing failed',
				instanceId,
				error: message,
			});
			return null;
		}
	}
}

// ───────────────────────────── helpers ─────────────────────────────

function pickStringField(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
	for (const k of keys) {
		const v = obj[k];
		if (typeof v === 'string' && v.length > 0) return v;
	}
	return undefined;
}

function isFileWriteTool(name: string): boolean {
	const n = name.toLowerCase();
	return n === 'write' || n === 'edit' || n === 'patch' || n === 'create';
}

function isFileDeleteTool(name: string): boolean {
	const n = name.toLowerCase();
	return n === 'delete' || n === 'rm' || n === 'remove';
}

function isLeakedToolCallText(text: string): boolean {
	const trimmed = text.trim();
	if (trimmed.startsWith('<tools>') || trimmed.startsWith('</tools>')) return true;
	if (
		trimmed.startsWith('{') &&
		/"name"\s*:\s*"(activate_skill|consult_specialist_agent|read|write|edit|list|find|grep|delete|commit|deploy_space|set_title|ask_questions|get_browser_console_logs|audit_dom|cloudflare_stack_search)"/i.test(trimmed)
	) {
		return true;
	}
	return false;
}

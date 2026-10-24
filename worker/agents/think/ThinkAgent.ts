import { Think } from '@cloudflare/think';
import type { PrepareStepContext, StepConfig, Session, TurnContext, TurnConfig } from '@cloudflare/think';
import { createWorkersAI } from 'workers-ai-provider';
import type { LanguageModel, ToolSet } from 'ai';
import {
	createReadTool,
	createWriteTool,
	createEditTool,
	createListTool,
	createFindTool,
	createGrepTool,
	createDeleteTool,
} from '@cloudflare/think/tools/workspace';
import type { SkillSource } from 'agents/skills';
import { createSpaceWorkspaceOps, type SpaceWorkspaceStub } from './space-workspace-ops';
import { selectSystemPrompt, PROMPT_MAX_STEPS } from './prompts';
import { createThinkSkillSource } from './skills';
import { createAskQuestionsTool } from './ask-questions-tool';
import { createBrowserConsoleLogsTool } from './browser-logs-tool';
import { createDeploySpaceTool } from './deploy-tool';
import { createCommitTool } from './commit-tool';
import { createSetTitleTool } from './set-title-tool';
import { selectThinkContextMessages } from './context-selector';
import { getUserConfigurableSettings } from '../../config';
import { RateLimitService } from '../../services/rate-limit/rateLimits';
import { hasCloudflareConfigured } from '../../services/rate-limit/usageChecker';
import type { RateLimitSettings } from '../../services/rate-limit/config';
import { THINK_MODEL_CONFIG } from './model-config';
import {
	computeTurnCreditAdjustment,
	isTurnVerified,
	turnNotWorkingMessage,
	MAX_CONSECUTIVE_BUILD_FAILURES,
	type BuildRetryState,
	type TurnVerification,
} from './turn-verification';
import { createCloudflareStackTools } from './cloudflare-stack-tools';
import { createSpecialistAgentTool } from './specialist-agent-tool';
import { createDomAuditTool } from './dom-audit-tool';

/**
 * Per-instance configuration pushed into a {@link ThinkAgent} by the host
 * `ThinkCodingBehavior` (which runs in the main worker and resolves the AI
 * Gateway configuration). Plain JSON only — it crosses
 * the DO RPC boundary and is persisted via Think's `configure()`/`getConfig()`.
 */
export interface ThinkAgentConfig {
	/** Owner — used for usage attribution / logging. */
	userId: string;
	/**
	 * Workers AI model and gateway. The AI binding handles authentication, so
	 * this config contains no provider or Cloudflare API credentials.
	 */
	model: {
		modelName: string;
		gatewayId: string;
		dynamicRouteName?: string;
		contextSize?: number;
	};
	/** Builder system prompt (assembled host-side; falls back to a default). */
	systemPrompt?: string;
	/**
	 * Current preview URL (computed host-side via `getBrowserPreviewURL`), used
	 * as the default target for the `get_browser_console_logs` tool.
	 */
	previewUrl?: string;
}

const DEFAULT_SYSTEM_PROMPT =
	'You are an expert Cloudflare full-stack engineer building deployable web apps. ' +
	'Use the workspace tools to read, write and edit files in the project. Keep changes ' +
	'minimal and runnable.';

/**
 * ThinkAgent — the `@cloudflare/think` harness. It owns the agentic loop
 * (model ↔ tools), message persistence and streaming; its file tools operate
 * on the companion SpaceDO (the preview source of truth) rather than Think's
 * default DO-SQLite workspace.
 */
export class ThinkAgent extends Think<Env> {
	/** Step budget per turn (Think's default is 10). */
	override maxSteps = 30;
	/** SpaceDO has no shell; expose only the explicit file tools. */
	override workspaceBash = false;

	private turnUsage: { config: RateLimitSettings; hasCloudflareConfigured: boolean } | null = null;

	/**
	 * Per-turn build verification, shared by `deploy_space` and
	 * `get_browser_console_logs` and read by the end-of-turn gate
	 * ({@link finalizeTurn}). Reset in {@link beforeTurn}.
	 */
	private turnVerification: TurnVerification = {
		deployed: false,
		consoleChecked: false,
		consoleClean: false,
		previewOk: false,
	};
	/** Shared deploy + preview/console failure counter (item 4). Reset per turn. */
	private buildRetry: BuildRetryState = { consecutiveFailures: 0 };
	/** Credits consumed by this turn's LLM steps; refunded if the turn is unverified. */
	private turnCreditsConsumed = 0;

	private requireConfig(): ThinkAgentConfig {
		const cfg = this.getConfig<ThinkAgentConfig>();
		if (!cfg) {
			throw new Error('ThinkAgent has not been configured yet (call configureVibe first)');
		}
		return cfg;
	}

	private getSpaceStub(): SpaceWorkspaceStub {
		// One space per session: the SpaceDO is always keyed by this session's
		// (agent) id, so a session can never resolve to a different space.
		const ns = (this.env as unknown as { SPACE_DO: DurableObjectNamespace }).SPACE_DO;
		return ns.get(ns.idFromName(this.name)) as unknown as SpaceWorkspaceStub;
	}

	override getModel(): LanguageModel {
		const { model, userId } = this.requireConfig();
		return createWorkersAI({ binding: this.env.AI })(
			model.dynamicRouteName
				? `dynamic/${model.dynamicRouteName}`
				: model.modelName,
			{
				gateway: {
					id: model.gatewayId,
					metadata: {
						application: 'masidy',
						agent: 'think',
						user_id: userId,
					},
				},
			},
		);
	}

	/**
	 * Register the base prompt as a context block.
	 *
	 * Think only falls back to `getSystemPrompt()` when the session has NO
	 * context blocks. Because `getSkills()` adds a skills block, that fallback
	 * never fires — so without this, the model would receive only the skill
	 * catalog and none of the file-based persona prompt or project context.
	 * Adding it as a (lazy, readonly) block makes Think render it ahead of the
	 * skills block in the assembled system prompt. The `get` closure is invoked
	 * at prompt-freeze time, so it picks up config pushed via `configureVibe`.
	 */
	override configureSession(session: Session): Session {
		return session.withContext('system', {
			description: 'Base system prompt and project context',
			provider: { get: async () => this.getSystemPrompt() },
		});
	}

	override getSystemPrompt(): string {
		const cfg = this.getConfig<ThinkAgentConfig>();
		// Base prompt is the file-based prompt selected by model
		// family; the host behavior's project/query context (`systemPrompt`) is
		// appended. Think additionally injects the skill catalog (see getSkills).
		const base = selectSystemPrompt(cfg?.model.modelName ?? '');
		const projectContext = cfg?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
		return `${base}\n\n${projectContext}`;
	}

	override async beforeTurn(ctx: TurnContext): Promise<TurnConfig> {
		const messages = selectThinkContextMessages(ctx.messages);
		const config = this.getConfig<ThinkAgentConfig>();
		this.turnUsage = null;
		// Reset per-turn build verification + zero-waste credit accounting.
		this.turnVerification.deployed = false;
		this.turnVerification.consoleChecked = false;
		this.turnVerification.consoleClean = false;
		this.turnVerification.previewOk = false;
		this.turnVerification.auditPassed = undefined;
		this.turnVerification.deployCommit = undefined;
		this.turnVerification.lastError = undefined;
		this.buildRetry.consecutiveFailures = 0;
		this.turnCreditsConsumed = 0;
		if (config) {
			try {
				const userConfig = await getUserConfigurableSettings(this.env, config.userId);
				this.turnUsage = {
					config: userConfig.security.rateLimit,
					hasCloudflareConfigured: await hasCloudflareConfigured(this.env, config.userId),
				};
			} catch (error) {
				console.warn('Failed to resolve Think credit metering configuration', error);
			}
		}
		console.info('Think context selected', {
			model: config?.model.modelName,
			contextSize: config?.model.contextSize,
			originalMessageCount: ctx.messages.length,
			selectedMessageCount: messages.length,
		});
		return { messages };
	}

	override getSkills(): SkillSource[] {
		// SKILL.md catalog. Think registers the skill-loading tool
		// and injects the catalog into the system prompt automatically.
		return [createThinkSkillSource()];
	}

	override getTools(): ToolSet {
		const ops = createSpaceWorkspaceOps(() => this.getSpaceStub());
		const config = this.getConfig<ThinkAgentConfig>();
		const previewUrl = config?.previewUrl;
		// Same names as Think's built-in workspace tools, so these SpaceDO-backed
		// versions win the tool-merge. Bash is disabled via `workspaceBash`.
		return {
			read: createReadTool({ ops }),
			write: createWriteTool({ ops }),
			edit: createEditTool({ ops }),
			list: createListTool({ ops }),
			find: createFindTool({ ops }),
			grep: createGrepTool({ ops }),
			delete: createDeleteTool({ ops }),
			// Save a restore point without deploying. The model decides when.
			commit: createCommitTool({ getStub: () => this.getSpaceStub() }),
			// Commit + deploy the SpaceDO branch so the preview rebuilds.
			deploy_space: createDeploySpaceTool({
				getStub: () => this.getSpaceStub(),
				getPreviewUrl: () => previewUrl,
				verification: this.turnVerification,
				retryState: this.buildRetry,
			}),
			// Set the project's short display title (host observes the output).
			set_title: createSetTitleTool(),
			// Ask the user clarifying questions via a frontend popup.
			ask_questions: createAskQuestionsTool(),
			// Consult specialized subagents via AI Gateway (database, backend, frontend, security, architect, ui_design).
			consult_specialist_agent: createSpecialistAgentTool({
				env: this.env,
				gatewayId: config?.model.gatewayId,
				userId: config?.userId,
			}),
			// Client-side debugging via a real headless browser.
			get_browser_console_logs: createBrowserConsoleLogsTool({
				env: this.env,
				defaultUrl: previewUrl,
				verification: this.turnVerification,
				retryState: this.buildRetry,
			}),
			// Cheap DOM-only visual audit (no screenshot/vision tokens).
			audit_dom: createDomAuditTool({
				env: this.env,
				defaultUrl: previewUrl,
				verification: this.turnVerification,
			}),
			...createCloudflareStackTools(),
		} as unknown as ToolSet;
	}

	/**
	 * On the final allowed step, disable tools and prime a text-only wrap-up so
	 * the turn ends with a summary instead of a truncated tool call (see
	 * `prompts/max-steps.txt`).
	 *
	 * The primer is injected as a `user` turn, not an `assistant` one: Gemini's
	 * OpenAI-compat endpoint rejects any request whose final message is a model
	 * turn (`400 INVALID_ARGUMENT: Requests ending with a model turn are not
	 * supported`), and the prompt is a control directive that reads naturally as
	 * user input.
	 */
	override async beforeStep(ctx: PrepareStepContext): Promise<StepConfig | void> {
		const config = this.getConfig<ThinkAgentConfig>();
		if (this.turnUsage && config) {
			await RateLimitService.enforceLLMCallsRateLimit(
				this.env,
				this.turnUsage.config,
				config.userId,
				'Think',
				'',
				false,
				this.turnUsage.hasCloudflareConfigured,
				{ creditCost: THINK_MODEL_CONFIG.creditCost, throwOnExceeded: false },
			);
			// Track what this turn actually consumed so an unverified build turn
			// can refund it (zero-waste billing). Mirrors the enforcer's decision.
			this.turnCreditsConsumed += RateLimitService.computeLLMChargeCost(
				this.turnUsage.config,
				'Think',
				false,
				this.turnUsage.hasCloudflareConfigured,
				{ creditCost: THINK_MODEL_CONFIG.creditCost },
			);
		}
		if (ctx.stepNumber >= this.maxSteps - 1) {
			return {
				activeTools: [],
				toolChoice: 'none',
				messages: [...ctx.messages, { role: 'user', content: PROMPT_MAX_STEPS }],
			};
		}
	}

	/**
	 * RPC entrypoint used by `ThinkCodingBehavior` to push model/space/prompt
	 * configuration. Called once per app, when the host behavior initializes a
	 * fresh agent (each app maps to its own ThinkAgent DO — and therefore its
	 * own session — keyed by `agentId`). Persisted in Think's `think_config`
	 * table (survives hibernation), so subsequent turns resolve
	 * `getModel()`/`getTools()`.
	 *
	 * The system prompt is frozen + persisted on its first render and served
	 * from cache afterwards (see the Sessions lifecycle). Re-render it here so
	 * THIS session's prompt is (re)loaded from the freshly pushed model/project
	 * config — the `system` context block (`configureSession`) reads config
	 * lazily, so a refresh is what actually pulls it in for a new app instead of
	 * any stale cached value.
	 */
	async configureVibe(config: ThinkAgentConfig): Promise<void> {
		this.configure<ThinkAgentConfig>(config);
		try {
			await this.session?.refreshSystemPrompt();
		} catch {
			// Session may not be wired yet on the very first configure; in that
			// case the initial freezeSystemPrompt() during chat() renders with
			// this config anyway.
		}
	}

	/**
	 * End-of-turn gate, enforced in code (not just the prompt): a build turn
	 * that deployed but was NOT verified — clean `get_browser_console_logs`
	 * after the last deploy AND the preview returning HTTP 200 — is treated as
	 * NOT working. Its credits are refunded (zero-waste billing) and a plain
	 * failure message is returned for the host to broadcast instead of the
	 * model's "done" text. Non-build turns and verified turns return verified.
	 */
	async finalizeTurn(): Promise<{
		verified: boolean;
		message?: string;
		refunded?: number;
	}> {
		const v = this.turnVerification;
		if (!v.deployed || isTurnVerified(v)) {
			return { verified: true };
		}
		const message = turnNotWorkingMessage(v) ?? 'The app is NOT working.';
		const refund = computeTurnCreditAdjustment(v, this.turnCreditsConsumed).refund;
		const config = this.getConfig<ThinkAgentConfig>();
		if (refund > 0 && config && this.turnUsage) {
			try {
				await RateLimitService.refundLLMCredits(
					this.env,
					this.turnUsage.config,
					config.userId,
					refund,
				);
			} catch (e) {
				console.error('Failed to refund credits for unverified turn', e);
			}
		}
		return { verified: false, message, refunded: refund };
	}

	/** Read-only access for the deploy/preview tools to the shared retry cap. */
	get maxConsecutiveBuildFailures(): number {
		return MAX_CONSECUTIVE_BUILD_FAILURES;
	}
}

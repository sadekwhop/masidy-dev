/**
 * Multi-Agent Router — agent definitions and intent classifier.
 *
 * Each agent maps to a Cloudflare AI Gateway dynamic route in vibesdk-gateway.
 * Dynamic routes must be created in the dashboard:
 *   - masidy-code      → primary: qwen2.5-coder-32b,   fallback: kimi-k2.7-code
 *   - masidy-chat      → primary: llama-3.3-70b-fp8,   fallback: llama-3.1-8b
 *   - masidy-reasoning → primary: deepseek-r1-qwen-32b, fallback: llama-3.3-70b-fp8
 *   - masidy-summary   → primary: llama-3.1-8b,         fallback: mistral-small-3.1-24b
 *
 * The router classifies every incoming think-agent request and returns the
 * matching dynamic route name. ThinkAgent.getModel() then calls
 * `dynamic/<routeName>` via the AI binding.
 */

export type AgentName = 'code' | 'chat' | 'reasoning' | 'summary';

export interface AgentDef {
	/** Dynamic route name in vibesdk-gateway */
	routeName: string;
	/** Fallback model ID (used directly if dynamic route fails) */
	fallbackModelId: string;
	/** Primary model ID (informational / for logging) */
	primaryModelId: string;
	/** System prompt injected for this agent type */
	system: string;
	/** Request timeout in ms */
	timeoutMs: number;
}

export const AGENTS: Record<AgentName, AgentDef> = {
	code: {
		routeName: 'masidy-code',
		primaryModelId: '@cf/qwen/qwen2.5-coder-32b-instruct',
		fallbackModelId: '@cf/moonshotai/kimi-k2.7-code',
		system: 'You are a senior software engineer. Return correct, minimal code with brief explanations.',
		timeoutMs: 45_000,
	},
	chat: {
		routeName: 'masidy-chat',
		primaryModelId: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
		fallbackModelId: '@cf/meta/llama-3.1-8b-instruct',
		system: 'You are a friendly, concise assistant. Answer clearly and directly.',
		timeoutMs: 20_000,
	},
	reasoning: {
		routeName: 'masidy-reasoning',
		primaryModelId: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
		fallbackModelId: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
		system: 'Think step by step. Show your reasoning, then give a clear final answer.',
		timeoutMs: 60_000,
	},
	summary: {
		routeName: 'masidy-summary',
		primaryModelId: '@cf/meta/llama-3.1-8b-instruct',
		fallbackModelId: '@cf/mistralai/mistral-small-3.1-24b-instruct',
		system: 'Summarize the input in clear bullet points. Do not add facts not in the source.',
		timeoutMs: 20_000,
	},
};

/**
 * Classify a user message and return the best agent for the task.
 *
 * Priority:
 *  1. Explicit `task` hint (passed by the caller, e.g. "code")
 *  2. Keyword classifier on the last user message
 *  3. Default → chat
 */
export function classifyIntent(lastUserMessage: string, taskHint?: string): AgentName {
	if (taskHint && taskHint in AGENTS) return taskHint as AgentName;

	const text = lastUserMessage.toLowerCase();

	// Summary signals — long text or explicit summarize request
	if (
		/summari[sz]e|tl;?dr|key.?points|shorten|brief|overview/.test(text) ||
		text.length > 3000
	) return 'summary';

	// Reasoning/planning signals
	if (
		/prove|step.?by.?step|calculate|why does|trade.?off|derive|algorithm/.test(text)
	) return 'reasoning';

	// General chat signals (only pure greetings or non-coding chat)
	if (
		/^(hi|hello|hey|howdy|sup|greetings|who are you|what can you do|what are you)\b/i.test(text.trim()) &&
		!/page|site|app|build|create|code|html|css|design/i.test(text)
	) return 'chat';

	// Everything else in the builder is code / web construction
	return 'code';
}

/** Get the agent def for a given message, with optional explicit task hint. */
export function resolveAgent(lastUserMessage: string, taskHint?: string): AgentDef & { name: AgentName } {
	const name = classifyIntent(lastUserMessage, taskHint);
	return { name, ...AGENTS[name] };
}

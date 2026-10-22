import { tool } from 'ai';
import { z } from 'zod';

export interface SpecialistAgentToolOptions {
	env: Env;
	gatewayId?: string;
	userId?: string;
}

const SPECIALIST_PROMPTS: Record<string, { system: string; route: string }> = {
	database: {
		system: 'You are a principal Cloudflare Database Engineer. You design production-ready, clean SQLite/D1 schemas with CREATE TABLE IF NOT EXISTS, indexed columns, clean primary/foreign keys, and high-performance parameterized queries for Cloudflare Durable Objects (this.ctx.storage.sql) and D1. Return direct SQL, types, and concise query helpers. No fluff.',
		route: 'masidy-code',
	},
	backend: {
		system: 'You are a senior Cloudflare Backend Engineer. You build robust, typed REST/WebSocket APIs with Hono on Cloudflare Workers and Durable Objects. You handle authentication, session validation, CORS, error formatting, and input validation. Return clean, copy-pasteable TypeScript code with proper status codes.',
		route: 'masidy-code',
	},
	frontend: {
		system: 'You are a world-class Frontend Engineer. You create state-of-the-art, interactive, beautiful web interfaces using modern HTML5, Tailwind CSS, or React. You implement working client-side state, modal dialogs, loading spinners, form submissions, and error handling. No placeholders, complete working code.',
		route: 'masidy-code',
	},
	ui_design: {
		system: 'You are an elite Product & UI/UX Designer. You provide modern color palettes, typography scales, glassmorphism/gradient styling rules, component states, and sleek layout structure that WOW the user.',
		route: 'masidy-chat',
	},
	security: {
		system: 'You are a Cloudflare Application Security Engineer. You review authentication flows, token handling, input sanitization, and session lifetimes. You provide hardened security practices for OAuth, sessions, and database queries.',
		route: 'masidy-reasoning',
	},
	architect: {
		system: 'You are a Principal Software Architect. You break down complex feature requests into clear technical architectures, data flows, components, and edge cases. You advise on the best Cloudflare primitives (Durable Objects, SQLite, KV, R2, AI, Workflows).',
		route: 'masidy-reasoning',
	},
};

export function createSpecialistAgentTool(opts: SpecialistAgentToolOptions) {
	return tool({
		description:
			'Consult a specialized AI agent through Cloudflare AI Gateway for expert domain guidance and complete code implementations. Specialists: "database" (SQLite/D1 schema, migrations, queries), "backend" (APIs, auth, Hono routes, sessions), "frontend" (UI components, styling, animations, forms), "ui_design" (color themes, typography, layout), "security" (auth & injection review), "architect" (system design, Cloudflare stack choices).',
		inputSchema: z.object({
			specialist: z
				.enum(['database', 'backend', 'frontend', 'ui_design', 'security', 'architect'])
				.describe('The domain specialist to consult.'),
			task: z
				.string()
				.min(3)
				.describe('The specific technical implementation or architecture task to delegate.'),
			context: z
				.string()
				.optional()
				.describe('Optional existing file snippets or project background.'),
		}),
		execute: async ({ specialist, task, context }) => {
			const spec = SPECIALIST_PROMPTS[specialist] || SPECIALIST_PROMPTS.backend;
			const gatewayId = opts.gatewayId || 'vibesdk-gateway';
			const userMessage = context ? `Project context:\n${context}\n\nTask:\n${task}` : task;

			try {
				const response = await opts.env.AI.run(
					`dynamic/${spec.route}` as Parameters<Ai['run']>[0],
					{
						messages: [
							{ role: 'system', content: spec.system },
							{ role: 'user', content: userMessage },
						],
						max_tokens: 3500,
					} as Parameters<Ai['run']>[1],
					{
						gateway: {
							id: gatewayId,
							metadata: {
								application: 'masidy',
								agent: `specialist-${specialist}`,
								...(opts.userId ? { user_id: opts.userId } : {}),
							},
						},
					},
				);

				if (response && typeof response === 'object' && 'response' in response) {
					return String((response as { response: string }).response);
				}
				return typeof response === 'string' ? response : JSON.stringify(response);
			} catch (err) {
				return `Specialist consultation encountered an error: ${err instanceof Error ? err.message : String(err)}. Proceed with best-practice implementation.`;
			}
		},
	});
}

/**
 * Agent catalogue — 11 specialists + reviewer.
 * Models use Workers AI IDs routed through vibesdk-gateway.
 */

import type { Agent } from './core';

// Model chains: [primary, fallback]
const CODE = [
	'@cf/qwen/qwen2.5-coder-32b-instruct',
	'@cf/moonshotai/kimi-k2.7-code',
];
const THINK = [
	'@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
	'@cf/meta/llama-3.3-70b-instruct-fp8-fast',
];
const GENERAL = [
	'@cf/meta/llama-3.3-70b-instruct-fp8-fast',
	'@cf/meta/llama-3.1-8b-instruct',
];

const OUT_OF_SCOPE =
	'If the task is outside your specialty, say so in one sentence and stop. Never invent APIs, versions, or facts.';

export const AGENTS: Agent[] = [
	{
		id: 'architect',
		kind: 'text',
		review: true,
		cost: 3,
		timeoutMs: 60_000,
		maxTokens: 3000,
		description: 'System design, stack choices, project structure, trade-offs, roadmaps.',
		system: `You are a principal software architect. Give decisions with reasons, a component list, data flow, risks and a phased plan. Prefer simple, proven designs. ${OUT_OF_SCOPE}`,
		chain: THINK,
		tools: ['search_knowledge'],
	},
	{
		id: 'frontend',
		kind: 'text',
		review: true,
		cost: 3,
		timeoutMs: 45_000,
		maxTokens: 4000,
		description: 'React, TypeScript, Tailwind UI code, components, state, accessibility, performance.',
		system: `You are a senior frontend engineer. Output complete, typed, production-ready code — no placeholders. Semantic HTML, keyboard support, ARIA where needed, responsive by default, loading/empty/error states. File paths as headings. End with at most 5 lines: assumptions and how to run. ${OUT_OF_SCOPE}`,
		chain: CODE,
	},
	{
		id: 'backend',
		kind: 'text',
		review: true,
		cost: 3,
		timeoutMs: 45_000,
		maxTokens: 4000,
		description: 'APIs, auth, validation, Cloudflare Workers, D1, KV, R2, Queues, Durable Objects.',
		system: `You are a senior backend engineer. Validate all input, use correct HTTP status codes and consistent error JSON, never hardcode secrets, use parameterized SQL. State auth and rate-limit decisions. File paths as headings. End with at most 5 lines: assumptions, risks, how to test. ${OUT_OF_SCOPE}`,
		chain: CODE,
	},
	{
		id: 'database',
		kind: 'text',
		review: true,
		cost: 2,
		timeoutMs: 45_000,
		maxTokens: 3000,
		description: 'Schema design, migrations, indexes, query optimization, D1/SQLite/Postgres.',
		system: `You are a database engineer. Output schema and migrations first (SQL), then indexes with reasons, then key queries. Call out constraints, data integrity and migration risk. ${OUT_OF_SCOPE}`,
		chain: CODE,
	},
	{
		id: 'security',
		kind: 'text',
		review: false,
		cost: 3,
		timeoutMs: 60_000,
		maxTokens: 2500,
		description: 'Security audit: auth flaws, injection, XSS, CSRF, secrets, SSRF, dependency and config risks.',
		system: `You are an application security engineer. Audit the given code or design. For each finding: severity (critical/high/medium/low), location, exploit scenario, concrete fix. Only report findings you can justify from the input. ${OUT_OF_SCOPE}`,
		chain: THINK,
	},
	{
		id: 'qa',
		kind: 'text',
		review: false,
		cost: 2,
		timeoutMs: 45_000,
		maxTokens: 3500,
		description: 'Unit, integration and end-to-end tests, test plans, edge cases (Vitest, Playwright).',
		system: `You are a QA engineer. Write runnable tests (Vitest/Playwright) with clear names, covering happy path, edge cases and failure modes. Include a short test plan first. ${OUT_OF_SCOPE}`,
		chain: CODE,
	},
	{
		id: 'devops',
		kind: 'text',
		review: true,
		cost: 2,
		timeoutMs: 45_000,
		maxTokens: 3000,
		description: 'CI/CD, Wrangler config, deployment, environments, monitoring, rollback.',
		system: `You are a DevOps engineer for Cloudflare. Give exact commands and config files, environment separation, secrets handling and a rollback path. ${OUT_OF_SCOPE}`,
		chain: CODE,
	},
	{
		id: 'ui_design',
		kind: 'text',
		review: false,
		cost: 2,
		timeoutMs: 30_000,
		maxTokens: 2500,
		description: 'UX flows, design systems, wireframes, color, typography, layout specs, design critique.',
		system: `You are a senior product designer. Output: goals, user flow, layout (described precisely), design tokens (color, type scale, spacing), components with states, accessibility notes. ${OUT_OF_SCOPE}`,
		chain: GENERAL,
	},
	{
		id: 'writer',
		kind: 'text',
		review: false,
		cost: 1,
		timeoutMs: 25_000,
		maxTokens: 2500,
		description: 'Docs, README, marketing copy, emails, microcopy, release notes.',
		system: `You are a professional technical and marketing writer. Clear, specific, no filler or clichés. Match the requested audience and tone. ${OUT_OF_SCOPE}`,
		chain: GENERAL,
	},
	{
		id: 'researcher',
		kind: 'text',
		review: false,
		cost: 2,
		timeoutMs: 45_000,
		maxTokens: 2500,
		description: 'Research with sources: reads web pages, searches the web and the private knowledge base.',
		system: `You are a research analyst. Use tools to gather evidence before answering. Cite the URL or source for every claim. Say clearly when evidence is missing or conflicting. Never present guesses as facts.`,
		chain: GENERAL,
		tools: ['fetch_url', 'web_search', 'search_knowledge'],
	},
	{
		id: 'reviewer',
		kind: 'text',
		review: false,
		cost: 2,
		timeoutMs: 60_000,
		maxTokens: 1800,
		description: 'Automatic quality and security gate. Not directly callable.',
		system: `You are a strict code reviewer. Review the work against the original request. Check correctness, missing requirements, security, error handling, accessibility, edge cases.
Output exactly "VERDICT: PASS" or "VERDICT: FAIL" on the first line, then a numbered list of concrete issues (severity, location, fix), max 8. Do not rewrite the work. Do not add praise.`,
		chain: THINK,
	},
	{
		id: 'image',
		kind: 'image',
		review: false,
		cost: 5,
		timeoutMs: 60_000,
		maxTokens: 0,
		description: 'Generates images: logos, hero art, icons, illustrations, product visuals.',
		chain: [
			'@cf/black-forest-labs/flux-1-schnell',
			'@cf/stabilityai/stable-diffusion-xl-base-1.0',
		],
	},
];

export const byId = (id: string): Agent | undefined =>
	AGENTS.find((a) => a.id === id);

/** Agents the planner may dispatch to (excludes the reviewer). */
export const PLANNABLE = AGENTS.filter((a) => a.id !== 'reviewer');

import { AGENTS, PLANNABLE, byId } from './agents';
import type { TeamEnv } from './core';
import { textOf } from './core';
import { logUsage, OutOfCredits, refund, spend } from './billing';
import { runImage } from './media';
import { runText } from './runtime';

const MAX_STEPS = 4;
const PLANNER_COST = 1;

export interface Step {
	agent: string;
	task: string;
}

export function heuristic(req: string): Step[] {
	const t = req.toLowerCase();
	const pick = (id: string) => [{ agent: id, task: req }];
	if (/\b(image|logo|icon|illustration|poster|picture)\b/.test(t)) return pick('image');
	if (/security|vulnerab|audit|xss|injection/.test(t)) return pick('security');
	if (/\btest(s|ing)?\b|vitest|playwright/.test(t)) return pick('qa');
	if (/sql|schema|migration|index/.test(t)) return pick('database');
	if (/react|tailwind|css|component|frontend/.test(t)) return pick('frontend');
	if (/api|endpoint|worker|auth|backend/.test(t)) return pick('backend');
	if (/deploy|ci\/cd|wrangler|docker/.test(t)) return pick('devops');
	if (/design|ux|wireframe|palette/.test(t)) return pick('ui_design');
	if (/research|compare|latest|sources/.test(t)) return pick('researcher');
	if (/architecture|stack|roadmap|trade-?off/.test(t)) return pick('architect');
	return pick('writer');
}

export async function plan(
	env: TeamEnv,
	request: string,
): Promise<{ steps: Step[]; reply?: string }> {
	const catalog = PLANNABLE.map((a) => `- ${a.id}: ${a.description}`).join('\n');
	const system = `You are the front desk of an engineering team. Split the request into the fewest tasks (max ${MAX_STEPS}), each assigned to one specialist, in execution order.

Specialists:
${catalog}

Reply with JSON only: {"steps":[{"agent":"<id>","task":"<complete, self-contained instruction>"}]}
Order: architect, database, backend, frontend, then security, qa, devops, writer.
If the request needs a skill the team lacks (video, 3D, legal advice), reply {"steps":[],"reply":"<one honest sentence>"}.`;

	const gatewayId = env.GATEWAY_ID || env.CLOUDFLARE_AI_GATEWAY || 'vibesdk-gateway';

	try {
		const out = await env.AI.run(
			'@cf/meta/llama-3.3-70b-instruct-fp8-fast' as Parameters<Ai['run']>[0],
			{
				messages: [
					{ role: 'system', content: system },
					{ role: 'user', content: request },
				],
				max_tokens: 700,
			} as Parameters<Ai['run']>[1],
			{ gateway: { id: gatewayId, metadata: { agent: 'planner' } } },
		);
		const raw = textOf(out);
		const firstBrace = raw.indexOf('{');
		const lastBrace = raw.lastIndexOf('}');
		if (firstBrace !== -1 && lastBrace !== -1) {
			const parsed = JSON.parse(raw.slice(firstBrace, lastBrace + 1)) as {
				steps?: Array<{ agent?: string; task?: string }>;
				reply?: string;
			};
			const steps: Step[] = (parsed.steps ?? [])
				.filter(
					(s): s is Step =>
						!!s &&
						typeof s.agent === 'string' &&
						!!byId(s.agent) &&
						s.agent !== 'reviewer' &&
						typeof s.task === 'string',
				)
				.slice(0, MAX_STEPS);
			if (steps.length || parsed.reply) {
				return { steps, reply: parsed.reply };
			}
		}
	} catch {
		/* fallback to heuristic */
	}
	return { steps: heuristic(request) };
}

export async function runTeam(
	env: TeamEnv,
	ctx: ExecutionContext,
	keyId: string,
	request: string,
	requestId: string,
	forced?: string,
) {
	const db = env.TEAM_DB || env.DB;
	if (!db) {
		throw new Error('Database is not configured for Masidy team.');
	}

	const pay = (n: number) => spend(db, keyId, n);
	let steps: Step[];
	let reply: string | undefined;

	if (forced) {
		steps = [{ agent: forced, task: request }];
	} else {
		await pay(PLANNER_COST);
		({ steps, reply } = await plan(env, request));
	}

	if (!steps.length) {
		return {
			requestId,
			plan: [],
			steps: [],
			review: null,
			final: reply ?? 'No suitable specialist yet.',
		};
	}

	const results: Array<{
		agent: string;
		model: string;
		usedFallback: boolean;
		output: string;
		image: boolean;
	}> = [];
	let context = '';

	const exec = async (s: Step, extra = '') => {
		const a = byId(s.agent)!;
		await pay(a.cost);
		const t0 = Date.now();
		try {
			const r =
				a.kind === 'image'
					? await runImage(env, a, s.task, requestId)
					: await runText(env, a, s.task, (context + extra).trim(), requestId);
			ctx.waitUntil(logUsage(db, keyId, a.id, r.model, a.cost, Date.now() - t0, true));
			return { agent: a.id, ...r, image: a.kind === 'image' };
		} catch (e) {
			await refund(db, keyId, a.cost);
			ctx.waitUntil(logUsage(db, keyId, a.id, null, 0, Date.now() - t0, false));
			throw e;
		}
	};

	for (const s of steps) {
		const r = await exec(s);
		results.push(r);
		if (!r.image) context += `\n\n[${r.agent} output]\n${r.output}`;
	}

	const reviewed = steps
		.map((s, i) => ({ s, i }))
		.filter(({ s }) => byId(s.agent)?.review);
	let review: { passed: boolean; notes: string; reworked?: boolean } | null = null;

	if (reviewed.length) {
		const reviewer = byId('reviewer')!;
		const doReview = async () => {
			await pay(reviewer.cost);
			const work = reviewed
				.map(({ i }) => `[${results[i].agent}]\n${results[i].output}`)
				.join('\n\n');
			const r = await runText(
				env,
				reviewer,
				'Review the work below against the original request.',
				`Original request:\n${request}\n\nWork:\n${work}`,
				requestId,
			);
			return { passed: /^\s*VERDICT:\s*PASS/i.test(r.output), notes: r.output };
		};

		try {
			review = await doReview();
			if (!review.passed) {
				const feedback = review.notes;
				context = '';
				for (let i = 0; i < steps.length; i++) {
					if (reviewed.some((x) => x.i === i)) {
						results[i] = await exec(
							steps[i],
							`\n\nYour previous output:\n${results[i].output}\n\nReviewer feedback to fix:\n${feedback}`,
						);
					}
					if (!results[i].image) {
						context += `\n\n[${results[i].agent} output]\n${results[i].output}`;
					}
				}
				review = { ...(await doReview()), reworked: true };
			}
		} catch (e) {
			if (e instanceof OutOfCredits) {
				review = {
					passed: false,
					notes: 'Review or rework skipped: out of credits.',
				};
			} else {
				throw e;
			}
		}
	}

	return {
		requestId,
		plan: steps,
		steps: results.map(({ image, ...r }) => r),
		review,
		final: results
			.map((r) => (r.image ? `![image](${r.output})` : r.output))
			.join('\n\n---\n\n'),
	};
}

export const AGENT_IDS = AGENTS.map((a) => a.id);

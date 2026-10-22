import { AGENTS, byId } from './agents';
import { authKey, checkout, createKey, isAdmin, OutOfCredits, stripeWebhook, spend } from './billing';
import { json, type TeamEnv } from './core';
import { speak, transcribe } from './media';
import { ingestKnowledge } from './tools';
import { runTeam } from './team';

const cors = (r: Response): Response => {
	const h = new Headers(r.headers);
	h.set('access-control-allow-origin', '*');
	h.set('access-control-allow-headers', 'authorization, content-type');
	h.set('access-control-allow-methods', 'GET, POST, OPTIONS');
	return new Response(r.body, { status: r.status, headers: h });
};

const SPEECH_COST = 1;

export async function handleTeam(
	req: Request,
	env: TeamEnv,
	ctx: ExecutionContext,
): Promise<Response | null> {
	const url = new URL(req.url);
	if (!url.pathname.startsWith('/team')) return null;
	if (req.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));

	const requestId = crypto.randomUUID();
	try {
		return cors(await route(req, env, ctx, url, requestId));
	} catch (e: unknown) {
		if (e instanceof OutOfCredits) {
			return cors(
				json(
					{
						error: 'insufficient credits',
						buy: 'POST /team/v1/billing/checkout',
						requestId,
					},
					402,
				),
			);
		}
		const err = e as { message?: string };
		console.error(JSON.stringify({ requestId, error: String(err?.message ?? e) }));
		return cors(json({ error: 'internal error', detail: String(err?.message ?? e), requestId }, 500));
	}
}

async function route(
	req: Request,
	env: TeamEnv,
	ctx: ExecutionContext,
	url: URL,
	requestId: string,
): Promise<Response> {
	const p = url.pathname;
	const m = req.method;
	const db = env.TEAM_DB || env.DB;
	const gatewayId = env.GATEWAY_ID || env.CLOUDFLARE_AI_GATEWAY || 'vibesdk-gateway';
	const publicBaseUrl =
		env.PUBLIC_BASE_URL ||
		(env.CUSTOM_DOMAIN ? `https://${env.CUSTOM_DOMAIN}` : 'http://localhost:5173');

	if (p === '/team/health') return json({ ok: true });
	if (p === '/team/v1/billing/success') {
		return new Response('Payment received. Credits are added within seconds.');
	}
	if (p === '/team/v1/billing/cancel') {
		return new Response('Checkout cancelled.');
	}
	if (m === 'POST' && p === '/team/v1/billing/webhook') {
		if (!db) return json({ error: 'database not configured' }, 500);
		return stripeWebhook(req, db, env.STRIPE_WEBHOOK_SECRET);
	}

	if (m === 'GET' && p.startsWith('/team/v1/files/')) {
		if (!env.TEAM_FILES) return json({ error: 'file storage not configured' }, 404);
		const key = p.replace('/team/v1/files/', '');
		const obj = await env.TEAM_FILES.get(key);
		if (!obj) return json({ error: 'not found' }, 404);
		return new Response(obj.body, {
			headers: {
				'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
				'cache-control': 'public, max-age=86400',
			},
		});
	}

	if (p.startsWith('/team/v1/admin/')) {
		if (!isAdmin(req, env.ADMIN_KEY)) return json({ error: 'unauthorized' }, 401);
		if (!db) return json({ error: 'database not configured' }, 500);

		const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
		if (m === 'POST' && p === '/team/v1/admin/keys') {
			if (!b.owner) return json({ error: 'owner required' }, 400);
			return json(
				await createKey(db, String(b.owner), Number(b.credits) || 0),
				201,
			);
		}
		if (m === 'POST' && p === '/team/v1/admin/knowledge') {
			if (!env.TEAM_VEC) return json({ error: 'Vectorize not configured' }, 500);
			if (!b.id || !b.text) return json({ error: 'id and text required' }, 400);
			return json({
				chunks: await ingestKnowledge(
					env.AI,
					env.TEAM_VEC,
					gatewayId,
					String(b.id),
					String(b.text),
					String(b.source ?? b.id),
				),
			});
		}
		return json({ error: 'not found' }, 404);
	}

	if (!db) return json({ error: 'database not configured' }, 500);
	const key = await authKey(req, db);
	if (!key) return json({ error: 'unauthorized' }, 401);

	if (m === 'GET' && p === '/team/v1/agents') {
		return json(
			AGENTS.map(({ id, description, kind, chain, cost, tools }) => ({
				id,
				description,
				kind,
				models: chain,
				cost,
				tools: tools ?? [],
			})),
		);
	}
	if (m === 'GET' && p === '/team/v1/models') {
		return json({
			object: 'list',
			data: [
				{ id: 'masidy-team', object: 'model' },
				...AGENTS.filter((a) => a.kind === 'text').map((a) => ({
					id: `masidy-${a.id}`,
					object: 'model',
				})),
			],
		});
	}
	if (m === 'GET' && p === '/team/v1/balance') {
		return json({ credits: key.credits });
	}

	if (m === 'POST' && p === '/team/v1/billing/checkout') {
		const b = (await req.json().catch(() => ({}))) as { pack?: string };
		return checkout(env.STRIPE_SECRET_KEY, publicBaseUrl, key, String(b.pack ?? ''));
	}

	if (m === 'POST' && p === '/team/v1/run') {
		const b = (await req.json().catch(() => ({}))) as {
			prompt?: string;
			agent?: string;
		};
		if (!b.prompt || String(b.prompt).length > 20_000) {
			return json({ error: 'prompt required (max 20k chars)' }, 400);
		}
		if (b.agent && (!byId(b.agent) || b.agent === 'reviewer')) {
			return json({ error: `unknown agent: ${b.agent}` }, 400);
		}
		return json(await runTeam(env, ctx, key.id, String(b.prompt), requestId, b.agent));
	}

	if (m === 'POST' && p === '/team/v1/chat/completions') {
		const b = (await req.json().catch(() => ({}))) as {
			messages?: Array<{ role?: string; content?: string }>;
			model?: string;
		};
		const last = b.messages?.filter((x) => x.role === 'user').pop()?.content;
		if (typeof last !== 'string' || !last) {
			return json({ error: 'user message required' }, 400);
		}
		const model = String(b.model ?? 'masidy-team');
		const forced =
			model.startsWith('masidy-') && model !== 'masidy-team'
				? model.slice(7)
				: undefined;
		if (forced && (!byId(forced) || forced === 'reviewer')) {
			return json({ error: `unknown model: ${model}` }, 400);
		}
		const r = await runTeam(env, ctx, key.id, last, requestId, forced);
		const note = r.review
			? `\n\n---\nReview: ${r.review.passed ? 'PASS' : 'FAIL'}\n${r.review.notes}`
			: '';
		return json({
			id: requestId,
			object: 'chat.completion',
			model,
			choices: [
				{
					index: 0,
					finish_reason: 'stop',
					message: { role: 'assistant', content: r.final + note },
				},
			],
		});
	}

	if (m === 'POST' && p === '/team/v1/speech/transcribe') {
		await spend(db, key.id, SPEECH_COST);
		return json({ text: await transcribe(env, await req.arrayBuffer()) });
	}

	if (m === 'POST' && p === '/team/v1/speech/speak') {
		const b = (await req.json().catch(() => ({}))) as { text?: string; lang?: string };
		if (!b.text || String(b.text).length > 2000) {
			return json({ error: 'text required (max 2000 chars)' }, 400);
		}
		await spend(db, key.id, SPEECH_COST);
		return json({ url: await speak(env, String(b.text), b.lang ?? 'en') });
	}

	if (m === 'POST' && p === '/team/mcp') {
		const rpc = (await req.json().catch(() => null)) as {
			jsonrpc?: string;
			id?: string | number | null;
			method?: string;
			params?: { name?: string; arguments?: { prompt?: string; agent?: string } };
		} | null;
		if (!rpc) {
			return json(
				{
					jsonrpc: '2.0',
					error: { code: -32700, message: 'parse error' },
					id: null,
				},
				400,
			);
		}
		const ok = (result: unknown) => json({ jsonrpc: '2.0', id: rpc.id, result });

		if (rpc.method === 'initialize') {
			return ok({
				protocolVersion: '2025-03-26',
				capabilities: { tools: {} },
				serverInfo: { name: 'masidy-team', version: '1.0.0' },
			});
		}
		if (rpc.method?.startsWith('notifications/')) {
			return new Response(null, { status: 202 });
		}
		if (rpc.method === 'tools/list') {
			return ok({
				tools: [
					{
						name: 'ask_team',
						description:
							'Give a task to the whole team; it plans, dispatches and reviews.',
						inputSchema: {
							type: 'object',
							properties: { prompt: { type: 'string' } },
							required: ['prompt'],
						},
					},
					{
						name: 'ask_agent',
						description: `Call one specialist: ${AGENTS.filter((a) => a.id !== 'reviewer')
							.map((a) => a.id)
							.join(', ')}.`,
						inputSchema: {
							type: 'object',
							properties: {
								agent: { type: 'string' },
								prompt: { type: 'string' },
							},
							required: ['agent', 'prompt'],
						},
					},
				],
			});
		}
		if (rpc.method === 'tools/call') {
			const { name, arguments: a } = rpc.params ?? {};
			const forced = name === 'ask_agent' ? a?.agent : undefined;
			if (!a?.prompt || (forced && (!byId(forced) || forced === 'reviewer'))) {
				return json({
					jsonrpc: '2.0',
					id: rpc.id,
					error: { code: -32602, message: 'invalid arguments' },
				});
			}
			const r = await runTeam(env, ctx, key.id, String(a.prompt), requestId, forced);
			return ok({ content: [{ type: 'text', text: r.final }] });
		}
		return json({
			jsonrpc: '2.0',
			id: rpc.id,
			error: { code: -32601, message: 'method not found' },
		});
	}

	return json({ error: 'not found' }, 404);
}

/**
 * Team billing — API key auth, credit spending, Stripe checkout, webhook.
 */

import { json, sha256 } from './core';

export interface TeamKey {
	id: string;
	owner: string;
	credits: number;
}

export class OutOfCredits extends Error {
	constructor() {
		super('insufficient credits');
		this.name = 'OutOfCredits';
	}
}

export const PACKS = {
	starter: { credits: 500, cents: 500, name: '500 credits' },
	pro: { credits: 3000, cents: 2500, name: '3000 credits' },
} as const;

// ------------------------------------------------------------------ auth

export async function authKey(
	req: Request,
	db: D1Database,
): Promise<TeamKey | null> {
	const token = (req.headers.get('authorization') ?? '').replace(
		/^Bearer\s+/i,
		'',
	);
	if (!token) return null;
	return db
		.prepare(
			'SELECT id, owner, credits FROM team_keys WHERE hash = ?1 AND active = 1',
		)
		.bind(await sha256(token))
		.first<TeamKey>();
}

export const isAdmin = (req: Request, adminKey: string | undefined): boolean =>
	!!adminKey &&
	(req.headers.get('authorization') ?? '') === `Bearer ${adminKey}`;

// ------------------------------------------------------------------ key management

export async function createKey(
	db: D1Database,
	owner: string,
	credits: number,
): Promise<{ id: string; key: string; credits: number }> {
	const id = crypto.randomUUID();
	const raw =
		'mk_' +
		[...crypto.getRandomValues(new Uint8Array(24))]
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('');
	await db
		.prepare(
			'INSERT INTO team_keys (id, hash, owner, credits, created_at) VALUES (?1, ?2, ?3, ?4, ?5)',
		)
		.bind(id, await sha256(raw), owner, credits, Date.now())
		.run();
	return { id, key: raw, credits };
}

// ------------------------------------------------------------------ credits

export async function spend(
	db: D1Database,
	keyId: string,
	n: number,
): Promise<void> {
	const r = await db
		.prepare(
			'UPDATE team_keys SET credits = credits - ?1 WHERE id = ?2 AND credits >= ?1 AND active = 1',
		)
		.bind(n, keyId)
		.run();
	if (r.meta.changes !== 1) throw new OutOfCredits();
}

export const refund = (
	db: D1Database,
	keyId: string,
	n: number,
): Promise<D1Result> =>
	db
		.prepare('UPDATE team_keys SET credits = credits + ?1 WHERE id = ?2')
		.bind(n, keyId)
		.run();

export const logUsage = (
	db: D1Database,
	keyId: string,
	agent: string,
	model: string | null,
	cost: number,
	ms: number,
	ok: boolean,
): Promise<D1Result> =>
	db
		.prepare(
			'INSERT INTO team_usage (id, key_id, agent, model, cost, ms, ok, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)',
		)
		.bind(
			crypto.randomUUID(),
			keyId,
			agent,
			model,
			cost,
			ms,
			ok ? 1 : 0,
			Date.now(),
		)
		.run();

// ------------------------------------------------------------------ Stripe

export async function checkout(
	stripeSecretKey: string | undefined,
	publicBaseUrl: string,
	key: TeamKey,
	pack: string,
): Promise<Response> {
	if (!stripeSecretKey) {
		return json({ error: 'payments not configured' }, 501);
	}
	const p = PACKS[pack as keyof typeof PACKS];
	if (!p) {
		return json(
			{ error: `pack must be one of: ${Object.keys(PACKS).join(', ')}` },
			400,
		);
	}

	const form = new URLSearchParams({
		mode: 'payment',
		success_url: `${publicBaseUrl}/team/v1/billing/success`,
		cancel_url: `${publicBaseUrl}/team/v1/billing/cancel`,
		'line_items[0][quantity]': '1',
		'line_items[0][price_data][currency]': 'usd',
		'line_items[0][price_data][unit_amount]': String(p.cents),
		'line_items[0][price_data][product_data][name]': `Masidy team: ${p.name}`,
		'metadata[key_id]': key.id,
		'metadata[credits]': String(p.credits),
	});

	const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
		method: 'POST',
		headers: {
			authorization: `Bearer ${stripeSecretKey}`,
			'content-type': 'application/x-www-form-urlencoded',
		},
		body: form,
	});
	const data = (await res.json()) as {
		url?: string;
		error?: { message?: string };
	};
	if (!res.ok) {
		return json(
			{ error: 'stripe error', detail: data?.error?.message },
			502,
		);
	}
	return json({ url: data.url });
}

const timingSafeEqual = (a: string, b: string): boolean => {
	if (a.length !== b.length) return false;
	let d = 0;
	for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return d === 0;
};

async function verifyStripe(
	body: string,
	header: string,
	secret: string,
): Promise<boolean> {
	const parts = Object.fromEntries(
		header.split(',').map((p) => p.split('=') as [string, string]),
	);
	if (!parts.t || !parts.v1) return false;
	if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false;
	const enc = new TextEncoder();
	const k = await crypto.subtle.importKey(
		'raw',
		enc.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const mac = await crypto.subtle.sign(
		'HMAC',
		k,
		enc.encode(`${parts.t}.${body}`),
	);
	const hex = [...new Uint8Array(mac)]
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
	return timingSafeEqual(hex, parts.v1);
}

export async function stripeWebhook(
	req: Request,
	db: D1Database,
	webhookSecret: string | undefined,
): Promise<Response> {
	if (!webhookSecret) return json({ error: 'not configured' }, 501);
	const body = await req.text();
	const valid = await verifyStripe(
		body,
		req.headers.get('stripe-signature') ?? '',
		webhookSecret,
	);
	if (!valid) return json({ error: 'bad signature' }, 400);

	const event = JSON.parse(body) as {
		type: string;
		id: string;
		data?: {
			object?: {
				payment_status?: string;
				metadata?: { key_id?: string; credits?: string };
			};
		};
	};

	if (
		event.type === 'checkout.session.completed' &&
		event.data?.object?.payment_status === 'paid'
	) {
		const { key_id, credits } = event.data.object.metadata ?? {};
		const n = Number(credits);
		if (key_id && n > 0) {
			const ins = await db
				.prepare(
					'INSERT OR IGNORE INTO team_payments (event_id, key_id, credits, created_at) VALUES (?1,?2,?3,?4)',
				)
				.bind(event.id, key_id, n, Date.now())
				.run();
			if (ins.meta.changes === 1) {
				await db
					.prepare(
						'UPDATE team_keys SET credits = credits + ?1 WHERE id = ?2',
					)
					.bind(n, key_id)
					.run();
			}
		}
	}
	return json({ received: true });
}

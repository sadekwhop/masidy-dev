/**
 * Team core — shared types, helpers, and constants.
 */

export interface TeamEnv {
	AI: Ai;
	TEAM_DB?: D1Database;
	DB?: D1Database;
	TEAM_FILES?: R2Bucket;
	TEAM_VEC?: VectorizeIndex;
	GATEWAY_ID?: string;
	CLOUDFLARE_AI_GATEWAY?: string;
	PUBLIC_BASE_URL?: string;
	CUSTOM_DOMAIN?: string;
	ADMIN_KEY?: string;
	STRIPE_SECRET_KEY?: string;
	STRIPE_WEBHOOK_SECRET?: string;
	BRAVE_API_KEY?: string;
}

export type ToolName = 'fetch_url' | 'web_search' | 'search_knowledge';

export interface Agent {
	id: string;
	description: string;
	kind: 'text' | 'image';
	system?: string;
	chain: string[];
	tools?: ToolName[];
	timeoutMs: number;
	maxTokens: number;
	cost: number;     // credits per call
	review: boolean;  // output gate-checked by the reviewer agent
}

export interface AgentOut {
	output: string;
	model: string;
	usedFallback: boolean;
}

export const json = (d: unknown, status = 200): Response =>
	new Response(JSON.stringify(d), {
		status,
		headers: { 'content-type': 'application/json' },
	});

export const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
	Promise.race([
		p,
		new Promise<T>((_, rej) =>
			setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms),
		),
	]);

export const textOf = (o: unknown): string => {
	if (typeof o === 'string') return o;
	const any = o as Record<string, unknown>;
	if (typeof any?.response === 'string') return any.response;
	const choices = any?.choices as Array<{ message?: { content?: string } }> | undefined;
	if (choices?.[0]?.message?.content) return choices[0].message!.content!;
	return '';
};

export const sha256 = async (s: string): Promise<string> => {
	const bytes = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(s),
	);
	return [...new Uint8Array(bytes)]
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
};

export const b64ToBytes = (b: string): Uint8Array =>
	Uint8Array.from(atob(b), (c) => c.charCodeAt(0));

export const bytesToB64 = (bytes: Uint8Array): string => {
	let s = '';
	for (let i = 0; i < bytes.length; i += 0x8000) {
		s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(s);
};

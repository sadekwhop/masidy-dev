/**
 * Team tools — fetch_url, web_search, search_knowledge.
 * Accessed by agents that declare them in their `tools` array.
 */

import type { ToolName } from './core';

function safeUrl(raw: string): URL {
	const u = new URL(raw);
	const h = u.hostname.toLowerCase();
	if (u.protocol !== 'https:') throw new Error('https only');
	if (
		h === 'localhost' ||
		h.endsWith('.local') ||
		h.endsWith('.internal') ||
		h.startsWith('[') ||
		/^(\d{1,3}\.){3}\d{1,3}$/.test(h)
	) {
		throw new Error('host not allowed (private range)');
	}
	return u;
}

const htmlToText = (html: string): string =>
	html
		.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/\s+/g, ' ')
		.trim();

async function fetchUrl(args: { url: string }): Promise<string> {
	const u = safeUrl(args.url);
	const res = await fetch(u, {
		signal: AbortSignal.timeout(8000),
		headers: { 'user-agent': 'masidy-team/1.0' },
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const body = (await res.text()).slice(0, 400_000);
	const type = res.headers.get('content-type') ?? '';
	return (type.includes('html') ? htmlToText(body) : body).slice(0, 8000);
}

async function webSearch(
	braveApiKey: string | undefined,
	args: { query: string },
): Promise<string> {
	if (!braveApiKey) {
		return 'web_search is not configured (BRAVE_API_KEY missing).';
	}
	const res = await fetch(
		`https://api.search.brave.com/res/v1/web/search?count=5&q=${encodeURIComponent(args.query)}`,
		{
			signal: AbortSignal.timeout(8000),
			headers: {
				'x-subscription-token': braveApiKey,
				accept: 'application/json',
			},
		},
	);
	if (!res.ok) throw new Error(`search HTTP ${res.status}`);
	const data = (await res.json()) as {
		web?: { results?: Array<{ title: string; url: string; description?: string }> };
	};
	return (
		(data.web?.results ?? [])
			.slice(0, 5)
			.map((r) => `${r.title}\n${r.url}\n${r.description ?? ''}`)
			.join('\n\n') || 'No results.'
	);
}

async function searchKnowledge(
	ai: Ai,
	vec: VectorizeIndex,
	gatewayId: string,
	args: { query: string },
): Promise<string> {
	const emb = await ai.run(
		'@cf/baai/bge-base-en-v1.5' as Parameters<Ai['run']>[0],
		{ text: [args.query] } as Parameters<Ai['run']>[1],
		{ gateway: { id: gatewayId, metadata: { agent: 'team-embed' } } },
	) as { data: number[][] };
	const res = await vec.query(emb.data[0], { topK: 5, returnMetadata: 'all' });
	return (
		res.matches
			.map((m) => `[${(m.metadata as Record<string, string>)?.source ?? m.id}] ${(m.metadata as Record<string, string>)?.text ?? ''}`)
			.join('\n\n') || 'No matches found in knowledge base.'
	);
}

export async function runTool(
	ai: Ai,
	vec: VectorizeIndex | undefined,
	gatewayId: string,
	braveApiKey: string | undefined,
	name: ToolName,
	args: Record<string, string>,
): Promise<string> {
	if (name === 'fetch_url') return fetchUrl(args as { url: string });
	if (name === 'web_search') return webSearch(braveApiKey, args as { query: string });
	if (name === 'search_knowledge') {
		if (!vec) return 'search_knowledge is not configured (Vectorize binding missing).';
		return searchKnowledge(ai, vec, gatewayId, args as { query: string });
	}
	throw new Error(`unknown tool: ${name}`);
}

export async function ingestKnowledge(
	ai: Ai,
	vec: VectorizeIndex,
	gatewayId: string,
	id: string,
	text: string,
	source: string,
): Promise<number> {
	const chunks = (text.match(/[\s\S]{1,1000}/g) ?? []).slice(0, 100);
	if (!chunks.length) return 0;
	const emb = await ai.run(
		'@cf/baai/bge-base-en-v1.5' as Parameters<Ai['run']>[0],
		{ text: chunks } as Parameters<Ai['run']>[1],
		{ gateway: { id: gatewayId, metadata: { agent: 'team-embed' } } },
	) as { data: number[][] };
	await vec.upsert(
		chunks.map((c, i) => ({
			id: `${id}:${i}`,
			values: emb.data[i],
			metadata: { text: c, source },
		})),
	);
	return chunks.length;
}

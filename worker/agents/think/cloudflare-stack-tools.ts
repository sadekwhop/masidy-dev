import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { tool } from 'ai';
import { z } from 'zod';

const CLOUDFLARE_STACK_URL =
	'https://stack.mcp.cloudflare.com/mcp?libs=cloudflare,cloudflare-api,cloudflare-blog,cloudflare-community,vite,vitest,astro,opennext,replicate,hono';

const ALLOWED_READ_ONLY_TOOLS = new Set(['list_libraries', 'search_dev_stack']);

async function callCloudflareStackTool(
	name: string,
	args: Record<string, unknown> = {},
): Promise<unknown> {
	const client = new Client({ name: 'masidy-think', version: '1.0.0' });
	const transport = new StreamableHTTPClientTransport(new URL(CLOUDFLARE_STACK_URL), {
		requestInit: { signal: AbortSignal.timeout(20_000) },
	});

	try {
		await client.connect(transport);
		const catalog = await client.listTools();
		const requestedTool = catalog.tools.find((candidate) => candidate.name === name);
		if (!requestedTool || !ALLOWED_READ_ONLY_TOOLS.has(name) || !requestedTool.annotations?.readOnlyHint) {
			throw new Error(`Cloudflare Developer Stack tool is unavailable or not approved for read-only use: ${name}`);
		}
		return await client.callTool({ name, arguments: args });
	} finally {
		await client.close();
	}
}

export function createCloudflareStackTools() {
	return {
		cloudflare_stack_search: tool({
			description:
				'Search current Cloudflare and supported web-framework documentation through the Cloudflare Developer Stack MCP. Search before implementing Cloudflare APIs or the included frameworks, and cite source URLs from the results.',
			inputSchema: z.object({
				query: z.string().min(1).max(1000),
				library: z
					.enum([
						'cloudflare',
						'cloudflare-api',
						'cloudflare-blog',
						'cloudflare-community',
						'vite',
						'vitest',
						'astro',
						'opennext',
						'replicate',
						'hono',
					])
					.optional(),
			}),
			execute: async ({ query, library }) =>
				JSON.stringify(
					await callCloudflareStackTool('search_dev_stack', {
						query,
						...(library ? { library } : {}),
					}),
				),
		}),
		cloudflare_stack_libraries: tool({
			description: 'List documentation libraries currently indexed by the Cloudflare Developer Stack MCP.',
			inputSchema: z.object({}),
			execute: async () => JSON.stringify(await callCloudflareStackTool('list_libraries')),
		}),
	};
}

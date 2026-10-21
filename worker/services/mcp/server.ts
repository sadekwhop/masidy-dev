import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { AppService } from '../../database/services/AppService';

function createMasidyMcpServer(env: Env): McpServer {
	const server = new McpServer({
		name: 'masidy',
		version: '1.0.0',
	});
	const appService = new AppService(env);

	server.registerTool(
		'list_public_apps',
		{
			description: 'List recently updated public Masidy apps. Only public summary fields are returned.',
			inputSchema: {
				limit: z.number().int().min(1).max(20).optional(),
			},
		},
		async ({ limit = 10 }) => {
			const result = await appService.getPublicApps({
				limit,
				offset: 0,
				sort: 'recent',
				order: 'desc',
			});
			const apps = result.data.map((app) => ({
				id: app.id,
				title: app.title,
				description: app.description,
				framework: app.framework,
				updatedAt: app.updatedAt,
				starCount: app.starCount,
				viewCount: app.viewCount,
			}));

			return { content: [{ type: 'text', text: JSON.stringify(apps) }] };
		},
	);

	server.registerTool(
		'get_public_app_summary',
		{
			description: 'Get the public summary of a Masidy app. Private apps are not disclosed.',
			inputSchema: {
				app_id: z.string().min(1).max(128),
			},
		},
		async ({ app_id }) => {
			const app = await appService.getAppDetails(app_id);
			if (!app || app.visibility !== 'public') {
				return { content: [{ type: 'text', text: 'Public app not found.' }], isError: true };
			}

			const summary = {
				id: app.id,
				title: app.title,
				description: app.description,
				framework: app.framework,
				status: app.status,
				screenshotUrl: app.screenshotUrl,
				createdAt: app.createdAt,
				updatedAt: app.updatedAt,
				starCount: app.starCount,
				viewCount: app.viewCount,
			};
			return { content: [{ type: 'text', text: JSON.stringify(summary) }] };
		},
	);

	return server;
}

export async function handleMasidyMcpRequest(request: Request, env: Env): Promise<Response> {
	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true,
	});
	const server = createMasidyMcpServer(env);
	await server.connect(transport);
	return transport.handleRequest(request);
}

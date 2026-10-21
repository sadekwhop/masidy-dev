import { Hono } from 'hono';
import { createLogger } from '../../logger';
import { handleMasidyMcpRequest } from '../../services/mcp/server';
import {
	parseCloudflareAccessConfig,
	verifyCloudflareAccessJwt,
} from '../../services/mcp/cloudflareAccess';
import type { AppEnv } from '../../types/appenv';

const logger = createLogger('MasidyMcp');

export function setupMcpRoutes(app: Hono<AppEnv>): void {
	app.all('/mcp', async (c) => {
		const accessConfig = parseCloudflareAccessConfig(
			c.env.CF_ACCESS_TEAM_DOMAIN,
			c.env.CF_ACCESS_AUD,
		);
		if (!accessConfig) {
			return c.json({ error: 'MCP authentication is not configured.' }, 503);
		}

		const accessJwt = c.req.header('Cf-Access-Jwt-Assertion');
		if (!accessJwt || !(await verifyCloudflareAccessJwt(accessJwt, accessConfig))) {
			return c.json({ error: 'Cloudflare Access authentication is required.' }, 401, {
				'WWW-Authenticate': 'Bearer',
			});
		}

		if (!['GET', 'POST', 'DELETE'].includes(c.req.method)) {
			return c.text('Method not allowed', 405, { Allow: 'GET, POST, DELETE' });
		}

		try {
			return await handleMasidyMcpRequest(c.req.raw, c.env);
		} catch (error) {
			logger.error('MCP request failed', error);
			return c.json({ error: 'MCP request failed.' }, 500);
		}
	});
}

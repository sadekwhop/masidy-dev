import { Hono } from 'hono';
import { Mppx, tempo } from 'mppx/hono';
import { handleMasidyMcpRequest } from '../../services/mcp/server';
import { createLogger } from '../../logger';
import type { AppEnv } from '../../types/appenv';

const logger = createLogger('MasidyMcp');

// USDC on Base mainnet
const USDC_BASE_MAINNET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

// Price per MCP tool call in USDC.
// Set to $0.02 — well above per-call infra cost (~$0.0006 gas), giving ~97% gross margin.
// Adjust here to change pricing; redeploy to take effect.
const PRICE_PER_CALL = '0.02';

export function setupMcpRoutes(app: Hono<AppEnv>): void {
	app.all('/mcp', async (c) => {
		if (!['GET', 'POST', 'DELETE'].includes(c.req.method)) {
			return c.text('Method not allowed', 405, { Allow: 'GET, POST, DELETE' });
		}

		// Require both secrets to be configured before accepting any requests.
		if (!c.env.MPP_SECRET_KEY || !c.env.MASIDY_WALLET) {
			logger.error('MCP payment not configured: MPP_SECRET_KEY or MASIDY_WALLET missing');
			return c.json({ error: 'MCP payment is not configured.' }, 503);
		}

		const mppx = Mppx.create({
			methods: [tempo.charge()],
			secretKey: c.env.MPP_SECRET_KEY,
		});

		// Charge per call. Returns a 402 challenge to the agent when unpaid;
		// passes through to the MCP handler once payment is verified.
		const chargeMiddleware = mppx.charge({
			amount: PRICE_PER_CALL,
			currency: USDC_BASE_MAINNET,
			description: 'masidy MCP tool call',
			recipient: c.env.MASIDY_WALLET,
		});

		// Run the charge middleware inline, then hand off to the MCP handler.
		// mppx/hono middleware returns a Response directly on 402; otherwise
		// it calls next() and we proceed to handleMasidyMcpRequest.
		let paymentPassed = false;
		await chargeMiddleware(c, async () => {
			paymentPassed = true;
		});

		if (!paymentPassed) {
			// mppx already wrote the 402 response to the context
			return c.res;
		}

		try {
			return await handleMasidyMcpRequest(c.req.raw, c.env);
		} catch (error) {
			logger.error('MCP request failed', error);
			return c.json({ error: 'MCP request failed.' }, 500);
		}
	});
}

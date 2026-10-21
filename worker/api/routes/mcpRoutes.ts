import { Hono, type MiddlewareHandler } from 'hono';
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

/**
 * Hono middleware that charges per MCP tool call via mppx.
 * Created per-request because secretKey comes from c.env bindings.
 */
function chargePerCall(): MiddlewareHandler<AppEnv> {
	return async (c, next) => {
		if (!c.env.MPP_SECRET_KEY || !c.env.MASIDY_WALLET) {
			logger.error('MCP payment not configured: MPP_SECRET_KEY or MASIDY_WALLET missing');
			return c.json({ error: 'MCP payment is not configured.' }, 503);
		}

		const mppx = Mppx.create({
			methods: [tempo.charge()],
			secretKey: c.env.MPP_SECRET_KEY,
		});

		// Delegate to mppx/hono middleware: returns 402 challenge when unpaid,
		// calls next() when payment is verified.
		return mppx.charge({
			amount: PRICE_PER_CALL,
			currency: USDC_BASE_MAINNET,
			description: 'masidy MCP tool call',
			recipient: c.env.MASIDY_WALLET,
		})(c, next);
	};
}

export function setupMcpRoutes(app: Hono<AppEnv>): void {
	// POST: payment required (actual tool calls)
	app.post('/mcp', chargePerCall(), async (c) => {
		try {
			return await handleMasidyMcpRequest(c.req.raw, c.env);
		} catch (error) {
			logger.error('MCP request failed', error);
			return c.json({ error: 'MCP request failed.' }, 500);
		}
	});

	// GET/DELETE: no payment (MCP session setup/teardown)
	app.get('/mcp', async (c) => {
		try {
			return await handleMasidyMcpRequest(c.req.raw, c.env);
		} catch (error) {
			logger.error('MCP request failed', error);
			return c.json({ error: 'MCP request failed.' }, 500);
		}
	});

	app.delete('/mcp', async (c) => {
		try {
			return await handleMasidyMcpRequest(c.req.raw, c.env);
		} catch (error) {
			logger.error('MCP request failed', error);
			return c.json({ error: 'MCP request failed.' }, 500);
		}
	});

	// Reject any other methods
	app.all('/mcp', (c) =>
		c.text('Method not allowed', 405, { Allow: 'GET, POST, DELETE' }),
	);
}

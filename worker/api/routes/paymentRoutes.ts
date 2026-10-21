/**
 * Payment Routes
 * Routes for USDC payments and credit management
 */

import { Hono } from 'hono';
import { AppEnv } from '../../types/appenv';
import { adaptController } from '../honoAdapter';
import { AuthConfig, setAuthLevel } from '../../middleware/auth/routeAuth';
import { PaymentsController } from '../controllers/payments/controller';

export function setupPaymentRoutes(app: Hono<AppEnv>): void {
	// Get platform wallet address for payment
	app.get(
		'/api/payments/wallet',
		setAuthLevel(AuthConfig.authenticated),
		adaptController(PaymentsController, PaymentsController.getWallet),
	);

	// Get current credit balance
	app.get(
		'/api/payments/balance',
		setAuthLevel(AuthConfig.authenticated),
		adaptController(PaymentsController, PaymentsController.getBalance),
	);

	// Verify a USDC payment and credit the user
	app.post(
		'/api/payments/verify',
		setAuthLevel(AuthConfig.authenticated),
		adaptController(PaymentsController, PaymentsController.verifyPayment),
	);

	// Get payment history (deposits)
	app.get(
		'/api/payments/history',
		setAuthLevel(AuthConfig.authenticated),
		adaptController(PaymentsController, PaymentsController.getHistory),
	);

	// Get usage history (credit deductions)
	app.get(
		'/api/payments/usage',
		setAuthLevel(AuthConfig.authenticated),
		adaptController(PaymentsController, PaymentsController.getUsage),
	);
}

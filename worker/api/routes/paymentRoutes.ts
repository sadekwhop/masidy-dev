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

	// Get linked blockchain wallets (Anti-sniping)
	app.get(
		'/api/payments/wallets',
		setAuthLevel(AuthConfig.authenticated),
		adaptController(PaymentsController, PaymentsController.getWallets),
	);

	// Get a single-use nonce for wallet linking
	app.post(
		'/api/payments/wallets/nonce',
		setAuthLevel(AuthConfig.authenticated),
		adaptController(PaymentsController, PaymentsController.createWalletNonce),
	);

	// Link a blockchain wallet with signature verification
	app.post(
		'/api/payments/wallets/link',
		setAuthLevel(AuthConfig.authenticated),
		adaptController(PaymentsController, PaymentsController.linkWallet),
	);

	// Unlink a blockchain wallet
	app.delete(
		'/api/payments/wallets/:address',
		setAuthLevel(AuthConfig.authenticated),
		adaptController(PaymentsController, PaymentsController.unlinkWallet),
	);

	// Stripe checkout session creation (Card / Apple Pay)
	app.post(
		'/api/payments/stripe/checkout',
		setAuthLevel(AuthConfig.authenticated),
		adaptController(PaymentsController, PaymentsController.createStripeCheckout),
	);

	// Stripe webhook receiver (Public, verified via stripe-signature)
	app.post(
		'/api/payments/stripe/webhook',
		setAuthLevel(AuthConfig.public),
		adaptController(PaymentsController, PaymentsController.handleStripeWebhook),
	);
}

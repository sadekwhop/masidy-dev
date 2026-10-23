/**
 * Payments Controller
 * API endpoints for USDC payments and credit management
 */

import { BaseController } from '../baseController';
import { RouteContext } from '../../types/route-context';
import { PaymentService } from '../../../database/services/PaymentService';
import { verifyUsdcPayment } from '../../../services/payments/PaymentVerificationService';
import { verifyStripeWebhookSignature } from '../../../services/payments/stripeUtils';
import { verifyMessage, type Address } from 'viem';
import { createLogger } from '../../../logger';
import type {
	PaymentWalletData,
	PaymentBalanceData,
	VerifyPaymentRequest,
	VerifyPaymentData,
	PaymentHistoryData,
	UsageHistoryData,
	UserWalletsData,
	LinkWalletRequest,
	LinkWalletData,
	StripeCheckoutRequest,
	StripeCheckoutData,
	WalletNonceData,
} from './types';

export class PaymentsController extends BaseController {
	static logger = createLogger('PaymentsController');

	// USDC on Base mainnet
	private static readonly USDC_CONTRACT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
	private static readonly CHAIN_ID = 8453;

	/**
	 * GET /api/payments/wallet
	 * Returns the platform wallet address so the frontend can display it / generate QR.
	 */
	static async getWallet(
		_request: Request,
		env: Env,
		_ctx: ExecutionContext,
		context: RouteContext,
	): Promise<Response> {
		if (!context.user) {
			return PaymentsController.createErrorResponse('Authentication required', 401);
		}

		if (!env.MASIDY_WALLET) {
			return PaymentsController.createErrorResponse('Payment not configured', 503);
		}

		return PaymentsController.createSuccessResponse<PaymentWalletData>({
			walletAddress: env.MASIDY_WALLET,
			chainId: this.CHAIN_ID,
			chainName: 'Base',
			usdcContract: this.USDC_CONTRACT,
		});
	}

	/**
	 * GET /api/payments/balance
	 * Returns the user's current credit balance and totals.
	 */
	static async getBalance(
		_request: Request,
		env: Env,
		_ctx: ExecutionContext,
		context: RouteContext,
	): Promise<Response> {
		if (!context.user) {
			return PaymentsController.createErrorResponse('Authentication required', 401);
		}

		const paymentService = new PaymentService(env);
		const summary = await paymentService.getCreditSummary(context.user.id);

		return PaymentsController.createSuccessResponse<PaymentBalanceData>(summary);
	}

	/**
	 * POST /api/payments/verify
	 * Verifies a USDC payment on-chain and credits the user's balance.
	 * Enforces wallet binding to prevent public mempool/BaseScan hash sniping.
	 */
	static async verifyPayment(
		request: Request,
		env: Env,
		_ctx: ExecutionContext,
		context: RouteContext,
	): Promise<Response> {
		if (!context.user) {
			return PaymentsController.createErrorResponse('Authentication required', 401);
		}

		if (!env.MASIDY_WALLET) {
			return PaymentsController.createErrorResponse('Payment not configured', 503);
		}

		const bodyResult = await PaymentsController.parseJsonBody<VerifyPaymentRequest>(request);
		if (!bodyResult.success || !bodyResult.data) {
			return bodyResult.response ?? PaymentsController.createErrorResponse('Invalid request body', 400);
		}

		const { txHash } = bodyResult.data;
		if (!txHash || !txHash.startsWith('0x')) {
			return PaymentsController.createErrorResponse('Invalid transaction hash', 400);
		}

		const paymentService = new PaymentService(env);

		// Prevent double-claiming the same tx
		const alreadyClaimed = await paymentService.isTxHashClaimed(txHash);
		if (alreadyClaimed) {
			return PaymentsController.createErrorResponse('This transaction has already been claimed', 409);
		}

		// Verify on-chain with confirmation check
		const verified = await verifyUsdcPayment(txHash, env.MASIDY_WALLET, env.BASE_RPC_URL);
		if (!verified) {
			return PaymentsController.createErrorResponse(
				'Payment verification failed. Ensure the transaction is a confirmed USDC transfer to the platform wallet on Base mainnet.',
				422,
			);
		}

		// Security: Prevent Hash Sniping
		// Ensure that the Transfer event's 'from' address matches one of the user's linked wallets
		const userWallets = await paymentService.getUserWallets(context.user.id);
		const senderAddress = verified.from.toLowerCase();
		const isLinked = userWallets.some((w) => w.address.toLowerCase() === senderAddress);

		if (!isLinked) {
			return PaymentsController.createErrorResponse(
				`This payment was sent from ${verified.from}. To claim these credits, please link this wallet to your Masidy account first.`,
				403,
			);
		}

		// Beta rule: check per-user maximum deposit cap if configured via env
		const rawMaxCap = env.MAX_USER_DEPOSIT_USD;
		const maxDepositCap = rawMaxCap ? Number(rawMaxCap) : undefined;
		if (maxDepositCap !== undefined && Number.isFinite(maxDepositCap) && maxDepositCap > 0) {
			const summary = await paymentService.getCreditSummary(context.user.id);
			if (summary.totalDeposited + verified.amountUsdc > maxDepositCap) {
				return PaymentsController.createErrorResponse(
					`Beta limit: Maximum deposit cap of $${maxDepositCap} reached for this account. Current total deposits: $${summary.totalDeposited.toFixed(2)}.`,
					400,
				);
			}
		}

		// Credit the user
		const newBalance = await paymentService.addCredits(
			context.user.id,
			verified.amountUsdc,
			txHash,
		);

		return PaymentsController.createSuccessResponse<VerifyPaymentData>({
			success: true,
			amountUsdc: verified.amountUsdc,
			creditsAdded: verified.amountUsdc,
			newBalance,
			txHash,
		});
	}

	/**
	 * GET /api/payments/history
	 * Returns the user's payment (deposit) history.
	 */
	static async getHistory(
		_request: Request,
		env: Env,
		_ctx: ExecutionContext,
		context: RouteContext,
	): Promise<Response> {
		if (!context.user) {
			return PaymentsController.createErrorResponse('Authentication required', 401);
		}

		const paymentService = new PaymentService(env);
		const payments = await paymentService.getPaymentHistory(context.user.id);

		return PaymentsController.createSuccessResponse<PaymentHistoryData>({
			payments: payments.map((p) => ({
				id: p.id,
				txHash: p.txHash,
				amountUsdc: p.amountUsdc,
				creditsAdded: p.creditsAdded,
				status: p.status,
				createdAt: p.createdAt,
				verifiedAt: p.verifiedAt,
			})),
		});
	}

	/**
	 * GET /api/payments/usage
	 * Returns the user's usage transactions (credit deductions) with aggregation.
	 */
	static async getUsage(
		_request: Request,
		env: Env,
		_ctx: ExecutionContext,
		context: RouteContext,
	): Promise<Response> {
		if (!context.user) {
			return PaymentsController.createErrorResponse('Authentication required', 401);
		}

		const paymentService = new PaymentService(env);
		const [transactions, byAction] = await Promise.all([
			paymentService.getUsageHistory(context.user.id),
			paymentService.getUsageByAction(context.user.id),
		]);

		const totalSpent = byAction.reduce((sum, a) => sum + a.totalCharged, 0);

		return PaymentsController.createSuccessResponse<UsageHistoryData>({
			transactions: transactions.map((t) => ({
				id: t.id,
				action: t.action,
				actualCost: t.actualCost,
				chargedCost: t.chargedCost,
				creditsBefore: t.creditsBefore,
				creditsAfter: t.creditsAfter,
				createdAt: t.createdAt,
			})),
			byAction,
			totalSpent,
		});
	}

	/**
	 * GET /api/payments/wallets
	 * Returns the user's linked blockchain wallets.
	 */
	static async getWallets(
		_request: Request,
		env: Env,
		_ctx: ExecutionContext,
		context: RouteContext,
	): Promise<Response> {
		if (!context.user) {
			return PaymentsController.createErrorResponse('Authentication required', 401);
		}

		const paymentService = new PaymentService(env);
		const wallets = await paymentService.getUserWallets(context.user.id);

		return PaymentsController.createSuccessResponse<UserWalletsData>({
			wallets: wallets.map((w) => ({
				id: w.id,
				address: w.address,
				createdAt: w.createdAt,
			})),
		});
	}

	/**
	 * POST /api/payments/wallets/nonce
	 * Issues a one-time challenge nonce for linking a wallet to the user's account.
	 */
	static async createWalletNonce(
		_request: Request,
		env: Env,
		_ctx: ExecutionContext,
		context: RouteContext,
	): Promise<Response> {
		if (!context.user) {
			return PaymentsController.createErrorResponse('Authentication required', 401);
		}

		const paymentService = new PaymentService(env);
		const nonce = await paymentService.createWalletNonce(context.user.id);

		return PaymentsController.createSuccessResponse<WalletNonceData>({
			nonce,
			expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
		});
	}

	/**
	 * POST /api/payments/wallets/link
	 * Links an Ethereum/Base wallet address to the user account by verifying an EIP-191 signature.
	 * Requires a strict message template with domain, wallet address, user ID, single-use nonce, and timestamp.
	 */
	static async linkWallet(
		request: Request,
		env: Env,
		_ctx: ExecutionContext,
		context: RouteContext,
	): Promise<Response> {
		if (!context.user) {
			return PaymentsController.createErrorResponse('Authentication required', 401);
		}

		const bodyResult = await PaymentsController.parseJsonBody<LinkWalletRequest>(request);
		if (!bodyResult.success || !bodyResult.data) {
			return bodyResult.response ?? PaymentsController.createErrorResponse('Invalid request body', 400);
		}

		const { address, message, signature } = bodyResult.data;
		if (!address || !address.startsWith('0x') || address.length !== 42) {
			return PaymentsController.createErrorResponse('Invalid wallet address format', 400);
		}
		if (!message || !signature || !signature.startsWith('0x')) {
			return PaymentsController.createErrorResponse('Message and signature are required', 400);
		}

		// Security: enforce strict message template format:
		// "Masidy (masidy.dev): Link wallet <address> to account <userId> with nonce <nonce> at <timestamp>"
		const TEMPLATE_REGEX =
			/^Masidy \(masidy\.dev\): Link wallet (0x[a-fA-F0-9]{40}) to account ([a-zA-Z0-9_-]+) with nonce ([a-zA-Z0-9_-]+) at (\d{10,13})$/;
		const match = message.trim().match(TEMPLATE_REGEX);
		if (!match) {
			return PaymentsController.createErrorResponse(
				'Invalid verification message format. Expected: "Masidy (masidy.dev): Link wallet <address> to account <userId> with nonce <nonce> at <timestamp>"',
				400,
			);
		}

		const [, msgAddress, msgUserId, msgNonce, msgTimestamp] = match;

		// Security: verify address and user match
		if (msgAddress.toLowerCase() !== address.toLowerCase()) {
			return PaymentsController.createErrorResponse('Message wallet address does not match request address', 400);
		}
		if (msgUserId !== context.user.id) {
			return PaymentsController.createErrorResponse('Verification message is not bound to this user account', 400);
		}

		// Security: verify mandatory timestamp to prevent replay attacks (within 5 minutes)
		const msgTime = Number(msgTimestamp);
		const timeMs = msgTime < 1e11 ? msgTime * 1000 : msgTime;
		if (Math.abs(Date.now() - timeMs) > 300_000) {
			return PaymentsController.createErrorResponse('Verification message has expired. Please sign a new message.', 400);
		}

		// Security: verify single-use server nonce
		const paymentService = new PaymentService(env);
		const validNonce = await paymentService.consumeWalletNonce(context.user.id, msgNonce);
		if (!validNonce) {
			return PaymentsController.createErrorResponse('Invalid or expired verification nonce. Please request a new nonce.', 400);
		}

		// Security: verify EIP-191 signature using viem
		try {
			const isValid = await verifyMessage({
				address: address as Address,
				message,
				signature: signature as `0x${string}`,
			});
			if (!isValid) {
				return PaymentsController.createErrorResponse('Invalid wallet signature', 401);
			}
		} catch (err: unknown) {
			PaymentsController.logger.warn('Failed to verify wallet signature', err);
			return PaymentsController.createErrorResponse('Signature verification failed', 400);
		}

		const normalizedAddress = address.toLowerCase();

		// Check if already linked to another user
		const existingOwner = await paymentService.getWalletOwner(normalizedAddress);
		if (existingOwner && existingOwner !== context.user.id) {
			return PaymentsController.createErrorResponse('This wallet address is already linked to another Masidy account', 409);
		}

		if (existingOwner === context.user.id) {
			return PaymentsController.createSuccessResponse<LinkWalletData>({
				success: true,
				wallet: {
					id: 'existing',
					address: normalizedAddress,
					createdAt: new Date(),
				},
			});
		}

		const linked = await paymentService.linkWallet(context.user.id, normalizedAddress);

		return PaymentsController.createSuccessResponse<LinkWalletData>({
			success: true,
			wallet: {
				id: linked.id,
				address: linked.address,
				createdAt: linked.createdAt,
			},
		});
	}

	/**
	 * DELETE /api/payments/wallets/:address
	 * Unlinks a wallet address from the user's account.
	 */
	static async unlinkWallet(
		_request: Request,
		env: Env,
		_ctx: ExecutionContext,
		context: RouteContext,
	): Promise<Response> {
		if (!context.user) {
			return PaymentsController.createErrorResponse('Authentication required', 401);
		}

		const address = context.pathParams?.address;
		if (!address || typeof address !== 'string') {
			return PaymentsController.createErrorResponse('Wallet address required', 400);
		}

		const paymentService = new PaymentService(env);
		await paymentService.unlinkWallet(context.user.id, address);

		return PaymentsController.createSuccessResponse<{ success: boolean }>({ success: true });
	}

	/**
	 * POST /api/payments/stripe/checkout
	 * Creates a Stripe Checkout session for purchasing credits via card or Apple Pay.
	 */
	static async createStripeCheckout(
		request: Request,
		env: Env,
		_ctx: ExecutionContext,
		context: RouteContext,
	): Promise<Response> {
		if (!context.user) {
			return PaymentsController.createErrorResponse('Authentication required', 401);
		}

		if (!env.STRIPE_SECRET_KEY) {
			return PaymentsController.createErrorResponse('Stripe card payments not configured', 503);
		}

		const bodyResult = await PaymentsController.parseJsonBody<StripeCheckoutRequest>(request);
		if (!bodyResult.success || !bodyResult.data) {
			return bodyResult.response ?? PaymentsController.createErrorResponse('Invalid request body', 400);
		}

		const { amountUsd } = bodyResult.data;
		const allowedAmounts = [10, 25, 50, 100];
		if (!amountUsd || !allowedAmounts.includes(amountUsd)) {
			return PaymentsController.createErrorResponse(
				`Select a valid credit pack: $${allowedAmounts.join(', $')}`,
				400,
			);
		}

		// Beta rule: check per-user maximum deposit cap if configured via env
		const rawMaxCap = env.MAX_USER_DEPOSIT_USD;
		const maxDepositCap = rawMaxCap ? Number(rawMaxCap) : undefined;
		if (maxDepositCap !== undefined && Number.isFinite(maxDepositCap) && maxDepositCap > 0) {
			const paymentService = new PaymentService(env);
			const summary = await paymentService.getCreditSummary(context.user.id);
			if (summary.totalDeposited + amountUsd > maxDepositCap) {
				return PaymentsController.createErrorResponse(
					`Beta limit: Maximum deposit cap of $${maxDepositCap} reached for this account. Current total deposits: $${summary.totalDeposited.toFixed(2)}.`,
					400,
				);
			}
		}

		const url = new URL(request.url);
		const origin = `${url.protocol}//${url.host}`;
		const amountCents = amountUsd * 100;

		const form = new URLSearchParams({
			mode: 'payment',
			success_url: `${origin}/settings#billing?payment=success&session_id={CHECKOUT_SESSION_ID}`,
			cancel_url: `${origin}/settings#billing?payment=cancelled`,
			'line_items[0][quantity]': '1',
			'line_items[0][price_data][currency]': 'usd',
			'line_items[0][price_data][unit_amount]': String(amountCents),
			'line_items[0][price_data][product_data][name]': `Masidy Platform Credits ($${amountUsd})`,
			'line_items[0][price_data][product_data][description]': `${amountUsd} credits for AI generation, builds, and hosting`,
			'metadata[user_id]': context.user.id,
			'metadata[credits]': String(amountUsd),
			'payment_intent_data[metadata][user_id]': context.user.id,
			'payment_intent_data[metadata][credits]': String(amountUsd),
		});

		try {
			const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
				method: 'POST',
				headers: {
					authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
					'content-type': 'application/x-www-form-urlencoded',
				},
				body: form,
			});

			const data = (await res.json()) as {
				url?: string;
				error?: { message?: string };
			};

			if (!res.ok || !data.url) {
				PaymentsController.logger.error('Stripe session creation failed', data?.error);
				return PaymentsController.createErrorResponse(
					data?.error?.message || 'Failed to initialize Stripe checkout',
					502,
				);
			}

			return PaymentsController.createSuccessResponse<StripeCheckoutData>({
				url: data.url,
			});
		} catch (err: unknown) {
			PaymentsController.logger.error('Stripe checkout error', err);
			return PaymentsController.createErrorResponse('Failed to initialize checkout', 500);
		}
	}

	/**
	 * POST /api/payments/stripe/webhook
	 * Handles Stripe webhook notifications for completed card/Apple Pay payments.
	 */
	static async handleStripeWebhook(
		request: Request,
		env: Env,
		_ctx: ExecutionContext,
		_context: RouteContext,
	): Promise<Response> {
		if (!env.STRIPE_WEBHOOK_SECRET) {
			return new Response('Stripe webhook not configured', { status: 501 });
		}

		const signature = request.headers.get('stripe-signature');
		if (!signature) {
			return new Response('Missing stripe-signature header', { status: 400 });
		}

		const body = await request.text();
		const valid = await verifyStripeWebhookSignature(body, signature, env.STRIPE_WEBHOOK_SECRET);
		if (!valid) {
			PaymentsController.logger.warn('Invalid Stripe signature in webhook');
			return new Response('Invalid signature', { status: 400 });
		}

		let event: {
			type: string;
			data?: {
				object?: {
					id?: string;
					currency?: string;
					payment_status?: string;
					amount_total?: number;
					metadata?: { user_id?: string; credits?: string; session_id?: string };
					payment_intent?: string | { id?: string };
					charge?: string;
					amount_refunded?: number;
					status?: string;
				};
			};
		};
		try {
			event = JSON.parse(body);
		} catch {
			return new Response('Invalid JSON payload', { status: 400 });
		}

		// Handle completed payment sessions (both instant and async methods)
		const isCheckoutSuccess =
			(event.type === 'checkout.session.completed' && event.data?.object?.payment_status === 'paid') ||
			event.type === 'checkout.session.async_payment_succeeded';

		if (isCheckoutSuccess && event.data?.object) {
			const session = event.data.object;
			const { user_id, credits } = session.metadata ?? {};

			// Security: verify currency is USD
			if (session.currency && session.currency.toLowerCase() !== 'usd') {
				PaymentsController.logger.warn(`Unexpected currency ${session.currency} in session ${session.id}`);
				return new Response(JSON.stringify({ received: true, error: 'invalid currency' }), { status: 200 });
			}

			// Security: derive credit amount from amount_total (cents to dollars) to ensure user is credited what was paid
			const amountTotalDollars = (session.amount_total ?? 0) / 100;
			const creditsAmount = amountTotalDollars > 0 ? amountTotalDollars : Number(credits);

			if (!user_id) {
				PaymentsController.logger.error(
					`CRITICAL: Stripe checkout session ${session.id} succeeded but user_id is missing in metadata! Customer paid $${amountTotalDollars} but credits could not be assigned.`,
					{ sessionId: session.id, metadata: session.metadata, amountTotal: session.amount_total },
				);
				return new Response(JSON.stringify({ received: true, error: 'missing user_id' }), { status: 200 });
			}

			if (creditsAmount > 0 && session.id) {
				const paymentService = new PaymentService(env);
				const paymentIntentId =
					typeof session.payment_intent === 'string'
						? session.payment_intent
						: (session.payment_intent as { id?: string } | undefined)?.id;

				try {
					await paymentService.addStripeCredits(
						user_id,
						creditsAmount,
						session.id,
						paymentIntentId,
					);
					PaymentsController.logger.info(`Credited $${creditsAmount} to user ${user_id} from Stripe session ${session.id} (PI: ${paymentIntentId ?? 'none'})`);
				} catch (err: unknown) {
					PaymentsController.logger.error('Failed to add Stripe credits', err);
					return new Response(JSON.stringify({ received: true, duplicate: true }), { status: 200 });
				}
			}
		}

		// Handle refunds
		if (event.type === 'charge.refunded') {
			const charge = event.data?.object;
			const paymentIntent =
				typeof charge?.payment_intent === 'string'
					? charge.payment_intent
					: (charge?.payment_intent as { id?: string } | undefined)?.id;
			const identifier = paymentIntent || charge?.metadata?.session_id || charge?.id;
			const amountRefundedDollars = charge?.amount_refunded ? charge.amount_refunded / 100 : undefined;

			if (identifier) {
				const paymentService = new PaymentService(env);
				await paymentService.refundStripeCredits(identifier, amountRefundedDollars);
				PaymentsController.logger.info(`Processed refund for payment: ${identifier}, amount: $${amountRefundedDollars ?? 'full'}`);
			} else {
				PaymentsController.logger.warn('Received charge.refunded event but could not determine payment identifier', charge);
			}
		}

		// Handle dispute creation (clawback)
		if (event.type === 'charge.dispute.created') {
			const dispute = event.data?.object;
			const paymentIntent =
				typeof dispute?.payment_intent === 'string'
					? dispute.payment_intent
					: (dispute?.payment_intent as { id?: string } | undefined)?.id;
			const identifier = paymentIntent || dispute?.charge;
			if (identifier) {
				const paymentService = new PaymentService(env);
				await paymentService.markPaymentDisputed(identifier);
				PaymentsController.logger.warn(`Marked payment disputed for: ${identifier}`);
			} else {
				PaymentsController.logger.warn('Received charge.dispute.created event but could not determine payment identifier', dispute);
			}
		}

		// Handle dispute resolution (charge.dispute.closed)
		if (event.type === 'charge.dispute.closed') {
			const dispute = event.data?.object;
			const paymentIntent =
				typeof dispute?.payment_intent === 'string'
					? dispute.payment_intent
					: (dispute?.payment_intent as { id?: string } | undefined)?.id;
			const identifier = paymentIntent || dispute?.charge;
			const disputeStatus = dispute?.status;
			if (identifier && disputeStatus) {
				const paymentService = new PaymentService(env);
				await paymentService.resolvePaymentDispute(identifier, disputeStatus);
				PaymentsController.logger.info(`Resolved dispute for payment ${identifier}: status=${disputeStatus}`);
			} else {
				PaymentsController.logger.warn('Received charge.dispute.closed event but could not determine identifier or status', dispute);
			}
		}

		return new Response(JSON.stringify({ received: true }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	}
}

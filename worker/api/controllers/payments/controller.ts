/**
 * Payments Controller
 * API endpoints for USDC payments and credit management
 */

import { BaseController } from '../baseController';
import { RouteContext } from '../../types/route-context';
import { PaymentService } from '../../../database/services/PaymentService';
import { verifyUsdcPayment } from '../../../services/payments/PaymentVerificationService';
import { createLogger } from '../../../logger';
import type {
	PaymentWalletData,
	PaymentBalanceData,
	VerifyPaymentRequest,
	VerifyPaymentData,
	PaymentHistoryData,
	UsageHistoryData,
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

		// Verify on-chain
		const verified = await verifyUsdcPayment(txHash, env.MASIDY_WALLET);
		if (!verified) {
			return PaymentsController.createErrorResponse(
				'Payment verification failed. Ensure the transaction is a confirmed USDC transfer to the platform wallet on Base mainnet.',
				422,
			);
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
}

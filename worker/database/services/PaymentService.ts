/**
 * Payment Service - Database operations for USDC payments and credits
 */

import { BaseService } from './BaseService';
import * as schema from '../schema';
import { eq, desc, sql, and, or, gt, ne } from 'drizzle-orm';
import { generateId } from '../../utils/idGenerator';

export class PaymentService extends BaseService {
	// ========================================
	// CREDITS
	// ========================================

	/**
	 * Get a user's current credit balance. Returns 0 if no row exists.
	 */
	async getBalance(userId: string): Promise<number> {
		const row = await this.db.db
			.select()
			.from(schema.userCredits)
			.where(eq(schema.userCredits.userId, userId))
			.get();
		return row?.balance ?? 0;
	}

	/**
	 * Get full credit summary (balance, total deposited, total used).
	 */
	async getCreditSummary(userId: string): Promise<{
		balance: number;
		totalDeposited: number;
		totalUsed: number;
	}> {
		const row = await this.db.db
			.select()
			.from(schema.userCredits)
			.where(eq(schema.userCredits.userId, userId))
			.get();
		return {
			balance: row?.balance ?? 0,
			totalDeposited: row?.totalDeposited ?? 0,
			totalUsed: row?.totalUsed ?? 0,
		};
	}

	/**
	 * Atomically add credits to a user's balance after a verified payment.
	 * Creates the row if it doesn't exist. Idempotent on txHash via the
	 * unique index on user_payments.tx_hash — caller should check first.
	 */
	async addCredits(userId: string, amountUsdc: number, txHash: string): Promise<number> {
		return this.db.db.transaction(async (tx) => {
			// Insert payment record
			await tx.insert(schema.userPayments).values({
				id: generateId(),
				userId,
				txHash,
				amountUsdc,
				creditsAdded: amountUsdc,
				status: 'verified',
				verifiedAt: new Date(),
			});

			// Upsert credit balance
			const existing = await tx
				.select()
				.from(schema.userCredits)
				.where(eq(schema.userCredits.userId, userId))
				.get();

			if (existing) {
				const newBalance = existing.balance + amountUsdc;
				await tx
					.update(schema.userCredits)
					.set({
						balance: newBalance,
						totalDeposited: existing.totalDeposited + amountUsdc,
						updatedAt: new Date(),
					})
					.where(eq(schema.userCredits.userId, userId));
				return newBalance;
			}

			await tx.insert(schema.userCredits).values({
				userId,
				balance: amountUsdc,
				totalDeposited: amountUsdc,
				totalUsed: 0,
				updatedAt: new Date(),
			});
			return amountUsdc;
		});
	}

	/**
	 * Atomically add credits from a verified Stripe checkout session.
	 * Idempotent on sessionId (stored as txHash) and stores paymentIntentId.
	 * Gracefully handles duplicate webhooks without throwing.
	 */
	async addStripeCredits(
		userId: string,
		amountUsd: number,
		sessionId: string,
		paymentIntentId?: string,
	): Promise<number> {
		return this.db.db.transaction(async (tx) => {
			const existingPayment = await tx
				.select()
				.from(schema.userPayments)
				.where(eq(schema.userPayments.txHash, sessionId))
				.get();

			if (existingPayment) {
				if (paymentIntentId && !existingPayment.paymentIntentId) {
					await tx
						.update(schema.userPayments)
						.set({ paymentIntentId })
						.where(eq(schema.userPayments.id, existingPayment.id));
				}
				const existingCredit = await tx
					.select()
					.from(schema.userCredits)
					.where(eq(schema.userCredits.userId, userId))
					.get();
				return existingCredit?.balance ?? 0;
			}

			// Insert payment record (safely handling duplicate key race condition)
			try {
				await tx.insert(schema.userPayments).values({
					id: generateId(),
					userId,
					txHash: sessionId,
					paymentIntentId: paymentIntentId ?? null,
					amountUsdc: amountUsd,
					creditsAdded: amountUsd,
					status: 'verified',
					chainId: 0, // Fiat / card
					verifiedAt: new Date(),
				});
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				if (msg.includes('UNIQUE constraint failed') || msg.includes('constraint')) {
					const existingCredit = await tx
						.select()
						.from(schema.userCredits)
						.where(eq(schema.userCredits.userId, userId))
						.get();
					return existingCredit?.balance ?? 0;
				}
				throw err;
			}

			// Upsert credit balance
			const existing = await tx
				.select()
				.from(schema.userCredits)
				.where(eq(schema.userCredits.userId, userId))
				.get();

			if (existing) {
				const newBalance = existing.balance + amountUsd;
				await tx
					.update(schema.userCredits)
					.set({
						balance: newBalance,
						totalDeposited: existing.totalDeposited + amountUsd,
						updatedAt: new Date(),
					})
					.where(eq(schema.userCredits.userId, userId));
				return newBalance;
			}

			await tx.insert(schema.userCredits).values({
				userId,
				balance: amountUsd,
				totalDeposited: amountUsd,
				totalUsed: 0,
				updatedAt: new Date(),
			});
			return amountUsd;
		});
	}

	/**
	 * Handle a Stripe charge refund.
	 * Matches by paymentIntentId or sessionId/txHash.
	 * Supports partial and incremental refunds safely.
	 * cumulativeRefundAmountUsd is the cumulative refunded amount from Stripe (charge.amount_refunded).
	 * Deducts only the newly refunded delta from user balance, preventing double-deduction.
	 */
	async refundStripeCredits(
		identifier: string,
		cumulativeRefundAmountUsd?: number,
	): Promise<{ success: boolean; deltaRefunded: number }> {
		return this.db.db.transaction(async (tx) => {
			const payment = await tx
				.select()
				.from(schema.userPayments)
				.where(
					or(
						eq(schema.userPayments.paymentIntentId, identifier),
						eq(schema.userPayments.txHash, identifier),
					),
				)
				.get();

			if (!payment) {
				return { success: false, deltaRefunded: 0 };
			}

			const alreadyRefunded = payment.amountRefunded ?? 0;
			const alreadyDisputed = payment.amountDisputed ?? 0;

			const targetCumulative =
				cumulativeRefundAmountUsd !== undefined && cumulativeRefundAmountUsd > 0
					? Math.min(cumulativeRefundAmountUsd, payment.creditsAdded)
					: payment.creditsAdded;

			// How much newly refunded amount has Stripe reported beyond what was already recorded as refunded?
			const incrementalRefund = Math.max(0, targetCumulative - alreadyRefunded);
			if (incrementalRefund <= 0) {
				return { success: true, deltaRefunded: 0 };
			}

			// If part of this incremental refund was already clawed back via dispute,
			// transfer that portion from amountDisputed to amountRefunded without deducting from user balance again.
			const offsetFromDispute = Math.min(incrementalRefund, alreadyDisputed);
			const deltaToDeduct = incrementalRefund - offsetFromDispute;

			const newAmountRefunded = targetCumulative;
			const newAmountDisputed = alreadyDisputed - offsetFromDispute;

			const isFullRefund = newAmountRefunded >= payment.creditsAdded;

			// Update payment record with new cumulative refunded amount and reduced disputed amount
			await tx
				.update(schema.userPayments)
				.set({
					amountRefunded: newAmountRefunded,
					amountDisputed: newAmountDisputed,
					...(isFullRefund ? { status: 'refunded' as const } : {}),
				})
				.where(eq(schema.userPayments.id, payment.id));

			if (deltaToDeduct > 0) {
				// Deduct delta from user balance (allows negative balance to block builds)
				const credit = await tx
					.select()
					.from(schema.userCredits)
					.where(eq(schema.userCredits.userId, payment.userId))
					.get();

				if (credit) {
					const newBalance = credit.balance - deltaToDeduct;
					await tx
						.update(schema.userCredits)
						.set({
							balance: newBalance,
							totalDeposited: Math.max(0, credit.totalDeposited - deltaToDeduct),
							updatedAt: new Date(),
						})
						.where(eq(schema.userCredits.userId, payment.userId));
				}
			}

			return { success: true, deltaRefunded: deltaToDeduct };
		});
	}

	/**
	 * Mark a payment as disputed and deduct/freeze disputed credits from user balance.
	 * If credits were already spent, the balance becomes negative, freezing builds until resolved.
	 */
	async markPaymentDisputed(
		identifier: string,
		disputeAmountUsd?: number,
	): Promise<{ success: boolean; disputedAmount: number }> {
		return this.db.db.transaction(async (tx) => {
			const payment = await tx
				.select()
				.from(schema.userPayments)
				.where(
					or(
						eq(schema.userPayments.paymentIntentId, identifier),
						eq(schema.userPayments.txHash, identifier),
					),
				)
				.get();

			if (!payment || payment.status === 'disputed') {
				return { success: false, disputedAmount: 0 };
			}

			// Amount to deduct for dispute (defaults to remaining unrefunded and undisputed credits)
			const totalAlreadyDeducted = (payment.amountRefunded ?? 0) + (payment.amountDisputed ?? 0);
			const unrefundedCredits = Math.max(0, payment.creditsAdded - totalAlreadyDeducted);
			const deductAmount =
				disputeAmountUsd !== undefined && disputeAmountUsd > 0
					? Math.min(disputeAmountUsd, unrefundedCredits)
					: unrefundedCredits;

			await tx
				.update(schema.userPayments)
				.set({
					status: 'disputed',
					amountDisputed: (payment.amountDisputed ?? 0) + deductAmount,
				})
				.where(eq(schema.userPayments.id, payment.id));

			// Suspend user account while dispute is active
			await tx
				.update(schema.users)
				.set({
					isSuspended: true,
					updatedAt: new Date(),
				})
				.where(eq(schema.users.id, payment.userId));

			if (deductAmount > 0) {
				const credit = await tx
					.select()
					.from(schema.userCredits)
					.where(eq(schema.userCredits.userId, payment.userId))
					.get();

				if (credit) {
					const newBalance = credit.balance - deductAmount;
					await tx
						.update(schema.userCredits)
						.set({
							balance: newBalance,
							totalDeposited: Math.max(0, credit.totalDeposited - deductAmount),
							updatedAt: new Date(),
						})
						.where(eq(schema.userCredits.userId, payment.userId));
				}
			}

			return { success: true, disputedAmount: deductAmount };
		});
	}

	/**
	 * Handle resolution of a Stripe dispute (charge.dispute.closed).
	 * If won: restores the clawed-back credits (amountDisputed) to the user's balance and unsuspends account.
	 * If lost: leaves the clawback permanent, retains 'disputed' status, and keeps account suspended.
	 */
	async resolvePaymentDispute(
		identifier: string,
		disputeStatus: string,
	): Promise<{ success: boolean; restoredAmount: number }> {
		return this.db.db.transaction(async (tx) => {
			const payment = await tx
				.select()
				.from(schema.userPayments)
				.where(
					or(
						eq(schema.userPayments.paymentIntentId, identifier),
						eq(schema.userPayments.txHash, identifier),
					),
				)
				.get();

			if (!payment) {
				return { success: false, restoredAmount: 0 };
			}

			if (disputeStatus === 'won') {
				const amountToRestore = payment.amountDisputed ?? 0;
				const isFullRefund = (payment.amountRefunded ?? 0) >= payment.creditsAdded;

				// Reset amountDisputed and restore status to verified or refunded
				await tx
					.update(schema.userPayments)
					.set({
						amountDisputed: 0,
						status: isFullRefund ? 'refunded' : 'verified',
					})
					.where(eq(schema.userPayments.id, payment.id));

				if (amountToRestore > 0) {
					const credit = await tx
						.select()
						.from(schema.userCredits)
						.where(eq(schema.userCredits.userId, payment.userId))
						.get();

					if (credit) {
						await tx
							.update(schema.userCredits)
							.set({
								balance: credit.balance + amountToRestore,
								totalDeposited: credit.totalDeposited + amountToRestore,
								updatedAt: new Date(),
							})
							.where(eq(schema.userCredits.userId, payment.userId));
					}
				}

				// Check if user has any other remaining active disputes
				const otherDisputed = await tx
					.select({ id: schema.userPayments.id })
					.from(schema.userPayments)
					.where(
						and(
							eq(schema.userPayments.userId, payment.userId),
							eq(schema.userPayments.status, 'disputed'),
							ne(schema.userPayments.id, payment.id),
						),
					)
					.get();

				if (!otherDisputed) {
					await tx
						.update(schema.users)
						.set({
							isSuspended: false,
							updatedAt: new Date(),
						})
						.where(eq(schema.users.id, payment.userId));
				}

				return { success: true, restoredAmount: amountToRestore };
			} else {
				// Dispute lost: the clawback remains permanent and account remains suspended
				return { success: true, restoredAmount: 0 };
			}
		});
	}

	/**
	 * Check if a tx hash has already been claimed (prevents double-credit).
	 */
	async isTxHashClaimed(txHash: string): Promise<boolean> {
		const row = await this.db.db
			.select({ id: schema.userPayments.id })
			.from(schema.userPayments)
			.where(eq(schema.userPayments.txHash, txHash))
			.get();
		return !!row;
	}

	// ========================================
	// WALLETS (Anti-Sniping & Nonces)
	// ========================================

	/**
	 * Generate and store a single-use nonce for wallet linking (valid for 10 minutes).
	 */
	async createWalletNonce(userId: string): Promise<string> {
		const nonce = crypto.randomUUID().replace(/-/g, '');
		const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

		await this.db.db.insert(schema.walletNonces).values({
			id: generateId(),
			userId,
			nonce,
			expiresAt,
		});

		return nonce;
	}

	/**
	 * Atomically consume and invalidate a wallet linking nonce in a single operation.
	 * Uses DELETE ... RETURNING to ensure exactly one concurrent request can consume the nonce,
	 * preventing race conditions / double-use. Returns true only if a valid, unexpired nonce was deleted.
	 */
	async consumeWalletNonce(userId: string, nonce: string): Promise<boolean> {
		const now = new Date();
		const deleted = await this.db.db
			.delete(schema.walletNonces)
			.where(
				and(
					eq(schema.walletNonces.userId, userId),
					eq(schema.walletNonces.nonce, nonce),
					gt(schema.walletNonces.expiresAt, now),
				),
			)
			.returning({ id: schema.walletNonces.id })
			.get();

		return !!deleted;
	}

	async getUserWallets(userId: string): Promise<schema.UserWallet[]> {
		return this.db.db
			.select()
			.from(schema.userWallets)
			.where(eq(schema.userWallets.userId, userId))
			.orderBy(desc(schema.userWallets.createdAt));
	}

	async linkWallet(userId: string, address: string): Promise<schema.UserWallet> {
		const normalized = address.toLowerCase();
		const wallet: schema.NewUserWallet = {
			id: generateId(),
			userId,
			address: normalized,
		};
		await this.db.db.insert(schema.userWallets).values(wallet);
		return wallet as schema.UserWallet;
	}

	async unlinkWallet(userId: string, address: string): Promise<boolean> {
		const normalized = address.toLowerCase();
		await this.db.db
			.delete(schema.userWallets)
			.where(
				and(
					eq(schema.userWallets.userId, userId),
					eq(schema.userWallets.address, normalized),
				),
			);
		return true;
	}

	async getWalletOwner(address: string): Promise<string | null> {
		const normalized = address.toLowerCase();
		const row = await this.db.db
			.select({ userId: schema.userWallets.userId })
			.from(schema.userWallets)
			.where(eq(schema.userWallets.address, normalized))
			.get();
		return row?.userId ?? null;
	}

	// ========================================
	// USAGE DEDUCTION
	// ========================================

	/**
	 * Atomically deduct credits for a usage action.
	 * Executes a single atomic SQL UPDATE with condition `balance >= chargedCost RETURNING balance`.
	 * This prevents race conditions under concurrent requests: only requests with sufficient balance
	 * at the instant of execution succeed; concurrent requests cannot overdraft or double-spend.
	 * Returns the new balance or null if insufficient credits.
	 */
	async deductCredits(
		userId: string,
		action: string,
		actualCost: number,
		chargedCost: number,
		metadata?: Record<string, unknown>,
	): Promise<{ balance: number; success: boolean } | null> {
		return this.db.db.transaction(async (tx) => {
			const updated = await tx
				.update(schema.userCredits)
				.set({
					balance: sql`${schema.userCredits.balance} - ${chargedCost}`,
					totalUsed: sql`${schema.userCredits.totalUsed} + ${chargedCost}`,
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(schema.userCredits.userId, userId),
						sql`${schema.userCredits.balance} >= ${chargedCost}`,
					),
				)
				.returning({
					balance: schema.userCredits.balance,
				})
				.get();

			if (!updated) {
				return null;
			}

			const newBalance = updated.balance;
			const previousBalance = newBalance + chargedCost;

			await tx.insert(schema.usageTransactions).values({
				id: generateId(),
				userId,
				action,
				actualCost,
				chargedCost,
				creditsBefore: previousBalance,
				creditsAfter: newBalance,
				metadata: metadata ? JSON.stringify(metadata) : null,
			});

			return { balance: newBalance, success: true };
		});
	}

	// ========================================
	// HISTORY
	// ========================================

	/**
	 * Get payment history (deposits) for a user.
	 */
	async getPaymentHistory(userId: string, limit = 50): Promise<schema.UserPayment[]> {
		return this.db.db
			.select()
			.from(schema.userPayments)
			.where(eq(schema.userPayments.userId, userId))
			.orderBy(desc(schema.userPayments.createdAt))
			.limit(limit);
	}

	/**
	 * Get usage transactions (credit deductions) for a user.
	 */
	async getUsageHistory(userId: string, limit = 50): Promise<schema.UsageTransaction[]> {
		return this.db.db
			.select()
			.from(schema.usageTransactions)
			.where(eq(schema.usageTransactions.userId, userId))
			.orderBy(desc(schema.usageTransactions.createdAt))
			.limit(limit);
	}

	/**
	 * Get aggregated usage by action type.
	 */
	async getUsageByAction(userId: string): Promise<
		Array<{ action: string; totalCharged: number; totalActual: number; count: number }>
	> {
		const result = await this.db.db
			.select({
				action: schema.usageTransactions.action,
				totalCharged: sql<number>`sum(${schema.usageTransactions.chargedCost})`,
				totalActual: sql<number>`sum(${schema.usageTransactions.actualCost})`,
				count: sql<number>`count(*)`,
			})
			.from(schema.usageTransactions)
			.where(eq(schema.usageTransactions.userId, userId))
			.groupBy(schema.usageTransactions.action);
		return result;
	}
}

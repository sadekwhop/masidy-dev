/**
 * Payment Service - Database operations for USDC payments and credits
 */

import { BaseService } from './BaseService';
import * as schema from '../schema';
import { eq, desc, sql } from 'drizzle-orm';
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
	// USAGE DEDUCTION
	// ========================================

	/**
	 * Atomically deduct credits for a usage action. 2x markup is applied
	 * by the caller (chargedCost = actualCost * 2). Returns the new balance
	 * or null if insufficient credits.
	 */
	async deductCredits(
		userId: string,
		action: string,
		actualCost: number,
		chargedCost: number,
		metadata?: Record<string, unknown>,
	): Promise<{ balance: number; success: boolean } | null> {
		return this.db.db.transaction(async (tx) => {
			const credit = await tx
				.select()
				.from(schema.userCredits)
				.where(eq(schema.userCredits.userId, userId))
				.get();

			if (!credit || credit.balance < chargedCost) {
				return null;
			}

			const newBalance = credit.balance - chargedCost;
			await tx
				.update(schema.userCredits)
				.set({
					balance: newBalance,
					totalUsed: credit.totalUsed + chargedCost,
					updatedAt: new Date(),
				})
				.where(eq(schema.userCredits.userId, userId));

			await tx.insert(schema.usageTransactions).values({
				id: generateId(),
				userId,
				action,
				actualCost,
				chargedCost,
				creditsBefore: credit.balance,
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

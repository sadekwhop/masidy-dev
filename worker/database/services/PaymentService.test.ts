import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PaymentService } from './PaymentService';
import * as schema from '../schema';

describe('PaymentService Unit Tests', () => {
	let paymentService: PaymentService;
	let userPaymentsTable: Array<{
		id: string;
		userId: string;
		txHash: string;
		paymentIntentId: string | null;
		amountUsdc: number;
		creditsAdded: number;
		amountRefunded: number;
		amountDisputed: number;
		status: string;
	}>;
	let userCreditsTable: Array<{
		userId: string;
		balance: number;
		totalDeposited: number;
		totalUsed: number;
	}>;
	let usersTable: Array<{
		id: string;
		isSuspended: boolean;
	}>;
	let walletNoncesTable: Array<{
		id: string;
		userId: string;
		nonce: string;
		expiresAt: Date;
	}>;
	let usageTransactionsTable: Array<{
		id: string;
		userId: string;
		action: string;
		actualCost: number;
		chargedCost: number;
		creditsBefore: number;
		creditsAfter: number;
	}>;

	beforeEach(() => {
		userPaymentsTable = [];
		userCreditsTable = [];
		usersTable = [];
		walletNoncesTable = [];
		usageTransactionsTable = [];

		// Create mock db that simulates Drizzle transactions on in-memory state
		const mockDb = {
			transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
				let currentTable: unknown = null;
				const tx = {
					select: (fields?: unknown) => ({
						from: (tableObj: unknown) => {
							currentTable = tableObj;
							return {
								where: (_whereClause: unknown) => ({
									get: async () => {
										if (currentTable === schema.userPayments) {
											if (fields) {
												// otherDisputed check: returns other disputed payments (excluding current)
												return (
													userPaymentsTable.find(
														(p) =>
															p.status === 'disputed' &&
															p.id !== userPaymentsTable[0]?.id,
													) ?? null
												);
											}
											return userPaymentsTable[0] ?? null;
										}
										if (currentTable === schema.userCredits) {
											return userCreditsTable[0] ?? null;
										}
										if (currentTable === schema.users) {
											return usersTable[0] ?? null;
										}
										return null;
									},
								}),
							};
						},
					}),
					insert: (tableObj: unknown) => ({
						values: async (values: Record<string, unknown>) => {
							if (tableObj === schema.userPayments) {
								userPaymentsTable.push(values as unknown as typeof userPaymentsTable[0]);
							} else if (tableObj === schema.userCredits) {
								userCreditsTable.push(values as unknown as typeof userCreditsTable[0]);
							} else if (tableObj === schema.usageTransactions) {
								usageTransactionsTable.push(values as unknown as typeof usageTransactionsTable[0]);
							} else if (tableObj === schema.users) {
								usersTable.push(values as unknown as typeof usersTable[0]);
							}
							return values;
						},
					}),
					update: (tableObj: unknown) => ({
						set: (setValues: Record<string, unknown>) => ({
							where: (_whereClause: unknown) => {
								const applyUpdate = () => {
									if (tableObj === schema.userPayments) {
										const payment = userPaymentsTable[0];
										if (payment) Object.assign(payment, setValues);
									} else if (tableObj === schema.userCredits) {
										const credit = userCreditsTable[0];
										if (credit) Object.assign(credit, setValues);
									} else if (tableObj === schema.users) {
										const user = usersTable[0];
										if (user) Object.assign(user, setValues);
									}
									return true;
								};
								return {
									returning: () => ({
										get: async () => {
											if (tableObj === schema.userCredits) {
												const credit = userCreditsTable[0];
												if (!credit) return null;
												const chargedCost = 10;
												if (credit.balance >= chargedCost) {
													credit.balance -= chargedCost;
													credit.totalUsed += chargedCost;
													return { balance: credit.balance };
												}
												return null;
											}
											return null;
										},
									}),
									then: (resolve: (val: unknown) => void) => {
										resolve(applyUpdate());
									},
								};
							},
						}),
					}),
				};
				return fn(tx);
			},
			delete: (_tableObj: unknown) => ({
				where: (_whereClause: unknown) => ({
					returning: (_returningObj: unknown) => ({
						get: async () => {
							const index = walletNoncesTable.findIndex((n) => n.expiresAt > new Date());
							if (index !== -1) {
								const [removed] = walletNoncesTable.splice(index, 1);
								return { id: removed.id };
							}
							return null;
						},
					}),
				}),
			}),
		};

		paymentService = Object.create(PaymentService.prototype);
		Object.assign(paymentService, {
			db: { db: mockDb },
			logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
		});
	});

	it('refundStripeCredits correctly handles two sequential partial refunds without double-deduction', async () => {
		userPaymentsTable.push({
			id: 'p1',
			userId: 'user-1',
			txHash: 'cs_123',
			paymentIntentId: 'pi_123',
			amountUsdc: 50,
			creditsAdded: 50,
			amountRefunded: 0,
			amountDisputed: 0,
			status: 'verified',
		});
		userCreditsTable.push({
			userId: 'user-1',
			balance: 50,
			totalDeposited: 50,
			totalUsed: 0,
		});

		// 1st partial refund: Stripe sends cumulative amount_refunded = $10.00
		const res1 = await paymentService.refundStripeCredits('pi_123', 10);
		expect(res1.success).toBe(true);
		expect(res1.deltaRefunded).toBe(10);
		expect(userPaymentsTable[0].amountRefunded).toBe(10);
		expect(userCreditsTable[0].balance).toBe(40); // 50 - 10 = 40

		// 2nd partial refund: Stripe sends cumulative amount_refunded = $25.00 ($10 + $15)
		const res2 = await paymentService.refundStripeCredits('pi_123', 25);
		expect(res2.success).toBe(true);
		expect(res2.deltaRefunded).toBe(15); // Delta is 25 - 10 = 15
		expect(userPaymentsTable[0].amountRefunded).toBe(25);
		expect(userCreditsTable[0].balance).toBe(25); // 40 - 15 = 25 (Total refunded = 25!)

		// 3rd duplicate event: Stripe re-sends cumulative amount_refunded = $25.00
		const resDup = await paymentService.refundStripeCredits('pi_123', 25);
		expect(resDup.success).toBe(true);
		expect(resDup.deltaRefunded).toBe(0); // Idempotent 0-delta
		expect(userCreditsTable[0].balance).toBe(25); // Balance unchanged!
	});

	it('Case 1: Dispute $50, then refund $50 -> balance drops by $50 total, once', async () => {
		userPaymentsTable.push({
			id: 'p_case1',
			userId: 'user-c1',
			txHash: 'cs_case1',
			paymentIntentId: 'pi_case1',
			amountUsdc: 50,
			creditsAdded: 50,
			amountRefunded: 0,
			amountDisputed: 0,
			status: 'verified',
		});
		userCreditsTable.push({
			userId: 'user-c1',
			balance: 50,
			totalDeposited: 50,
			totalUsed: 0,
		});

		// Step 1: Dispute $50 arrives
		const disputeRes = await paymentService.markPaymentDisputed('pi_case1', 50);
		expect(disputeRes.success).toBe(true);
		expect(disputeRes.disputedAmount).toBe(50);
		expect(userPaymentsTable[0].amountDisputed).toBe(50);
		expect(userPaymentsTable[0].status).toBe('disputed');
		expect(userCreditsTable[0].balance).toBe(0); // 50 - 50 = 0

		// Step 2: Refund $50 subsequently arrives
		const refundRes = await paymentService.refundStripeCredits('pi_case1', 50);
		expect(refundRes.success).toBe(true);
		expect(refundRes.deltaRefunded).toBe(0); // Delta is 0 because $50 was already deducted via dispute!
		expect(userCreditsTable[0].balance).toBe(0); // Balance drops by $50 once, NOT $100!
		expect(userPaymentsTable[0].amountRefunded).toBe(50);
		expect(userPaymentsTable[0].amountDisputed).toBe(0); // Shifted from disputed to refunded
		expect(userPaymentsTable[0].status).toBe('refunded');
	});

	it('Case 2: Dispute $50, win it, then refund $50 -> balance drops by $50 total, not $0 or $100', async () => {
		userPaymentsTable.push({
			id: 'p_case2',
			userId: 'user-c2',
			txHash: 'cs_case2',
			paymentIntentId: 'pi_case2',
			amountUsdc: 50,
			creditsAdded: 50,
			amountRefunded: 0,
			amountDisputed: 0,
			status: 'verified',
		});
		userCreditsTable.push({
			userId: 'user-c2',
			balance: 50,
			totalDeposited: 50,
			totalUsed: 0,
		});

		// Step 1: Dispute $50 arrives
		await paymentService.markPaymentDisputed('pi_case2', 50);
		expect(userCreditsTable[0].balance).toBe(0);
		expect(userPaymentsTable[0].amountDisputed).toBe(50);

		// Step 2: We win the dispute! (charge.dispute.closed: won)
		const resolveRes = await paymentService.resolvePaymentDispute('pi_case2', 'won');
		expect(resolveRes.success).toBe(true);
		expect(resolveRes.restoredAmount).toBe(50);
		expect(userPaymentsTable[0].amountDisputed).toBe(0);
		expect(userPaymentsTable[0].status).toBe('verified');
		expect(userCreditsTable[0].balance).toBe(50); // Restored to $50

		// Step 3: Refund $50 arrives
		const refundRes = await paymentService.refundStripeCredits('pi_case2', 50);
		expect(refundRes.success).toBe(true);
		expect(refundRes.deltaRefunded).toBe(50); // Now deducts the $50 refund
		expect(userCreditsTable[0].balance).toBe(0); // Total drop is $50, not $0 or $100!
		expect(userPaymentsTable[0].amountRefunded).toBe(50);
		expect(userPaymentsTable[0].status).toBe('refunded');
	});

	it('Case 3: Refund $20, then dispute the same charge -> only the remaining $30 is clawed back', async () => {
		userPaymentsTable.push({
			id: 'p_case3',
			userId: 'user-c3',
			txHash: 'cs_case3',
			paymentIntentId: 'pi_case3',
			amountUsdc: 50,
			creditsAdded: 50,
			amountRefunded: 0,
			amountDisputed: 0,
			status: 'verified',
		});
		userCreditsTable.push({
			userId: 'user-c3',
			balance: 50,
			totalDeposited: 50,
			totalUsed: 0,
		});

		// Step 1: Partial refund $20 arrives
		const refundRes = await paymentService.refundStripeCredits('pi_case3', 20);
		expect(refundRes.success).toBe(true);
		expect(refundRes.deltaRefunded).toBe(20);
		expect(userCreditsTable[0].balance).toBe(30); // 50 - 20 = 30
		expect(userPaymentsTable[0].amountRefunded).toBe(20);

		// Step 2: Dispute arrives for the charge (customer disputes full amount or remaining)
		const disputeRes = await paymentService.markPaymentDisputed('pi_case3', 50);
		expect(disputeRes.success).toBe(true);
		expect(disputeRes.disputedAmount).toBe(30); // ONLY remaining $30 is clawed back!
		expect(userCreditsTable[0].balance).toBe(0); // 30 - 30 = 0
		expect(userPaymentsTable[0].amountDisputed).toBe(30);
		expect(userPaymentsTable[0].status).toBe('disputed');
	});

	it('Case 4: Dispute $50, refund $20, then win the dispute -> only restores remaining $30, final balance reflects $20 refund', async () => {
		userPaymentsTable.push({
			id: 'p_case4',
			userId: 'user-c4',
			txHash: 'cs_case4',
			paymentIntentId: 'pi_case4',
			amountUsdc: 50,
			creditsAdded: 50,
			amountRefunded: 0,
			amountDisputed: 0,
			status: 'verified',
		});
		userCreditsTable.push({
			userId: 'user-c4',
			balance: 50,
			totalDeposited: 50,
			totalUsed: 0,
		});
		usersTable.push({
			id: 'user-c4',
			isSuspended: false,
		});

		// Step 1: Customer files dispute for $50
		const disputeRes = await paymentService.markPaymentDisputed('pi_case4', 50);
		expect(disputeRes.success).toBe(true);
		expect(disputeRes.disputedAmount).toBe(50);
		expect(userPaymentsTable[0].amountDisputed).toBe(50);
		expect(userCreditsTable[0].balance).toBe(0); // 50 - 50 = 0
		expect(usersTable[0].isSuspended).toBe(true); // Account suspended on dispute

		// Step 2: Partial refund $20 is settled while dispute was open
		// Moves $20 from disputed to refunded, deltaToDeduct is 0 because already clawed back
		const refundRes = await paymentService.refundStripeCredits('pi_case4', 20);
		expect(refundRes.success).toBe(true);
		expect(refundRes.deltaRefunded).toBe(0);
		expect(userPaymentsTable[0].amountRefunded).toBe(20);
		expect(userPaymentsTable[0].amountDisputed).toBe(30); // 50 - 20 = 30
		expect(userCreditsTable[0].balance).toBe(0); // Balance unchanged

		// Step 3: We win the dispute!
		// Crucial Invariant: Only restore what is still marked as disputed ($30),
		// NOT the money that was genuinely refunded ($20).
		const resolveRes = await paymentService.resolvePaymentDispute('pi_case4', 'won');
		expect(resolveRes.success).toBe(true);
		expect(resolveRes.restoredAmount).toBe(30); // Restores ONLY the $30 still disputed!
		expect(userPaymentsTable[0].amountDisputed).toBe(0);
		expect(userPaymentsTable[0].amountRefunded).toBe(20);
		expect(userPaymentsTable[0].status).toBe('verified');
		expect(userCreditsTable[0].balance).toBe(30); // Final balance is $30 ($50 deposit - $20 refund)
		expect(usersTable[0].isSuspended).toBe(false); // Account unsuspended on dispute won
	});

	it('Dispute lost keeps account suspended and makes clawback permanent', async () => {
		userPaymentsTable.push({
			id: 'p_lost',
			userId: 'user-lost',
			txHash: 'cs_lost',
			paymentIntentId: 'pi_lost',
			amountUsdc: 50,
			creditsAdded: 50,
			amountRefunded: 0,
			amountDisputed: 0,
			status: 'verified',
		});
		userCreditsTable.push({
			userId: 'user-lost',
			balance: 50,
			totalDeposited: 50,
			totalUsed: 0,
		});
		usersTable.push({
			id: 'user-lost',
			isSuspended: false,
		});

		// Dispute opens
		await paymentService.markPaymentDisputed('pi_lost', 50);
		expect(usersTable[0].isSuspended).toBe(true);

		// Dispute lost
		const resolveRes = await paymentService.resolvePaymentDispute('pi_lost', 'lost');
		expect(resolveRes.success).toBe(true);
		expect(resolveRes.restoredAmount).toBe(0);
		expect(userCreditsTable[0].balance).toBe(0);
		expect(usersTable[0].isSuspended).toBe(true); // Account remains suspended!
	});

	it('consumeWalletNonce is single-use and atomic', async () => {
		walletNoncesTable.push({
			id: 'nonce-1',
			userId: 'user-1',
			nonce: 'valid_nonce_abc',
			expiresAt: new Date(Date.now() + 600_000),
		});

		// First consume succeeds
		const first = await paymentService.consumeWalletNonce('user-1', 'valid_nonce_abc');
		expect(first).toBe(true);

		// Second consume fails (replay attack prevented)
		const second = await paymentService.consumeWalletNonce('user-1', 'valid_nonce_abc');
		expect(second).toBe(false);
	});
});

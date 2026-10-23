/**
 * Payment API Types
 */

export interface PaymentWalletData {
	walletAddress: string;
	chainId: number;
	chainName: string;
	usdcContract: string;
}

export interface PaymentBalanceData {
	balance: number;
	totalDeposited: number;
	totalUsed: number;
}

export interface VerifyPaymentRequest {
	txHash: string;
}

export interface VerifyPaymentData {
	success: boolean;
	amountUsdc: number;
	creditsAdded: number;
	newBalance: number;
	txHash: string;
}

export interface PaymentHistoryItem {
	id: string;
	txHash: string;
	amountUsdc: number;
	creditsAdded: number;
	status: string;
	createdAt: Date | null;
	verifiedAt: Date | null;
}

export interface PaymentHistoryData {
	payments: PaymentHistoryItem[];
}

export interface UsageTransactionItem {
	id: string;
	action: string;
	actualCost: number;
	chargedCost: number;
	creditsBefore: number;
	creditsAfter: number;
	createdAt: Date | null;
}

export interface UsageByActionItem {
	action: string;
	totalCharged: number;
	totalActual: number;
	count: number;
}

export interface UsageHistoryData {
	transactions: UsageTransactionItem[];
	byAction: UsageByActionItem[];
	totalSpent: number;
}

export interface UserWalletItem {
	id: string;
	address: string;
	createdAt: Date | null;
}

export interface UserWalletsData {
	wallets: UserWalletItem[];
}

export interface LinkWalletRequest {
	address: string;
	message: string;
	signature: string;
}

export interface LinkWalletData {
	success: boolean;
	wallet: UserWalletItem;
}

export interface StripeCheckoutRequest {
	amountUsd: number;
}

export interface StripeCheckoutData {
	url: string;
}

export interface WalletNonceData {
	nonce: string;
	expiresAt: string;
}


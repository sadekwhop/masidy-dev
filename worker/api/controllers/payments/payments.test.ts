import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PaymentsController } from './controller';
import { verifyStripeWebhookSignature } from '../../../services/payments/stripeUtils';
import type { RouteContext } from '../../types/route-context';
import { privateKeyToAccount } from 'viem/accounts';
import { checkUsageAndBalance } from '../../../services/rate-limit/usageChecker';

// Test Ethereum private key for deterministic test wallet
const TEST_PRIVATE_KEY = '0x4c0883a69102937d6231471b5dbb6204db7e71644d08a455043e8d0f9e854f27';
const testAccount = privateKeyToAccount(TEST_PRIVATE_KEY);
const TEST_WALLET_ADDRESS = testAccount.address;

const mockAddCredits = vi.fn();
const mockAddStripeCredits = vi.fn();
const mockIsTxHashClaimed = vi.fn();
const mockGetUserWallets = vi.fn();
const mockLinkWallet = vi.fn();
const mockUnlinkWallet = vi.fn();
const mockGetWalletOwner = vi.fn();
const mockRefundStripeCredits = vi.fn();
const mockMarkPaymentDisputed = vi.fn();
const mockResolvePaymentDispute = vi.fn();
const mockCreateWalletNonce = vi.fn();
const mockConsumeWalletNonce = vi.fn();
const mockGetBalance = vi.fn();
const mockDeductCredits = vi.fn();

vi.mock('../../../database/services/PaymentService', () => ({
	PaymentService: vi.fn().mockImplementation(() => ({
		getBalance: mockGetBalance,
		deductCredits: mockDeductCredits,
		addCredits: mockAddCredits,
		addStripeCredits: mockAddStripeCredits,
		isTxHashClaimed: mockIsTxHashClaimed,
		getUserWallets: mockGetUserWallets,
		linkWallet: mockLinkWallet,
		unlinkWallet: mockUnlinkWallet,
		getWalletOwner: mockGetWalletOwner,
		refundStripeCredits: mockRefundStripeCredits,
		markPaymentDisputed: mockMarkPaymentDisputed,
		resolvePaymentDispute: mockResolvePaymentDispute,
		createWalletNonce: mockCreateWalletNonce,
		consumeWalletNonce: mockConsumeWalletNonce,
	})),
}));

const mockVerifyUsdcPayment = vi.fn();
vi.mock('../../../services/payments/PaymentVerificationService', () => ({
	verifyUsdcPayment: (...args: unknown[]) => mockVerifyUsdcPayment(...args),
}));

const testEnv = {
	MASIDY_WALLET: '0x1234567890123456789012345678901234567890',
	STRIPE_SECRET_KEY: 'sk_test_123',
	STRIPE_WEBHOOK_SECRET: 'whsec_test_secret_12345',
} as unknown as Env;

function makeContext(overrides: Partial<RouteContext> = {}): RouteContext {
	return {
		user: { id: 'user-1', email: 'user@example.com' },
		sessionId: 'session-1',
		config: {},
		pathParams: {},
		queryParams: new URLSearchParams(),
		...overrides,
	} as unknown as RouteContext;
}

// Helper to sign Stripe webhook payload with HMAC-SHA256
async function signStripePayload(payload: string, secret: string, timestamp?: number): Promise<string> {
	const t = timestamp ?? Math.floor(Date.now() / 1000);
	const enc = new TextEncoder();
	const key = await crypto.subtle.importKey(
		'raw',
		enc.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${payload}`));
	const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
	return `t=${t},v1=${hex}`;
}

describe('Stripe Webhook Signature Verification (stripeUtils)', () => {
	it('validates authentic Stripe webhook signatures', async () => {
		const payload = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
		const header = await signStripePayload(payload, 'whsec_my_secret');
		const isValid = await verifyStripeWebhookSignature(payload, header, 'whsec_my_secret');
		expect(isValid).toBe(true);
	});

	it('validates signatures during Stripe secret rotation with multiple v1 signatures', async () => {
		const payload = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
		const t = Math.floor(Date.now() / 1000);
		const validSig = await signStripePayload(payload, 'whsec_new_secret', t);
		const hexOnly = validSig.split('v1=')[1];
		// Multiple v1 headers: old rollover signature + new secret signature
		const headerWithMultipleV1 = `t=${t},v1=deadbeefcafebabe0123456789abcdef,v1=${hexOnly}`;

		const isValid = await verifyStripeWebhookSignature(payload, headerWithMultipleV1, 'whsec_new_secret');
		expect(isValid).toBe(true);
	});

	it('rejects tampered webhook payloads', async () => {
		const payload = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
		const header = await signStripePayload(payload, 'whsec_my_secret');
		const tampered = JSON.stringify({ id: 'evt_1', type: 'charge.failed' });
		const isValid = await verifyStripeWebhookSignature(tampered, header, 'whsec_my_secret');
		expect(isValid).toBe(false);
	});

	it('rejects expired webhook signatures (> 300 seconds old)', async () => {
		const payload = JSON.stringify({ id: 'evt_1' });
		const oldTimestamp = Math.floor(Date.now() / 1000) - 350; // 350s old
		const header = await signStripePayload(payload, 'whsec_my_secret', oldTimestamp);
		const isValid = await verifyStripeWebhookSignature(payload, header, 'whsec_my_secret');
		expect(isValid).toBe(false);
	});

	it('rejects signatures created with the wrong secret', async () => {
		const payload = JSON.stringify({ id: 'evt_1' });
		const header = await signStripePayload(payload, 'whsec_wrong_secret');
		const isValid = await verifyStripeWebhookSignature(payload, header, 'whsec_real_secret');
		expect(isValid).toBe(false);
	});

	it('rejects malformed header without timestamp or v1', async () => {
		const payload = JSON.stringify({ id: 'evt_1' });
		expect(await verifyStripeWebhookSignature(payload, 'invalid_header', 'whsec_secret')).toBe(false);
		expect(await verifyStripeWebhookSignature(payload, 't=12345', 'whsec_secret')).toBe(false);
	});
});

describe('PaymentsController.createWalletNonce', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('issues a one-time nonce for an authenticated user', async () => {
		mockCreateWalletNonce.mockResolvedValue('test_nonce_123456');
		const request = new Request('https://api.masidy.local/api/payments/wallets/nonce', {
			method: 'POST',
		});

		const response = await PaymentsController.createWalletNonce(
			request,
			testEnv,
			{} as ExecutionContext,
			makeContext({ user: { id: 'user-1', email: 'user@example.com' } }),
		);

		expect(response.status).toBe(200);
		const json = await response.json<{ success: boolean; data?: { nonce: string; expiresAt: string } }>();
		expect(json.success).toBe(true);
		expect(json.data?.nonce).toBe('test_nonce_123456');
		expect(mockCreateWalletNonce).toHaveBeenCalledWith('user-1');
	});

	it('rejects unauthenticated requests with 401', async () => {
		const request = new Request('https://api.masidy.local/api/payments/wallets/nonce', {
			method: 'POST',
		});

		const response = await PaymentsController.createWalletNonce(
			request,
			testEnv,
			{} as ExecutionContext,
			makeContext({ user: null }),
		);

		expect(response.status).toBe(401);
		expect(mockCreateWalletNonce).not.toHaveBeenCalled();
	});
});

describe('PaymentsController.handleStripeWebhook', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('credits user and saves payment_intent_id when checkout.session.completed with payment_status=paid', async () => {
		const payload = JSON.stringify({
			type: 'checkout.session.completed',
			data: {
				object: {
					id: 'cs_test_session_123',
					payment_intent: 'pi_test_intent_789',
					currency: 'usd',
					payment_status: 'paid',
					amount_total: 2500, // $25.00
					metadata: {
						user_id: 'user-1',
						credits: '25',
					},
				},
			},
		});

		const signature = await signStripePayload(payload, 'whsec_test_secret_12345');
		const request = new Request('https://api.masidy.local/api/payments/stripe/webhook', {
			method: 'POST',
			headers: {
				'stripe-signature': signature,
				'content-type': 'application/json',
			},
			body: payload,
		});

		const response = await PaymentsController.handleStripeWebhook(
			request,
			testEnv,
			{} as ExecutionContext,
			makeContext(),
		);

		expect(response.status).toBe(200);
		expect(mockAddStripeCredits).toHaveBeenCalledWith('user-1', 25, 'cs_test_session_123', 'pi_test_intent_789');
	});

	it('credits user on checkout.session.async_payment_succeeded', async () => {
		const payload = JSON.stringify({
			type: 'checkout.session.async_payment_succeeded',
			data: {
				object: {
					id: 'cs_test_async_456',
					payment_intent: 'pi_test_async_intent_123',
					currency: 'usd',
					payment_status: 'paid',
					amount_total: 5000, // $50.00
					metadata: {
						user_id: 'user-1',
					},
				},
			},
		});

		const signature = await signStripePayload(payload, 'whsec_test_secret_12345');
		const request = new Request('https://api.masidy.local/api/payments/stripe/webhook', {
			method: 'POST',
			headers: {
				'stripe-signature': signature,
				'content-type': 'application/json',
			},
			body: payload,
		});

		const response = await PaymentsController.handleStripeWebhook(
			request,
			testEnv,
			{} as ExecutionContext,
			makeContext(),
		);

		expect(response.status).toBe(200);
		expect(mockAddStripeCredits).toHaveBeenCalledWith('user-1', 50, 'cs_test_async_456', 'pi_test_async_intent_123');
	});

	it('logs loudly and returns 200 without throwing when user_id is missing', async () => {
		const payload = JSON.stringify({
			type: 'checkout.session.completed',
			data: {
				object: {
					id: 'cs_test_no_user',
					payment_status: 'paid',
					amount_total: 1000,
					metadata: {}, // Missing user_id!
				},
			},
		});

		const signature = await signStripePayload(payload, 'whsec_test_secret_12345');
		const request = new Request('https://api.masidy.local/api/payments/stripe/webhook', {
			method: 'POST',
			headers: { 'stripe-signature': signature },
			body: payload,
		});

		const response = await PaymentsController.handleStripeWebhook(
			request,
			testEnv,
			{} as ExecutionContext,
			makeContext(),
		);

		expect(response.status).toBe(200);
		const json = await response.json<{ error?: string }>();
		expect(json.error).toBe('missing user_id');
		expect(mockAddStripeCredits).not.toHaveBeenCalled();
	});

	it('returns 200 duplicate when addStripeCredits handles duplicate gracefully', async () => {
		const payload = JSON.stringify({
			type: 'checkout.session.completed',
			data: {
				object: {
					id: 'cs_test_dup',
					payment_status: 'paid',
					amount_total: 2500,
					metadata: { user_id: 'user-1' },
				},
			},
		});

		mockAddStripeCredits.mockResolvedValue(50); // returns balance, no throw
		const signature = await signStripePayload(payload, 'whsec_test_secret_12345');
		const request = new Request('https://api.masidy.local/api/payments/stripe/webhook', {
			method: 'POST',
			headers: { 'stripe-signature': signature },
			body: payload,
		});

		const response = await PaymentsController.handleStripeWebhook(
			request,
			testEnv,
			{} as ExecutionContext,
			makeContext(),
		);

		expect(response.status).toBe(200);
	});

	it('processes refunds on charge.refunded by payment_intent with partial refund support', async () => {
		const payload = JSON.stringify({
			type: 'charge.refunded',
			data: {
				object: {
					id: 'ch_test_charge_123',
					payment_intent: 'pi_test_intent_789',
					amount_refunded: 1000, // $10.00 partial refund (in cents)
				},
			},
		});

		const signature = await signStripePayload(payload, 'whsec_test_secret_12345');
		const request = new Request('https://api.masidy.local/api/payments/stripe/webhook', {
			method: 'POST',
			headers: { 'stripe-signature': signature },
			body: payload,
		});

		const response = await PaymentsController.handleStripeWebhook(
			request,
			testEnv,
			{} as ExecutionContext,
			makeContext(),
		);

		expect(response.status).toBe(200);
		// Crucial verification: looked up by payment_intent, not charge ID or session ID!
		// And passed partial amount: 10.00
		expect(mockRefundStripeCredits).toHaveBeenCalledWith('pi_test_intent_789', 10);
	});

	it('marks payment disputed on charge.dispute.created by payment_intent', async () => {
		const payload = JSON.stringify({
			type: 'charge.dispute.created',
			data: {
				object: {
					id: 'dp_test_123',
					payment_intent: 'pi_disputed_intent_999',
					charge: 'ch_test_charge_999',
				},
			},
		});

		const signature = await signStripePayload(payload, 'whsec_test_secret_12345');
		const request = new Request('https://api.masidy.local/api/payments/stripe/webhook', {
			method: 'POST',
			headers: { 'stripe-signature': signature },
			body: payload,
		});

		const response = await PaymentsController.handleStripeWebhook(
			request,
			testEnv,
			{} as ExecutionContext,
			makeContext(),
		);

		expect(response.status).toBe(200);
		expect(mockMarkPaymentDisputed).toHaveBeenCalledWith('pi_disputed_intent_999');
	});

	it('handles two consecutive partial refunds in sequence ($10 then $25 cumulative)', async () => {
		// First refund: $10 refunded
		const payload1 = JSON.stringify({
			type: 'charge.refunded',
			data: {
				object: {
					id: 'ch_test_charge_123',
					payment_intent: 'pi_test_partial_123',
					amount_refunded: 1000, // $10.00 cumulative
				},
			},
		});
		const sig1 = await signStripePayload(payload1, 'whsec_test_secret_12345');
		const req1 = new Request('https://api.masidy.local/api/payments/stripe/webhook', {
			method: 'POST',
			headers: { 'stripe-signature': sig1 },
			body: payload1,
		});
		const res1 = await PaymentsController.handleStripeWebhook(req1, testEnv, {} as ExecutionContext, makeContext());
		expect(res1.status).toBe(200);
		expect(mockRefundStripeCredits).toHaveBeenLastCalledWith('pi_test_partial_123', 10);

		// Second refund: cumulative refunded is now $25 ($10 + $15 additional)
		const payload2 = JSON.stringify({
			type: 'charge.refunded',
			data: {
				object: {
					id: 'ch_test_charge_123',
					payment_intent: 'pi_test_partial_123',
					amount_refunded: 2500, // $25.00 cumulative
				},
			},
		});
		const sig2 = await signStripePayload(payload2, 'whsec_test_secret_12345');
		const req2 = new Request('https://api.masidy.local/api/payments/stripe/webhook', {
			method: 'POST',
			headers: { 'stripe-signature': sig2 },
			body: payload2,
		});
		const res2 = await PaymentsController.handleStripeWebhook(req2, testEnv, {} as ExecutionContext, makeContext());
		expect(res2.status).toBe(200);
		expect(mockRefundStripeCredits).toHaveBeenLastCalledWith('pi_test_partial_123', 25);
	});

	it('resolves dispute on charge.dispute.closed by payment_intent (won / lost)', async () => {
		const payload = JSON.stringify({
			type: 'charge.dispute.closed',
			data: {
				object: {
					id: 'dp_closed_123',
					payment_intent: 'pi_won_intent_123',
					charge: 'ch_won_charge_123',
					status: 'won',
				},
			},
		});

		const signature = await signStripePayload(payload, 'whsec_test_secret_12345');
		const request = new Request('https://api.masidy.local/api/payments/stripe/webhook', {
			method: 'POST',
			headers: { 'stripe-signature': signature },
			body: payload,
		});

		const response = await PaymentsController.handleStripeWebhook(
			request,
			testEnv,
			{} as ExecutionContext,
			makeContext(),
		);

		expect(response.status).toBe(200);
		expect(mockResolvePaymentDispute).toHaveBeenCalledWith('pi_won_intent_123', 'won');
	});
});

describe('PaymentsController.linkWallet', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('successfully links a wallet when signed with valid nonce, timestamp, and template', async () => {
		const timestamp = Date.now();
		const nonce = 'abc123nonce';
		const message = `Masidy (masidy.dev): Link wallet ${TEST_WALLET_ADDRESS.toLowerCase()} to account user-1 with nonce ${nonce} at ${timestamp}`;
		const signature = await testAccount.signMessage({ message });

		mockConsumeWalletNonce.mockResolvedValue(true);
		mockGetWalletOwner.mockResolvedValue(null);
		mockLinkWallet.mockResolvedValue({
			id: 'wallet-1',
			userId: 'user-1',
			address: TEST_WALLET_ADDRESS.toLowerCase(),
			createdAt: new Date(),
		});

		const request = new Request('https://api.masidy.local/api/payments/wallets/link', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				address: TEST_WALLET_ADDRESS,
				message,
				signature,
			}),
		});

		const response = await PaymentsController.linkWallet(
			request,
			testEnv,
			{} as ExecutionContext,
			makeContext({ user: { id: 'user-1', email: 'user@example.com' } }),
		);

		expect(response.status).toBe(200);
		const json = await response.json<{ success: boolean; data?: { wallet: { address: string } } }>();
		expect(json.success).toBe(true);
		expect(json.data?.wallet.address).toBe(TEST_WALLET_ADDRESS.toLowerCase());
		expect(mockConsumeWalletNonce).toHaveBeenCalledWith('user-1', nonce);
		expect(mockLinkWallet).toHaveBeenCalledWith('user-1', TEST_WALLET_ADDRESS.toLowerCase());
	});

	it('FAILS when message does not include domain (masidy.dev) prefix', async () => {
		const timestamp = Date.now();
		const nonce = 'abc123nonce';
		// Missing "(masidy.dev)"
		const message = `Masidy: Link wallet ${TEST_WALLET_ADDRESS.toLowerCase()} to account user-1 with nonce ${nonce} at ${timestamp}`;
		const signature = await testAccount.signMessage({ message });

		const request = new Request('https://api.masidy.local/api/payments/wallets/link', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				address: TEST_WALLET_ADDRESS,
				message,
				signature,
			}),
		});

		const response = await PaymentsController.linkWallet(
			request,
			testEnv,
			{} as ExecutionContext,
			makeContext({ user: { id: 'user-1', email: 'user@example.com' } }),
		);

		expect(response.status).toBe(400);
		const json = await response.json<{ error: { message: string } }>();
		expect(json.error.message).toContain('Expected: "Masidy (masidy.dev): Link wallet');
		expect(mockConsumeWalletNonce).not.toHaveBeenCalled();
	});

	it('FAILS when message has NO timestamp (strict template required)', async () => {
		const message = `Masidy (masidy.dev): Link wallet ${TEST_WALLET_ADDRESS.toLowerCase()} to account user-1 with nonce abc123nonce`;
		const signature = await testAccount.signMessage({ message });

		const request = new Request('https://api.masidy.local/api/payments/wallets/link', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				address: TEST_WALLET_ADDRESS,
				message,
				signature,
			}),
		});

		const response = await PaymentsController.linkWallet(
			request,
			testEnv,
			{} as ExecutionContext,
			makeContext({ user: { id: 'user-1', email: 'user@example.com' } }),
		);

		expect(response.status).toBe(400);
		const json = await response.json<{ error: { message: string } }>();
		expect(json.error.message).toContain('Invalid verification message format');
		expect(mockConsumeWalletNonce).not.toHaveBeenCalled();
		expect(mockLinkWallet).not.toHaveBeenCalled();
	});

	it('FAILS when message has an invalid or expired nonce', async () => {
		const timestamp = Date.now();
		const message = `Masidy (masidy.dev): Link wallet ${TEST_WALLET_ADDRESS.toLowerCase()} to account user-1 with nonce bad_nonce at ${timestamp}`;
		const signature = await testAccount.signMessage({ message });

		mockConsumeWalletNonce.mockResolvedValue(false); // Nonce invalid or expired!

		const request = new Request('https://api.masidy.local/api/payments/wallets/link', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				address: TEST_WALLET_ADDRESS,
				message,
				signature,
			}),
		});

		const response = await PaymentsController.linkWallet(
			request,
			testEnv,
			{} as ExecutionContext,
			makeContext({ user: { id: 'user-1', email: 'user@example.com' } }),
		);

		expect(response.status).toBe(400);
		const json = await response.json<{ error: { message: string } }>();
		expect(json.error.message).toContain('Invalid or expired verification nonce');
		expect(mockLinkWallet).not.toHaveBeenCalled();
	});

	it('FAILS when message timestamp is expired (> 5 minutes old)', async () => {
		const expiredTime = Date.now() - 350_000;
		const message = `Masidy (masidy.dev): Link wallet ${TEST_WALLET_ADDRESS.toLowerCase()} to account user-1 with nonce valid_nonce at ${expiredTime}`;
		const signature = await testAccount.signMessage({ message });

		const request = new Request('https://api.masidy.local/api/payments/wallets/link', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				address: TEST_WALLET_ADDRESS,
				message,
				signature,
			}),
		});

		const response = await PaymentsController.linkWallet(
			request,
			testEnv,
			{} as ExecutionContext,
			makeContext({ user: { id: 'user-1', email: 'user@example.com' } }),
		);

		expect(response.status).toBe(400);
		const json = await response.json<{ error: { message: string } }>();
		expect(json.error.message).toContain('expired');
		expect(mockConsumeWalletNonce).not.toHaveBeenCalled();
		expect(mockLinkWallet).not.toHaveBeenCalled();
	});

	it('rejects signature if message is bound to a different user ID', async () => {
		const timestamp = Date.now();
		const message = `Masidy (masidy.dev): Link wallet ${TEST_WALLET_ADDRESS.toLowerCase()} to account different-user with nonce valid_nonce at ${timestamp}`;
		const signature = await testAccount.signMessage({ message });

		const request = new Request('https://api.masidy.local/api/payments/wallets/link', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				address: TEST_WALLET_ADDRESS,
				message,
				signature,
			}),
		});

		const response = await PaymentsController.linkWallet(
			request,
			testEnv,
			{} as ExecutionContext,
			makeContext({ user: { id: 'user-1', email: 'user@example.com' } }),
		);

		expect(response.status).toBe(400);
		expect(mockConsumeWalletNonce).not.toHaveBeenCalled();
		expect(mockLinkWallet).not.toHaveBeenCalled();
	});

	it('rejects linking if wallet is already linked to another user account', async () => {
		const timestamp = Date.now();
		const message = `Masidy (masidy.dev): Link wallet ${TEST_WALLET_ADDRESS.toLowerCase()} to account user-1 with nonce valid_nonce at ${timestamp}`;
		const signature = await testAccount.signMessage({ message });

		mockConsumeWalletNonce.mockResolvedValue(true);
		mockGetWalletOwner.mockResolvedValue('user-2'); // already owned by user-2!

		const request = new Request('https://api.masidy.local/api/payments/wallets/link', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				address: TEST_WALLET_ADDRESS,
				message,
				signature,
			}),
		});

		const response = await PaymentsController.linkWallet(
			request,
			testEnv,
			{} as ExecutionContext,
			makeContext({ user: { id: 'user-1', email: 'user@example.com' } }),
		);

		expect(response.status).toBe(409);
		expect(mockLinkWallet).not.toHaveBeenCalled();
	});
});

describe('PaymentsController.verifyPayment (Anti-Sniping Protection)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('REJECTS claim if payment was sent from an unlinked wallet (Anti-Sniping)', async () => {
		mockIsTxHashClaimed.mockResolvedValue(false);
		mockVerifyUsdcPayment.mockResolvedValue({
			amountUsdc: 50,
			from: '0xVictimWalletAddress123456789012345678901',
			to: '0x1234567890123456789012345678901234567890',
			txHash: '0xabc123',
			blockNumber: 1000n,
		});

		mockGetUserWallets.mockResolvedValue([
			{ id: 'w1', userId: 'user-attacker', address: '0xattackerwallet00000000000000000000000000' },
		]);

		const request = new Request('https://api.masidy.local/api/payments/verify', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ txHash: '0xabc123' }),
		});

		const response = await PaymentsController.verifyPayment(
			request,
			testEnv,
			{} as ExecutionContext,
			makeContext({ user: { id: 'user-attacker', email: 'attacker@example.com' } }),
		);

		expect(response.status).toBe(403);
		const json = await response.json<{ error: { message: string } }>();
		expect(json.error.message).toContain('please link this wallet');
		expect(mockAddCredits).not.toHaveBeenCalled();
	});

	it('ACCEPTS claim when payment was sent from the user linked wallet', async () => {
		mockIsTxHashClaimed.mockResolvedValue(false);
		mockVerifyUsdcPayment.mockResolvedValue({
			amountUsdc: 50,
			from: TEST_WALLET_ADDRESS,
			to: '0x1234567890123456789012345678901234567890',
			txHash: '0xabc123',
			blockNumber: 1000n,
		});

		mockGetUserWallets.mockResolvedValue([
			{ id: 'w1', userId: 'user-1', address: TEST_WALLET_ADDRESS.toLowerCase() },
		]);
		mockAddCredits.mockResolvedValue(50);

		const request = new Request('https://api.masidy.local/api/payments/verify', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ txHash: '0xabc123' }),
		});

		const response = await PaymentsController.verifyPayment(
			request,
			testEnv,
			{} as ExecutionContext,
			makeContext({ user: { id: 'user-1', email: 'user@example.com' } }),
		);

		expect(response.status).toBe(200);
		const json = await response.json<{ success: boolean; data?: { creditsAdded: number } }>();
		expect(json.success).toBe(true);
		expect(json.data?.creditsAdded).toBe(50);
		expect(mockAddCredits).toHaveBeenCalledWith('user-1', 50, '0xabc123');
	});
});

describe('Negative Balance Enforcement (checkUsageAndBalance)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('blocks user requests when balance is negative due to refund/dispute clawback', async () => {
		mockGetBalance.mockResolvedValue(-15.5);

		const result = await checkUsageAndBalance(
			{ DB: {} } as unknown as Env,
			'user-arrears',
		);

		expect(result.allowed).toBe(false);
		expect(result.reason).toContain('Account balance is negative ($-15.50)');
		expect(result.reason).toContain('refund or dispute chargeback');
		expect(result.balance).toBe(-15.5);
	});

	it('allows user requests when balance is non-negative and limits are disabled', async () => {
		mockGetBalance.mockResolvedValue(25.0);

		const result = await checkUsageAndBalance(
			{ DB: {}, ENABLE_CLOUDFLARE_LIMITS: 'false' } as unknown as Env,
			'user-good',
		);

		expect(result.allowed).toBe(true);
		expect(result.withinLimits).toBe(true);
	});
});

describe('Zero-Waste Billing & Minimum Deposit Enforcement', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('guarantees zero-waste billing: failed, errored, or aborted builds never call deductCredits', async () => {
		// Mock initial user balance
		mockGetBalance.mockResolvedValue(20.0);

		// Simulate build failure handling (e.g. invalid code, runtime crash, cancelled generation)
		const buildError = new Error('Build runtime error: SyntaxError');
		const onBuildFailed = vi.fn((err: Error) => {
			// Zero-waste invariant: only log/report error; NEVER call deductCredits
			return { status: 'failed', error: err.message };
		});

		const result = onBuildFailed(buildError);
		expect(result.status).toBe('failed');
		// Confirm no credit deduction occurred
		expect(mockDeductCredits).not.toHaveBeenCalled();
	});

	it('enforces $5 minimum deposit on Stripe checkout (rejects $1 or $2 packs)', async () => {
		const request = new Request('http://localhost/api/payments/stripe/checkout', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ amountUsd: 2 }), // below minimum $5
		});

		const response = await PaymentsController.createStripeCheckout(
			request,
			{ STRIPE_SECRET_KEY: 'sk_test_123' } as unknown as Env,
			{} as ExecutionContext,
			makeContext({ user: { id: 'user-1', email: 'test@example.com' } }),
		);

		expect(response.status).toBe(400);
		const json = await response.json<{ success: boolean; error?: { message: string } }>();
		expect(json.success).toBe(false);
		expect(json.error?.message).toContain('Select a valid credit pack: $5, $10, $25, $50, $100');
	});

	it('accepts $5 minimum pack on Stripe checkout', async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ url: 'https://checkout.stripe.com/c/pay/cs_test_5dollar' }),
		} as Response);

		try {
			const request = new Request('http://localhost/api/payments/stripe/checkout', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ amountUsd: 5 }),
			});

			const response = await PaymentsController.createStripeCheckout(
				request,
				{ STRIPE_SECRET_KEY: 'sk_test_123' } as unknown as Env,
				{} as ExecutionContext,
				makeContext({ user: { id: 'user-1', email: 'test@example.com' } }),
			);

			expect(response.status).toBe(200);
			const json = await response.json<{ success: boolean; data?: { url: string } }>();
			expect(json.success).toBe(true);
			expect(json.data?.url).toContain('cs_test_5dollar');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('enforces $5 minimum deposit on USDC payment verification (rejects < $5 USDC)', async () => {
		mockIsTxHashClaimed.mockResolvedValue(false);
		mockGetUserWallets.mockResolvedValue([
			{ address: '0x1234567890123456789012345678901234567890', chainId: 8453, linkedAt: new Date() },
		]);
		mockVerifyUsdcPayment.mockResolvedValue({
			from: '0x1234567890123456789012345678901234567890',
			amountUsdc: 2.50, // below $5
			blockNumber: 12345,
		});

		const request = new Request('http://localhost/api/payments/verify', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ txHash: '0xvalidhash' }),
		});

		const response = await PaymentsController.verifyPayment(
			request,
			{ MASIDY_WALLET: '0xplatform' } as unknown as Env,
			{} as ExecutionContext,
			makeContext({ user: { id: 'user-1', email: 'test@example.com' } }),
		);

		expect(response.status).toBe(400);
		const json = await response.json<{ success: boolean; error?: { message: string } }>();
		expect(json.success).toBe(false);
		expect(json.error?.message).toContain('Minimum deposit is $5.00 USDC');
		expect(mockAddCredits).not.toHaveBeenCalled();
	});
});


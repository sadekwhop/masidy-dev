/**
 * Payment Verification Service
 * Verifies USDC transfers on Base mainnet using viem.
 */

import { createPublicClient, http, type Address, parseAbiItem, toEventSelector } from 'viem';
import { base } from 'viem/chains';
import { createLogger } from '../../logger';

const logger = createLogger('PaymentVerification');

// USDC contract on Base mainnet
const USDC_CONTRACT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address;

// ERC20 Transfer event signature
const TRANSFER_EVENT = parseAbiItem(
	'event Transfer(address indexed from, address indexed to, uint256 value)',
);

// Transfer event topic0 hash
const TRANSFER_TOPIC = toEventSelector(TRANSFER_EVENT);
const USDC_DECIMALS = 6;

const client = createPublicClient({
	chain: base,
	transport: http('https://mainnet.base.org'),
});

export interface VerifiedPayment {
	amountUsdc: number;
	from: Address;
	to: Address;
	txHash: string;
	blockNumber: bigint;
}

/**
 * Verify that a transaction is a confirmed USDC transfer to the platform wallet.
 *
 * Checks:
 * 1. Transaction receipt exists and status === success
 * 2. A Transfer event exists where `to` === platform wallet
 * 3. The token contract is USDC on Base mainnet
 *
 * Returns the verified amount in USDC (human-readable, e.g. 10.5) or null if invalid.
 */
export async function verifyUsdcPayment(
	txHash: string,
	platformWallet: string,
): Promise<VerifiedPayment | null> {
	try {
		const hash = txHash as `0x${string}`;
		const receipt = await client.getTransactionReceipt({ hash });

		if (receipt.status !== 'success') {
			logger.warn('Transaction not successful', { txHash, status: receipt.status });
			return null;
		}

		const platformAddress = platformWallet.toLowerCase() as Address;

		// Look for USDC Transfer events to the platform wallet
		const transferLogs = receipt.logs.filter(
			(log) =>
				log.address.toLowerCase() === USDC_CONTRACT.toLowerCase() &&
				log.topics[0] === TRANSFER_TOPIC,
		);

		for (const log of transferLogs) {
			// Transfer event: topic1 = from, topic2 = to, data = value
			const to = ('0x' + (log.topics[2]?.slice(26) ?? '')) as Address;
			if (to.toLowerCase() === platformAddress.toLowerCase()) {
				const value = BigInt(log.data);
				const amountUsdc = Number(value) / 10 ** USDC_DECIMALS;

				if (amountUsdc <= 0) {
					logger.warn('Zero or negative amount', { txHash, value: value.toString() });
					return null;
				}

				const from = ('0x' + (log.topics[1]?.slice(26) ?? '')) as Address;

				return {
					amountUsdc,
					from,
					to: platformAddress,
					txHash,
					blockNumber: receipt.blockNumber,
				};
			}
		}

		logger.warn('No matching USDC transfer found', { txHash });
		return null;
	} catch (error) {
		logger.error('Failed to verify payment', { txHash, error });
		return null;
	}
}

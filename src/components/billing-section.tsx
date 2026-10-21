/**
 * Billing & Credits Section
 * Displays credit balance, platform wallet for USDC payments,
 * MetaMask payment flow, manual tx hash submission, and payment history.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Wallet, ArrowClockwise, ArrowRight } from '@phosphor-icons/react';
import { Button, Input, LayerCard, Table } from '@cloudflare/kumo';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';
import { useAuth } from '@/contexts/auth-context';
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';

// Base mainnet chain ID (decimal)
const BASE_CHAIN_ID_HEX = '0x2105';
// USDC on Base mainnet
const USDC_CONTRACT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

// Minimal ERC20 transfer ABI fragment — kept for reference
// const ERC20_TRANSFER_ABI = [...] as const;

// Decode an ABI-encoded transfer(address,uint256) call from the data field
function encodeTransferCall(to: string, amount: string): string {
	// transfer(address,uint256) selector = 0xa9059cbb
	const selector = 'a9059cbb';
	const toPadded = to.toLowerCase().replace('0x', '').padStart(64, '0');
	// USDC has 6 decimals
	const amountWei = BigInt(Math.round(parseFloat(amount) * 1e6));
	const amountHex = amountWei.toString(16).padStart(64, '0');
	return '0x' + selector + toPadded + amountHex;
}

export function BillingSection() {
	const { user } = useAuth();
	const queryClient = useQueryClient();
	const [payAmount, setPayAmount] = useState('5');
	const [manualTxHash, setManualTxHash] = useState('');
	const [paying, setPaying] = useState(false);
	const {
		copied: copiedWallet,
		copy: copyWallet,
	} = useCopyToClipboard();

	const walletQuery = useQuery({
		queryKey: queryKeys.account.payments.wallet(user?.id),
		queryFn: async () => {
			const res = await apiClient.getPaymentWallet();
			if (!res.success) throw new Error(res.error?.message || 'Failed to load wallet');
			return res.data!;
		},
		enabled: !!user,
	});

	const balanceQuery = useQuery({
		queryKey: queryKeys.account.payments.balance(user?.id),
		queryFn: async () => {
			const res = await apiClient.getPaymentBalance();
			if (!res.success) throw new Error(res.error?.message || 'Failed to load balance');
			return res.data!;
		},
		enabled: !!user,
	});

	const historyQuery = useQuery({
		queryKey: queryKeys.account.payments.history(user?.id),
		queryFn: async () => {
			const res = await apiClient.getPaymentHistory();
			if (!res.success) throw new Error(res.error?.message || 'Failed to load history');
			return res.data!;
		},
		enabled: !!user,
	});

	const verifyMutation = useMutation({
		mutationFn: async (txHash: string) => {
			const res = await apiClient.verifyPayment(txHash);
			if (!res.success || !res.data) {
				throw new Error(res.error?.message || 'Verification failed');
			}
			return res.data;
		},
		onSuccess: (data) => {
			toast.success(`$${data.amountUsdc} USDC verified! New balance: $${data.newBalance.toFixed(2)}`);
			setManualTxHash('');
			void queryClient.invalidateQueries({ queryKey: queryKeys.account.payments.all() });
		},
		onError: (error) => {
			toast.error(error instanceof Error ? error.message : 'Verification failed');
		},
	});

	const walletAddress = walletQuery.data?.walletAddress ?? '';

	const handleMetaMaskPay = async () => {
		const amount = parseFloat(payAmount);
		if (!amount || amount <= 0 || !walletAddress) {
			toast.error('Enter a valid amount and ensure wallet is loaded');
			return;
		}

		const eth = (window as { ethereum?: { request: (args: { method: string; params?: unknown[] }) => Promise<string | string[]> } }).ethereum;
		if (!eth) {
			toast.error('MetaMask not detected. You can send USDC manually and submit the tx hash below.');
			return;
		}

		try {
			setPaying(true);
			// Request account access
			const accounts = await eth.request({ method: 'eth_requestAccounts' });
			const from = (accounts as string[])[0];

			// Switch to Base network if needed
			try {
				await eth.request({
					method: 'wallet_switchEthereumChain',
					params: [{ chainId: BASE_CHAIN_ID_HEX }],
				});
			} catch (switchError) {
				// Chain not added — add it
				if ((switchError as { code?: number }).code === 4902) {
					await eth.request({
						method: 'wallet_addEthereumChain',
						params: [{
							chainId: BASE_CHAIN_ID_HEX,
							chainName: 'Base',
							nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
							rpcUrls: ['https://mainnet.base.org'],
							blockExplorerUrls: ['https://basescan.org'],
						}],
					});
				} else {
					throw switchError;
				}
			}

			// Send USDC transfer
			const txHash = await eth.request({
				method: 'eth_sendTransaction',
				params: [{
					from,
					to: USDC_CONTRACT,
					data: encodeTransferCall(walletAddress, payAmount),
				}],
			});

			toast.success('Transaction sent! Verifying...');

			// Wait a few seconds for block confirmation, then verify
			await new Promise((r) => setTimeout(r, 8000));

			await verifyMutation.mutateAsync(txHash as string);
		} catch (error) {
			const msg = error instanceof Error ? error.message : 'Payment failed';
			if (msg.includes('User denied') || msg.includes('rejected')) {
				toast.error('Transaction rejected');
			} else {
				toast.error(msg);
			}
		} finally {
			setPaying(false);
		}
	};

	const handleManualVerify = () => {
		const hash = manualTxHash.trim();
		if (!hash || !hash.startsWith('0x')) {
			toast.error('Enter a valid transaction hash (starts with 0x)');
			return;
		}
		verifyMutation.mutate(hash);
	};

	const balance = balanceQuery.data?.balance ?? 0;
	const totalDeposited = balanceQuery.data?.totalDeposited ?? 0;
	const totalUsed = balanceQuery.data?.totalUsed ?? 0;
	const payments = historyQuery.data?.payments ?? [];

	return (
		<LayerCard id="billing">
			<LayerCard.Secondary className="font-funky-mono tracking-tighter">
				<div className="flex items-center gap-2">
					<Wallet className="size-4" />
					<span>Billing & Credits</span>
				</div>
			</LayerCard.Secondary>
			<LayerCard.Primary>
				<div className="grid gap-6">
					{/* Balance overview */}
					<div className="grid gap-1.5">
						<h4 className="text-sm font-medium text-kumo-default">
							Credit Balance
						</h4>
						<div className="flex items-baseline gap-2">
							<span className="text-3xl font-semibold font-funky-mono text-kumo-default">
								${balance.toFixed(2)}
							</span>
							<span className="text-sm text-kumo-subtle">
								credits remaining
							</span>
						</div>
						<div className="flex gap-4 text-xs text-kumo-subtle">
							<span>Total deposited: ${totalDeposited.toFixed(2)}</span>
							<span>Total used: ${totalUsed.toFixed(2)}</span>
						</div>
					</div>

					{/* Payment section */}
					<div className="grid gap-4">
						<h4 className="text-sm font-medium text-kumo-default">
							Add Credits — Pay with USDC on Base
						</h4>

						{/* Wallet address */}
						<div className="grid gap-2">
							<label className="text-xs text-kumo-subtle">
								Platform wallet address
							</label>
							<div className="flex items-center gap-2">
								<code className="flex-1 rounded-md bg-kumo-subtle px-3 py-2 text-xs break-all">
									{walletAddress || 'Loading...'}
								</code>
								{walletAddress && (
									<Button
										variant="secondary"
										size="sm"
										onClick={() => copyWallet(walletAddress)}
									>
										{copiedWallet ? 'Copied!' : 'Copy'}
									</Button>
								)}
							</div>
						</div>

						{/* Amount input + MetaMask pay */}
						<div className="flex flex-wrap items-end gap-2">
							<div className="grid gap-1.5 flex-1 min-w-[140px]">
								<label className="text-xs text-kumo-subtle">
									Amount (USDC)
								</label>
								<Input
									type="number"
									value={payAmount}
									onChange={(e) => setPayAmount(e.target.value)}
									placeholder="5"
									min="0.01"
									step="0.01"
								/>
							</div>
							<Button
								variant="primary"
								onClick={handleMetaMaskPay}
								disabled={paying || verifyMutation.isPending}
								className="gap-2"
							>
								{paying ? (
									<>
										<ArrowClockwise className="size-4 animate-spin" />
										Processing...
									</>
								) : (
									<>
										<Wallet className="size-4" />
										Pay with MetaMask
									</>
								)}
							</Button>
						</div>

						{/* Manual tx hash submission */}
						<div className="border-t pt-4 mt-2">
							<p className="text-xs text-kumo-subtle mb-2">
								Sent USDC manually? Paste your transaction hash to verify:
							</p>
							<div className="flex gap-2">
								<Input
									value={manualTxHash}
									onChange={(e) => setManualTxHash(e.target.value)}
									placeholder="0x..."
									className="flex-1"
								/>
								<Button
									variant="secondary"
									onClick={handleManualVerify}
									disabled={verifyMutation.isPending || !manualTxHash.trim()}
									className="gap-2"
								>
									{verifyMutation.isPending ? (
										<ArrowClockwise className="size-4 animate-spin" />
									) : (
										<ArrowRight className="size-4" />
									)}
									Verify
								</Button>
							</div>
						</div>
					</div>

					{/* Payment history */}
					{payments.length > 0 && (
						<div className="grid gap-2">
							<h4 className="text-sm font-medium text-kumo-default">
								Payment History
							</h4>
							<Table>
								<Table.Header>
									<Table.Row>
										<Table.Head>Amount</Table.Head>
										<Table.Head>Credits</Table.Head>
										<Table.Head>Status</Table.Head>
										<Table.Head>Date</Table.Head>
									</Table.Row>
								</Table.Header>
								<Table.Body>
									{payments.map((p) => (
										<Table.Row key={p.id}>
											<Table.Cell>${p.amountUsdc.toFixed(2)} USDC</Table.Cell>
											<Table.Cell>${p.creditsAdded.toFixed(2)}</Table.Cell>
											<Table.Cell>{p.status}</Table.Cell>
											<Table.Cell>
												{p.createdAt ? new Date(p.createdAt).toLocaleDateString() : '—'}
											</Table.Cell>
										</Table.Row>
									))}
								</Table.Body>
							</Table>
						</div>
					)}
				</div>
			</LayerCard.Primary>
		</LayerCard>
	);
}

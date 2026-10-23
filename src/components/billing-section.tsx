/**
 * Billing & Credits Section
 * Displays credit balance, Stripe card checkout, linked wallets for anti-sniping protection,
 * Base USDC payments via MetaMask, manual tx hash verification, and payment history.
 */

import { useState, useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
	Wallet,
	ArrowClockwise,
	ArrowRight,
	CreditCard,
	ShieldCheck,
	CheckCircle,
	Trash,
} from '@phosphor-icons/react';
import { Button, Input, LayerCard, Table, Badge } from '@cloudflare/kumo';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';
import { useAuth } from '@/contexts/auth-context';
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';

// Base mainnet chain ID (hex)
const BASE_CHAIN_ID_HEX = '0x2105';
// USDC on Base mainnet
const USDC_CONTRACT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

// Preset credit packages for Stripe checkout ($5 min everywhere)
const STRIPE_CREDIT_PACKS = [
	{ amount: 5, label: '$5', credits: '5 credits' },
	{ amount: 10, label: '$10', credits: '10 credits' },
	{ amount: 25, label: '$25', credits: '25 credits', popular: true },
	{ amount: 50, label: '$50', credits: '50 credits' },
	{ amount: 100, label: '$100', credits: '100 credits' },
];

// Decode an ABI-encoded transfer(address,uint256) call from the data field
function encodeTransferCall(to: string, amount: string): string {
	const selector = 'a9059cbb';
	const toPadded = to.toLowerCase().replace('0x', '').padStart(64, '0');
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
	const [linkingWallet, setLinkingWallet] = useState(false);
	const [stripeLoading, setStripeLoading] = useState<number | null>(null);

	const {
		copied: copiedWallet,
		copy: copyWallet,
	} = useCopyToClipboard();

	// Check URL params for Stripe return
	useEffect(() => {
		const searchParams = new URLSearchParams(window.location.search);
		const hash = window.location.hash;
		const hasPaymentSuccess =
			searchParams.get('payment') === 'success' ||
			hash.includes('payment=success');
		const hasPaymentCancel =
			searchParams.get('payment') === 'cancelled' ||
			hash.includes('payment=cancelled');
		const returnTo =
			searchParams.get('returnTo') ||
			new URLSearchParams(hash.split('?')[1] || '').get('returnTo');

		if (hasPaymentSuccess) {
			toast.success('Payment successful! Your credits have been updated.', {
				duration: 8000,
				action: returnTo
					? {
							label: 'Return to build',
							onClick: () => {
								window.location.href = returnTo;
							},
						}
					: undefined,
			});
			void queryClient.invalidateQueries({ queryKey: queryKeys.account.payments.all() });
			void queryClient.invalidateQueries({ queryKey: queryKeys.account.limits.all() });
			// Clean URL without reloading
			const cleanUrl = window.location.pathname + window.location.hash.split('?')[0];
			window.history.replaceState({}, document.title, cleanUrl);

			if (returnTo) {
				setTimeout(() => {
					window.location.href = returnTo;
				}, 2200);
			}
		} else if (hasPaymentCancel) {
			toast.info('Checkout cancelled. No charges were made.');
			const cleanUrl = window.location.pathname + window.location.hash.split('?')[0];
			window.history.replaceState({}, document.title, cleanUrl);
		}
	}, [queryClient]);

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

	const walletsQuery = useQuery({
		queryKey: queryKeys.account.payments.wallets(user?.id),
		queryFn: async () => {
			const res = await apiClient.getLinkedWallets();
			if (!res.success) throw new Error(res.error?.message || 'Failed to load wallets');
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

	const unlinkMutation = useMutation({
		mutationFn: async (address: string) => {
			const res = await apiClient.unlinkWallet(address);
			if (!res.success) {
				throw new Error(res.error?.message || 'Failed to unlink wallet');
			}
			return res.data;
		},
		onSuccess: () => {
			toast.success('Wallet unlinked');
			void queryClient.invalidateQueries({ queryKey: queryKeys.account.payments.wallets(user?.id) });
		},
		onError: (error) => {
			toast.error(error instanceof Error ? error.message : 'Failed to unlink wallet');
		},
	});

	// Handle Stripe Checkout purchase
	const handleStripeCheckout = async (amountUsd: number) => {
		try {
			setStripeLoading(amountUsd);
			const searchParams = new URLSearchParams(window.location.search);
			const hash = window.location.hash;
			const returnTo = searchParams.get('returnTo') || new URLSearchParams(hash.split('?')[1] || '').get('returnTo') || undefined;
			const res = await apiClient.createStripeCheckout(amountUsd, returnTo);
			if (!res.success || !res.data?.url) {
				throw new Error(res.error?.message || 'Could not initialize checkout');
			}
			window.location.href = res.data.url;
		} catch (error) {
			toast.error(error instanceof Error ? error.message : 'Checkout failed');
			setStripeLoading(null);
		}
	};

	// Link MetaMask wallet by signing a verification message (Anti-sniping protection)
	const handleLinkWallet = async () => {
		if (!user?.id) {
			toast.error('Please log in first');
			return;
		}

		const eth = (window as { ethereum?: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> } }).ethereum;
		if (!eth) {
			toast.error('MetaMask or Web3 wallet extension not detected');
			return;
		}

		try {
			setLinkingWallet(true);
			const accounts = (await eth.request({ method: 'eth_requestAccounts' })) as string[];
			const address = accounts[0];
			if (!address) throw new Error('No account selected');

			// Fetch one-time challenge nonce from server
			const nonceRes = await apiClient.getWalletNonce();
			if (!nonceRes.success || !nonceRes.data?.nonce) {
				throw new Error(nonceRes.error?.message || 'Failed to obtain security nonce');
			}
			const nonce = nonceRes.data.nonce;
			const timestamp = Date.now();
			const message = `Masidy (masidy.dev): Link wallet ${address.toLowerCase()} to account ${user.id} with nonce ${nonce} at ${timestamp}`;

			const signature = (await eth.request({
				method: 'personal_sign',
				params: [message, address],
			})) as string;

			const res = await apiClient.linkWallet({
				address,
				message,
				signature,
			});

			if (!res.success) {
				throw new Error(res.error?.message || 'Failed to link wallet');
			}

			toast.success(`Wallet ${address.slice(0, 6)}...${address.slice(-4)} linked successfully!`);
			void queryClient.invalidateQueries({ queryKey: queryKeys.account.payments.wallets(user.id) });
		} catch (error) {
			const msg = error instanceof Error ? error.message : 'Failed to link wallet';
			if (msg.includes('User denied') || msg.includes('rejected')) {
				toast.error('Signature request rejected');
			} else {
				toast.error(msg);
			}
		} finally {
			setLinkingWallet(false);
		}
	};

	const walletAddress = walletQuery.data?.walletAddress ?? '';
	const linkedWallets = walletsQuery.data?.wallets ?? [];

	const handleMetaMaskPay = async () => {
		const amount = parseFloat(payAmount);
		if (!amount || amount < 5 || !walletAddress) {
			toast.error('Minimum payment is $5.00 USDC');
			return;
		}

		const eth = (window as { ethereum?: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> } }).ethereum;
		if (!eth) {
			toast.error('MetaMask not detected. You can send USDC manually and submit the tx hash below.');
			return;
		}

		try {
			setPaying(true);
			const accounts = (await eth.request({ method: 'eth_requestAccounts' })) as string[];
			const from = accounts[0];

			// Check if wallet is linked; if not, prompt user to link it first
			const isLinked = linkedWallets.some((w) => w.address.toLowerCase() === from.toLowerCase());
			if (!isLinked) {
				toast.info('Linking your wallet first to protect your deposit...');
				const nonceRes = await apiClient.getWalletNonce();
				if (!nonceRes.success || !nonceRes.data?.nonce) {
					throw new Error(nonceRes.error?.message || 'Failed to obtain security nonce');
				}
				const nonce = nonceRes.data.nonce;
				const timestamp = Date.now();
				const message = `Masidy (masidy.dev): Link wallet ${from.toLowerCase()} to account ${user?.id} with nonce ${nonce} at ${timestamp}`;
				const signature = (await eth.request({
					method: 'personal_sign',
					params: [message, from],
				})) as string;

				const linkRes = await apiClient.linkWallet({
					address: from,
					message,
					signature,
				});

				if (!linkRes.success) {
					throw new Error(linkRes.error?.message || 'Could not link wallet');
				}
				void queryClient.invalidateQueries({ queryKey: queryKeys.account.payments.wallets(user?.id) });
			}

			// Switch to Base network if needed
			try {
				await eth.request({
					method: 'wallet_switchEthereumChain',
					params: [{ chainId: BASE_CHAIN_ID_HEX }],
				});
			} catch (switchError) {
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
			const txHash = (await eth.request({
				method: 'eth_sendTransaction',
				params: [{
					from,
					to: USDC_CONTRACT,
					data: encodeTransferCall(walletAddress, payAmount),
				}],
			})) as string;

			toast.success('Transaction broadcasted! Waiting for Base confirmation...');

			// Wait a few seconds for block confirmation, then verify
			await new Promise((r) => setTimeout(r, 6000));
			await verifyMutation.mutateAsync(txHash);
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
				<div className="grid gap-8">
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

					{/* Option 1: Card & Apple Pay (Instant via Stripe) */}
					<div className="grid gap-3 rounded-lg border border-kumo-subtle/50 p-4 bg-kumo-subtle/20">
						<div className="flex items-center justify-between">
							<div className="flex items-center gap-2">
								<CreditCard className="size-5 text-kumo-default" />
								<div>
									<h4 className="text-sm font-semibold text-kumo-default">
										Pay with Card or Apple Pay
									</h4>
									<p className="text-xs text-kumo-subtle">
										Instant top-up powered by Stripe
									</p>
								</div>
							</div>
							<Badge variant="secondary">Instant</Badge>
						</div>

						<div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-2">
							{STRIPE_CREDIT_PACKS.map((pack) => (
								<Button
									key={pack.amount}
									variant={pack.popular ? 'primary' : 'secondary'}
									size="sm"
									disabled={stripeLoading !== null}
									onClick={() => handleStripeCheckout(pack.amount)}
									className="flex flex-col items-center justify-center py-4 h-auto"
								>
									{stripeLoading === pack.amount ? (
										<ArrowClockwise className="size-4 animate-spin my-1" />
									) : (
										<>
											<span className="text-base font-bold font-funky-mono">{pack.label}</span>
											<span className="text-[11px] opacity-80">{pack.credits}</span>
										</>
									)}
								</Button>
							))}
						</div>
					</div>

					{/* Option 2: USDC on Base (Web3) */}
					<div className="grid gap-4 rounded-lg border border-kumo-subtle/50 p-4">
						<div className="flex items-center justify-between">
							<div className="flex items-center gap-2">
								<Wallet className="size-5 text-kumo-default" />
								<div>
									<h4 className="text-sm font-semibold text-kumo-default">
										Pay with USDC on Base
									</h4>
									<p className="text-xs text-kumo-subtle">
										Zero-fee stablecoin transfers via Base mainnet
									</p>
								</div>
							</div>
							<Badge variant="outline">Base Mainnet</Badge>
						</div>

						{/* Anti-Sniping Protection / Linked Wallets */}
						<div className="rounded-md bg-kumo-subtle/30 p-3 text-xs">
							<div className="flex items-center justify-between mb-2">
								<div className="flex items-center gap-1.5 font-medium text-kumo-default">
									<ShieldCheck className="size-4 text-emerald-500" />
									<span>Anti-Sniping Protection</span>
								</div>
								<Button
									variant="outline"
									size="sm"
									onClick={handleLinkWallet}
									disabled={linkingWallet}
									className="text-xs h-7 gap-1.5"
								>
									{linkingWallet ? (
										<ArrowClockwise className="size-3.5 animate-spin" />
									) : (
										<CheckCircle className="size-3.5" />
									)}
									Link MetaMask Wallet
								</Button>
							</div>

							{linkedWallets.length > 0 ? (
								<div className="space-y-1.5 pt-1">
									<span className="text-[11px] text-kumo-subtle">Your verified deposit wallets:</span>
									<div className="flex flex-wrap gap-1.5">
										{linkedWallets.map((w) => (
											<div
												key={w.id}
												className="flex items-center gap-1.5 bg-kumo-subtle/70 px-2 py-1 rounded text-[11px] font-funky-mono"
											>
												<span>{w.address.slice(0, 6)}...{w.address.slice(-4)}</span>
												<button
													onClick={() => unlinkMutation.mutate(w.address)}
													className="text-kumo-subtle hover:text-red-500 transition-colors"
													title="Unlink wallet"
												>
													<Trash className="size-3" />
												</button>
											</div>
										))}
									</div>
								</div>
							) : (
								<p className="text-kumo-subtle text-[11px]">
									No wallet linked yet. Link your MetaMask address so that only you can claim your on-chain USDC transfers.
									(Note: EIP-191 personal signatures are required; smart contract wallets like Safe or Coinbase Smart Wallet are not currently supported for linking).
								</p>
							)}
						</div>

						{/* Platform wallet address */}
						<div className="grid gap-2">
							<label className="text-xs text-kumo-subtle">
								Platform recipient address (Base)
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
						<div className="border-t border-kumo-subtle/50 pt-3 mt-1">
							<p className="text-xs text-kumo-subtle mb-2">
								Sent USDC from your linked wallet? Paste the transaction hash to verify:
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
										<Table.Head>Method</Table.Head>
										<Table.Head>Amount</Table.Head>
										<Table.Head>Credits</Table.Head>
										<Table.Head>Status</Table.Head>
										<Table.Head>Date</Table.Head>
									</Table.Row>
								</Table.Header>
								<Table.Body>
									{payments.map((p) => {
										const isStripe = p.txHash?.startsWith('cs_') || p.id?.includes('stripe');
										return (
											<Table.Row key={p.id}>
												<Table.Cell>
													<span className="flex items-center gap-1.5 text-xs">
														{isStripe ? (
															<>
																<CreditCard className="size-3.5 text-blue-500" />
																Card (Stripe)
															</>
														) : (
															<>
																<Wallet className="size-3.5 text-orange-500" />
																Base USDC
															</>
														)}
													</span>
												</Table.Cell>
												<Table.Cell>${p.amountUsdc.toFixed(2)}</Table.Cell>
												<Table.Cell>${p.creditsAdded.toFixed(2)}</Table.Cell>
												<Table.Cell>
													<Badge variant="secondary">
														{p.status}
													</Badge>
												</Table.Cell>
												<Table.Cell>
													{p.createdAt ? new Date(p.createdAt).toLocaleDateString() : '—'}
												</Table.Cell>
											</Table.Row>
										);
									})}
								</Table.Body>
							</Table>
						</div>
					)}
				</div>
			</LayerCard.Primary>
		</LayerCard>
	);
}

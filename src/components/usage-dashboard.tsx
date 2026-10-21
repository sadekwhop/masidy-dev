/**
 * Usage Dashboard — shows credit deductions and cost breakdown.
 * Embedded as a tab in the profile page.
 */

import { useQuery } from '@tanstack/react-query';
import { ChartBar, Lightning, Coins } from '@phosphor-icons/react';
import { LayerCard, Table, Empty } from '@cloudflare/kumo';
import { apiClient } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';
import { useAuth } from '@/contexts/auth-context';

const ACTION_LABELS: Record<string, string> = {
	think_agent: 'Think Agent',
	codegen: 'Code Generation',
	app_create: 'App Creation',
	mcp_tool: 'MCP Tool Call',
	deployment: 'Deployment',
};

export function UsageDashboard() {
	const { user } = useAuth();

	const usageQuery = useQuery({
		queryKey: queryKeys.account.payments.usage(user?.id),
		queryFn: async () => {
			const res = await apiClient.getUsageHistory();
			if (!res.success) throw new Error(res.error?.message || 'Failed to load usage');
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

	const balance = balanceQuery.data?.balance ?? 0;
	const totalSpent = usageQuery.data?.totalSpent ?? 0;
	const byAction = usageQuery.data?.byAction ?? [];
	const transactions = usageQuery.data?.transactions ?? [];

	return (
		<div className="grid gap-4">
			{/* Summary cards */}
			<div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
				<div className="rounded-xl px-4 py-4 bg-kumo-base ring ring-kumo-line/70">
					<div className="flex items-center gap-2 mb-1">
						<Coins className="size-4 text-kumo-brand" weight="duotone" />
						<p className="text-xs text-kumo-subtle">Balance</p>
					</div>
					<p className="text-2xl font-semibold tabular-nums text-kumo-strong">
						${balance.toFixed(2)}
					</p>
				</div>
				<div className="rounded-xl px-4 py-4 bg-kumo-base ring ring-kumo-line/70">
					<div className="flex items-center gap-2 mb-1">
						<Lightning className="size-4 text-amber-500" weight="duotone" />
						<p className="text-xs text-kumo-subtle">Total Spent</p>
					</div>
					<p className="text-2xl font-semibold tabular-nums text-kumo-strong">
						${totalSpent.toFixed(2)}
					</p>
				</div>
				<div className="rounded-xl px-4 py-4 bg-kumo-base ring ring-kumo-line/70">
					<div className="flex items-center gap-2 mb-1">
						<ChartBar className="size-4 text-teal-500" weight="duotone" />
						<p className="text-xs text-kumo-subtle">Actions</p>
					</div>
					<p className="text-2xl font-semibold tabular-nums text-kumo-strong">
						{byAction.reduce((sum, a) => sum + a.count, 0)}
					</p>
				</div>
			</div>

			{/* Cost breakdown by action */}
			{byAction.length > 0 && (
				<LayerCard>
					<LayerCard.Secondary className="font-funky-mono tracking-tighter">
						Cost breakdown
					</LayerCard.Secondary>
					<LayerCard.Primary>
						<Table>
							<Table.Header>
								<Table.Row>
									<Table.Head>Action</Table.Head>
									<Table.Head>Calls</Table.Head>
									<Table.Head>Actual Cost</Table.Head>
									<Table.Head>Charged (2x)</Table.Head>
								</Table.Row>
							</Table.Header>
							<Table.Body>
								{byAction.map((item) => (
									<Table.Row key={item.action}>
										<Table.Cell>
											{ACTION_LABELS[item.action] ?? item.action}
										</Table.Cell>
										<Table.Cell>{item.count}</Table.Cell>
										<Table.Cell>${item.totalActual.toFixed(4)}</Table.Cell>
										<Table.Cell>${item.totalCharged.toFixed(4)}</Table.Cell>
									</Table.Row>
								))}
							</Table.Body>
						</Table>
					</LayerCard.Primary>
				</LayerCard>
			)}

			{/* Recent transactions */}
			{transactions.length > 0 ? (
				<LayerCard>
					<LayerCard.Secondary className="font-funky-mono tracking-tighter">
						Recent usage
					</LayerCard.Secondary>
					<LayerCard.Primary>
						<Table>
							<Table.Header>
								<Table.Row>
									<Table.Head>Action</Table.Head>
									<Table.Head>Charged</Table.Head>
									<Table.Head>Balance After</Table.Head>
									<Table.Head>Date</Table.Head>
								</Table.Row>
							</Table.Header>
							<Table.Body>
								{transactions.slice(0, 20).map((t) => (
									<Table.Row key={t.id}>
										<Table.Cell>
											{ACTION_LABELS[t.action] ?? t.action}
										</Table.Cell>
										<Table.Cell>${t.chargedCost.toFixed(4)}</Table.Cell>
										<Table.Cell>${t.creditsAfter.toFixed(2)}</Table.Cell>
										<Table.Cell>
											{t.createdAt ? new Date(t.createdAt).toLocaleDateString() : '—'}
										</Table.Cell>
									</Table.Row>
								))}
							</Table.Body>
						</Table>
					</LayerCard.Primary>
				</LayerCard>
			) : (
				!usageQuery.isLoading && (
					<Empty
						size="sm"
						icon={<ChartBar size={40} className="text-kumo-inactive" weight="duotone" />}
						title="No usage yet"
						description="Your credit deductions will appear here once you start using masidy."
					/>
				)
			)}
		</div>
	);
}

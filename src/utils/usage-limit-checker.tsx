/**
 * Usage Limit Checker
 * Validates usage limits before sending prompts and shows appropriate dialogs
 */

import { UsageSummary } from '@/hooks/use-limits';
import type { CloudflareDeploymentErrorCode } from '@/api-types';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { AlertCircle } from 'lucide-react';
import { useNavigate } from 'react-router';

export interface LimitCheckDialogResult {
	canProceed: boolean;
	dialogComponent?: React.ReactElement;
}


export interface UsageLimitDialogOptions {
	onClose: () => void;
	navigate: (path: string) => void;
	currentBalance?: number;
	costEstimate?: number;
	customMessage?: string;
	returnUrl?: string;
}

export function createUsageLimitDialog(options: UsageLimitDialogOptions): React.ReactElement {
	const { onClose, navigate, currentBalance, costEstimate = 0.15, customMessage, returnUrl } = options;
	const billingUrl = returnUrl
		? `/settings#billing?returnTo=${encodeURIComponent(returnUrl)}`
		: '/settings#billing';

	return (
		<Dialog open={true} onOpenChange={onClose}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<div className="mb-2">
						<AlertCircle className="h-10 w-10 text-amber-500" />
					</div>
					<DialogTitle className="text-xl">
						{customMessage?.includes('already in progress')
							? 'Build already in progress'
							: 'Credits needed to continue'}
					</DialogTitle>
					<DialogDescription className="pt-2 text-sm text-text-secondary leading-relaxed">
						{customMessage ||
							"You don't have enough credits to start or continue this action. Top up with credit card (Stripe) or USDC on Base to keep building."}
					</DialogDescription>
				</DialogHeader>

				<div className="my-3 p-3 rounded-lg bg-kumo-elevated/50 border border-kumo-line text-xs space-y-1.5">
					<div className="flex justify-between items-center text-text-secondary">
						<span>Current balance:</span>
						<span className="font-semibold text-text-primary">
							${(currentBalance ?? 0).toFixed(2)}
						</span>
					</div>
					<div className="flex justify-between items-center text-text-secondary">
						<span>Estimated action cost:</span>
						<span className="font-semibold text-text-primary">
							~${costEstimate.toFixed(2)}
						</span>
					</div>
					<div className="pt-1 border-t border-kumo-line/50 text-[11px] text-text-tertiary">
						Policy: You only pay for completed builds. Failed or cancelled generations never deduct credits.
					</div>
				</div>

				<DialogFooter className="sm:justify-start gap-2">
					<Button
						type="button"
						onClick={() => {
							onClose();
							navigate(billingUrl);
						}}
						className="w-full sm:w-auto bg-brand-primary hover:bg-brand-primary/90 text-white font-medium"
					>
						Buy credits
					</Button>
					<Button
						type="button"
						variant="outline"
						onClick={onClose}
						className="w-full sm:w-auto"
					>
						Close
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function createPublishingUnavailableDialog(
	onClose: () => void,
): React.ReactElement {
	return (
		<Dialog open={true} onOpenChange={onClose}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<div className="mb-2">
						<AlertCircle className="h-10 w-10 text-text-tertiary" />
					</div>
					<DialogTitle className="text-xl">
						Publishing isn't available yet
					</DialogTitle>
					<DialogDescription className="pt-2 text-sm">
						Masidy-hosted app publishing is still being set up.
						Please try again later.
					</DialogDescription>
				</DialogHeader>
				<DialogFooter className="sm:justify-start gap-2">
					<Button
						type="button"
						onClick={onClose}
						className="w-full sm:w-auto bg-brand-primary hover:bg-brand-primary/90 text-white"
					>
						Got it
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/**
 * Replace retired customer-account deployment prompts with Masidy messaging.
 */
export function getDeployGateDialog(
	code: CloudflareDeploymentErrorCode,
	onClose: () => void
): React.ReactElement | null {
	switch (code) {
		case 'cloudflare_not_connected':
		case 'cloudflare_not_configured':
			return createPublishingUnavailableDialog(onClose);
		default:
			return null;
	}
}

/**
 * Check if user can send a prompt and return appropriate dialog if blocked
 */
export function checkCanSendPrompt(
	limitsData: UsageSummary | null,
	loading: boolean,
	onClose: () => void,
	navigate: ReturnType<typeof useNavigate>,
	returnUrl?: string,
): LimitCheckDialogResult {
	if (loading || !limitsData) {
		return { canProceed: true };
	}

	const { limitCheck } = limitsData;

	if (limitCheck.withinLimits) {
		return { canProceed: true };
	}

	const balance = limitsData.cloudflareCredits?.credits ?? 0;

	return {
		canProceed: false,
		dialogComponent: createUsageLimitDialog({
			onClose,
			navigate,
			currentBalance: balance,
			costEstimate: 0.15,
			customMessage: limitCheck.message,
			returnUrl,
		}),
	};
}

/**
 * Get appropriate dialog for backend limit error
 */
export function getBackendLimitDialog(
	limitsData: UsageSummary | null,
	onClose: () => void,
	navigate: ReturnType<typeof useNavigate>,
	customMessage?: string,
	returnUrl?: string,
): LimitCheckDialogResult {
	const balance = limitsData?.cloudflareCredits?.credits ?? 0;

	return {
		canProceed: false,
		dialogComponent: createUsageLimitDialog({
			onClose,
			navigate,
			currentBalance: balance,
			costEstimate: 0.15,
			customMessage,
			returnUrl,
		}),
	};
}

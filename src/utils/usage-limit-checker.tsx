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
import { MINIMUM_CLOUDFLARE_BALANCE } from '../../shared/constants/limits';

export interface LimitCheckDialogResult {
	canProceed: boolean;
	dialogComponent?: React.ReactElement;
}


function createUsageLimitDialog(onClose: () => void): React.ReactElement {
	return (
		<Dialog open={true} onOpenChange={onClose}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<div className="mb-2">
						<AlertCircle className="h-10 w-10 text-text-tertiary" />
					</div>
					<DialogTitle className="text-xl">
						Usage limit reached
					</DialogTitle>
					<DialogDescription className="pt-2 text-sm">
						You've reached your current usage limit. Masidy
						pay-as-you-go billing is coming soon; please try again
						later.
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
	onClose: () => void
): LimitCheckDialogResult {
	// If loading or no data, allow proceed (optimistic)
	if (loading || !limitsData) {
		return { canProceed: true };
	}

	const { limitCheck, hasUserToken, hasCloudflareConfigured, cloudflareCredits } = limitsData;

	// If within limits, allow proceed
	if (limitCheck.withinLimits) {
		return { canProceed: true };
	}

	// Free limits are exhausted, check Cloudflare status
	
	// Case 1: No Cloudflare token connected
	if (!hasUserToken) {
		return {
			canProceed: false,
			dialogComponent: createUsageLimitDialog(onClose),
		};
	}

	// Case 2: Has token but not configured (no AI Gateway setup)
	if (hasUserToken && !hasCloudflareConfigured) {
		return {
			canProceed: false,
			dialogComponent: createUsageLimitDialog(onClose),
		};
	}

	// Case 3: Configured but insufficient credits
	if (hasUserToken && hasCloudflareConfigured) {
		const credits = cloudflareCredits?.credits ?? 0;
		
		if (credits < MINIMUM_CLOUDFLARE_BALANCE) {
			return {
				canProceed: false,
				dialogComponent: createUsageLimitDialog(onClose),
			};
		}
	}

	// If we got here, user has token, is configured, and has enough credits
	return { canProceed: true };
}

/**
 * Get appropriate dialog for backend limit error
 * Backend sends generic USAGE_LIMIT_EXCEEDED - frontend uses its own limitsData to determine which dialog
 * Reuses the same logic and dialogs as checkCanSendPrompt for consistency
 */
export function getBackendLimitDialog(
	limitsData: UsageSummary | null,
	onClose: () => void
): LimitCheckDialogResult {
	// Use the same logic as checkCanSendPrompt, but don't check if within limits
	// (backend already determined limits are exceeded)
	if (!limitsData) {
		return { canProceed: true };
	}

	const { hasUserToken, hasCloudflareConfigured, cloudflareCredits } = limitsData;

	// Case 1: No Cloudflare token connected
	if (!hasUserToken) {
		return {
			canProceed: false,
			dialogComponent: createUsageLimitDialog(onClose),
		};
	}

	// Case 2: Has token but not configured (no AI Gateway setup)
	if (hasUserToken && !hasCloudflareConfigured) {
		return {
			canProceed: false,
			dialogComponent: createUsageLimitDialog(onClose),
		};
	}

	// Case 3: Configured but insufficient credits
	if (hasUserToken && hasCloudflareConfigured) {
		const credits = cloudflareCredits?.credits ?? 0;
		
		if (credits < MINIMUM_CLOUDFLARE_BALANCE) {
			return {
				canProceed: false,
				dialogComponent: createUsageLimitDialog(onClose),
			};
		}
	}

	// Unknown state - should not block
	return { canProceed: true };
}

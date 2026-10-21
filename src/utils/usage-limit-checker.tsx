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


function createUsageLimitDialog(onClose: () => void, navigate: (path: string) => void): React.ReactElement {
	return (
		<Dialog open={true} onOpenChange={onClose}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<div className="mb-2">
						<AlertCircle className="h-10 w-10 text-text-tertiary" />
					</div>
					<DialogTitle className="text-xl">
						Daily limit reached
					</DialogTitle>
					<DialogDescription className="pt-2 text-sm">
						You've used your 100 free daily credits. Add USDC credits
						to keep building — your usage resets every day at midnight UTC.
					</DialogDescription>
				</DialogHeader>
				<DialogFooter className="sm:justify-start gap-2">
					<Button
						type="button"
						onClick={() => { onClose(); navigate('/settings#billing'); }}
						className="w-full sm:w-auto bg-brand-primary hover:bg-brand-primary/90 text-white"
					>
						Add credits
					</Button>
					<Button
						type="button"
						variant="outline"
						onClick={onClose}
						className="w-full sm:w-auto"
					>
						Later
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
): LimitCheckDialogResult {
	if (loading || !limitsData) {
		return { canProceed: true };
	}

	const { limitCheck } = limitsData;

	if (limitCheck.withinLimits) {
		return { canProceed: true };
	}

	return {
		canProceed: false,
		dialogComponent: createUsageLimitDialog(onClose, navigate),
	};
}

/**
 * Get appropriate dialog for backend limit error
 */
export function getBackendLimitDialog(
	limitsData: UsageSummary | null,
	onClose: () => void,
	navigate: ReturnType<typeof useNavigate>,
): LimitCheckDialogResult {
	if (!limitsData) {
		return { canProceed: true };
	}

	const { limitCheck } = limitsData;
	if (limitCheck.withinLimits) {
		return { canProceed: true };
	}

	return {
		canProceed: false,
		dialogComponent: createUsageLimitDialog(onClose, navigate),
	};
}

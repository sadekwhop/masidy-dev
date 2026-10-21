import { useState, useMemo, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { type UsageSummary, type LimitConfig } from '@/hooks/use-limits';
import { CREDITS_BANNER_THRESHOLD } from '../../shared/constants/limits';

interface CreditsBannerProps {
	limitsData?: UsageSummary | null;
	className?: string;
	children?: ReactNode;
	/** Border-radius (in px) of the encapsulated element — banner adds matching bottom padding so it tucks flush beneath it. */
	radius?: number;
}

function getResetDate(window: LimitWindow, periodSeconds?: number): Date | null {
	const now = new Date();
	switch (window) {
		case 'daily': {
			const d = new Date(now);
			d.setDate(d.getDate() + 1);
			d.setHours(0, 0, 0, 0);
			return d;
		}
		case 'weekly': {
			const d = new Date(now);
			const daysUntilMonday = (8 - d.getDay()) % 7 || 7;
			d.setDate(d.getDate() + daysUntilMonday);
			d.setHours(0, 0, 0, 0);
			return d;
		}
		case 'monthly':
			return new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0);
		case 'rolling':
			return periodSeconds ? new Date(now.getTime() + periodSeconds * 1000) : null;
		case 'lifetime':
		default:
			return null;
	}
}

function formatResetIn(target: Date): string {
	const diffMs = target.getTime() - Date.now();
	if (diffMs <= 0) return 'soon';
	const minutes = Math.floor(diffMs / 60000);
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);
	if (days >= 1) return `${days}d`;
	if (hours >= 1) return `${hours}h`;
	return `${Math.max(1, minutes)}m`;
}

type LimitWindow = 'daily' | 'weekly' | 'monthly' | 'lifetime' | 'rolling';

interface BannerInfo {
	content: ReactNode;
}

/** Resolve the display reset date, preferring server-provided `resetAt`. */
function resolveResetDate(limit: LimitConfig): Date | null {
	return limit.resetAt
		? new Date(limit.resetAt)
		: getResetDate(limit.window as LimitWindow, limit.periodSeconds);
}

function useBannerInfo(limitsData?: UsageSummary | null): { bannerInfo: BannerInfo | null; dismiss: () => void } {
	const [isDismissed, setIsDismissed] = useState(false);

	const bannerInfo = useMemo<BannerInfo | null>(() => {
		if (isDismissed || !limitsData || limitsData.config?.unlimited) return null;
		const { config, usage } = limitsData;
		const limit = config?.limit;
		if (!limit) return null;

		const current = usage[limit.type]?.[limit.window] || 0;
		const remaining = Math.max(0, limit.maxValue - current);
		const resetDate = resolveResetDate(limit);

		// Hide banner when remaining free credits are above the threshold
		if (remaining >= CREDITS_BANNER_THRESHOLD) return null;

		if (remaining <= 0) {
			return {
				content:
					'Included usage exhausted · pay-as-you-go billing is coming soon',
			};
		}

		const formatNumber = (value: number) => {
			const rounded = Math.round(value * 10) / 10;
			return Number.isInteger(rounded) ? rounded.toString() : rounded.toFixed(1);
		};
		const formatValue = (value: number) => {
			switch (limit.type) {
				case 'prompts': return formatNumber(value);
				case 'credits': return formatNumber(value);
				case 'tokens': return `${(value / 1000).toFixed(0)}K`;
				case 'cost': return `$${value.toFixed(2)}`;
				default: return formatNumber(value);
			}
		};

		const unit = (() => {
			switch (limit.type) {
				case 'prompts': return remaining === 1 ? 'free prompt' : 'free prompts';
				case 'credits': return remaining === 1 ? 'free credit' : 'free credits';
				case 'tokens': return 'free tokens';
				case 'cost': return 'of free credit';
				default: return 'free';
			}
		})();

		const resetVerb = limit.window === 'rolling' && !limit.resetAt ? 'resets within' : 'resets in';
		const resetText = resetDate ? ` · ${resetVerb} ${formatResetIn(resetDate)}` : '';

		return {
			content: `${formatValue(remaining)} ${unit} remaining${resetText}`.trim(),
		};
	}, [limitsData, isDismissed]);

	return { bannerInfo, dismiss: () => setIsDismissed(true) };
}

export function CreditsBanner({ limitsData, className, children, radius = 12 }: CreditsBannerProps) {
	const { bannerInfo, dismiss } = useBannerInfo(limitsData);

	if (children) {
		return (
			<div className={`flex flex-col ${className ?? ''}`}>
				{bannerInfo && (
					<BannerContent
						bannerInfo={bannerInfo}
						onDismiss={dismiss}
						style={{ paddingBottom: radius + 6, marginBottom: -radius, borderTopLeftRadius: radius, borderTopRightRadius: radius, borderBottomLeftRadius: 0, borderBottomRightRadius: 0 }}
					/>
				)}
				{children}
			</div>
		);
	}

	if (!bannerInfo) return null;

	return (
		<BannerContent
			bannerInfo={bannerInfo}
			onDismiss={dismiss}
			className={className}
		/>
	);
}

function BannerContent({
	bannerInfo,
	onDismiss,
	className,
	style,
}: {
	bannerInfo: BannerInfo;
	onDismiss: () => void;
	className?: string;
	style?: React.CSSProperties;
}) {
	return (
		<div
			style={style}
			className={`flex items-center justify-between px-3 py-1.5 bg-kumo-elevated border border-brand-primary/30 shadow-md ${style?.borderTopLeftRadius !== undefined ? '' : 'rounded-lg'} ${className ?? ''}`}
		>
			<span className="text-xs font-medium text-kumo-brand-primary">
				{bannerInfo.content}
			</span>
			<div className="flex items-center gap-1.5">
				<button
					type="button"
					onClick={onDismiss}
					className="p-0.5 rounded hover:bg-kumo-base text-kumo-subtle hover:text-text-primary transition-colors"
				>
					<X className="size-3.5" />
				</button>
			</div>
		</div>
	);
}

import { cn } from '@cloudflare/kumo';

interface MasidyLogoProps {
	className?: string;
	markClassName?: string;
	collapsed?: boolean;
}

export function MasidyLogo({
	className,
	markClassName,
	collapsed = false,
}: MasidyLogoProps) {
	return (
		<span className={cn('inline-flex min-w-0 items-center gap-2', className)}>
			<span
				aria-hidden="true"
				className={cn('relative block shrink-0', markClassName ?? 'size-7')}
			>
				<img
					src="/brand/masidy-mark-light.png"
					alt=""
					className="size-full dark:hidden"
				/>
				<img
					src="/brand/masidy-mark.png"
					alt=""
					className="hidden size-full dark:block"
				/>
			</span>
			{!collapsed && (
				<span className="truncate text-base font-bold tracking-[0.12em]">
					MASIDY
				</span>
			)}
		</span>
	);
}

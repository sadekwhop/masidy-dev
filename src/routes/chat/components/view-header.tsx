import { cn } from '@cloudflare/kumo';
import type { ReactNode } from 'react';
import { ViewModeSwitch } from './view-mode-switch';
import { HEADER_STYLES } from './view-header-styles';
import type { ProjectType } from '@/api-types';

interface ViewHeaderProps {
	view: 'preview' | 'editor' | 'docs' | 'blueprint' | 'presentation' | 'database' | 'repo';
	onViewChange: (mode: 'preview' | 'editor' | 'docs' | 'blueprint' | 'presentation' | 'database' | 'repo') => void;
	previewAvailable: boolean;
	showTooltip: boolean;
	hasDocumentation: boolean;
	previewUrl?: string;
	centerContent?: ReactNode;
	rightActions?: ReactNode;
	projectType?: ProjectType;
	databaseAvailable?: boolean;
	repoAvailable?: boolean;
}

export function ViewHeader({
	view,
	onViewChange,
	previewAvailable,
	showTooltip,
    hasDocumentation,
	previewUrl,
	centerContent,
	rightActions,
	projectType,
	databaseAvailable,
	repoAvailable,
}: ViewHeaderProps) {
	return (
		<div className={cn(
			'min-h-10 bg-kumo-elevated border-b flex items-center justify-between px-2 gap-2 w-full min-w-0',
			HEADER_STYLES.padding
		)}>
			<div className="flex items-center shrink-0">
				<ViewModeSwitch
					view={view}
					onChange={onViewChange}
					previewAvailable={previewAvailable}
					showTooltip={showTooltip}
					hasDocumentation={hasDocumentation}
					previewUrl={previewUrl}
					projectType={projectType}
					databaseAvailable={databaseAvailable}
					repoAvailable={repoAvailable}
				/>
			</div>
			<div className="hidden sm:flex min-w-0 flex-1 items-center justify-center truncate px-2">
				{centerContent}
			</div>
			<div className="flex items-center justify-end shrink-0 gap-1">
				{rightActions}
			</div>
		</div>
	);
}

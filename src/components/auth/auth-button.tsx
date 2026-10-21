/**
 * Auth Button
 * Account menu for authenticated users
 */

import { useNavigate } from 'react-router';
import { cn, Button, DropdownMenu } from '@cloudflare/kumo';
import { useAuth } from '../../contexts/auth-context';
import { getInitials } from '@/lib/utils';
import { Avatar, AvatarFallback, AvatarImage } from '../ui/avatar';
import { Skeleton } from '../ui/skeleton';
import { GearIcon, SignOutIcon, UserIcon } from '@phosphor-icons/react';

interface AuthButtonProps {
	className?: string;
	display?: 'icon' | 'sidebar';
}

export function AuthButton({ className, display = 'icon' }: AuthButtonProps) {
	const { user, isAuthenticated, isLoading, logout } = useAuth();

	const navigate = useNavigate();

	if (isLoading) {
		return <Skeleton className="w-10 h-10 rounded-full" />;
	}

	if (!isAuthenticated || !user) {
		return null;
	}

	const initials = getInitials(user.displayName, user.email);

	return (
		<DropdownMenu>
			<DropdownMenu.Trigger
				render={
					display === 'sidebar' ? (
						<Button
							variant="ghost"
							size="base"
							className={cn(
								'h-auto min-h-10 min-w-0 flex-1 justify-start gap-2 rounded-lg px-2 py-1.5 text-left text-kumo-default',
								className,
							)}
						>
							<Avatar className="h-7 w-7 shrink-0">
								<AvatarImage
									src={user.avatarUrl}
									alt={user.displayName || user.email}
								/>
								<AvatarFallback className="bg-kumo-elevated text-xs font-semibold text-kumo-default">
									{initials}
								</AvatarFallback>
							</Avatar>
							<span className="min-w-0 flex-1 flex-col group-data-[state=collapsed]/sidebar:hidden">
								<span className="block truncate text-sm font-medium text-kumo-default">
									{user.displayName || 'User'}
								</span>
							</span>
						</Button>
					) : (
						<Button
							variant="ghost"
							size="base"
							shape="circle"
							aria-label="Account menu"
							className={cn(
								'relative rounded-full transition-all hover:ring-2 hover:ring-kumo-brand/20',
								className,
							)}
						>
							<Avatar className="h-8 w-8">
								<AvatarImage
									src={user.avatarUrl}
									alt={user.displayName || user.email}
								/>
								<AvatarFallback className="bg-kumo-elevated font-semibold text-kumo-default">
									{initials}
								</AvatarFallback>
							</Avatar>
						</Button>
					)
				}
			/>

			<DropdownMenu.Content
				align={display === 'sidebar' ? 'start' : 'end'}
				className="w-72"
			>
				<DropdownMenu.Group>
					<DropdownMenu.Item
						onClick={() => navigate('/profile')}
						icon={UserIcon}
					>
						Profile
					</DropdownMenu.Item>
					<DropdownMenu.Item
						onClick={() => navigate('/settings')}
						icon={GearIcon}
					>
						Settings
					</DropdownMenu.Item>
				</DropdownMenu.Group>

				<DropdownMenu.Item
					onClick={() => logout()}
					icon={SignOutIcon}
					variant="danger"
				>
					Sign Out
				</DropdownMenu.Item>
			</DropdownMenu.Content>
		</DropdownMenu>
	);
}

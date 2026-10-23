import { useRef, useState, useEffect, useMemo } from 'react';
import { ArrowUpRight, Loader2 } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router';
import { useAuth } from '@/contexts/auth-context';
import {
	ProjectModeSelector,
	type ProjectModeOption,
} from '../components/project-mode-selector';
import {
	MAX_AGENT_QUERY_LENGTH,
	SUPPORTED_IMAGE_MIME_TYPES,
	type ProjectType,
	type BehaviorType,
} from '@/api-types';
import { useFeature } from '@/features';
import { useAuthGuard } from '../hooks/useAuthGuard';
import { usePaginatedApps } from '@/hooks/use-paginated-apps';
import { AnimatePresence, LayoutGroup, motion } from 'framer-motion';
import { AppCard } from '@/components/shared/AppCard';
import { LinkButton, cn } from '@cloudflare/kumo';
import { useImageUpload } from '@/hooks/use-image-upload';
import { useDragDrop } from '@/hooks/use-drag-drop';
import { toast } from 'sonner';
import { useLimitsContext } from '@/contexts/limits-context';
import { checkCanSendPrompt } from '@/utils/usage-limit-checker';
import { MasidyLogo } from '@/components/masidy-logo';
import { PromptBox } from '@/components/prompt-box';
import { Link } from 'react-router';
import {
	InfoIcon,
	PaperPlaneTiltIcon,
	Sparkle,
	Code,
	Database,
	Eye,
	ChatCircleDots,
	ArrowCounterClockwise,
	Globe,
	CreditCard,
	Coins,
	ShieldCheck,
	CheckCircle,
} from '@phosphor-icons/react';

const EXAMPLE_PROMPTS = [
	{
		label: 'Local Business Landing',
		prompt:
			'Create a modern, high-converting landing page for an artisanal coffee roastery with menu showcase, opening hours, customer reviews, and reservation CTA',
	},
	{
		label: 'Todo App with Database & Auth',
		prompt:
			'Build a full-stack todo task manager with user authentication, category tags, priority levels, due dates, and SQLite persistence',
	},
	{
		label: 'Blog with Admin Editor',
		prompt:
			'Create a full-stack blog with an admin markdown editor, published article feed, tag filtering, and reader comment section backed by SQLite',
	},
	{
		label: 'Store Page & Cart',
		prompt:
			'Build an online storefront featuring a product catalog with search, category filtering, a shopping cart drawer, and order summary',
	},
	{
		label: 'Barber Booking Form',
		prompt:
			'Create a stylish barber shop booking app with service selection, staff stylist picker, date/time scheduling form, and confirmation summary',
	},
	{
		label: 'Habit Tracker with Streaks',
		prompt:
			'Build a daily habit tracker app with completion checkboxes, weekly progress rings, streak counters, and motivational statistics',
	},
	{
		label: 'Developer Portfolio',
		prompt:
			'Create a sleek developer portfolio showcasing featured projects with live demo links, technical skill badges, and a contact form',
	},
	{
		label: 'Analytics Dashboard',
		prompt:
			'Build a responsive SaaS metrics dashboard with interactive revenue charts, key performance stat cards, and user activity logs',
	},
	{
		label: 'Interactive Trivia Quiz',
		prompt:
			'Create a timed multi-category trivia quiz game with score tallying, instant answer explanations, and a global top-10 leaderboard',
	},
];

export default function Home() {
	const navigate = useNavigate();
	const { requireAuth } = useAuthGuard();
	const [projectMode, setProjectMode] = useState<ProjectType>('app');
	const behaviorMode: Extract<BehaviorType, 'think' | 'phasic'> = 'think';
	const [query, setQuery] = useState('');
	const { user } = useAuth();
	const { isLoadingCapabilities, capabilities, getEnabledFeatures } =
		useFeature();
	const { data: limitsData, loading: usageLimitsLoading } =
		useLimitsContext();
	const [showLimitDialog, setShowLimitDialog] =
		useState<React.ReactElement | null>(null);

	// Surface auth failures redirected here from the OAuth callback (e.g. an email
	// that already belongs to an account created via a different method).
	const [searchParams, setSearchParams] = useSearchParams();
	useEffect(() => {
		const authError = searchParams.get('error');
		if (!authError) return;
		const messages: Record<string, string> = {
			email_exists:
				'An account with this email already exists. Sign in with your existing method, then link the provider from Settings.',
			oauth_failed:
				'The sign-in provider reported an error. Please try again.',
			auth_failed: 'Sign-in failed. Please try again.',
		};
		toast.error(messages[authError] ?? messages.auth_failed);
		searchParams.delete('error');
		setSearchParams(searchParams, { replace: true });
	}, [searchParams, setSearchParams]);

	const modeOptions = useMemo<ProjectModeOption[]>(() => {
		if (isLoadingCapabilities || !capabilities) return [];
		return getEnabledFeatures().map((def) => ({
			id: def.id,
			label:
				def.id === 'presentation'
					? 'Slides'
					: def.id === 'general'
						? 'General'
						: 'App',
			description: def.description,
		}));
	}, [capabilities, getEnabledFeatures, isLoadingCapabilities]);

	const showModeSelector = modeOptions.length > 1;

	useEffect(() => {
		if (isLoadingCapabilities) return;
		if (modeOptions.length === 0) {
			if (projectMode !== 'app') setProjectMode('app');
			return;
		}
		if (!modeOptions.some((m) => m.id === projectMode)) {
			setProjectMode(modeOptions[0].id);
		}
	}, [isLoadingCapabilities, modeOptions, projectMode]);

	const { images, addImages, removeImage, clearImages, isProcessing } =
		useImageUpload({
			onError: (error) => {
				console.error('Image upload error:', error);
				toast.error(error);
			},
		});

	const { isDragging, dragHandlers } = useDragDrop({
		onFilesDropped: addImages,
		accept: [...SUPPORTED_IMAGE_MIME_TYPES],
	});

	const placeholderPhrases = useMemo(
		() => ['todo list app', 'F1 fantasy game', 'personal finance tracker'],
		[],
	);

	const { apps, loading } = usePaginatedApps({
		type: 'public',
		defaultSort: 'trending',
		defaultPeriod: 'week',
		limit: 24,
	});

	// Discover section should appear only when enough apps are available and loading is done
	const discoverReady = useMemo(
		() => !loading && (apps?.length ?? 0) > 0,
		[loading, apps],
	);
	const discoverApps = useMemo(() => (apps ?? []).slice(0, 9), [apps]);

	const handleCreateApp = (query: string, mode: ProjectType) => {
		if (query.length > MAX_AGENT_QUERY_LENGTH) {
			toast.error(
				`Prompt too large (${query.length} characters). Maximum allowed is ${MAX_AGENT_QUERY_LENGTH} characters.`,
			);
			return;
		}

		if (user && usageLimitsLoading) {
			return;
		}

		const encodedQuery = encodeURIComponent(query);
		const encodedMode = encodeURIComponent(mode);
		const behaviorParam =
			mode === 'app'
				? `&behaviorType=${encodeURIComponent(behaviorMode)}`
				: '';

		// Encode images as JSON if present
		const imageParam =
			images.length > 0
				? `&images=${encodeURIComponent(JSON.stringify(images))}`
				: '';
		const intendedUrl = `/chat/new?query=${encodedQuery}&projectType=${encodedMode}${behaviorParam}${imageParam}`;

		if (
			!requireAuth({
				requireFullAuth: true,
				actionContext: 'to create applications',
				intendedUrl: intendedUrl,
			})
		) {
			return;
		}

		// Check usage limits before proceeding
		const limitCheck = checkCanSendPrompt(
			limitsData,
			usageLimitsLoading,
			() => setShowLimitDialog(null),
			navigate,
		);

		if (!limitCheck.canProceed) {
			setShowLimitDialog(limitCheck.dialogComponent || null);
			return;
		}

		// User is already authenticated, navigate immediately. Mark the
		// navigation as in-app so the chat session can auto-start without the
		// external-link confirmation gate.
		navigate(intendedUrl, { state: { fromPrompt: true } });
		// Clear images after navigation
		clearImages();
	};

	const discoverLinkRef = useRef<HTMLDivElement>(null);

	return (
		<div className="relative flex flex-col items-center w-full min-h-full">
			<title>Masidy — AI app builder</title>
			<div className="home-atmosphere" aria-hidden>
				<div className="home-atmosphere__spotlight" />
			</div>
			<LayoutGroup>
				<div className="w-full max-w-3xl px-5 sm:px-6">
					<motion.div
						layout
						transition={{
							layout: { duration: 0.5, ease: [0.22, 1, 0.36, 1] },
						}}
						className={cn(
							'flex flex-col items-stretch z-10 w-full',
							discoverReady
								? 'mt-20 sm:mt-36'
								: 'mt-12 sm:mt-[22vh] md:mt-[26vh]',
						)}
					>
						<MasidyLogo
							markClassName="size-8"
							className="mb-5 justify-center text-sm"
						/>
						<div className="mb-6 sm:mb-7 grid gap-2">
							<h1 className="w-full text-center text-[clamp(1.75rem,4.5vw,2.5rem)] font-semibold leading-[1.12] text-kumo-strong/80 z-20">
								What should we{' '}
								<span className="font-funky-mono font-bold text-[1.1em] tracking-tighter uppercase text-brand-emphasis">
									build
								</span>{' '}
								today?
							</h1>
						</div>
						<PromptBox
							value={query}
							onChange={setQuery}
							onSubmit={() => handleCreateApp(query, projectMode)}
							placeholder="Create a "
							animatedPlaceholder
							placeholderPhrases={placeholderPhrases}
							images={images}
							onAddImages={addImages}
							onRemoveImage={removeImage}
							isProcessing={
								isProcessing ||
								(user ? usageLimitsLoading : false)
							}
							isDragging={isDragging}
							dragHandlers={dragHandlers}
							submitDisabled={user ? usageLimitsLoading : false}
							limitsData={user ? limitsData : undefined}
							variant="expanded"
							submitIcon={
								user && usageLimitsLoading ? (
									<Loader2 className="animate-spin" />
								) : (
									<PaperPlaneTiltIcon weight="duotone" />
								)
							}
							leftActions={
								showModeSelector ? (
									<ProjectModeSelector
										value={projectMode}
										onChange={setProjectMode}
										modes={modeOptions}
									/>
								) : undefined
							}
						/>

						{/* Clickable example prompts */}
						<div className="mt-3.5 flex flex-wrap items-center justify-center gap-1.5 px-1 sm:px-2">
							<span className="text-[11px] font-medium text-kumo-subtle mr-1">
								Try:
							</span>
							{EXAMPLE_PROMPTS.map((ex) => (
								<button
									key={ex.label}
									type="button"
									onClick={() => setQuery(ex.prompt)}
									className="group inline-flex items-center gap-1 rounded-full border border-kumo-line bg-kumo-elevated/40 px-2.5 py-1 text-[11px] font-medium text-kumo-subtle transition-all hover:border-brand-primary/40 hover:bg-kumo-elevated hover:text-kumo-default active:scale-[0.98]"
								>
									<Sparkle className="size-3 text-brand-primary/70 group-hover:text-brand-primary" />
									<span>{ex.label}</span>
								</button>
							))}
						</div>
					</motion.div>
				</div>

				<AnimatePresence mode="popLayout">
					{images.length > 0 && (
						<motion.div
							initial={{ opacity: 0, y: -10 }}
							animate={{ opacity: 1, y: 0 }}
							exit={{ opacity: 0, y: -10 }}
							className="w-full max-w-2xl px-5 sm:px-6 mt-4"
						>
							<div
								className="flex items-start gap-2 px-4 py-3 rounded-xl bg-bg-4/50 dark:bg-bg-2/50 shadow-sm"
								style={{
									borderColor:
										'color-mix(in srgb, var(--color-brand) 20%, transparent)',
								}}
							>
								<InfoIcon
									className="size-4 flex-shrink-0 mt-0.5 text-brand"
								/>
								<p className="text-xs text-kumo-subtle leading-relaxed">
									<span className="font-medium text-text-secondary">
										Images Beta:
									</span>{' '}
									Images guide app layout and design but may
									not be replicated exactly. The coding agent
									cannot access images directly for app
									assets.
								</p>
							</div>
						</motion.div>
					)}
				</AnimatePresence>

				<AnimatePresence>
					{discoverReady && (
						<motion.section
							key="discover-section"
							layout
							initial={{ opacity: 0, height: 0 }}
							animate={{ opacity: 1, height: 'auto' }}
							exit={{ opacity: 0, height: 0 }}
							transition={{
								duration: 0.5,
								ease: [0.22, 1, 0.36, 1],
							}}
							className={cn(
								'w-full max-w-5xl mx-auto px-5 sm:px-6 z-10',
								images.length > 0
									? 'mt-10'
									: 'mt-16 sm:mt-20 mb-12',
							)}
						>
							<div className="flex flex-col gap-6">
								<div className="flex items-end justify-between gap-4">
									<div className="grid gap-1.5 min-w-0">
										<h2 className="text-xl sm:text-2xl font-semibold text-kumo-default/90">
											Discover apps from the community
										</h2>
									</div>
									<div ref={discoverLinkRef}>
										<LinkButton
											variant="outline"
											size="sm"
											href="/discover"
										>
											View all
											<ArrowUpRight className="size-3.5 opacity-70" />
										</LinkButton>
									</div>
								</div>
								<motion.div
									layout
									transition={{ duration: 0.4 }}
									className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3"
								>
									<AnimatePresence mode="popLayout">
										{discoverApps.map((app) => (
											<AppCard
												key={app.id}
												app={app}
												onClick={() =>
													navigate(`/app/${app.id}`)
												}
												showStats={true}
												showUser={true}
												showActions={false}
											/>
										))}
									</AnimatePresence>
								</motion.div>
							</div>
						</motion.section>
					)}
				</AnimatePresence>

				{/* What you get section */}
				<section className="w-full max-w-5xl mx-auto px-5 sm:px-6 mt-16 sm:mt-24 z-10">
					<div className="text-center max-w-2xl mx-auto mb-10 sm:mb-14">
						<h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-text-primary">
							What you get with Masidy
						</h2>
						<p className="mt-2 text-sm sm:text-base text-kumo-subtle">
							Real full-stack web applications generated from natural language, running on your own isolated edge environment.
						</p>
					</div>

					<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
						<div className="p-5 rounded-2xl border border-kumo-line bg-kumo-elevated/40 hover:bg-kumo-elevated/60 transition-colors space-y-2.5">
							<div className="size-9 rounded-xl bg-brand-primary/10 text-brand-primary flex items-center justify-center">
								<Code className="size-5" weight="duotone" />
							</div>
							<h3 className="text-base font-semibold text-text-primary">Full-Stack Application</h3>
							<p className="text-xs sm:text-sm text-kumo-subtle leading-relaxed">
								AI creates working frontend code and real server-side endpoints powered by Cloudflare Workers and Hono.
							</p>
						</div>

						<div className="p-5 rounded-2xl border border-kumo-line bg-kumo-elevated/40 hover:bg-kumo-elevated/60 transition-colors space-y-2.5">
							<div className="size-9 rounded-xl bg-brand-primary/10 text-brand-primary flex items-center justify-center">
								<Eye className="size-5" weight="duotone" />
							</div>
							<h3 className="text-base font-semibold text-text-primary">Live Interactive Preview</h3>
							<p className="text-xs sm:text-sm text-kumo-subtle leading-relaxed">
								Test your application instantly in a live, sandboxed browser iframe as the code is being written.
							</p>
						</div>

						<div className="p-5 rounded-2xl border border-kumo-line bg-kumo-elevated/40 hover:bg-kumo-elevated/60 transition-colors space-y-2.5">
							<div className="size-9 rounded-xl bg-brand-primary/10 text-brand-primary flex items-center justify-center">
								<Database className="size-5" weight="duotone" />
							</div>
							<h3 className="text-base font-semibold text-text-primary">Built-In Database & Viewer</h3>
							<p className="text-xs sm:text-sm text-kumo-subtle leading-relaxed">
								Persistent SQLite and D1 storage with an integrated visual table inspector right inside the chat workspace.
							</p>
						</div>

						<div className="p-5 rounded-2xl border border-kumo-line bg-kumo-elevated/40 hover:bg-kumo-elevated/60 transition-colors space-y-2.5">
							<div className="size-9 rounded-xl bg-brand-primary/10 text-brand-primary flex items-center justify-center">
								<ChatCircleDots className="size-5" weight="duotone" />
							</div>
							<h3 className="text-base font-semibold text-text-primary">Edit by Chatting</h3>
							<p className="text-xs sm:text-sm text-kumo-subtle leading-relaxed">
								Request design tweaks, add new tables, fix bugs, or expand features naturally by conversing with the agent.
							</p>
						</div>

						<div className="p-5 rounded-2xl border border-kumo-line bg-kumo-elevated/40 hover:bg-kumo-elevated/60 transition-colors space-y-2.5">
							<div className="size-9 rounded-xl bg-brand-primary/10 text-brand-primary flex items-center justify-center">
								<ArrowCounterClockwise className="size-5" weight="duotone" />
							</div>
							<h3 className="text-base font-semibold text-text-primary">One-Click Rollback</h3>
							<p className="text-xs sm:text-sm text-kumo-subtle leading-relaxed">
								Every build creates a durable git-backed checkpoint. Revert to any earlier working state with a single click.
							</p>
						</div>

						<div className="p-5 rounded-2xl border border-kumo-line bg-kumo-elevated/40 hover:bg-kumo-elevated/60 transition-colors space-y-2.5">
							<div className="size-9 rounded-xl bg-brand-primary/10 text-brand-primary flex items-center justify-center">
								<Globe className="size-5" weight="duotone" />
							</div>
							<h3 className="text-base font-semibold text-text-primary">Publish, Share & GitHub Export</h3>
							<p className="text-xs sm:text-sm text-kumo-subtle leading-relaxed">
								Deploy to a public <code className="font-mono text-xs text-text-primary">*.masidy.dev</code> link, share with others, or sync code to GitHub.
							</p>
						</div>
					</div>
				</section>

				{/* How Masidy works section */}
				<section className="w-full max-w-5xl mx-auto px-5 sm:px-6 mt-20 sm:mt-28 z-10">
					<div className="text-center max-w-2xl mx-auto mb-10 sm:mb-14">
						<h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-text-primary">
							How Masidy works
						</h2>
						<p className="mt-2 text-sm sm:text-base text-kumo-subtle">
							Five simple steps from an idea to a deployed, production-ready web application.
						</p>
					</div>

					<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3.5">
						<div className="p-4 rounded-xl border border-kumo-line bg-kumo-elevated/30 space-y-2">
							<span className="inline-block text-xs font-mono font-bold text-brand-primary px-2 py-0.5 rounded bg-brand-primary/10">01</span>
							<h3 className="text-sm font-semibold text-text-primary">Describe your app</h3>
							<p className="text-xs text-kumo-subtle leading-relaxed">
								Type your idea or pick a template prompt. Add optional screenshots or UI mockups to guide the layout.
							</p>
						</div>

						<div className="p-4 rounded-xl border border-kumo-line bg-kumo-elevated/30 space-y-2">
							<span className="inline-block text-xs font-mono font-bold text-brand-primary px-2 py-0.5 rounded bg-brand-primary/10">02</span>
							<h3 className="text-sm font-semibold text-text-primary">Plans, writes & previews</h3>
							<p className="text-xs text-kumo-subtle leading-relaxed">
								Masidy drafts the file structure, writes the frontend and backend code, and mounts the live preview.
							</p>
						</div>

						<div className="p-4 rounded-xl border border-kumo-line bg-kumo-elevated/30 space-y-2">
							<span className="inline-block text-xs font-mono font-bold text-brand-primary px-2 py-0.5 rounded bg-brand-primary/10">03</span>
							<h3 className="text-sm font-semibold text-text-primary">Console self-healing</h3>
							<p className="text-xs text-kumo-subtle leading-relaxed">
								The agent reads browser console logs in real-time and fixes any runtime errors before handing off.
							</p>
						</div>

						<div className="p-4 rounded-xl border border-kumo-line bg-kumo-elevated/30 space-y-2">
							<span className="inline-block text-xs font-mono font-bold text-brand-primary px-2 py-0.5 rounded bg-brand-primary/10">04</span>
							<h3 className="text-sm font-semibold text-text-primary">Edit by chatting</h3>
							<p className="text-xs text-kumo-subtle leading-relaxed">
								Iterate conversationally. Make adjustments, add new features, or roll back to any earlier checkpoint.
							</p>
						</div>

						<div className="p-4 rounded-xl border border-kumo-line bg-kumo-elevated/30 space-y-2">
							<span className="inline-block text-xs font-mono font-bold text-brand-primary px-2 py-0.5 rounded bg-brand-primary/10">05</span>
							<h3 className="text-sm font-semibold text-text-primary">Publish & export</h3>
							<p className="text-xs text-kumo-subtle leading-relaxed">
								Deploy to your custom <code className="font-mono text-[11px] text-text-primary">*.masidy.dev</code> subdomain, share with users, or export to GitHub.
							</p>
						</div>
					</div>
				</section>

				{/* How credits work section */}
				<section className="w-full max-w-5xl mx-auto px-5 sm:px-6 mt-20 sm:mt-28 z-10">
					<div className="text-center max-w-2xl mx-auto mb-10 sm:mb-14">
						<h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-text-primary">
							How credits work
						</h2>
						<p className="mt-2 text-sm sm:text-base text-kumo-subtle">
							Prepaid credits with total cost transparency. No hidden fees or recurring subscriptions.
						</p>
					</div>

					<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
						<div className="p-5 rounded-2xl border border-kumo-line bg-kumo-elevated/40 space-y-2">
							<div className="flex items-center gap-2.5">
								<CreditCard className="size-5 text-brand-primary" />
								<h3 className="text-base font-semibold text-text-primary">Prepaid & Upfront Pricing</h3>
							</div>
							<p className="text-xs sm:text-sm text-kumo-subtle leading-relaxed">
								You only pay for what you actually use. The estimated cost is displayed before each build or iteration starts. Deposit credits in increments starting at $5.
							</p>
						</div>

						<div className="p-5 rounded-2xl border border-kumo-line bg-kumo-elevated/40 space-y-2">
							<div className="flex items-center gap-2.5">
								<Coins className="size-5 text-brand-primary" />
								<h3 className="text-base font-semibold text-text-primary">Card & USDC on Base</h3>
							</div>
							<p className="text-xs sm:text-sm text-kumo-subtle leading-relaxed">
								Buy credits using debit/credit cards via Stripe or on-chain USDC on Base mainnet. Perfect for international builders who lack an international credit card.
							</p>
						</div>

						<div className="p-5 rounded-2xl border border-kumo-line bg-kumo-elevated/40 space-y-2">
							<div className="flex items-center gap-2.5">
								<ShieldCheck className="size-5 text-emerald-500" />
								<h3 className="text-base font-semibold text-text-primary">Zero-Waste Guarantee</h3>
							</div>
							<p className="text-xs sm:text-sm text-kumo-subtle leading-relaxed">
								If an AI build fails, encounters a server error, or is stopped early, no credits are deducted. You are only charged when working code is delivered.
							</p>
						</div>

						<div className="p-5 rounded-2xl border border-kumo-line bg-kumo-elevated/40 space-y-2">
							<div className="flex items-center gap-2.5">
								<CheckCircle className="size-5 text-brand-primary" />
								<h3 className="text-base font-semibold text-text-primary">When Credits Run Out & Refunds</h3>
							</div>
							<p className="text-xs sm:text-sm text-kumo-subtle leading-relaxed">
								When credits reach zero, builds pause cleanly with a top-up dialog. Your existing apps, databases, and previews stay live. We offer a full 14-day refund on unused credit balances.
							</p>
						</div>
					</div>
				</section>

				{/* Footer */}
				<footer className="w-full max-w-5xl mx-auto px-5 sm:px-6 mt-24 sm:mt-32 pb-12 z-10 border-t border-kumo-line pt-8">
					<div className="flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-kumo-subtle">
						<div className="flex items-center gap-2">
							<MasidyLogo markClassName="size-5" className="text-xs" />
							<span>© 2026 Masidy. All rights reserved.</span>
						</div>
						<div className="flex flex-wrap items-center justify-center gap-4 sm:gap-6">
							<Link to="/about" className="hover:text-text-primary transition-colors">
								About
							</Link>
							<Link to="/contact" className="hover:text-text-primary transition-colors">
								Contact
							</Link>
							<Link to="/terms" className="hover:text-text-primary transition-colors">
								Terms of Service
							</Link>
							<Link to="/privacy" className="hover:text-text-primary transition-colors">
								Privacy Policy
							</Link>
							<Link to="/refund" className="hover:text-text-primary transition-colors">
								Refund Policy
							</Link>
						</div>
					</div>
				</footer>
			</LayoutGroup>

			{/* Usage limit dialogs */}
			{showLimitDialog}
		</div>
	);
}

type ArrowProps = {
	/** Ref to the source element the arrow starts from */
	sourceRef: React.RefObject<HTMLElement | null>;
	/** Target point in viewport/client coordinates */
	target: { x: number; y: number };
	/** Curve intensity (0.1 - 1.5 is typical) */
	curvature?: number;
	/** Optional pixel offset from source element edge */
	sourceOffset?: number;
	/** If true, hides the arrow when the source is offscreen/not measurable */
	hideWhenInvalid?: boolean;
};

type Point = { x: number; y: number };

export const CurvedArrow: React.FC<ArrowProps> = ({
	sourceRef,
	target,
	curvature = 0.5,
	sourceOffset = 6,
	hideWhenInvalid = true,
}) => {
	const [start, setStart] = useState<Point | null>(null);
	const [end, setEnd] = useState<Point | null>(null);

	const rafRef = useRef<number | null>(null);
	const roRef = useRef<ResizeObserver | null>(null);

	const compute = () => {
		const el = sourceRef.current;
		if (!el) {
			setStart(null);
			setEnd(null);
			return;
		}

		const rect = el.getBoundingClientRect();
		if (!rect || rect.width === 0 || rect.height === 0) {
			setStart(null);
			setEnd(null);
			return;
		}

		const endPoint: Point = { x: target.x, y: target.y };

		// Choose an anchor on the source: midpoint of the side facing the target
		const centers = {
			right: { x: rect.right, y: rect.top + rect.height / 2 },
			left: { x: rect.left, y: rect.top + rect.height / 2 },
		};

		// Distances to target from each side center
		const dists = Object.fromEntries(
			Object.entries(centers).map(([side, p]) => [
				side,
				(p.x - endPoint.x) ** 2 + (p.y - endPoint.y) ** 2,
			]),
		) as Record<keyof typeof centers, number>;

		const bestSide = (Object.entries(dists).sort(
			(a, b) => a[1] - b[1],
		)[0][0] || 'right') as keyof typeof centers;

		// Nudge start point slightly outside the element for visual clarity
		const nudge = (
			p: Point,
			side: keyof typeof centers,
			offset: number,
		) => {
			switch (side) {
				case 'right':
					return { x: p.x + offset, y: p.y };
				case 'left':
					return { x: p.x - offset, y: p.y };
			}
		};

		const startPoint = nudge(centers[bestSide], bestSide, sourceOffset);

		setStart(startPoint);
		setEnd(endPoint);
	};

	// Throttle updates with rAF to avoid layout thrash
	const scheduleCompute = () => {
		if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
		rafRef.current = requestAnimationFrame(compute);
	};

	useEffect(() => {
		scheduleCompute();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [target.x, target.y, sourceRef.current]);

	useEffect(() => {
		const onScroll = () => scheduleCompute();
		const onResize = () => scheduleCompute();

		window.addEventListener('scroll', onScroll, { passive: true });
		window.addEventListener('resize', onResize);

		// Track source element size changes
		const el = sourceRef.current;
		if ('ResizeObserver' in window) {
			roRef.current = new ResizeObserver(() => scheduleCompute());
			if (el) roRef.current.observe(el);
		}

		scheduleCompute();

		return () => {
			window.removeEventListener('scroll', onScroll);
			window.removeEventListener('resize', onResize);
			if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
			if (roRef.current && el) roRef.current.unobserve(el);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const d = useMemo(() => {
		if (!start || !end) return '';

		const dx = end.x - start.x;
		const dy = end.y - start.y;

		// Control points: bend the curve based on the primary axis difference.
		// This gives a nice S or C curve without sharp kinks.
		const cpOffset = Math.max(Math.abs(dx), Math.abs(dy)) * curvature;

		const c1: Point = {
			x: start.x + cpOffset * (dx >= 0 ? 1 : -1),
			y: start.y,
		};
		const c2: Point = {
			x: end.x - cpOffset * (dx >= 0 ? 1 : -1),
			y: end.y,
		};

		return `M ${start.x},${start.y} C ${c1.x},${c1.y} ${c2.x},${c2.y} ${end.x},${end.y}`;
	}, [start, end, curvature]);

	const hidden = hideWhenInvalid && (!start || !end);

	if (start && end && (end.y - start.y > 420 || start.x - end.x < 100)) {
		return null;
	}

	return (
		<svg
			aria-hidden="true"
			style={{
				position: 'fixed',
				inset: 0,
				width: '100vw',
				height: '100vh',
				pointerEvents: 'none',
				overflow: 'visible',
				zIndex: 9999,
				display: hidden ? 'none' : 'block',
			}}
		>
			<defs>
				<filter
					id="discover-squiggle"
					x="-20%"
					y="-20%"
					width="140%"
					height="140%"
				>
					<feTurbulence
						type="fractalNoise"
						baseFrequency="0.8"
						numOctaves="1"
						seed="3"
						result="noise"
					/>
					<feDisplacementMap
						in="SourceGraphic"
						in2="noise"
						scale="1"
						xChannelSelector="R"
						yChannelSelector="G"
					/>
				</filter>
				<marker
					id="discover-arrowhead"
					markerWidth="8"
					markerHeight="8"
					refX="7"
					refY="4"
					orient="auto"
					markerUnits="strokeWidth"
					opacity={0.2}
				>
					<path
						d="M 0 1.2 L 7 4"
						stroke="var(--color-text-tertiary)"
						strokeWidth="1.6"
						strokeLinecap="round"
						fill="none"
					/>
					<path
						d="M 0 6.8 L 7 4"
						stroke="var(--color-text-tertiary)"
						strokeWidth="1.2"
						strokeLinecap="round"
						fill="none"
					/>
				</marker>
			</defs>

			<path
				d={d}
				// stroke="var(--color-brand)"
				stroke="var(--color-text-tertiary)"
				strokeOpacity={0.2}
				strokeWidth={1.6}
				fill="none"
				strokeLinecap="round"
				strokeLinejoin="round"
				vectorEffect="non-scaling-stroke"
				markerEnd="url(#discover-arrowhead)"
			/>
			{/* Soft squiggle overlay for hand-drawn feel */}
			<g filter="url(#discover-squiggle)">
				<path
					d={d}
					// stroke="var(--color-brand)"
					stroke="var(--color-text-tertiary)"
					strokeOpacity={0.12}
					strokeWidth={1}
					fill="none"
					strokeLinecap="round"
					strokeLinejoin="round"
					strokeDasharray="8 6 4 9 5 7"
					vectorEffect="non-scaling-stroke"
				/>
			</g>
		</svg>
	);
};

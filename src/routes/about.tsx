import { Link } from 'react-router';
import { ArrowLeft, ShieldCheck, Database, CurrencyDollar, Globe } from '@phosphor-icons/react';
import { MasidyLogo } from '@/components/masidy-logo';

export default function AboutPage() {
	return (
		<main className="min-h-screen bg-kumo-base px-5 py-12 text-kumo-default">
			<article className="mx-auto max-w-3xl space-y-10">
				<header className="space-y-4">
					<Link
						to="/"
						className="inline-flex items-center gap-1.5 text-sm text-kumo-subtle hover:text-kumo-default transition-colors"
					>
						<ArrowLeft className="size-4" />
						Back to Masidy
					</Link>
					<div className="pt-2">
						<MasidyLogo markClassName="size-7" className="mb-4 text-sm" />
						<h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-text-primary">
							About Masidy
						</h1>
						<p className="mt-2 text-base text-kumo-subtle leading-relaxed">
							The AI-powered application builder built for modern creators, developers, and global founders.
						</p>
					</div>
				</header>

				<section className="space-y-4 text-sm sm:text-base leading-relaxed text-kumo-subtle">
					<h2 className="text-xl font-semibold text-text-primary">What is Masidy?</h2>
					<p>
						Masidy is a full-stack platform that transforms conversational natural language descriptions into
						live, production-ready web applications. Unlike simple code snippet generators or static frontends,
						Masidy builds complete apps with real server-side APIs (powered by Cloudflare Workers and Hono) and
						real persistent SQLite databases with integrated schema viewers.
					</p>
					<p>
						Every app runs inside an isolated, durable environment with real-time interactive previews,
						automated browser error self-healing, safe version checkpoints, and one-click publishing to custom
						<code className="mx-1 px-1.5 py-0.5 rounded bg-kumo-elevated text-text-primary text-xs font-mono">*.masidy.dev</code>
						links or direct export to GitHub.
					</p>
				</section>

				<section className="space-y-4 text-sm sm:text-base leading-relaxed text-kumo-subtle">
					<h2 className="text-xl font-semibold text-text-primary">Who is Masidy for?</h2>
					<p>
						We believe software creation should be universally accessible to everyone, anywhere in the world.
						Masidy is designed specifically for:
					</p>
					<div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
						<div className="p-4 rounded-xl border border-kumo-line bg-kumo-elevated/40 space-y-2">
							<div className="flex items-center gap-2 font-medium text-text-primary">
								<Globe className="size-5 text-brand-primary" />
								<span>Global Creators & Founders</span>
							</div>
							<p className="text-xs text-kumo-subtle leading-relaxed">
								Entrepreneurs worldwide who need to launch functional MVPs, SaaS apps, or client prototypes
								in minutes rather than months.
							</p>
						</div>

						<div className="p-4 rounded-xl border border-kumo-line bg-kumo-elevated/40 space-y-2">
							<div className="flex items-center gap-2 font-medium text-text-primary">
								<CurrencyDollar className="size-5 text-brand-primary" />
								<span>Card-Free & Unbanked Builders</span>
							</div>
							<p className="text-xs text-kumo-subtle leading-relaxed">
								Many talented developers and designers do not have access to international credit cards or
								corporate banking. Masidy natively accepts low-fee USDC on Base cryptocurrency alongside Stripe cards.
							</p>
						</div>

						<div className="p-4 rounded-xl border border-kumo-line bg-kumo-elevated/40 space-y-2">
							<div className="flex items-center gap-2 font-medium text-text-primary">
								<Database className="size-5 text-brand-primary" />
								<span>Full-Stack Builders</span>
							</div>
							<p className="text-xs text-kumo-subtle leading-relaxed">
								People who need more than just HTML/CSS: full database tables, user authentication, sessions,
								and server logic that survive page reloads.
							</p>
						</div>

						<div className="p-4 rounded-xl border border-kumo-line bg-kumo-elevated/40 space-y-2">
							<div className="flex items-center gap-2 font-medium text-text-primary">
								<ShieldCheck className="size-5 text-brand-primary" />
								<span>Zero-Waste AI Users</span>
							</div>
							<p className="text-xs text-kumo-subtle leading-relaxed">
								Pay-as-you-go transparency. You only pay for what you actually use, with transparent prices
								shown upfront and zero deductions for failed or aborted builds.
							</p>
						</div>
					</div>
				</section>

				<section className="space-y-4 text-sm sm:text-base leading-relaxed text-kumo-subtle">
					<h2 className="text-xl font-semibold text-text-primary">Our Philosophy</h2>
					<p>
						We don't believe in locking your code into proprietary silos. You own 100% of your generated projects.
						You can download your repository, publish it on Cloudflare's edge network with global reach, or export
						it to your personal GitHub account with complete commit history at any time.
					</p>
				</section>

				<footer className="border-t border-kumo-line pt-6 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 text-xs text-kumo-subtle">
					<div>
						Operated by Ragab Sadek • Varese, Italy
					</div>
					<div className="flex gap-4">
						<Link to="/contact" className="hover:text-text-primary transition-colors">Contact</Link>
						<Link to="/terms" className="hover:text-text-primary transition-colors">Terms</Link>
						<Link to="/privacy" className="hover:text-text-primary transition-colors">Privacy</Link>
						<Link to="/refund" className="hover:text-text-primary transition-colors">Refunds</Link>
					</div>
				</footer>
			</article>
		</main>
	);
}

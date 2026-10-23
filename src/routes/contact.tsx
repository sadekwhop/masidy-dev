import { useState } from 'react';
import { Link } from 'react-router';
import { ArrowLeft, PaperPlaneTilt, CheckCircle, WarningCircle } from '@phosphor-icons/react';
import { Button, Input } from '@cloudflare/kumo';
import { MasidyLogo } from '@/components/masidy-logo';
import { apiClient } from '@/lib/api-client';
import { toast } from 'sonner';

export default function ContactPage() {
	const [name, setName] = useState('');
	const [email, setEmail] = useState('');
	const [message, setMessage] = useState('');
	const [submitting, setSubmitting] = useState(false);
	const [submitted, setSubmitted] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setError(null);

		if (!name.trim() || name.trim().length < 2) {
			setError('Please enter your name (at least 2 characters).');
			return;
		}

		const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
		if (!email.trim() || !emailRegex.test(email.trim())) {
			setError('Please enter a valid email address.');
			return;
		}

		if (!message.trim() || message.trim().length < 10) {
			setError('Please enter a message (at least 10 characters).');
			return;
		}

		if (message.length > 3000) {
			setError('Message is too long (maximum 3,000 characters).');
			return;
		}

		try {
			setSubmitting(true);
			const res = await apiClient.submitContactForm({
				name: name.trim(),
				email: email.trim(),
				message: message.trim(),
			});

			if (!res.success) {
				throw new Error(res.error?.message || 'Failed to send message. Please try again.');
			}

			setSubmitted(true);
			toast.success('Your message has been sent successfully!');
		} catch (err: unknown) {
			const errMsg = err instanceof Error ? err.message : 'An unexpected error occurred.';
			setError(errMsg);
			toast.error(errMsg);
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<main className="min-h-screen bg-kumo-base px-5 py-12 text-kumo-default">
			<article className="mx-auto max-w-xl space-y-8">
				<header className="space-y-4">
					<Link
						to="/"
						className="inline-flex items-center gap-1.5 text-sm text-kumo-subtle hover:text-kumo-default transition-colors"
					>
						<ArrowLeft className="size-4" />
						Back to Masidy
					</Link>
					<div>
						<MasidyLogo markClassName="size-7" className="mb-4 text-sm" />
						<h1 className="text-3xl font-bold tracking-tight text-text-primary">
							Contact Support & Feedback
						</h1>
						<p className="mt-2 text-sm text-kumo-subtle leading-relaxed">
							Have questions about builds, prepaid credits, refunds, or enterprise custom domains?
							Send us a note below and our team will get back to you promptly.
						</p>
					</div>
				</header>

				{submitted ? (
					<div className="p-6 rounded-2xl border border-kumo-line bg-kumo-elevated/50 text-center space-y-4">
						<div className="inline-flex items-center justify-center size-12 rounded-full bg-emerald-500/10 text-emerald-500 mx-auto">
							<CheckCircle className="size-6" weight="fill" />
						</div>
						<h2 className="text-xl font-semibold text-text-primary">Message Received!</h2>
						<p className="text-sm text-kumo-subtle leading-relaxed">
							Thank you for reaching out. A confirmation copy and our response will be sent to{' '}
							<span className="font-semibold text-text-primary">{email}</span>.
						</p>
						<div className="pt-2">
							<Button
								variant="outline"
								onClick={() => {
									setSubmitted(false);
									setMessage('');
								}}
							>
								Send another message
							</Button>
						</div>
					</div>
				) : (
					<form onSubmit={handleSubmit} className="p-6 rounded-2xl border border-kumo-line bg-kumo-elevated/30 space-y-5">
						{error && (
							<div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-500 text-xs flex items-center gap-2">
								<WarningCircle className="size-4 shrink-0" weight="fill" />
								<span>{error}</span>
							</div>
						)}

						<div className="space-y-1.5">
							<label htmlFor="name" className="text-xs font-medium text-text-secondary">
								Your Name
							</label>
							<Input
								id="name"
								type="text"
								placeholder="Alex Smith"
								value={name}
								onChange={(e) => setName(e.target.value)}
								disabled={submitting}
								required
								maxLength={100}
							/>
						</div>

						<div className="space-y-1.5">
							<label htmlFor="email" className="text-xs font-medium text-text-secondary">
								Email Address
							</label>
							<Input
								id="email"
								type="email"
								placeholder="alex@example.com"
								value={email}
								onChange={(e) => setEmail(e.target.value)}
								disabled={submitting}
								required
								maxLength={150}
							/>
						</div>

						<div className="space-y-1.5">
							<label htmlFor="message" className="text-xs font-medium text-text-secondary flex justify-between">
								<span>Message</span>
								<span className="text-[11px] text-kumo-subtle">{message.length}/3,000</span>
							</label>
							<textarea
								id="message"
								rows={5}
								placeholder="How can we help you today? Describe your question or issue in detail..."
								value={message}
								onChange={(e) => setMessage(e.target.value)}
								disabled={submitting}
								required
								maxLength={3000}
								className="w-full rounded-lg border border-kumo-line bg-kumo-elevated px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-brand-primary"
							/>
						</div>

						<Button
							type="submit"
							variant="primary"
							loading={submitting}
							className="w-full"
							icon={<PaperPlaneTilt className="size-4" weight="fill" />}
						>
							{submitting ? 'Sending...' : 'Send Message'}
						</Button>

						<p className="text-[11px] text-center text-kumo-subtle leading-tight">
							Protected by Cloudflare Edge Security & rate-limiting. Your submission is securely archived.
						</p>
					</form>
				)}

				<footer className="border-t border-kumo-line pt-6 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 text-xs text-kumo-subtle">
					<div>
						Operated by Ragab Sadek • Varese, Italy
					</div>
					<div className="flex gap-4">
						<Link to="/about" className="hover:text-text-primary transition-colors">About</Link>
						<Link to="/terms" className="hover:text-text-primary transition-colors">Terms</Link>
						<Link to="/privacy" className="hover:text-text-primary transition-colors">Privacy</Link>
						<Link to="/refund" className="hover:text-text-primary transition-colors">Refunds</Link>
					</div>
				</footer>
			</article>
		</main>
	);
}

import { Link } from 'react-router';

function LegalPageLayout({
	title,
	children,
}: {
	title: string;
	children: React.ReactNode;
}) {
	return (
		<main className="min-h-screen bg-kumo-base px-5 py-12 text-kumo-default">
			<article className="mx-auto max-w-3xl space-y-8">
				<header className="space-y-3">
					<Link to="/" className="text-sm text-kumo-subtle hover:text-kumo-default">
						← Back to Masidy
					</Link>
					<h1 className="text-3xl font-semibold">{title}</h1>
					<p className="text-sm text-kumo-subtle">Last updated: October 21, 2026</p>
				</header>
				<div className="space-y-6 text-sm leading-7 text-kumo-subtle [&_h2]:mb-2 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-kumo-default [&_p]:mb-3 [&_ul]:mb-3 [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-6">
					{children}
				</div>
				<footer className="border-t border-kumo-line pt-5 text-sm text-kumo-subtle">
					Questions? Contact{' '}
					<a className="underline hover:text-kumo-default" href="mailto:info@ragabsadek.me">
						info@ragabsadek.me
					</a>
				</footer>
			</article>
		</main>
	);
}

export function TermsPage() {
	return (
		<LegalPageLayout title="Masidy Terms of Service">
			<p>
				These Terms govern your access to and use of Masidy, an AI-assisted
				application-building service operated by Ragab Sadek in Varese, Italy.
				By using Masidy, you agree to these Terms. If you do not agree, do not
				use the service.
			</p>
			<section>
				<h2>1. Accounts and access</h2>
				<p>
					You must provide accurate account information, keep your sign-in
					credentials secure, and be authorized to use any account or
					integration you connect. You are responsible for activity carried
					out through your account.
				</p>
			</section>
			<section>
				<h2>2. Your content and generated projects</h2>
				<p>
					You retain your rights to prompts, files, and other material you
					submit. As between you and Masidy, you own the project content
					generated for you, subject to third-party rights and applicable law.
					You give Masidy permission to host, process, and display that content
					only as needed to operate, secure, and improve the service and carry
					out actions you request.
				</p>
				<p>
					You are responsible for reviewing generated code and content before
					using or publishing it. AI-generated output may be incomplete,
					inaccurate, or similar to output provided to others.
				</p>
			</section>
			<section>
				<h2>3. Public projects and integrations</h2>
				<p>
					Projects you choose to publish or make public may be accessible to
					other people. You are responsible for the content, configuration,
					and data in projects you publish. When you connect an external
					account or service, its own terms and privacy practices also apply.
				</p>
			</section>
			<section>
				<h2>4. Acceptable use</h2>
				<p>
					Do not use Masidy to break the law, violate another person&apos;s
					rights, distribute malware, gain unauthorized access, interfere with
					the service, or submit content you are not permitted to use. Do not
					try to bypass usage limits or security controls.
				</p>
			</section>
			<section>
				<h2>5. Availability and changes</h2>
				<p>
					Masidy is provided on an evolving basis. Features may change, be
					limited, or become unavailable. We may suspend or restrict access
					where reasonably necessary to protect users, the service, or comply
					with law.
				</p>
			</section>
			<section>
				<h2>6. Disclaimers and liability</h2>
				<p>
					To the extent permitted by law, Masidy is provided without a
					guarantee that it will be uninterrupted, error-free, or suitable for
					every purpose. Nothing in these Terms limits rights or remedies that
					cannot legally be excluded, including mandatory consumer protections.
				</p>
			</section>
			<section>
				<h2>7. Applicable law and contact</h2>
				<p>
					These Terms are governed by the laws of Italy, without limiting
					mandatory protections available to consumers in their place of
					residence. Contact{' '}
					<a className="underline" href="mailto:info@ragabsadek.me">
						info@ragabsadek.me
					</a>{' '}
					with questions about these Terms.
				</p>
			</section>
		</LegalPageLayout>
	);
}

export function PrivacyPage() {
	return (
		<LegalPageLayout title="Masidy Privacy Policy">
			<p>
				This policy explains how Ragab Sadek, based in Varese, Italy, handles
				personal data when you use Masidy. For privacy questions or requests,
				contact{' '}
				<a className="underline" href="mailto:info@ragabsadek.me">
					info@ragabsadek.me
				</a>
				.
			</p>
			<section>
				<h2>1. Data we process</h2>
				<ul>
					<li>
						Account information, such as your email address, profile details,
						and the identity provider used to sign in.
					</li>
					<li>
						Prompts, uploaded materials, generated files, project settings,
						and content you choose to publish.
					</li>
					<li>
						Support messages, usage and quota information, and technical
						diagnostic and security data generated while using the service.
					</li>
					<li>
						Information needed to connect integrations you choose to use.
					</li>
				</ul>
			</section>
			<section>
				<h2>2. How we use data</h2>
				<p>
					We use this information to provide and secure Masidy, authenticate
					accounts, generate and host projects, respond to requests, enforce
					usage limits, troubleshoot problems, and meet legal obligations.
					Prompts and project content are processed by AI services to provide
					generation features. If you connect an external provider, relevant
					data may be sent to that provider to perform the action you request.
				</p>
			</section>
			<section>
				<h2>3. Service providers and sharing</h2>
				<p>
					We share data with infrastructure, hosting, AI, authentication, and
					integration providers only as needed to operate features you use,
					protect the service, or comply with law. Masidy-hosted apps and
					content you make public may be accessible to others. We do not sell
					personal data.
				</p>
			</section>
			<section>
				<h2>4. Retention and security</h2>
				<p>
					We keep information for as long as needed to provide the service,
					maintain your projects and account, resolve disputes, and meet legal
					or security needs. You may request account or data deletion by
					contacting us. Some information may remain for a limited period in
					backups or where retention is legally required. We use reasonable
					technical and organizational measures to protect data, but no
					internet service can guarantee absolute security.
				</p>
			</section>
			<section>
				<h2>5. International processing</h2>
				<p>
					Our service providers may process data in countries outside your
					country of residence. Where required, appropriate safeguards are
					used for international transfers.
				</p>
			</section>
			<section>
				<h2>6. Your rights</h2>
				<p>
					Depending on your location, you may have the right to request access
					to, correction or deletion of your personal data, restrict or object
					to certain processing, request data portability, or withdraw consent
					where processing is based on consent. Contact us to exercise these
					rights. You may also lodge a complaint with your local data
					protection authority; in Italy, this is the Garante per la
					protezione dei dati personali.
				</p>
			</section>
			<section>
				<h2>7. Changes to this policy</h2>
				<p>
					We may update this policy as Masidy changes. The date at the top of
					this page indicates when it was last updated.
				</p>
			</section>
		</LegalPageLayout>
	);
}

// NOTICE FOR OPERATOR: You must review these Terms, Privacy Policy, and Refund Policy
// with a qualified legal professional to ensure full compliance with the consumer protection,
// digital goods, and tax regulations of your jurisdiction.
export function RefundPage() {
	return (
		<LegalPageLayout title="Masidy Refund Policy">
			<p>
				At Masidy, we operate a transparent, pay-as-you-go credit system. This policy
				explains how purchases, credit deductions, and refunds work.
			</p>
			<section>
				<h2>1. How Masidy credits work</h2>
				<p>
					Masidy uses prepaid credits for AI generation, full-stack builds, and hosting.
					You purchase credit packs using standard payment cards (via Stripe) or
					on-chain USDC cryptocurrency on Base mainnet. Credits do not expire while your
					account remains active.
				</p>
				<p>
					<strong>Zero-waste billing:</strong> Credits are only consumed for completed
					generation phases and verified builds. If an AI build encounters a technical
					failure, runtime crash, or is cancelled before producing output, no credits are deducted.
				</p>
			</section>
			<section>
				<h2>2. Refund eligibility for unused credits</h2>
				<p>
					You are eligible for a full refund of any <strong>unused</strong> credit balance
					within <strong>14 days</strong> of the original purchase date.
				</p>
				<ul>
					<li>
						<strong>Card purchases (Stripe):</strong> Refunds will be issued back to the
						original payment card used at checkout. Stripe processing typically takes 5–10 business days.
					</li>
					<li>
						<strong>Crypto purchases (USDC on Base):</strong> Refunds for unused balances
						can be sent to your linked Base wallet address. Due to blockchain finality, network
						gas fees (~$0.01 on Base) are non-refundable.
					</li>
				</ul>
			</section>
			<section>
				<h2>3. Non-refundable items</h2>
				<p>
					Credits that have already been consumed to execute completed AI model inference,
					builds, and compute workloads are non-refundable once successfully delivered.
				</p>
			</section>
			<section>
				<h2>4. How to request a refund</h2>
				<p>
					To request a refund, email{' '}
					<a className="underline" href="mailto:info@ragabsadek.me">
						info@ragabsadek.me
					</a>{' '}
					with your Masidy account email and your Stripe receipt number or Base transaction hash.
					We review and process refund requests within 2 business days.
				</p>
			</section>
			<section>
				<h2>5. Chargebacks and dispute policy</h2>
				<p>
					If you experience an issue with a purchase or generation, please contact us first
					at <a className="underline" href="mailto:info@ragabsadek.me">info@ragabsadek.me</a>.
					Filing an unnotified payment dispute automatically pauses account generation capabilities
					while the dispute is investigated by the payment processor.
				</p>
			</section>
		</LegalPageLayout>
	);
}

import { BaseController } from '../baseController';
import { RouteContext } from '../../types/route-context';
import { createLogger } from '../../../logger';

export interface ContactFormRequest {
	name: string;
	email: string;
	message: string;
	turnstileToken?: string;
}

export class ContactController extends BaseController {
	static logger = createLogger('ContactController');
	private static readonly DESTINATION_EMAIL = 'info@ragabsadek.me';

	/**
	 * POST /api/contact
	 * Handles contact form submissions, validates inputs, verifies bot protection,
	 * enforces rate limiting, archives the message in D1, and dispatches email.
	 */
	static async submitContactForm(
		request: Request,
		env: Env,
		_ctx: ExecutionContext,
		_context: RouteContext,
	): Promise<Response> {
		const bodyResult = await ContactController.parseJsonBody<ContactFormRequest>(request);
		if (!bodyResult.success || !bodyResult.data) {
			return bodyResult.response ?? ContactController.createErrorResponse('Invalid request body', 400);
		}

		const { name, email, message, turnstileToken } = bodyResult.data;

		// 1. Validation
		if (!name || typeof name !== 'string' || name.trim().length < 2 || name.length > 100) {
			return ContactController.createErrorResponse('Please provide a valid name (2-100 characters)', 400);
		}

		const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
		if (!email || typeof email !== 'string' || !emailRegex.test(email) || email.length > 150) {
			return ContactController.createErrorResponse('Please provide a valid email address', 400);
		}

		if (!message || typeof message !== 'string' || message.trim().length < 10 || message.length > 3000) {
			return ContactController.createErrorResponse('Message must be between 10 and 3,000 characters', 400);
		}

		const clientIp = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || '';

		// 2. Cloudflare Turnstile verification if secret key is configured
		if (env.TURNSTILE_SECRET_KEY) {
			if (!turnstileToken) {
				return ContactController.createErrorResponse('Bot verification challenge is required', 400);
			}

			try {
				const formData = new URLSearchParams();
				formData.append('secret', env.TURNSTILE_SECRET_KEY);
				formData.append('response', turnstileToken);
				if (clientIp) formData.append('remoteip', clientIp);

				const verifyRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
					method: 'POST',
					body: formData,
					headers: { 'content-type': 'application/x-www-form-urlencoded' },
				});

				const verifyData = (await verifyRes.json()) as { success: boolean };
				if (!verifyData.success) {
					return ContactController.createErrorResponse('Bot verification failed. Please try again.', 400);
				}
			} catch (err) {
				ContactController.logger.error('Turnstile verification error', err);
				return ContactController.createErrorResponse('Verification service temporarily unavailable', 503);
			}
		}

		// 3. Ensure D1 backup table exists
		try {
			await env.DB.exec(`
				CREATE TABLE IF NOT EXISTS contact_messages (
					id TEXT PRIMARY KEY,
					name TEXT NOT NULL,
					email TEXT NOT NULL,
					message TEXT NOT NULL,
					ip_address TEXT,
					created_at DATETIME DEFAULT CURRENT_TIMESTAMP
				);
			`);

			// 4. IP Rate limiting (max 5 submissions per 10 minutes per IP)
			if (clientIp) {
				const recentCount = await env.DB.prepare(`
					SELECT COUNT(*) as count FROM contact_messages
					WHERE ip_address = ? AND datetime(created_at) >= datetime('now', '-10 minutes')
				`).bind(clientIp).first<{ count: number }>();

				if (recentCount && recentCount.count >= 5) {
					return ContactController.createErrorResponse(
						'Too many contact requests from this IP. Please try again in a few minutes.',
						429,
					);
				}
			}

			// 5. Store in D1 database backup
			const id = crypto.randomUUID();
			await env.DB.prepare(`
				INSERT INTO contact_messages (id, name, email, message, ip_address)
				VALUES (?, ?, ?, ?, ?)
			`).bind(id, name.trim(), email.trim().toLowerCase(), message.trim(), clientIp || null).run();

			// 6. Dispatch email via Resend if configured
			const resendKey = (env as unknown as { RESEND_API_KEY?: string }).RESEND_API_KEY;
			if (resendKey) {
				try {
					await fetch('https://api.resend.com/emails', {
						method: 'POST',
						headers: {
							authorization: `Bearer ${resendKey}`,
							'content-type': 'application/json',
						},
						body: JSON.stringify({
							from: 'Masidy Contact <contact@masidy.dev>',
							to: [ContactController.DESTINATION_EMAIL],
							reply_to: email.trim(),
							subject: `[Masidy Contact] New message from ${name.trim()}`,
							text: `Name: ${name.trim()}\nEmail: ${email.trim()}\nIP: ${clientIp || 'Unknown'}\n\nMessage:\n${message.trim()}`,
						}),
					});
				} catch (mailErr) {
					ContactController.logger.error('Resend email dispatch error (message safely saved to D1)', mailErr);
				}
			}

			return ContactController.createSuccessResponse({
				success: true,
				message: 'Thank you! Your message has been received. We will get back to you shortly.',
			});
		} catch (dbErr) {
			ContactController.logger.error('Failed to store contact message in D1', dbErr);
			return ContactController.createErrorResponse('Failed to record message. Please try again later.', 500);
		}
	}
}

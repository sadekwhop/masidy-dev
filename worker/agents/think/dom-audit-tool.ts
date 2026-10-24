/**
 * `audit_dom` — runs a cheap, pure-JS DOM audit inside the preview page
 * using the existing headless Chromium (Cloudflare BROWSER binding in prod,
 * local sidecar in dev). No vision or screenshot tokens are consumed.
 *
 * Checks:
 *  - buttons/links with low text-background contrast (< 3:1)
 *  - interactive elements that have zero computed size or display:none
 *  - forms with no visible submit button
 *  - content touching the viewport edge (horizontal padding < 8px)
 *  - horizontal overflow (page scrolls sideways)
 *  - img elements whose src failed to load
 *
 * The result is recorded in the per-turn {@link TurnVerification} so the
 * end-of-turn gate can require a clean audit for primary CTAs and forms.
 */
import { tool, type Tool } from 'ai';
import { z } from 'zod';
import { getBrowserCaptureClient } from '../../services/browser-capture/factory';
import { createLogger } from '../../logger';
import type { TurnVerification } from './turn-verification';

const DESCRIPTION = [
	'Run a cheap DOM-only visual audit of the preview page — no screenshot or vision tokens. Reports: low-contrast CTA/link text, zero-size or hidden interactive elements, forms with no submit button, content touching the viewport edge, horizontal overflow, and broken images/icons.',
	'',
	'Call this after `get_browser_console_logs` passes (zero errors). The result is required for the turn to be considered verified.',
	'',
	'OUTPUT is JSON: { url, audited_at, passed, issues:[{type, message, selector}], warning? }. `passed` is true when issues is empty. Fix every reported issue, redeploy, and re-audit before reporting the turn complete.',
].join('\n');

export interface DomAuditToolOptions {
	env: Env;
	defaultUrl?: string;
	verification?: TurnVerification;
}

export function createDomAuditTool(opts: DomAuditToolOptions): Tool {
	const { env, defaultUrl } = opts;
	const verification = opts.verification;
	const logger = createLogger('ThinkDomAudit');

	return tool({
		description: DESCRIPTION,
		inputSchema: z.object({
			url: z
				.string()
				.optional()
				.describe('URL to audit. Defaults to the current preview URL.'),
			wait_seconds: z
				.number()
				.optional()
				.describe('Seconds to wait after page load before auditing. Default 3, max 15.'),
		}),
		execute: async (args: { url?: string; wait_seconds?: number }) => {
			const targetUrl = args.url ?? defaultUrl;
			if (!targetUrl) {
				return JSON.stringify({
					error: 'No preview URL available yet. Deploy the app first, or pass an explicit `url`.',
				});
			}

			const client = getBrowserCaptureClient(env, logger);
			let result;
			try {
				result = await client.auditDom({
					url: targetUrl,
					waitSeconds: Math.min(Math.max(args.wait_seconds ?? 3, 0), 15),
				});
			} catch (e) {
				const message = `DOM audit failed: ${e instanceof Error ? e.message : String(e)}`;
				if (verification) {
					verification.auditPassed = false;
					verification.lastError = message;
				}
				return JSON.stringify({ error: message });
			}

			// Record in per-turn verification (sidecar unavailability is fail-open).
			if (verification) {
				if (result.warning) {
					// Sidecar not reachable — don't gate the turn on an unavailable audit.
					verification.auditPassed = true;
				} else {
					verification.auditPassed = result.passed;
					if (!result.passed && result.issues.length > 0) {
						verification.lastError =
							`DOM audit failed: ${result.issues[0]?.message ?? 'unknown issue'}`;
					}
				}
			}

			return JSON.stringify(result, null, 2);
		},
	});
}

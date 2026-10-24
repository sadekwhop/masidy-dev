/**
 * `get_browser_console_logs` — opens the
 * current preview app in a real headless browser (Cloudflare `BROWSER` binding
 * in prod, local sidecar in dev) and returns console output, uncaught page
 * errors, and failed network requests captured during page load.
 *
 * This runs inside the ThinkAgent DO and calls the shared capture service directly via
 * `getBrowserCaptureClient` — the parent agent is busy awaiting the Think
 * stream, so re-entrant RPC into it would deadlock.
 *
 * Shares a per-turn {@link TurnVerification} record with `deploy_space`: a clean
 * console check after a deploy marks the turn's preview as verified (when the
 * preview URL also returns HTTP 200), and repeated preview/console failures
 * count toward the shared build retry cap.
 */
import { tool, type Tool } from 'ai';
import { z } from 'zod';
import { getBrowserCaptureClient } from '../../services/browser-capture/factory';
import { createLogger } from '../../logger';
import {
	MAX_CONSECUTIVE_BUILD_FAILURES,
	type BuildRetryState,
	type TurnVerification,
} from './turn-verification';

const DESCRIPTION = [
	'Open the current preview app in a real headless browser and return its console output, uncaught page errors, and failed network requests captured during page load.',
	'',
	"USE THIS FOR client-side bugs invisible to server-side logs: React render/hydration errors, broken client-side fetches, missing assets (4xx/5xx), CSP/CORS violations, JS exceptions in handlers.",
	'',
	"DEFAULTS to the current preview URL. Pass 'url' to inspect a specific route. Pass 'wait_seconds' (default 5, max 25) to allow late-firing logs/network calls after page load. Optional 'interact_script' is a JS string evaluated in the page after load (e.g. 'document.querySelector(\"button\").click()') to trigger interactions before logs are collected.",
	'',
	"OUTPUT is JSON: { url, captured_at, logs:[{level,text,location}], page_errors:[{message,stack}], request_failures:[{url,failure,status}], truncated, totals, warning?, retry_cap_reached? }. If 'warning' is set in dev, the browser sidecar wasn't reachable — instruct the user to run 'npm run dev:browser' and retry. Each category is independently capped at max_lines (default 100, -1 = no limit).",
].join('\n');

export interface BrowserConsoleLogsToolOptions {
	env: Env;
	defaultUrl?: string;
	verification?: TurnVerification;
	retryState?: BuildRetryState;
}

/** Fetch the preview URL and confirm it returned HTTP 200 (not 2xx — 200). */
async function checkPreviewHttpOk(
	url: string,
): Promise<{ ok: boolean; status?: number; error?: string }> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 10_000);
	try {
		const res = await fetch(url, { redirect: 'follow', signal: controller.signal });
		return res.status === 200
			? { ok: true, status: 200 }
			: { ok: false, status: res.status, error: `preview returned HTTP ${res.status}` };
	} catch (e) {
		return {
			ok: false,
			error: `preview HTTP check failed: ${e instanceof Error ? e.message : String(e)}`,
		};
	} finally {
		clearTimeout(timeout);
	}
}

export function createBrowserConsoleLogsTool(opts: BrowserConsoleLogsToolOptions): Tool {
	const { env, defaultUrl } = opts;
	const verification = opts.verification;
	const retryState = opts.retryState ?? { consecutiveFailures: 0 };
	const logger = createLogger('ThinkBrowserLogs');
	return tool({
		description: DESCRIPTION,
		inputSchema: z.object({
			url: z
				.string()
				.optional()
				.describe('Optional URL to inspect. Defaults to the current preview URL.'),
			wait_seconds: z
				.number()
				.optional()
				.describe('Seconds to wait after page load for late output. Default 5, max 25.'),
			max_lines: z
				.number()
				.optional()
				.describe(
					'Max entries returned per category (logs, page_errors, request_failures). Default 100. Set -1 for no limit.',
				),
			interact_script: z
				.string()
				.optional()
				.describe('Optional JS string evaluated in the page after load to trigger interactions.'),
		}),
		execute: async (args: {
			url?: string;
			wait_seconds?: number;
			max_lines?: number;
			interact_script?: string;
		}) => {
			const targetUrl = args.url ?? defaultUrl;
			if (!targetUrl) {
				return JSON.stringify({
					error:
						'No preview URL available yet. Deploy the app first, or pass an explicit `url`.',
				});
			}

			const client = getBrowserCaptureClient(env, logger);
			let result;
			try {
				result = await client.captureConsoleLogs({
					url: targetUrl,
					waitSeconds: Math.min(Math.max(args.wait_seconds ?? 2, 0), 25),
					viewport: { width: 1280, height: 800 },
					interactScript: args.interact_script,
				});
			} catch (e) {
				const message = `Browser console capture failed: ${e instanceof Error ? e.message : String(e)}`;
				if (verification) verification.lastError = message;
				if (retryState) retryState.consecutiveFailures += 1;
				return JSON.stringify({ error: message });
			}

			const cap = args.max_lines ?? 100;
			const trunc = <T>(arr: T[]): T[] => (cap === -1 ? arr : arr.slice(-cap));
			const truncated =
				cap !== -1 &&
				(result.logs.length > cap ||
					result.pageErrors.length > cap ||
					result.requestFailures.length > cap);

			// ── Verification (item 3) ──────────────────────────────────────
			// Clean = zero uncaught page errors and zero failed network requests.
			const consoleClean =
				result.pageErrors.length === 0 && result.requestFailures.length === 0;
			const http = await checkPreviewHttpOk(targetUrl);
			if (verification) {
				verification.consoleChecked = true;
				verification.consoleClean = consoleClean;
				verification.previewOk = http.ok;
				if (!consoleClean) {
					verification.lastError =
						result.pageErrors[0]?.message ??
						result.requestFailures[0]?.failure ??
						'browser console reported errors';
				}
				if (!http.ok) {
					verification.lastError = http.error ?? verification.lastError;
				}
			}

			// ── Retry cap (item 4): count preview/console failures ─────────
			let retryCapReached = false;
			if (verification?.deployed) {
				const verified = consoleClean && http.ok;
				if (verified) {
					if (retryState) retryState.consecutiveFailures = 0;
				} else if (retryState) {
					retryState.consecutiveFailures += 1;
					retryCapReached = retryState.consecutiveFailures >= MAX_CONSECUTIVE_BUILD_FAILURES;
				}
			}

			return JSON.stringify(
				{
					url: result.url,
					captured_at: result.capturedAt,
					logs: trunc(result.logs),
					page_errors: trunc(result.pageErrors),
					request_failures: trunc(result.requestFailures),
					truncated,
					totals: {
						logs: result.logs.length,
						page_errors: result.pageErrors.length,
						request_failures: result.requestFailures.length,
					},
					preview_http_ok: http.ok,
					...(http.status ? { preview_http_status: http.status } : {}),
					...(result.warning ? { warning: result.warning } : {}),
					...(retryCapReached
						? {
								retry_cap_reached: `RETRY_CAP_REACHED: ${MAX_CONSECUTIVE_BUILD_FAILURES} consecutive build failures. Stop deploying and report the latest preview error.`,
							}
						: {}),
				},
				null,
				2,
			);
		},
	});
}

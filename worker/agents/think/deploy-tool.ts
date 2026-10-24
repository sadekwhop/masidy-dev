/**
 * `deploy_space` — commits
 * the working tree and deploys a SpaceDO branch so the preview at
 * `/space/:name/preview/:branch/` rebuilds. The skills (see
 * `skills/app-file-structure`) instruct the model to call this after writing
 * files; pair it with `get_browser_console_logs` to verify the preview.
 *
 * Runs inside the ThinkAgent DO and talks to the companion SpaceDO directly via
 * RPC (no round-trip through the busy parent agent). Shares a per-turn
 * {@link TurnVerification} record with `get_browser_console_logs` and a
 * {@link BuildRetryState} counter so deploy AND preview/console failures count
 * toward the same retry cap.
 */
import { tool, type Tool } from 'ai';
import { z } from 'zod';
import { withDurableObjectResetRetry, type SpaceWorkspaceStub } from './space-workspace-ops';
import {
	MAX_CONSECUTIVE_BUILD_FAILURES,
	type BuildRetryState,
	type TurnVerification,
} from './turn-verification';

const DESCRIPTION = [
	'Commit the current working tree and deploy a branch so its preview rebuilds and serves the latest code.',
	'',
	'Call this after writing/editing files to make changes visible in the preview. Deployment validates the app against the SpaceDO runtime contract before publishing it. Returns the deploy result as JSON, including the preview path and any build or runtime-validation errors. Treat errors as your responsibility: inspect the details, fix the project, and retry deployment without asking the user to explain platform requirements.',
	'',
	"Defaults to the 'main' branch.",
].join('\n');

export interface DeploySpaceToolOptions {
	getStub: () => SpaceWorkspaceStub;
	getPreviewUrl?: () => string | undefined;
	/** Per-turn verification record shared with `get_browser_console_logs`. */
	verification?: TurnVerification;
	/** Shared deploy + preview/console failure counter (item 4). */
	retryState?: BuildRetryState;
}

export function createDeploySpaceTool(opts: DeploySpaceToolOptions): Tool {
	const { getStub, getPreviewUrl } = opts;
	const verification = opts.verification;
	const retryState = opts.retryState ?? { consecutiveFailures: 0 };

	const recordFailure = (message: string): void => {
		if (verification) verification.lastError = message;
		retryState.consecutiveFailures += 1;
	};

	return tool({
		description: DESCRIPTION,
		inputSchema: z.object({
			branch: z
				.string()
				.optional()
				.describe("Git branch to deploy. Defaults to 'main'."),
		}),
		execute: async (args: { branch?: string }) => {
			if (retryState.consecutiveFailures >= MAX_CONSECUTIVE_BUILD_FAILURES) {
				return JSON.stringify({
					error: `RETRY_CAP_REACHED: ${MAX_CONSECUTIVE_BUILD_FAILURES} consecutive build failures (failed deploys or unverified previews). Build paused to protect your credits. Review the latest deploy/preview error before deploying again.`,
				});
			}

			const branch = args.branch && args.branch.length > 0 ? args.branch : 'main';
			try {
				await withDurableObjectResetRetry(getStub, (stub) =>
					stub.gitCommit('deploy: snapshot working tree'),
				);
			} catch {
				// No changes to commit (clean tree) — proceed to deploy the existing HEAD.
			}
			try {
				const result = (await withDurableObjectResetRetry(getStub, (stub) =>
					stub.deploy(branch),
				)) as Record<string, unknown>;
				const output: Record<string, unknown> = { branch, ...result };
				const signedUrl = getPreviewUrl?.();
				if (signedUrl) {
					output.preview_url = signedUrl;
				}

				// SpaceDO reports build/config/contract-validation failures in the
				// payload (with `error`) rather than throwing — count those as
				// build failures too, not just thrown RPC errors.
				if (typeof result?.error === 'string') {
					const details = typeof result.details === 'string' ? result.details : '';
					const message = details ? `${result.error}: ${details}` : result.error;
					recordFailure(message);
					if (retryState.consecutiveFailures >= MAX_CONSECUTIVE_BUILD_FAILURES) {
						return JSON.stringify({
							branch,
							error: `Deploy failed: ${message}. RETRY_CAP_REACHED: ${MAX_CONSECUTIVE_BUILD_FAILURES} consecutive build failures reached. Generation paused to avoid wasting credits.`,
						});
					}
					return JSON.stringify({ branch, error: `Deploy failed: ${message}` });
				}

				// Successful deploy: a new build invalidates any prior console
				// check, so the turn is not verified again until the browser is
				// re-checked. Reset the failure counter.
				if (verification) {
					verification.deployed = true;
					verification.deployCommit =
						typeof result?.commit_hash === 'string' ? result.commit_hash : undefined;
					verification.consoleChecked = false;
					verification.consoleClean = false;
					verification.previewOk = false;
					verification.lastError = undefined;
				}
				retryState.consecutiveFailures = 0;
				return JSON.stringify(output, null, 2);
			} catch (e) {
				const errMsg = e instanceof Error ? e.message : String(e);
				recordFailure(errMsg);
				if (retryState.consecutiveFailures >= MAX_CONSECUTIVE_BUILD_FAILURES) {
					return JSON.stringify({
						branch,
						error: `Deploy failed: ${errMsg}. RETRY_CAP_REACHED: ${MAX_CONSECUTIVE_BUILD_FAILURES} consecutive build failures reached. Generation paused to avoid wasting credits.`,
					});
				}
				return JSON.stringify({ branch, error: `Deploy failed: ${errMsg}` });
			}
		},
	});
}

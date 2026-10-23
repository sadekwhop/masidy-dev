/**
 * `deploy_space` — commits
 * the working tree and deploys a SpaceDO branch so the preview at
 * `/space/:name/preview/:branch/` rebuilds. The skills (see
 * `skills/app-file-structure`) instruct the model to call this after writing
 * files; pair it with `get_browser_console_logs` to verify the preview.
 *
 * Runs inside the ThinkAgent DO and talks to the companion SpaceDO directly via
 * RPC (no round-trip through the busy parent agent).
 */
import { tool, type Tool } from 'ai';
import { z } from 'zod';
import { withDurableObjectResetRetry, type SpaceWorkspaceStub } from './space-workspace-ops';

const DESCRIPTION = [
	'Commit the current working tree and deploy a branch so its preview rebuilds and serves the latest code.',
	'',
	'Call this after writing/editing files to make changes visible in the preview. Deployment validates the app against the SpaceDO runtime contract before publishing it. Returns the deploy result as JSON, including the preview path and any build or runtime-validation errors. Treat errors as your responsibility: inspect the details, fix the project, and retry deployment without asking the user to explain platform requirements.',
	'',
	"Defaults to the 'main' branch.",
].join('\n');

export function createDeploySpaceTool(opts: {
	getStub: () => SpaceWorkspaceStub;
	getPreviewUrl?: () => string | undefined;
}): Tool {
	const { getStub, getPreviewUrl } = opts;
	let consecutiveDeployFailures = 0;
	const MAX_CONSECUTIVE_DEPLOY_FAILURES = 3;

	return tool({
		description: DESCRIPTION,
		inputSchema: z.object({
			branch: z
				.string()
				.optional()
				.describe("Git branch to deploy. Defaults to 'main'."),
		}),
		execute: async (args: { branch?: string }) => {
			if (consecutiveDeployFailures >= MAX_CONSECUTIVE_DEPLOY_FAILURES) {
				return JSON.stringify({
					error: `RETRY_CAP_REACHED: ${MAX_CONSECUTIVE_DEPLOY_FAILURES} consecutive deployments failed. Build paused to protect your credits. Please review error logs before attempting to deploy again.`,
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
				const result = await withDurableObjectResetRetry(getStub, (stub) => stub.deploy(branch));
				const output: Record<string, unknown> = { branch, ...(result as Record<string, unknown>) };
				const signedUrl = getPreviewUrl?.();
				if (signedUrl) {
					output.preview_url = signedUrl;
				}
				consecutiveDeployFailures = 0; // reset on successful deploy
				return JSON.stringify(output, null, 2);
			} catch (e) {
				consecutiveDeployFailures++;
				const errMsg = e instanceof Error ? e.message : String(e);
				if (consecutiveDeployFailures >= MAX_CONSECUTIVE_DEPLOY_FAILURES) {
					return JSON.stringify({
						branch,
						error: `Deploy failed: ${errMsg}. RETRY_CAP_REACHED: ${MAX_CONSECUTIVE_DEPLOY_FAILURES} consecutive deployment failures reached. Generation paused to avoid wasting credits.`,
					});
				}
				return JSON.stringify({
					branch,
					error: `Deploy failed: ${errMsg}`,
				});
			}
		},
	});
}

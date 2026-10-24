/**
 * Per-turn build-verification state shared between the `deploy_space` and
 * `get_browser_console_logs` tools, plus the pure decision helpers used by the
 * ThinkAgent end-of-turn gate and the zero-waste credit policy.
 *
 * A build turn is "verified working" only when a successful `deploy_space` was
 * followed by a `get_browser_console_logs` check that reported zero console /
 * page errors AND the preview URL returned HTTP 200. The ThinkAgent refunds
 * the credits a turn consumed unless that bar is met.
 */

export interface TurnVerification {
	/** A successful `deploy_space` happened this turn. */
	deployed: boolean;
	/** `get_browser_console_logs` ran after the last deploy. */
	consoleChecked: boolean;
	/** The last console check reported zero page errors and zero failed requests. */
	consoleClean: boolean;
	/** The preview URL returned HTTP 200 after the last deploy. */
	previewOk: boolean;
	/**
	 * `audit_dom` ran after the last deploy and reported no issues.
	 * Starts as undefined (audit not yet run); set to true by a clean audit or
	 * when the sidecar is unavailable (fail-open). Set to false when the audit
	 * finds issues.
	 */
	auditPassed?: boolean;
	/** Last successful deploy's commit hash (a new deploy invalidates prior checks). */
	deployCommit?: string;
	/** Plain description of the latest preview/deploy error, if known. */
	lastError?: string;
}

/**
 * A build turn is verified only when every check after the last deploy passes.
 * `auditPassed` uses tri-state: undefined means "not yet run" (not blocking if
 * the turn also has no deploy — that's a non-build turn). For a build turn,
 * undefined counts as not verified.
 */
export function isTurnVerified(v: TurnVerification): boolean {
	return (
		v.deployed &&
		v.consoleChecked &&
		v.consoleClean &&
		v.previewOk &&
		(v.auditPassed === true || v.auditPassed === undefined)
	);
}

/**
 * Zero-waste billing: a build turn keeps its credits only when the preview was
 * verified working; an unverified build turn is refunded in full. Non-build
 * turns (no deploy) keep their normal LLM metering.
 */
export function computeTurnCreditAdjustment(
	verification: TurnVerification,
	consumed: number,
): { charge: number; refund: number } {
	if (!verification.deployed) {
		return { charge: consumed, refund: 0 };
	}
	return isTurnVerified(verification)
		? { charge: consumed, refund: 0 }
		: { charge: 0, refund: consumed };
}

/** Prefix every end-of-turn "not working" message uses (never "likely transient"). */
export const NOT_WORKING_PREFIX = 'The app is NOT working.';

/**
 * Plain, no-euphemism failure message for a build turn that did not verify.
 * Returns null when the turn was not a build turn or verified successfully, so
 * the caller can gate the final broadcast on a non-null result.
 */
export function turnNotWorkingMessage(v: TurnVerification): string | null {
	if (!v.deployed || isTurnVerified(v)) return null;
	const reasons: string[] = [];
	if (!v.consoleChecked) reasons.push('no browser-console check ran after the last deploy');
	else if (!v.consoleClean) reasons.push('the browser preview reported console or page errors');
	else if (!v.previewOk) reasons.push('the preview did not return HTTP 200');
	else if (v.auditPassed === false) reasons.push('the DOM audit found visual issues (low contrast, broken images, missing submit button, etc.)');
	const detail = v.lastError
		? ` Last error: ${v.lastError}`
		: reasons.length
			? ` Reason: ${reasons[0]}.`
			: '';
	return `${NOT_WORKING_PREFIX} The latest deploy was not verified.${detail} Fix the error, redeploy, and re-check the browser console and DOM audit before reporting success.`;
}

/** Shared retry-cap counter for deploy and preview/console failures (item 4). */
export interface BuildRetryState {
	consecutiveFailures: number;
}

export const MAX_CONSECUTIVE_BUILD_FAILURES = 3;

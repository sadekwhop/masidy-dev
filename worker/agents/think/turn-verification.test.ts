import { describe, expect, it } from 'vitest';
import {
	computeTurnCreditAdjustment,
	isTurnVerified,
	turnNotWorkingMessage,
	NOT_WORKING_PREFIX,
	type TurnVerification,
} from './turn-verification';

function base(over: Partial<TurnVerification> = {}): TurnVerification {
	return {
		deployed: false,
		consoleChecked: false,
		consoleClean: false,
		previewOk: false,
		...over,
	};
}

describe('isTurnVerified', () => {
	it('is true only when a deploy was followed by a clean console check and HTTP 200', () => {
		expect(isTurnVerified(base())).toBe(false);
		expect(isTurnVerified(base({ deployed: true }))).toBe(false);
		expect(isTurnVerified(base({ deployed: true, consoleChecked: true }))).toBe(false);
		expect(
			isTurnVerified(base({ deployed: true, consoleChecked: true, consoleClean: true })),
		).toBe(false);
		expect(
			isTurnVerified(
				base({ deployed: true, consoleChecked: true, consoleClean: true, previewOk: true }),
			),
		).toBe(true);
	});

	it('fails when console was dirty even if HTTP was 200', () => {
		expect(
			isTurnVerified(
				base({ deployed: true, consoleChecked: true, consoleClean: false, previewOk: true }),
			),
		).toBe(false);
	});

	it('is true when auditPassed is undefined (audit not yet run — non-blocking)', () => {
		// undefined means the audit tool was not called; fail-open for non-landing turns
		expect(
			isTurnVerified(
				base({
					deployed: true,
					consoleChecked: true,
					consoleClean: true,
					previewOk: true,
					auditPassed: undefined,
				}),
			),
		).toBe(true);
	});

	it('is true when auditPassed is true', () => {
		expect(
			isTurnVerified(
				base({
					deployed: true,
					consoleChecked: true,
					consoleClean: true,
					previewOk: true,
					auditPassed: true,
				}),
			),
		).toBe(true);
	});

	it('is false when auditPassed is explicitly false', () => {
		expect(
			isTurnVerified(
				base({
					deployed: true,
					consoleChecked: true,
					consoleClean: true,
					previewOk: true,
					auditPassed: false,
				}),
			),
		).toBe(false);
	});
});

describe('computeTurnCreditAdjustment (zero-waste billing)', () => {
	it('keeps credits for a verified build turn', () => {
		const v = base({ deployed: true, consoleChecked: true, consoleClean: true, previewOk: true });
		expect(computeTurnCreditAdjustment(v, 7)).toEqual({ charge: 7, refund: 0 });
	});

	it('refunds all credits for a build turn that ended without a verified working preview', () => {
		const v = base({ deployed: true, consoleChecked: false });
		expect(computeTurnCreditAdjustment(v, 7)).toEqual({ charge: 0, refund: 7 });
	});

	it('refunds when the deploy succeeded but the preview did not return HTTP 200', () => {
		const v = base({ deployed: true, consoleChecked: true, consoleClean: true, previewOk: false });
		expect(computeTurnCreditAdjustment(v, 5)).toEqual({ charge: 0, refund: 5 });
	});

	it('does not refund a non-build turn (no deploy) — normal LLM metering stays', () => {
		const v = base({ deployed: false });
		expect(computeTurnCreditAdjustment(v, 4)).toEqual({ charge: 4, refund: 0 });
	});

	it('refunds nothing when nothing was consumed', () => {
		const v = base({ deployed: true, consoleChecked: false });
		expect(computeTurnCreditAdjustment(v, 0)).toEqual({ charge: 0, refund: 0 });
	});
});

describe('turnNotWorkingMessage', () => {
	it('is null for non-build turns and verified build turns', () => {
		expect(turnNotWorkingMessage(base({ deployed: false }))).toBeNull();
		expect(
			turnNotWorkingMessage(
				base({ deployed: true, consoleChecked: true, consoleClean: true, previewOk: true }),
			),
		).toBeNull();
	});

	it('states plainly the app is NOT working and never uses "likely transient"', () => {
		const msg = turnNotWorkingMessage(base({ deployed: true, consoleChecked: false }));
		expect(msg).not.toBeNull();
		expect(msg!.startsWith(NOT_WORKING_PREFIX)).toBe(true);
		expect(msg).not.toContain('likely transient');
	});

	it('includes the specific reason when the preview did not return HTTP 200', () => {
		const msg = turnNotWorkingMessage(
			base({ deployed: true, consoleChecked: true, consoleClean: true, previewOk: false }),
		);
		expect(msg).toContain('HTTP 200');
	});

	it('surfaces the last error when known', () => {
		const msg = turnNotWorkingMessage(
			base({ deployed: true, consoleChecked: false, lastError: 'preview returned 503' }),
		);
		expect(msg).toContain('preview returned 503');
	});

	it('mentions DOM audit when that is the blocking reason', () => {
		const msg = turnNotWorkingMessage(
			base({
				deployed: true,
				consoleChecked: true,
				consoleClean: true,
				previewOk: true,
				auditPassed: false,
				lastError: 'DOM audit failed: low contrast 2.1:1',
			}),
		);
		expect(msg).not.toBeNull();
		expect(msg!.startsWith(NOT_WORKING_PREFIX)).toBe(true);
		expect(msg).toContain('low contrast 2.1:1');
	});
});

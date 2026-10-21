import { describe, expect, it } from 'vitest';
import { getDeployFailureMessage, parseDeployResult } from './deploy-result';

describe('deploy result errors', () => {
	it('preserves build details from the JSON deploy tool output', () => {
		const result = parseDeployResult('{"error":"Build failed","details":"Could not resolve ./missing-module"}');

		expect(getDeployFailureMessage(result)).toBe(
			'Build failed: Could not resolve ./missing-module',
		);
	});

	it('returns a deploy error when no details are available', () => {
		expect(getDeployFailureMessage({ error: 'Build failed' })).toBe('Build failed');
	});

	it('ignores successful and malformed deploy results', () => {
		expect(getDeployFailureMessage(parseDeployResult('{"commit_hash":"abc123"}'))).toBeNull();
		expect(parseDeployResult('not json')).toBeUndefined();
	});
});

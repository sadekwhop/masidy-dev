export function parseDeployResult(output: unknown): Record<string, unknown> | undefined {
	if (typeof output === 'string') {
		try {
			return JSON.parse(output) as Record<string, unknown>;
		} catch {
			return undefined;
		}
	}

	return output && typeof output === 'object'
		? output as Record<string, unknown>
		: undefined;
}

export function getDeployFailureMessage(result: Record<string, unknown> | undefined): string | null {
	if (typeof result?.error !== 'string') return null;

	const details = typeof result.details === 'string' ? result.details.trim() : '';
	return details ? `${result.error}: ${details}` : result.error;
}

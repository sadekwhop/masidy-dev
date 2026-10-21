import { describe, expect, it } from 'vitest';
import {
	parseCloudflareAccessConfig,
	verifyCloudflareAccessJwt,
} from './cloudflareAccess';

describe('Cloudflare Access MCP authentication', () => {
	it('builds the expected issuer, audience, and signing-key endpoint', () => {
		expect(parseCloudflareAccessConfig('https://masidy.cloudflareaccess.com', 'app-aud')).toEqual({
			issuer: 'https://masidy.cloudflareaccess.com',
			jwksUrl: new URL('https://masidy.cloudflareaccess.com/cdn-cgi/access/certs'),
			audience: 'app-aud',
		});
	});

	it.each([
		[undefined, 'app-aud'],
		['https://masidy.cloudflareaccess.com', undefined],
		['http://masidy.cloudflareaccess.com', 'app-aud'],
		['https://masidy.cloudflareaccess.com/path', 'app-aud'],
		['not a URL', 'app-aud'],
	])('rejects incomplete or invalid Access configuration', (teamDomain, audience) => {
		expect(parseCloudflareAccessConfig(teamDomain, audience)).toBeNull();
	});

	it('rejects malformed assertions without making them authenticated', async () => {
		const config = parseCloudflareAccessConfig(
			'https://masidy.cloudflareaccess.com',
			'app-aud',
		)!;
		await expect(verifyCloudflareAccessJwt('not-a-jwt', config)).resolves.toBe(false);
	});
});

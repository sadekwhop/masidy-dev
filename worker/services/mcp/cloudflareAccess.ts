import { createRemoteJWKSet, jwtVerify } from 'jose';

export interface CloudflareAccessConfig {
	issuer: string;
	jwksUrl: URL;
	audience: string;
}

const remoteKeySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export function parseCloudflareAccessConfig(
	teamDomain: string | undefined,
	audience: string | undefined,
): CloudflareAccessConfig | null {
	if (!teamDomain || !audience) return null;

	try {
		const url = new URL(teamDomain);
		if (
			url.protocol !== 'https:' ||
			url.username ||
			url.password ||
			url.pathname !== '/' ||
			url.search ||
			url.hash
		) {
			return null;
		}

		return {
			issuer: url.origin,
			jwksUrl: new URL('/cdn-cgi/access/certs', url.origin),
			audience,
		};
	} catch {
		return null;
	}
}

export async function verifyCloudflareAccessJwt(
	token: string,
	config: CloudflareAccessConfig,
): Promise<boolean> {
	let keySet = remoteKeySets.get(config.issuer);
	if (!keySet) {
		keySet = createRemoteJWKSet(config.jwksUrl);
		remoteKeySets.set(config.issuer, keySet);
	}

	try {
		await jwtVerify(token, keySet, {
			issuer: config.issuer,
			audience: config.audience,
			algorithms: ['RS256'],
		});
		return true;
	} catch {
		return false;
	}
}

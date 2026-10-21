import { AppService } from '../../database/services/AppService';
import { createLogger } from '../../logger';
import {
	buildOwnerPreviewCookie,
	readOwnerPreviewCookie,
	readOwnerPreviewTokenFromQuery,
	verifyOwnerPreviewToken,
} from '../../utils/ownerPreviewToken';
import { getManagedAppDomain } from '../../utils/urls';

const logger = createLogger('PublishedApps');
const PUBLISHED_REQUEST_PATH = '/__masidy/published';
const APP_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const GLOBAL_PUBLISHED_REQUEST_DAILY_LIMIT = 10_000;

export function isManagedAppHost(hostname: string, appDomain: string): boolean {
	const normalizedHostname = hostname.toLowerCase().replace(/\.$/, '');
	const normalizedDomain = appDomain.toLowerCase().replace(/\.$/, '');
	return normalizedHostname.endsWith(`.${normalizedDomain}`);
}

export function getManagedAppSlug(hostname: string, appDomain: string): string | null {
	const normalizedHostname = hostname.toLowerCase().replace(/\.$/, '');
	const normalizedDomain = appDomain.toLowerCase().replace(/\.$/, '');
	const suffix = `.${normalizedDomain}`;
	if (!normalizedHostname.endsWith(suffix)) return null;

	const slug = normalizedHostname.slice(0, -suffix.length);
	return APP_SLUG_PATTERN.test(slug) ? slug : null;
}

type PublishedAppOwnership = NonNullable<
	Awaited<ReturnType<AppService['getAppOwnershipByDeploymentId']>>
>;

export async function handlePublishedAppRequest(
	request: Request,
	env: Env,
	deploymentId: string,
	knownApp?: PublishedAppOwnership,
): Promise<Response> {
	const app = knownApp ?? await new AppService(env).getAppOwnershipByDeploymentId(deploymentId);
	if (!app || app.status !== 'completed') {
		return new Response('This application is not currently available.', { status: 404 });
	}

	let ownerAuthedViaQuery = false;
	if (app.visibility === 'private' && app.userId) {
		const url = new URL(request.url);
		const queryToken = readOwnerPreviewTokenFromQuery(url);
		const cookieToken = readOwnerPreviewCookie(request);

		let ownerId: string | null = null;
		if (queryToken) {
			ownerId = await verifyOwnerPreviewToken(env, queryToken, deploymentId);
			ownerAuthedViaQuery = ownerId !== null;
		}
		if (!ownerId && cookieToken) {
			ownerId = await verifyOwnerPreviewToken(env, cookieToken, deploymentId);
		}
		if (ownerId !== app.userId) {
			return new Response('This application is not currently available.', { status: 404 });
		}
	}

	if (!env.SPACE_DO) {
		logger.error('SpaceDO binding is unavailable for published app request');
		return new Response('Published applications are temporarily unavailable.', { status: 503 });
	}

	try {
		const now = new Date();
		const globalUsage = await env.DORateLimitStore
			.get(env.DORateLimitStore.idFromName('managed-published-apps'))
			.increment(
				'managed-published-apps',
				{
					limit: GLOBAL_PUBLISHED_REQUEST_DAILY_LIMIT,
					period: 24 * 60 * 60,
					calendarDaily: true,
					bucketSize: 60 * 60,
				},
			);
		if (!globalUsage.success) {
			const resetAt = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
			return new Response('Masidy daily app request limit reached.', {
				status: 429,
				headers: {
					'Retry-After': String(Math.ceil((resetAt - now.getTime()) / 1000)),
					'Cache-Control': 'no-store',
				},
			});
		}

		const space = env.SPACE_DO.get(env.SPACE_DO.idFromName(app.id));
		const url = new URL(request.url);
		url.pathname = `${PUBLISHED_REQUEST_PATH}${url.pathname}`;
		const response = await space.fetch(new Request(url, request));
		if (!ownerAuthedViaQuery || response.status === 101) return response;

		const responseHeaders = new Headers(response.headers);
		responseHeaders.append(
			'Set-Cookie',
			buildOwnerPreviewCookie({
				token: readOwnerPreviewTokenFromQuery(new URL(request.url))!,
				secure: new URL(request.url).protocol === 'https:',
			}),
		);
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers: responseHeaders,
		});
	} catch (error) {
		logger.error(`Failed to serve published app '${deploymentId}'`, error);
		return new Response('Published applications are temporarily unavailable.', { status: 503 });
	}
}

export async function routeManagedAppRequest(
	request: Request,
	env: Env,
): Promise<Response | null> {
	const url = new URL(request.url);
	const appDomain = getManagedAppDomain(env);
	if (!isManagedAppHost(url.hostname, appDomain)) return null;

	const deploymentId = getManagedAppSlug(url.hostname, appDomain);
	if (!deploymentId) return null;

	const app = await new AppService(env).getAppOwnershipByDeploymentId(deploymentId);
	if (!app) return null;

	return handlePublishedAppRequest(request, env, deploymentId, app);
}

import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
	ownership: null as null | {
		id: string;
		userId: string | null;
		visibility: 'private' | 'public';
		status: 'generating' | 'completed';
	},
}));

vi.mock('../../database/services/AppService', () => ({
	AppService: class {
		async getAppOwnershipByDeploymentId() {
			return state.ownership;
		}
	},
}));

const {
	getManagedAppSlug,
	handlePublishedAppRequest,
	isManagedAppHost,
	routeManagedAppRequest,
} = await import('./controller');
const { signOwnerPreviewToken } = await import('../../utils/ownerPreviewToken');

beforeEach(() => {
	state.ownership = {
		id: 'app-123',
		userId: 'user-1',
		visibility: 'public',
		status: 'completed',
	};
});

function makeEnv(
	fetch: ReturnType<typeof vi.fn> = vi.fn(async () => new Response('app response')),
	globalLimit: { success: boolean } = { success: true },
) {
	const spaceStub = { fetch };
	const namespace = {
		idFromName: vi.fn((name: string) => `id:${name}`),
		get: vi.fn(() => spaceStub),
	};
	const rateLimitStub = { increment: vi.fn(async () => globalLimit) };
	const rateLimitNamespace = {
		idFromName: vi.fn((name: string) => `rate:${name}`),
		get: vi.fn(() => rateLimitStub),
	};
	return {
		env: {
			CUSTOM_DOMAIN: 'masidy.dev',
			JWT_SECRET: 'test-secret-for-published-owner-token-1234567890',
			SPACE_DO: namespace,
			DORateLimitStore: rateLimitNamespace,
		} as unknown as Env,
		namespace,
		fetch,
		rateLimitNamespace,
	};
}

describe('managed app host routing', () => {
	it('recognizes exactly one valid app slug under the configured domain', () => {
		expect(isManagedAppHost('shop.masidy.dev', 'masidy.dev')).toBe(true);
		expect(getManagedAppSlug('shop-123456789abc.masidy.dev', 'masidy.dev')).toBe('shop-123456789abc');
		expect(getManagedAppSlug('a.b.masidy.dev', 'masidy.dev')).toBeNull();
		expect(getManagedAppSlug('bad_slug.masidy.dev', 'masidy.dev')).toBeNull();
		expect(isManagedAppHost('masidy.dev', 'masidy.dev')).toBe(false);
	});

	it('forwards app requests to the app-specific SpaceDO while preserving URL and method', async () => {
		const { env, namespace, fetch } = makeEnv();
		const request = new Request('https://shop-123456789abc.masidy.dev/api/items?q=1', {
			method: 'POST',
			body: 'payload',
		});

		const response = await routeManagedAppRequest(request, env);

		expect(await response?.text()).toBe('app response');
		expect(namespace.idFromName).toHaveBeenCalledWith('app-123');
		expect(fetch).toHaveBeenCalledTimes(1);
		const forwarded = fetch.mock.calls[0][0] as Request;
		expect(new URL(forwarded.url).pathname).toBe('/__masidy/published/api/items');
		expect(new URL(forwarded.url).search).toBe('?q=1');
		expect(forwarded.method).toBe('POST');
		expect(await forwarded.text()).toBe('payload');
	});

	it('routes separate apps to separate SpaceDO identities', async () => {
		const { env, namespace } = makeEnv();
		const request = new Request('https://shop-123456789abc.masidy.dev/');

		await routeManagedAppRequest(request, env);
		state.ownership = { ...state.ownership!, id: 'app-456' };
		await routeManagedAppRequest(request, env);

		expect(namespace.idFromName.mock.calls).toEqual([['app-123'], ['app-456']]);
	});

	it('blocks published app requests when the account-wide daily cap is exhausted', async () => {
		const { env, fetch } = makeEnv(undefined, { success: false });
		const response = await routeManagedAppRequest(
			new Request('https://shop-123456789abc.masidy.dev/'),
			env,
		);

		expect(response?.status).toBe(429);
		expect(response?.headers.get('Retry-After')).toBeTruthy();
		expect(fetch).not.toHaveBeenCalled();
	});

	it('does not serve private or incomplete apps', async () => {
		const { env, fetch } = makeEnv();

		state.ownership = { ...state.ownership!, visibility: 'private' };
		expect((await handlePublishedAppRequest(new Request('https://x.test/'), env, 'shop')).status).toBe(404);

		state.ownership = { ...state.ownership!, status: 'generating', visibility: 'public' };
		expect((await handlePublishedAppRequest(new Request('https://x.test/'), env, 'shop')).status).toBe(404);
		expect(fetch).not.toHaveBeenCalled();
	});

	it('allows the private owner with a deployment-scoped token and sets an owner cookie', async () => {
		const { env, fetch } = makeEnv();
		state.ownership = { ...state.ownership!, visibility: 'private' };
		const token = await signOwnerPreviewToken(env, {
			userId: 'user-1',
			deploymentId: 'shop-123456789abc',
		});

		const response = await routeManagedAppRequest(
			new Request(`https://shop-123456789abc.masidy.dev/?__vibesdk_owner=${encodeURIComponent(token)}`),
			env,
		);

		expect(response?.status).toBe(200);
		expect(response?.headers.get('Set-Cookie')).toContain('HttpOnly');
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it('returns 404 for unknown apps and malformed hosts', async () => {
		const { env, fetch } = makeEnv();
		state.ownership = null;
		expect((await handlePublishedAppRequest(new Request('https://x.test/'), env, 'unknown')).status).toBe(404);
		expect(await routeManagedAppRequest(new Request('https://a.b.masidy.dev/'), env)).toBeNull();
		expect(await routeManagedAppRequest(new Request('https://www.masidy.dev/'), env)).toBeNull();
		expect(fetch).not.toHaveBeenCalled();
	});

	it('leaves requests outside the managed app domain to the normal router', async () => {
		const { env } = makeEnv();
		expect(await routeManagedAppRequest(new Request('https://masidy.dev/'), env)).toBeNull();
		expect(await routeManagedAppRequest(new Request('https://example.com/slug/'), env)).toBeNull();
	});
});

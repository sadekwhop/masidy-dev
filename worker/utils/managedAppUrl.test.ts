import { describe, expect, it } from 'vitest';
import {
	buildManagedAppDeploymentId,
	buildManagedAppUrl,
	getManagedAppDomain,
} from './urls';

describe('managed app URLs', () => {
	it('creates a stable DNS-safe id unique to the app', () => {
		expect(buildManagedAppDeploymentId('My New App!', 'app-123456789abc')).toBe('my-new-app-123456789abc');
		expect(buildManagedAppDeploymentId('My New App!', 'other-987654321xyz')).not.toBe(
			buildManagedAppDeploymentId('My New App!', 'app-123456789abc'),
		);
		expect(buildManagedAppDeploymentId('!!!', 'app-1')).toBe('app-app1');
	});

	it('serves managed apps on unique first-level subdomains of the main domain', () => {
		const baseEnv = { CUSTOM_DOMAIN: 'masidy.dev' } as Env;
		expect(getManagedAppDomain(baseEnv)).toBe('masidy.dev');
		expect(buildManagedAppUrl(baseEnv, 'demo-app')).toBe('https://demo-app.masidy.dev');

		const customEnv = { CUSTOM_DOMAIN: 'example.test' } as Env;
		expect(buildManagedAppUrl(customEnv, 'demo-app')).toBe('https://demo-app.example.test');
	});
});

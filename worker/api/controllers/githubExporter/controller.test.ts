import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '../../types/route-context';

const { mockCheckAppOwnership, mockGetGitHubToken, mockCreateOAuthProvider } = vi.hoisted(() => ({
	mockCheckAppOwnership: vi.fn(),
	mockGetGitHubToken: vi.fn(),
	mockCreateOAuthProvider: vi.fn(),
}));

vi.mock('../../../database/services/AppService', () => ({
	AppService: vi.fn().mockImplementation(() => ({
		checkAppOwnership: mockCheckAppOwnership,
	})),
}));

vi.mock('../../../agents', () => ({
	getAgentStub: vi.fn(async () => ({ getGitHubToken: mockGetGitHubToken })),
	getSpaceGitStub: vi.fn(),
	isThinkApp: vi.fn(),
}));

vi.mock('../../../services/github', () => ({
	GitHubService: {},
}));

vi.mock('../../../services/oauth/github-exporter', () => ({
	GitHubExporterOAuthProvider: {
		create: mockCreateOAuthProvider,
	},
}));

import { GitHubExporterController } from './controller';

type TestEnv = Parameters<typeof GitHubExporterController.initiateGitHubExport>[1];
type TestExecutionContext = Parameters<typeof GitHubExporterController.initiateGitHubExport>[2];

const testEnv = {} as TestEnv;

function makeContext(): RouteContext {
	return {
		user: { id: 'user-1', email: 'user@example.com' },
		sessionId: 'session-1',
		config: {},
		pathParams: {},
		queryParams: new URLSearchParams(),
	} as unknown as RouteContext;
}

function makeRequest(): Request {
	return new Request('https://masidy.dev/api/github-app/export', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			agentId: 'agent-1',
			repositoryName: 'generated-app',
		}),
	});
}

describe('GitHubExporterController.initiateGitHubExport', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockCheckAppOwnership.mockResolvedValue({ isOwner: true });
		mockGetGitHubToken.mockResolvedValue(null);
	});

	it('returns an actionable configuration error when export OAuth secrets are missing', async () => {
		const response = await GitHubExporterController.initiateGitHubExport(
			makeRequest(),
			testEnv,
			{} as TestExecutionContext,
			makeContext(),
		);

		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			success: false,
			error: {
				message: 'GitHub export is not configured. Set GITHUB_EXPORTER_CLIENT_ID and GITHUB_EXPORTER_CLIENT_SECRET on the Worker, then retry.',
			},
		});
		expect(mockCreateOAuthProvider).not.toHaveBeenCalled();
	});
});

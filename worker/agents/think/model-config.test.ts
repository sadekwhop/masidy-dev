import { generateText } from 'ai';
import { describe, expect, it } from 'vitest';
import { createWorkersAI } from 'workers-ai-provider';
import { getThinkModelId, THINK_MODEL_CONFIG, THINK_MODEL_ID } from './model-config';

describe('Think Workers AI model configuration', () => {
	it('uses GLM 4.7 Flash with the Workers AI provider', () => {
		expect(THINK_MODEL_ID).toBe('@cf/zai-org/glm-4.7-flash');
		expect(THINK_MODEL_CONFIG.provider).toBe('workers-ai');
		expect(THINK_MODEL_CONFIG.contextSize).toBe(131_072);
	});

	it('uses the configured dynamic route name in AI Gateway format', () => {
		expect(getThinkModelId()).toBe(THINK_MODEL_ID);
		expect(getThinkModelId('cost-aware')).toBe('dynamic/cost-aware');
		expect(() => getThinkModelId('invalid/route')).toThrow(
			'CLOUDFLARE_AI_GATEWAY_ROUTE must be a route name',
		);
	});

	it.each([
		{ modelId: THINK_MODEL_ID, expectedModelId: THINK_MODEL_ID },
		{ modelId: getThinkModelId('cost-aware'), expectedModelId: 'dynamic/cost-aware' },
	])('sends $expectedModelId inference through AI Gateway with routing metadata', async ({
		modelId,
		expectedModelId,
	}) => {
		const gatewayId = 'test-gateway';
		const calls: unknown[][] = [];
		const binding = {
			run: async (...args: unknown[]) => {
				calls.push(args);
				throw new Error('stop after verifying the binding request');
			},
		} as unknown as Parameters<typeof createWorkersAI>[0]['binding'];
			const model = createWorkersAI({ binding })(modelId, {
				gateway: {
					id: gatewayId,
					metadata: {
						application: 'masidy',
						agent: 'think',
						user_id: 'user-123',
					},
				},
			});

			await expect(generateText({ model, prompt: 'Build a test app' })).rejects.toThrow();

			expect(calls).toHaveLength(1);
			expect(calls[0]?.[0]).toBe(expectedModelId);
			expect(calls[0]?.[2]).toMatchObject({
				gateway: {
					id: gatewayId,
					metadata: {
						application: 'masidy',
						agent: 'think',
						user_id: 'user-123',
					},
				},
			});
	});
});

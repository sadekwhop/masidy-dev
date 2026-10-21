import { generateText } from 'ai';
import { describe, expect, it } from 'vitest';
import { createWorkersAI } from 'workers-ai-provider';
import { THINK_MODEL_CONFIG, THINK_MODEL_ID } from './model-config';

describe('Think Workers AI model configuration', () => {
	it('uses GLM 4.7 Flash with the Workers AI provider', () => {
		expect(THINK_MODEL_ID).toBe('@cf/zai-org/glm-4.7-flash');
		expect(THINK_MODEL_CONFIG.provider).toBe('workers-ai');
		expect(THINK_MODEL_CONFIG.contextSize).toBe(131_072);
	});

	it('sends inference through the configured AI Gateway binding', async () => {
		const gatewayId = 'test-gateway';
		const calls: unknown[][] = [];
		const binding = {
			run: async (...args: unknown[]) => {
				calls.push(args);
				throw new Error('stop after verifying the binding request');
			},
		} as unknown as Parameters<typeof createWorkersAI>[0]['binding'];
		const model = createWorkersAI({ binding })(THINK_MODEL_ID, {
			gateway: { id: gatewayId },
		});

		await expect(generateText({ model, prompt: 'Build a test app' })).rejects.toThrow();

		expect(calls).toHaveLength(1);
		expect(calls[0]?.[0]).toBe(THINK_MODEL_ID);
		expect(calls[0]?.[2]).toMatchObject({ gateway: { id: gatewayId } });
	});
});

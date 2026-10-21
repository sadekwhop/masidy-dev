import { ModelSize, type AIModelConfig } from '../inferutils/config.types';

export const THINK_MODEL_ID = '@cf/zai-org/glm-4.7-flash';

export function getThinkModelId(dynamicRouteName?: string): string {
	if (!dynamicRouteName) return THINK_MODEL_ID;
	if (!/^[A-Za-z0-9_-]+$/.test(dynamicRouteName)) {
		throw new Error(
			'CLOUDFLARE_AI_GATEWAY_ROUTE must be a route name containing only letters, numbers, "_" or "-".',
		);
	}
	return `dynamic/${dynamicRouteName}`;
}

export const THINK_MODEL_CONFIG: AIModelConfig = {
	name: 'GLM 4.7 Flash',
	size: ModelSize.REGULAR,
	provider: 'workers-ai',
	creditCost: 2,
	contextSize: 131_072,
};

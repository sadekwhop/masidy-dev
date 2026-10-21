import { ModelSize, type AIModelConfig } from '../inferutils/config.types';

export const THINK_MODEL_ID = '@cf/zai-org/glm-4.7-flash';

export const THINK_MODEL_CONFIG: AIModelConfig = {
	name: 'GLM 4.7 Flash',
	size: ModelSize.REGULAR,
	provider: 'workers-ai',
	creditCost: 2,
	contextSize: 131_072,
};

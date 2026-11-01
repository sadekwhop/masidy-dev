import {
    AgentActionKey,
    AgentConfig,
    AgentConstraintConfig,
    AIModels,
    AllModels,
} from "./config.types";
import { env } from 'cloudflare:workers';

// Workers AI models — free with your Workers Paid plan, no API key needed
// These run through your AI Gateway (vibesdk-gateway)
const WORKERS_AI = {
    // Best quality — reasoning, code generation, function calling (128k context)
    GPT_OSS_120B: AIModels.WORKERS_AI_GPT_OSS_120B,
    // Good general purpose — function calling (24k context)
    LLAMA_3_3_70B: AIModels.WORKERS_AI_LLAMA_3_3_70B,
    // Fast and lightweight — quick responses (60k context)
    LLAMA_3_1_8B: AIModels.WORKERS_AI_LLAMA_3_1_8B,
    // Z.ai flagship agentic coding model
    GLM_5_2: AIModels.WORKERS_AI_GLM_5_2,
    // Fast multilingual with function calling (131k context)
    GLM_4_7_FLASH: AIModels.WORKERS_AI_GLM_4_7_FLASH,
} as const;

// Common configs - these are good defaults
const COMMON_AGENT_CONFIGS = {
    screenshotAnalysis: {
        name: AIModels.DISABLED,
        reasoning_effort: 'medium' as const,
        max_tokens: 8000,
        temperature: 1,
        fallbackModel: WORKERS_AI.LLAMA_3_1_8B,
    },
    realtimeCodeFixer: {
        name: WORKERS_AI.LLAMA_3_1_8B,
        reasoning_effort: 'low' as const,
        max_tokens: 32000,
        temperature: 0.2,
        fallbackModel: WORKERS_AI.LLAMA_3_3_70B,
    },
    fastCodeFixer: {
        name: AIModels.DISABLED,
        reasoning_effort: undefined,
        max_tokens: 64000,
        temperature: 0.0,
        fallbackModel: WORKERS_AI.GPT_OSS_120B,
    },
    templateSelection: {
        name: WORKERS_AI.LLAMA_3_1_8B,
        max_tokens: 2000,
        fallbackModel: WORKERS_AI.LLAMA_3_3_70B,
        temperature: 1,
    },
} as const;

const SHARED_IMPLEMENTATION_CONFIG = {
    reasoning_effort: 'low' as const,
    max_tokens: 48000,
    temperature: 1,
    fallbackModel: WORKERS_AI.GPT_OSS_120B,
};

//======================================================================================
// ATTENTION! Platform config requires specific API keys and Cloudflare AI Gateway setup.
//======================================================================================
/* 
These are the configs used at build.cloudflare.dev 
You may need to provide API keys for these models in your environment or use 
Cloudflare AI Gateway unified billing for seamless model access without managing multiple keys.
*/
const PLATFORM_AGENT_CONFIG: AgentConfig = {
    ...COMMON_AGENT_CONFIGS,
    blueprint: {
        name: WORKERS_AI.GPT_OSS_120B,
        reasoning_effort: 'high',
        max_tokens: 20000,
        fallbackModel: WORKERS_AI.LLAMA_3_3_70B,
        temperature: 1.0,
    },
    projectSetup: {
        name: WORKERS_AI.LLAMA_3_3_70B,
        reasoning_effort: 'medium',
        max_tokens: 8000,
        temperature: 1,
        fallbackModel: WORKERS_AI.GPT_OSS_120B,
    },
    phaseGeneration: {
        name: WORKERS_AI.LLAMA_3_3_70B,
        reasoning_effort: 'medium',
        max_tokens: 8000,
        temperature: 1,
        fallbackModel: WORKERS_AI.GPT_OSS_120B,
    },
    firstPhaseImplementation: {
        name: WORKERS_AI.LLAMA_3_3_70B,
        ...SHARED_IMPLEMENTATION_CONFIG,
    },
    phaseImplementation: {
        name: WORKERS_AI.LLAMA_3_3_70B,
        ...SHARED_IMPLEMENTATION_CONFIG,
    },
    conversationalResponse: {
        name: WORKERS_AI.LLAMA_3_1_8B,
        reasoning_effort: 'low',
        max_tokens: 4000,
        temperature: 1,
        fallbackModel: WORKERS_AI.LLAMA_3_3_70B,
    },
    deepDebugger: {
        name: WORKERS_AI.GPT_OSS_120B,
        reasoning_effort: 'high',
        max_tokens: 8000,
        temperature: 1,
        fallbackModel: WORKERS_AI.LLAMA_3_3_70B,
    },
    fileRegeneration: {
        name: WORKERS_AI.LLAMA_3_3_70B,
        reasoning_effort: 'low',
        max_tokens: 16000,
        temperature: 0.0,
        fallbackModel: WORKERS_AI.GPT_OSS_120B,
    },
    agenticProjectBuilder: {
        name: WORKERS_AI.GLM_5_2,
        reasoning_effort: 'medium',
        max_tokens: 8000,
        temperature: 1,
        fallbackModel: WORKERS_AI.GPT_OSS_120B,
    },
};

//======================================================================================
// Default config using Workers AI models (free with Workers Paid plan)
//======================================================================================
/* These are the default models used when PLATFORM_MODEL_PROVIDERS is not set */
const DEFAULT_AGENT_CONFIG: AgentConfig = {
    ...COMMON_AGENT_CONFIGS,
    templateSelection: {
        name: WORKERS_AI.LLAMA_3_1_8B,
        max_tokens: 2000,
        fallbackModel: WORKERS_AI.LLAMA_3_3_70B,
        temperature: 0.6,
    },
    blueprint: {
        name: WORKERS_AI.GPT_OSS_120B,
        reasoning_effort: 'high',
        max_tokens: 64000,
        fallbackModel: WORKERS_AI.LLAMA_3_3_70B,
        temperature: 1,
    },
    projectSetup: {
        name: WORKERS_AI.LLAMA_3_3_70B,
        ...SHARED_IMPLEMENTATION_CONFIG,
    },
    phaseGeneration: {
        name: WORKERS_AI.LLAMA_3_3_70B,
        ...SHARED_IMPLEMENTATION_CONFIG,
    },
    firstPhaseImplementation: {
        name: WORKERS_AI.LLAMA_3_3_70B,
        ...SHARED_IMPLEMENTATION_CONFIG,
    },
    phaseImplementation: {
        name: WORKERS_AI.LLAMA_3_3_70B,
        ...SHARED_IMPLEMENTATION_CONFIG,
    },
    conversationalResponse: {
        name: WORKERS_AI.LLAMA_3_1_8B,
        reasoning_effort: 'low',
        max_tokens: 4000,
        temperature: 0,
        fallbackModel: WORKERS_AI.LLAMA_3_3_70B,
    },
    deepDebugger: {
        name: WORKERS_AI.GPT_OSS_120B,
        reasoning_effort: 'high',
        max_tokens: 8000,
        temperature: 1,
        fallbackModel: WORKERS_AI.LLAMA_3_3_70B,
    },
    fileRegeneration: {
        name: WORKERS_AI.LLAMA_3_3_70B,
        reasoning_effort: 'low',
        max_tokens: 32000,
        temperature: 1,
        fallbackModel: WORKERS_AI.LLAMA_3_1_8B,
    },
    agenticProjectBuilder: {
        name: WORKERS_AI.GPT_OSS_120B,
        reasoning_effort: 'high',
        max_tokens: 8000,
        temperature: 1,
        fallbackModel: WORKERS_AI.LLAMA_3_3_70B,
    },
};

export const AGENT_CONFIG: AgentConfig = env.PLATFORM_MODEL_PROVIDERS
    ? PLATFORM_AGENT_CONFIG
    : DEFAULT_AGENT_CONFIG;


export const AGENT_CONSTRAINTS: Map<AgentActionKey, AgentConstraintConfig> = new Map([
    ['fastCodeFixer', {
        allowedModels: new Set([AIModels.DISABLED]),
        enabled: true,
    }],
    ['realtimeCodeFixer', {
        allowedModels: new Set([AIModels.DISABLED]),
        enabled: true,
    }],
    ['fileRegeneration', {
        allowedModels: new Set(AllModels),
        enabled: true,
    }],
    ['phaseGeneration', {
        allowedModels: new Set(AllModels),
        enabled: true,
    }],
    ['projectSetup', {
        allowedModels: new Set(AllModels),
        enabled: true,
    }],
    ['conversationalResponse', {
        allowedModels: new Set(AllModels),
        enabled: true,
    }],
    ['templateSelection', {
        allowedModels: new Set(AllModels),
        enabled: true,
    }],
]);

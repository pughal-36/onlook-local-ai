import {
    LLMProvider,
    OLLAMA_MODELS,
    OPENROUTER_MODELS,
    type ChatMessage,
    type ModelConfig,
} from '@onlook/models';
import { initModel } from './providers';

export type AITask =
    | 'main_chat'
    | 'tool_repair'
    | 'suggestions'
    | 'conversation_title'
    | 'project_name';

export interface ResolvedTaskConfig {
    task: AITask;
    provider: LLMProvider;
    model: string;
    modelConfig: ModelConfig;
}

const DEFAULT_OPENROUTER_MODELS: Record<AITask, OPENROUTER_MODELS> = {
    main_chat: OPENROUTER_MODELS.CLAUDE_4_5_SONNET,
    tool_repair: OPENROUTER_MODELS.OPEN_AI_GPT_5_NANO,
    suggestions: OPENROUTER_MODELS.OPEN_AI_GPT_5_NANO,
    conversation_title: OPENROUTER_MODELS.CLAUDE_3_5_HAIKU,
    project_name: OPENROUTER_MODELS.OPEN_AI_GPT_5_NANO,
};

function parseProvider(raw?: string): LLMProvider | undefined {
    if (!raw) return undefined;
    const lower = raw.trim().toLowerCase();
    if (lower === 'ollama') return LLMProvider.OLLAMA;
    if (lower === 'openrouter') return LLMProvider.OPENROUTER;
    return undefined;
}

export function getTaskProvider(task: AITask): LLMProvider {
    let taskProviderEnv: string | undefined;

    switch (task) {
        case 'main_chat':
            taskProviderEnv = process.env.AI_TASK_CHAT_PROVIDER;
            break;
        case 'tool_repair':
            taskProviderEnv = process.env.AI_TASK_TOOL_REPAIR_PROVIDER;
            break;
        case 'suggestions':
            taskProviderEnv = process.env.AI_TASK_SUGGESTIONS_PROVIDER;
            break;
        case 'conversation_title':
            taskProviderEnv = process.env.AI_TASK_TITLE_PROVIDER;
            break;
        case 'project_name':
            taskProviderEnv = process.env.AI_TASK_PROJECT_NAME_PROVIDER;
            break;
    }

    const overridden = parseProvider(taskProviderEnv);
    if (overridden) return overridden;

    const globalDefault = parseProvider(process.env.AI_PROVIDER);
    if (globalDefault) return globalDefault;

    return LLMProvider.OPENROUTER;
}

export function getTaskModel(task: AITask, provider: LLMProvider): string {
    let taskModelEnv: string | undefined;

    switch (task) {
        case 'main_chat':
            taskModelEnv = process.env.AI_TASK_CHAT_MODEL;
            break;
        case 'tool_repair':
            taskModelEnv = process.env.AI_TASK_TOOL_REPAIR_MODEL;
            break;
        case 'suggestions':
            taskModelEnv = process.env.AI_TASK_SUGGESTIONS_MODEL;
            break;
        case 'conversation_title':
            taskModelEnv = process.env.AI_TASK_TITLE_MODEL;
            break;
        case 'project_name':
            taskModelEnv = process.env.AI_TASK_PROJECT_NAME_MODEL;
            break;
    }

    if (taskModelEnv && taskModelEnv.trim().length > 0) {
        return taskModelEnv.trim();
    }

    if (provider === LLMProvider.OLLAMA) {
        return process.env.OLLAMA_MODEL?.trim() || OLLAMA_MODELS.QWEN_2_5_CODER_3B;
    }

    return DEFAULT_OPENROUTER_MODELS[task];
}

export function resolveTaskConfig(task: AITask, modelOverride?: string): ResolvedTaskConfig {
    const provider = getTaskProvider(task);
    const model = modelOverride || getTaskModel(task, provider);

    // Diagnostic logging without logging prompts or secrets
    console.info(`[AI Dispatch] Task="${task}" Provider="${provider}" Model="${model}"`);

    const modelConfig = initModel({
        provider: provider as any,
        model: model as any,
    });

    return {
        task,
        provider,
        model,
        modelConfig,
    };
}

const KNOWN_VISION_MODEL_SUBSTRINGS = ['vision', 'vl', 'llava', 'minicpm-v', 'bakllava'];

export function modelSupportsVision(provider: LLMProvider, modelName: string): boolean {
    if (provider === LLMProvider.OPENROUTER) {
        return true;
    }
    const lower = modelName.toLowerCase();
    return KNOWN_VISION_MODEL_SUBSTRINGS.some((sub) => lower.includes(sub));
}

export function hasImageParts(messages: ChatMessage[]): boolean {
    for (const msg of messages) {
        if (msg.metadata?.context) {
            for (const ctx of msg.metadata.context) {
                if (ctx.type === 'image') return true;
            }
        }
        if (msg.parts) {
            for (const part of msg.parts) {
                if (part.type === 'file' && (part as any).mediaType?.startsWith('image/')) {
                    return true;
                }
            }
        }
    }
    return false;
}

export function assertVisionSupport(provider: LLMProvider, modelName: string, messages: ChatMessage[]): void {
    if (!hasImageParts(messages)) {
        return;
    }
    if (!modelSupportsVision(provider, modelName)) {
        throw new Error(
            `The selected model "${modelName}" under provider "${provider}" does not support image or vision inputs. Please remove attached images, or configure a vision-capable provider/model.`,
        );
    }
}

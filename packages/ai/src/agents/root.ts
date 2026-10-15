import type { ToolCall } from '@ai-sdk/provider-utils';
import { ChatType, LLMProvider, OPENROUTER_MODELS, type ChatMessage, type ModelConfig } from '@onlook/models';
import { NoSuchToolError, generateObject, smoothStream, stepCountIs, streamText, type ToolSet } from 'ai';
import {
    assertVisionSupport,
    convertToStreamMessages,
    getAskModeSystemPrompt,
    getCreatePageSystemPrompt,
    getSystemPrompt,
    getToolSetFromType,
    initModel,
    resolveTaskConfig,
} from '../index';

export const createRootAgentStream = ({
    chatType,
    conversationId,
    projectId,
    userId,
    traceId,
    messages,
}: {
    chatType: ChatType;
    conversationId: string;
    projectId: string;
    userId: string;
    traceId: string;
    messages: ChatMessage[];
}) => {
    const { modelConfig, provider, model } = getModelFromType(chatType);

    // Verify vision compatibility before dispatching
    assertVisionSupport(provider, model, messages);

    const systemPrompt = getSystemPromptFromType(chatType);
    const toolSet = getToolSetFromType(chatType);
    return streamText({
        providerOptions: modelConfig.providerOptions,
        messages: convertToStreamMessages(messages),
        model: modelConfig.model,
        system: systemPrompt,
        tools: toolSet,
        headers: modelConfig.headers,
        stopWhen: stepCountIs(20),
        experimental_repairToolCall: repairToolCall,
        experimental_transform: smoothStream(),
        experimental_telemetry: {
            isEnabled: true,
            metadata: {
                conversationId,
                projectId,
                userId,
                chatType: chatType,
                tags: ['chat'],
                langfuseTraceId: traceId,
                sessionId: conversationId,
            },
        },
    });
};

const getSystemPromptFromType = (chatType: ChatType): string => {
    switch (chatType) {
        case ChatType.CREATE:
            return getCreatePageSystemPrompt();
        case ChatType.ASK:
            return getAskModeSystemPrompt();
        case ChatType.EDIT:
        default:
            return getSystemPrompt();
    }
};

const getModelFromType = (
    chatType: ChatType,
): { modelConfig: ModelConfig; provider: LLMProvider; model: string } => {
    const resolved = resolveTaskConfig('main_chat');

    // Preserve existing OpenRouter model specialization per chatType unless user overrode AI_TASK_CHAT_MODEL
    if (resolved.provider === LLMProvider.OPENROUTER && !process.env.AI_TASK_CHAT_MODEL) {
        const specializedModel =
            chatType === ChatType.CREATE || chatType === ChatType.FIX
                ? OPENROUTER_MODELS.OPEN_AI_GPT_5
                : OPENROUTER_MODELS.CLAUDE_4_5_SONNET;
        return {
            modelConfig: initModel({
                provider: LLMProvider.OPENROUTER,
                model: specializedModel,
            }),
            provider: LLMProvider.OPENROUTER,
            model: specializedModel,
        };
    }

    return {
        modelConfig: resolved.modelConfig,
        provider: resolved.provider,
        model: resolved.model,
    };
};

export const repairToolCall = async ({
    toolCall,
    tools,
    error,
}: {
    toolCall: ToolCall<string, unknown>;
    tools: ToolSet;
    error: Error;
}) => {
    if (NoSuchToolError.isInstance(error)) {
        throw new Error(
            `Tool "${toolCall.toolName}" not found. Available tools: ${Object.keys(tools).join(', ')}`,
        );
    }
    const tool = tools[toolCall.toolName];
    if (!tool?.inputSchema) {
        throw new Error(`Tool "${toolCall.toolName}" has no input schema`);
    }

    console.warn(
        `Invalid parameter for tool ${toolCall.toolName} with args ${JSON.stringify(toolCall.input)}, attempting to fix`,
    );

    try {
        const { modelConfig } = resolveTaskConfig('tool_repair');

        const { object: repairedArgs } = await generateObject({
            model: modelConfig.model,
            schema: tool.inputSchema,
            prompt: [
                `The model tried to call the tool "${toolCall.toolName}"` +
                    ` with the following arguments:`,
                JSON.stringify(toolCall.input),
                `The tool accepts the following schema:`,
                JSON.stringify(tool?.inputSchema),
                'Please fix the inputs. Return the fixed inputs as a JSON object, DO NOT include any other text.',
            ].join('\n'),
        });

        return {
            type: 'tool-call' as const,
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            input: JSON.stringify(repairedArgs),
        };
    } catch (repairError) {
        console.warn(`Tool repair failed for ${toolCall.toolName}, falling back to original input:`, repairError);
        return {
            type: 'tool-call' as const,
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            input: JSON.stringify(toolCall.input),
        };
    }
};

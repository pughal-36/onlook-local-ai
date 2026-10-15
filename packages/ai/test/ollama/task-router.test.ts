import { LLMProvider, OLLAMA_MODELS, OPENROUTER_MODELS, type ChatMessage } from '@onlook/models';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
    assertVisionSupport,
    getTaskModel,
    getTaskProvider,
    hasImageParts,
    modelSupportsVision,
    resolveTaskConfig
} from '../../src/chat/task-router';

describe('Task Router & Hybrid Configuration', () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
        // Clear task routing envs
        delete process.env.AI_PROVIDER;
        delete process.env.AI_TASK_CHAT_PROVIDER;
        delete process.env.AI_TASK_TOOL_REPAIR_PROVIDER;
        delete process.env.AI_TASK_SUGGESTIONS_PROVIDER;
        delete process.env.AI_TASK_TITLE_PROVIDER;
        delete process.env.AI_TASK_PROJECT_NAME_PROVIDER;
        delete process.env.AI_TASK_CHAT_MODEL;
        delete process.env.AI_TASK_TOOL_REPAIR_MODEL;
        delete process.env.AI_TASK_SUGGESTIONS_MODEL;
        delete process.env.AI_TASK_TITLE_MODEL;
        delete process.env.AI_TASK_PROJECT_NAME_MODEL;
        delete process.env.OLLAMA_MODEL;
    });

    afterEach(() => {
        process.env = { ...originalEnv };
    });

    describe('Default Provider Resolution', () => {
        it('defaults to OpenRouter when AI_PROVIDER is not set', () => {
            expect(getTaskProvider('main_chat')).toBe(LLMProvider.OPENROUTER);
            expect(getTaskProvider('tool_repair')).toBe(LLMProvider.OPENROUTER);
            expect(getTaskProvider('suggestions')).toBe(LLMProvider.OPENROUTER);
            expect(getTaskProvider('conversation_title')).toBe(LLMProvider.OPENROUTER);
            expect(getTaskProvider('project_name')).toBe(LLMProvider.OPENROUTER);
        });

        it('routes all tasks to Ollama when AI_PROVIDER=ollama', () => {
            process.env.AI_PROVIDER = 'ollama';
            expect(getTaskProvider('main_chat')).toBe(LLMProvider.OLLAMA);
            expect(getTaskProvider('tool_repair')).toBe(LLMProvider.OLLAMA);
            expect(getTaskProvider('suggestions')).toBe(LLMProvider.OLLAMA);
            expect(getTaskProvider('conversation_title')).toBe(LLMProvider.OLLAMA);
            expect(getTaskProvider('project_name')).toBe(LLMProvider.OLLAMA);
        });
    });

    describe('Per-Task Overrides & Hybrid Configuration', () => {
        it('supports hybrid task routing (e.g. Chat on OpenRouter, others on Ollama)', () => {
            process.env.AI_PROVIDER = 'ollama';
            process.env.AI_TASK_CHAT_PROVIDER = 'openrouter';
            process.env.AI_TASK_TOOL_REPAIR_PROVIDER = 'openrouter';

            expect(getTaskProvider('main_chat')).toBe(LLMProvider.OPENROUTER);
            expect(getTaskProvider('tool_repair')).toBe(LLMProvider.OPENROUTER);
            expect(getTaskProvider('suggestions')).toBe(LLMProvider.OLLAMA);
            expect(getTaskProvider('conversation_title')).toBe(LLMProvider.OLLAMA);
            expect(getTaskProvider('project_name')).toBe(LLMProvider.OLLAMA);
        });

        it('supports per-task model overrides', () => {
            process.env.AI_PROVIDER = 'ollama';
            process.env.OLLAMA_MODEL = 'qwen2.5-coder:3b';
            process.env.AI_TASK_TITLE_MODEL = 'tinyllama:latest';

            expect(getTaskModel('main_chat', LLMProvider.OLLAMA)).toBe('qwen2.5-coder:3b');
            expect(getTaskModel('conversation_title', LLMProvider.OLLAMA)).toBe('tinyllama:latest');
        });
    });

    describe('Vision & Capability Guard', () => {
        it('identifies image parts correctly from message context', () => {
            const textOnlyMessage: ChatMessage = {
                id: '1',
                role: 'user',
                parts: [{ type: 'text', text: 'Hello' }],
            };

            const imageMessage: ChatMessage = {
                id: '2',
                role: 'user',
                parts: [{ type: 'text', text: 'Analyze this' }],
                metadata: {
                    context: [
                        {
                            type: 'image' as any,
                            id: 'img1',
                            displayName: 'screenshot.png',
                            mimeType: 'image/png',
                            content: 'data:image/png;base64,...',
                        } as any,
                    ],
                },
            };

            expect(hasImageParts([textOnlyMessage])).toBe(false);
            expect(hasImageParts([textOnlyMessage, imageMessage])).toBe(true);
        });

        it('detects vision support by model name', () => {
            expect(modelSupportsVision(LLMProvider.OPENROUTER, 'claude-3.5-sonnet')).toBe(true);
            expect(modelSupportsVision(LLMProvider.OLLAMA, 'qwen2.5-coder:3b')).toBe(false);
            expect(modelSupportsVision(LLMProvider.OLLAMA, 'llava:latest')).toBe(true);
            expect(modelSupportsVision(LLMProvider.OLLAMA, 'qwen2.5-vl:7b')).toBe(true);
        });

        it('throws actionable error when text-only Ollama model receives images', () => {
            const imageMessage: ChatMessage = {
                id: '2',
                role: 'user',
                parts: [{ type: 'text', text: 'Analyze this' }],
                metadata: {
                    context: [
                        {
                            type: 'image' as any,
                            id: 'img1',
                            displayName: 'screenshot.png',
                            mimeType: 'image/png',
                            content: 'data:image/png;base64,...',
                        } as any,
                    ],
                },
            };

            expect(() => {
                assertVisionSupport(LLMProvider.OLLAMA, 'qwen2.5-coder:3b', [imageMessage]);
            }).toThrow('does not support image or vision inputs');
        });

        it('allows text-only messages on text-only Ollama models', () => {
            const textOnlyMessage: ChatMessage = {
                id: '1',
                role: 'user',
                parts: [{ type: 'text', text: 'Hello' }],
            };

            expect(() => {
                assertVisionSupport(LLMProvider.OLLAMA, 'qwen2.5-coder:3b', [textOnlyMessage]);
            }).not.toThrow();
        });
    });

    describe('resolveTaskConfig Execution', () => {
        it('resolves Ollama task config properly', () => {
            process.env.AI_PROVIDER = 'ollama';
            process.env.OLLAMA_MODEL = 'qwen2.5-coder:3b';

            const resolved = resolveTaskConfig('main_chat');
            expect(resolved.provider).toBe(LLMProvider.OLLAMA);
            expect(resolved.model).toBe('qwen2.5-coder:3b');
            expect(resolved.modelConfig).toBeDefined();
        });
    });
});

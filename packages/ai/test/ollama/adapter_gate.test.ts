import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateObject, generateText, streamText, type LanguageModel } from 'ai';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

describe('Candidate Adapter: @ai-sdk/openai-compatible@1.0.58', () => {
    it('creates an ollama provider instance with LanguageModel specifications', () => {
        const provider = createOpenAICompatible({
            name: 'ollama',
            baseURL: 'http://localhost:11434/v1',
        });
        const model = provider('qwen2.5-coder:3b');
        expect(model).toBeDefined();
        expect(model.modelId).toBe('qwen2.5-coder:3b');
        expect(model.provider).toBe('ollama.chat');

        // Type compatibility check with LanguageModel from ai@5.0.60
        const lm: LanguageModel = model;
        expect(lm.specificationVersion).toBe('v2');
        expect(typeof lm.doGenerate).toBe('function');
        expect(typeof lm.doStream).toBe('function');
    });

    it('verifies streaming execution with simulated OpenAI-compatible SSE', async () => {
        const sseChunks = [
            'data: {"id":"chatcmpl-1","choices":[{"delta":{"role":"assistant","content":"Hello"},"index":0}]}\n\n',
            'data: {"id":"chatcmpl-1","choices":[{"delta":{"content":" world"},"index":0}]}\n\n',
            'data: {"id":"chatcmpl-1","choices":[{"delta":{},"finish_reason":"stop","index":0}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n',
            'data: [DONE]\n\n',
        ];

        const mockFetch: typeof fetch = async () => {
            const stream = new ReadableStream({
                start(controller) {
                    for (const chunk of sseChunks) {
                        controller.enqueue(new TextEncoder().encode(chunk));
                    }
                    controller.close();
                },
            });

            return new Response(stream, {
                status: 200,
                headers: { 'Content-Type': 'text/event-stream' },
            });
        };

        const provider = createOpenAICompatible({
            name: 'ollama',
            baseURL: 'http://mock-ollama:11434/v1',
            fetch: mockFetch,
        });

        const model = provider('qwen2.5-coder:3b');
        const result = streamText({
            model,
            prompt: 'Hello',
        });

        let fullText = '';
        for await (const delta of result.textStream) {
            fullText += delta;
        }

        expect(fullText).toBe('Hello world');
    });

    it('verifies tool-calling handling via OpenAI-compatible endpoint', async () => {
        const toolCallResponse = {
            id: 'chatcmpl-2',
            choices: [
                {
                    message: {
                        role: 'assistant',
                        tool_calls: [
                            {
                                id: 'call_123',
                                type: 'function',
                                function: {
                                    name: 'getWeather',
                                    arguments: JSON.stringify({ location: 'San Francisco' }),
                                },
                            },
                        ],
                    },
                    finish_reason: 'tool_calls',
                    index: 0,
                },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 15, total_tokens: 25 },
        };

        const mockFetch: typeof fetch = async () => {
            return new Response(JSON.stringify(toolCallResponse), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        };

        const provider = createOpenAICompatible({
            name: 'ollama',
            baseURL: 'http://mock-ollama:11434/v1',
            fetch: mockFetch,
        });

        const model = provider('qwen2.5-coder:3b');
        const result = await generateText({
            model,
            prompt: 'What is the weather in SF?',
            tools: {
                getWeather: {
                    description: 'Get weather for a location',
                    parameters: z.object({ location: z.string() }),
                },
            },
        });

        expect(result.toolCalls.length).toBe(1);
        expect(result.toolCalls[0].toolName).toBe('getWeather');
        expect(result.toolCalls[0].input).toEqual({ location: 'San Francisco' });
    });

    it('verifies structured output (generateObject) via JSON mode', async () => {
        const objectResponse = {
            id: 'chatcmpl-3',
            choices: [
                {
                    message: {
                        role: 'assistant',
                        content: JSON.stringify({ name: 'Onlook Project', rating: 5 }),
                    },
                    finish_reason: 'stop',
                    index: 0,
                },
            ],
            usage: { prompt_tokens: 12, completion_tokens: 10, total_tokens: 22 },
        };

        const mockFetch: typeof fetch = async () => {
            return new Response(JSON.stringify(objectResponse), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        };

        const provider = createOpenAICompatible({
            name: 'ollama',
            baseURL: 'http://mock-ollama:11434/v1',
            fetch: mockFetch,
        });

        const model = provider('qwen2.5-coder:3b');
        const schema = z.object({
            name: z.string(),
            rating: z.number(),
        });

        const result = await generateObject({
            model,
            schema,
            prompt: 'Generate project rating',
        });

        expect(result.object).toEqual({ name: 'Onlook Project', rating: 5 });
    });
});

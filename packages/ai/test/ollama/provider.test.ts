import { LLMProvider, OPENROUTER_MODELS } from '@onlook/models';
import { generateText } from 'ai';
import { describe, expect, it } from 'bun:test';
import {
    getOllamaProvider,
    initModel,
    normalizeOllamaBaseUrl,
    parseOllamaNumCtx
} from '../../src/chat/providers';

describe('Ollama Provider Implementation', () => {
    describe('URL Normalization', () => {
        it('normalizes base URLs correctly', () => {
            expect(normalizeOllamaBaseUrl('http://localhost:11434')).toBe('http://localhost:11434/v1');
            expect(normalizeOllamaBaseUrl('http://localhost:11434/')).toBe('http://localhost:11434/v1');
            expect(normalizeOllamaBaseUrl('http://localhost:11434/v1')).toBe('http://localhost:11434/v1');
            expect(normalizeOllamaBaseUrl('http://localhost:11434/v1/')).toBe('http://localhost:11434/v1');
            expect(normalizeOllamaBaseUrl('http://172.23.32.1:11434')).toBe('http://172.23.32.1:11434/v1');
            expect(normalizeOllamaBaseUrl()).toBe('http://localhost:11434/v1');
        });
    });

    describe('num_ctx Parsing', () => {
        it('parses valid context window values', () => {
            expect(parseOllamaNumCtx('2048')).toBe(2048);
            expect(parseOllamaNumCtx('8192')).toBe(8192);
            expect(parseOllamaNumCtx(undefined)).toBe(4096);
            expect(parseOllamaNumCtx('invalid')).toBe(4096);
            expect(parseOllamaNumCtx('-500')).toBe(4096);
        });
    });

    describe('initModel Integration', () => {
        it('initializes Ollama provider through initModel', () => {
            const config = initModel({
                provider: LLMProvider.OLLAMA,
                model: 'qwen2.5-coder:3b',
            });

            expect(config.model).toBeDefined();
            expect(config.model.modelId).toBe('qwen2.5-coder:3b');
            expect(config.maxOutputTokens).toBe(8192);
        });

        it('preserves OpenRouter provider initialization error when key is missing', () => {
            const originalKey = process.env.OPENROUTER_API_KEY;
            delete process.env.OPENROUTER_API_KEY;

            try {
                expect(() => {
                    initModel({
                        provider: LLMProvider.OPENROUTER,
                        model: OPENROUTER_MODELS.CLAUDE_4_5_SONNET,
                    });
                }).toThrow('OPENROUTER_API_KEY must be set');
            } finally {
                if (originalKey) {
                    process.env.OPENROUTER_API_KEY = originalKey;
                }
            }
        });
    });

    describe('options.num_ctx body injection', () => {
        it('injects num_ctx into outgoing request body', async () => {
            let capturedBody: any = null;

            const mockFetch: typeof fetch = async (input, init) => {
                if (init?.body && typeof init.body === 'string') {
                    capturedBody = JSON.parse(init.body);
                }

                return new Response(JSON.stringify({
                    id: 'chatcmpl-test',
                    choices: [{ message: { role: 'assistant', content: 'test response' }, finish_reason: 'stop', index: 0 }],
                    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
                }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            };

            const model = getOllamaProvider('qwen2.5-coder:3b', {
                baseURL: 'http://test-host:11434',
                numCtx: 6144,
                fetch: mockFetch,
            });

            await generateText({
                model,
                prompt: 'Test prompt',
            });

            expect(capturedBody).not.toBeNull();
            expect(capturedBody.options).toBeDefined();
            expect(capturedBody.options.num_ctx).toBe(6144);
        });
    });

    describe('Actionable Error Handling', () => {
        it('formats missing model error with ollama pull suggestion', async () => {
            const mockFetch: typeof fetch = async () => {
                return new Response(JSON.stringify({
                    error: { message: 'model "nonexistent:latest" not found, try pulling it first' },
                }), { status: 404, statusText: 'Not Found', headers: { 'Content-Type': 'application/json' } });
            };

            const model = getOllamaProvider('nonexistent:latest', {
                baseURL: 'http://test-host:11434',
                fetch: mockFetch,
            });

            let thrownError: Error | null = null;
            try {
                await generateText({
                    model,
                    prompt: 'Hello',
                });
            } catch (err: any) {
                thrownError = err;
            }

            expect(thrownError).not.toBeNull();
            expect(thrownError!.message).toContain('not found at http://test-host:11434/v1');
            expect(thrownError!.message).toContain('ollama pull nonexistent:latest');
        });

        it('formats connection failure with WSL host troubleshooting suggestion', async () => {
            const mockFetch: typeof fetch = async () => {
                throw new Error('fetch failed: connect ECONNREFUSED 172.23.32.1:11434');
            };

            const model = getOllamaProvider('qwen2.5-coder:3b', {
                baseURL: 'http://172.23.32.1:11434',
                fetch: mockFetch,
            });

            let thrownError: Error | null = null;
            try {
                await generateText({
                    model,
                    prompt: 'Hello',
                });
            } catch (err: any) {
                thrownError = err;
            }

            expect(thrownError).not.toBeNull();
            expect(thrownError!.message).toContain('Cannot connect to Ollama at http://172.23.32.1:11434/v1');
            expect(thrownError!.message).toContain('check Windows portproxy or firewall');
        });
    });
});

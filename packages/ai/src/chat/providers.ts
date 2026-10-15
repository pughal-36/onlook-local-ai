import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
    LLMProvider,
    MODEL_MAX_TOKENS,
    OPENROUTER_MODELS,
    type InitialModelPayload,
    type ModelConfig
} from '@onlook/models';
import { assertNever } from '@onlook/utility';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { LanguageModel } from 'ai';

export function normalizeOllamaBaseUrl(rawUrl?: string): string {
    const fallback = 'http://localhost:11434';
    const trimmed = (rawUrl || fallback).trim().replace(/\/+$/, '');
    if (trimmed.endsWith('/v1')) {
        return trimmed;
    }
    return `${trimmed}/v1`;
}

export function parseOllamaNumCtx(rawVal?: string): number {
    if (!rawVal) return 4096;
    const parsed = parseInt(rawVal, 10);
    return isNaN(parsed) || parsed <= 0 ? 4096 : parsed;
}

export function initModel({
    provider: requestedProvider,
    model: requestedModel,
}: InitialModelPayload): ModelConfig {
    let model: LanguageModel;
    let providerOptions: Record<string, any> | undefined;
    let headers: Record<string, string> | undefined;
    let maxOutputTokens: number = (MODEL_MAX_TOKENS as Record<string, number>)[requestedModel] ?? 4096;

    switch (requestedProvider) {
        case LLMProvider.OPENROUTER:
            model = getOpenRouterProvider(requestedModel as OPENROUTER_MODELS);
            headers = {
                'HTTP-Referer': 'https://onlook.com',
                'X-Title': 'Onlook',
            };
            providerOptions = {
                openrouter: { transforms: ['middle-out'] },
            };
            const isAnthropic = requestedModel === OPENROUTER_MODELS.CLAUDE_4_5_SONNET || requestedModel === OPENROUTER_MODELS.CLAUDE_3_5_HAIKU;
            providerOptions = isAnthropic
                ? { ...providerOptions, anthropic: { cacheControl: { type: 'ephemeral' } } }
                : providerOptions;
            break;

        case LLMProvider.OLLAMA:
            model = getOllamaProvider(requestedModel as string);
            break;

        default:
            assertNever(requestedProvider);
    }

    return {
        model,
        providerOptions,
        headers,
        maxOutputTokens,
    };
}

function getOpenRouterProvider(model: OPENROUTER_MODELS): LanguageModel {
    if (!process.env.OPENROUTER_API_KEY) {
        throw new Error('OPENROUTER_API_KEY must be set');
    }
    const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY });
    return openrouter(model);
}

export function getOllamaProvider(
    model: string,
    options?: {
        baseURL?: string;
        numCtx?: number;
        fetch?: typeof fetch;
    }
): LanguageModel {
    const rawBaseUrl = options?.baseURL ?? process.env.OLLAMA_BASE_URL;
    const baseURL = normalizeOllamaBaseUrl(rawBaseUrl);
    const numCtx = options?.numCtx ?? parseOllamaNumCtx(process.env.OLLAMA_NUM_CTX);
    const baseFetch = options?.fetch ?? globalThis.fetch;

    const wrappedFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = async (input, init) => {
        let requestInit = init;

        // Inject num_ctx into body if POST request
        if (requestInit?.body && typeof requestInit.body === 'string' && numCtx) {
            try {
                const parsed = JSON.parse(requestInit.body);
                parsed.options = { ...parsed.options, num_ctx: numCtx };
                requestInit = {
                    ...requestInit,
                    body: JSON.stringify(parsed),
                };
            } catch {
                // Keep original body if parsing fails
            }
        }

        try {
            const response = await baseFetch(input, requestInit);

            if (!response.ok) {
                let errorMessage = `HTTP ${response.status} ${response.statusText}`;
                try {
                    const cloned = response.clone();
                    const text = await cloned.text();
                    try {
                        const json = JSON.parse(text);
                        if (json?.error?.message) {
                            errorMessage = json.error.message;
                        } else if (json?.message) {
                            errorMessage = json.message;
                        } else if (json?.error) {
                            errorMessage = typeof json.error === 'string' ? json.error : JSON.stringify(json.error);
                        }
                    } catch {
                        if (text) errorMessage = text;
                    }
                } catch {
                    // Ignore clone reading errors
                }

                if (response.status === 404 && errorMessage.toLowerCase().includes('model')) {
                    throw new Error(
                        `Ollama model "${model}" not found at ${baseURL}. Try running \`ollama pull ${model}\` in your Ollama host terminal.`,
                    );
                }

                throw new Error(`Ollama request failed (${response.status}): ${errorMessage}`);
            }

            return response;
        } catch (error: any) {
            const msg = error?.message || String(error);
            // Catch network level errors (ECONNREFUSED, fetch failed, timeout)
            if (
                msg.includes('fetch failed') ||
                msg.includes('ECONNREFUSED') ||
                msg.includes('ETIMEDOUT') ||
                msg.includes('ENOTFOUND')
            ) {
                throw new Error(
                    `Cannot connect to Ollama at ${baseURL}. Ensure Ollama is running on your host machine and reachable from WSL (e.g. check Windows portproxy or firewall). Details: ${msg}`,
                );
            }
            throw error;
        }
    };

    const provider = createOpenAICompatible({
        name: 'ollama',
        baseURL,
        fetch: wrappedFetch as any,
    });

    return provider(model);
}

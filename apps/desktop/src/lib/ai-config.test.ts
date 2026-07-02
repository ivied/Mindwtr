import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiSettings, AppSettings } from '@mindwtr/core';
import { buildAIConfig, isAIKeyRequired } from './ai-config';

const isTauriRuntimeMock = vi.hoisted(() => vi.fn(() => false));
const nativeFetchMock = vi.hoisted(() => vi.fn());

vi.mock('./runtime', () => ({
    isTauriRuntime: isTauriRuntimeMock,
}));

vi.mock('@tauri-apps/plugin-http', () => ({
    fetch: nativeFetchMock,
}));

const createSettings = (ai: AiSettings): AppSettings => ({ ai });

beforeEach(() => {
    isTauriRuntimeMock.mockReturnValue(false);
    nativeFetchMock.mockReset();
});

describe('isAIKeyRequired', () => {
    it('requires key for default OpenAI endpoint', () => {
        expect(isAIKeyRequired(createSettings({
            provider: 'openai',
            model: 'gpt-4o-mini',
        }))).toBe(true);
    });

    it('does not require key for custom OpenAI-compatible endpoint', () => {
        expect(isAIKeyRequired(createSettings({
            provider: 'openai',
            model: 'llama3.2',
            baseUrl: 'http://localhost:11434/v1',
        }))).toBe(false);
    });

    it('requires key for non-openai providers', () => {
        expect(isAIKeyRequired(createSettings({
            provider: 'gemini',
            model: 'gemini-2.5-flash',
        }))).toBe(true);
    });
});

describe('buildAIConfig', () => {
    it('uses Tauri native HTTP fetch in the desktop runtime', async () => {
        isTauriRuntimeMock.mockReturnValue(true);

        const config = await buildAIConfig(createSettings({
            provider: 'openai',
            model: 'gpt-4o-mini',
        }), 'test-key');

        expect(config.fetcher).toBe(nativeFetchMock);
    });
});

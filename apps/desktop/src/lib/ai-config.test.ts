import { describe, expect, it } from 'vitest';
import type { AiSettings, AppSettings } from '@mindwtr/core';
import { isAIKeyRequired } from './ai-config';

const createSettings = (ai: AiSettings): AppSettings => ({ ai });

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

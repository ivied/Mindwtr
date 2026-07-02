import { describe, expect, it } from 'vitest';

import { DEFAULT_LOCAL_API_PORT, normalizeLocalApiPortInput } from './local-api-server';

describe('local-api-server', () => {
    it('validates localhost API port input', () => {
        expect(DEFAULT_LOCAL_API_PORT).toBe(3456);
        expect(normalizeLocalApiPortInput('3456')).toBe(3456);
        expect(normalizeLocalApiPortInput('1023')).toBeNull();
        expect(normalizeLocalApiPortInput('65536')).toBeNull();
        expect(normalizeLocalApiPortInput('abc')).toBeNull();
    });
});

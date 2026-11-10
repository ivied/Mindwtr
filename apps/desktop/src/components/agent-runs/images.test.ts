import { describe, expect, it } from 'vitest';
import { fitWithin } from './images';

describe('reply images', () => {
    it('shrinks a large screenshot to fit and never upscales', () => {
        expect(fitWithin(4400, 2200)).toEqual({ width: 2200, height: 1100 });
        expect(fitWithin(1000, 3300)).toEqual({ width: 667, height: 2200 });
        expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
    });
});

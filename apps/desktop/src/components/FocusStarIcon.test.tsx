import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { FocusStarIcon } from './FocusStarIcon';

describe('FocusStarIcon', () => {
    it('uses the project focus star fill style', () => {
        expect(renderToStaticMarkup(<FocusStarIcon className="h-4 w-4" filled />))
            .toContain('fill="currentColor"');
        expect(renderToStaticMarkup(<FocusStarIcon className="h-4 w-4" />))
            .toContain('fill="none"');
    });
});

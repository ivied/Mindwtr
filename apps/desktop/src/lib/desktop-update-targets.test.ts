import { describe, expect, it } from 'vitest';

import {
    getDesktopUpdateTarget,
    isDesktopUpdateReminderAllowed,
} from './desktop-update-targets';
import { MS_STORE_UPDATES_URL } from './update-service';

describe('desktop update targets', () => {
    it('allows automatic update reminders for Microsoft Store installs', () => {
        expect(isDesktopUpdateReminderAllowed('microsoft-store')).toBe(true);
    });

    it('routes Microsoft Store update reminders to the Store updates page', () => {
        expect(getDesktopUpdateTarget('microsoft-store')).toEqual({
            label: 'Update in Microsoft Store',
            url: MS_STORE_UPDATES_URL,
        });
    });
});

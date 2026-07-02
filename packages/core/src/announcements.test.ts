import { describe, expect, it } from 'vitest';

import {
    ACTIVE_APP_ANNOUNCEMENT,
    APP_ANNOUNCEMENT_DISMISSED_VALUE,
    getAnnouncementDismissalStorageKey,
    shouldShowAppAnnouncement,
    type AppAnnouncement,
} from './announcements';

const announcement: AppAnnouncement = {
    id: 'mindwtr-1-0',
    title: 'Mindwtr 1.0',
    body: 'Thanks for helping shape Mindwtr.',
};

describe('app announcements', () => {
    it('stays silent by default', () => {
        expect(ACTIVE_APP_ANNOUNCEMENT).toBeNull();
        expect(shouldShowAppAnnouncement(ACTIVE_APP_ANNOUNCEMENT, null)).toBe(false);
    });

    it('uses the announcement id for dismissal storage', () => {
        expect(getAnnouncementDismissalStorageKey(' mindwtr-1-0 ')).toBe(
            'mindwtr:announcement-dismissed:mindwtr-1-0',
        );
    });

    it('shows a valid announcement until the same id has been dismissed', () => {
        expect(shouldShowAppAnnouncement(announcement, null)).toBe(true);
        expect(shouldShowAppAnnouncement(announcement, APP_ANNOUNCEMENT_DISMISSED_VALUE)).toBe(false);
    });

    it('does not show incomplete announcements', () => {
        expect(shouldShowAppAnnouncement({ ...announcement, id: ' ' }, null)).toBe(false);
        expect(shouldShowAppAnnouncement({ ...announcement, title: ' ' }, null)).toBe(false);
        expect(shouldShowAppAnnouncement({ ...announcement, body: ' ' }, null)).toBe(false);
    });
});

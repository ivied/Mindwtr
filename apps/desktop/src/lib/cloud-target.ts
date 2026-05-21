/**
 * Origin-aware cloud sync target.
 *
 * The same web bundle is served from two origins that need different API
 * hosts:
 *   - localhost (dev)       → http://localhost:8787  (HTTP, same machine)
 *   - any other host (prod) → VITE_CLOUD_URL          (https://api.kurdy.uk)
 *
 * A localhost API URL can't be reached from an HTTPS page (mixed-content
 * block — this was the "Sync failed" on gtd.kurdy.uk), and forcing the prod
 * HTTPS URL from the same machine adds needless latency. So we pick per
 * origin at runtime instead of storing one fixed URL.
 *
 * The token is baked at build time. It is NOT a real secret in this
 * single-user deploy: the cloud is only reachable through the Cloudflare
 * tunnel, and the bundle already needs the token to sync at all. Rotate by
 * rebuilding with a new VITE_CLOUD_TOKEN if it ever leaks.
 */

const PROD_CLOUD_BASE = (import.meta.env.VITE_CLOUD_URL ?? 'https://api.kurdy.uk').replace(/\/+$/, '');
const CLOUD_TOKEN = (import.meta.env.VITE_CLOUD_TOKEN ?? 'dev-token-gtd-automation-2026').trim();

export const isLocalhostOrigin = (): boolean => {
    if (typeof window === 'undefined') return true;
    const h = window.location.hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]' || h.endsWith('.local');
};

/** Base API origin for the current page — no trailing slash, no path. */
export const cloudBaseUrl = (): string => (isLocalhostOrigin() ? 'http://localhost:8787' : PROD_CLOUD_BASE);

/** Full /v1/data endpoint for bootstrap + pull. */
export const cloudDataUrl = (): string => `${cloudBaseUrl()}/v1/data`;

export const cloudToken = (): string => CLOUD_TOKEN;

/** True when the stored sync URL can't work for the current page and should
 *  be self-healed. Catches two common leftovers:
 *   - a localhost URL while served from a remote origin (or vice versa) —
 *     mixed-content / unreachable;
 *   - the API URL accidentally pointed at the web-UI origin itself
 *     (e.g. https://gtd.kurdy.uk instead of https://api.kurdy.uk). */
export const isOriginMismatchedUrl = (storedUrl: string | null | undefined): boolean => {
    if (!storedUrl) return false;
    const storedIsLocal = /\/\/(localhost|127\.0\.0\.1|\[?::1\]?)(:|\/|$)/.test(storedUrl);
    if (storedIsLocal !== isLocalhostOrigin()) return true;
    if (typeof window !== 'undefined') {
        try {
            if (new URL(storedUrl).host === window.location.host) return true;
        } catch {
            return true; // unparseable URL → heal it
        }
    }
    return false;
};

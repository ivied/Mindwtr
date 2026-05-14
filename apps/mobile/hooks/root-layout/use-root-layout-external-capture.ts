import { useCallback, useEffect, useRef } from 'react';

import type { Task } from '@mindwtr/core';

import type { ToastOptions } from '@/contexts/toast-context';
import { logError, logWarn } from '@/lib/app-log';
import {
    isOpenFeatureUrl,
    isShortcutCaptureUrl,
    parseOpenFeatureUrl,
    parseShortcutCaptureUrl,
    resolveOpenFeaturePath,
    type ShortcutCapturePayload,
} from '@/lib/capture-deeplink';

type ResolveText = (key: string, fallback: string) => string;

type RouterLike = {
    canGoBack: () => boolean;
    push: (...args: any[]) => void;
    replace: (...args: any[]) => void;
};

type UseRootLayoutExternalCaptureParams = {
    dataReady: boolean;
    hasShareIntent: boolean;
    incomingUrl: string | null;
    resolveText: ResolveText;
    resetShareIntent: () => void;
    router: RouterLike;
    shareText?: string | null;
    shareWebUrl?: string | null;
    showToast: (options: ToastOptions) => void;
};

const normalizeShortcutTags = (tags: string[]): string[] => {
    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const rawTag of tags) {
        const trimmed = String(rawTag || '').trim();
        if (!trimmed) continue;
        const prefixed = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
        const key = prefixed.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        normalized.push(prefixed);
    }
    return normalized;
};

export function useRootLayoutExternalCapture({
    dataReady,
    hasShareIntent,
    incomingUrl,
    resolveText,
    resetShareIntent,
    router,
    shareText,
    shareWebUrl,
    showToast,
}: UseRootLayoutExternalCaptureParams) {
    const lastHandledUrl = useRef<string | null>(null);

    const openCaptureConfirmation = useCallback((payload: ShortcutCapturePayload) => {
        const tags = normalizeShortcutTags(payload.tags);
        const initialProps: Partial<Task> = {
            ...(payload.note ? { description: payload.note } : {}),
            ...(tags.length > 0 ? { tags } : {}),
        };
        const params: Record<string, string> = {
            initialValue: encodeURIComponent(payload.title),
        };
        if (Object.keys(initialProps).length > 0) {
            params.initialProps = encodeURIComponent(JSON.stringify(initialProps));
        }
        if (payload.project) {
            params.project = encodeURIComponent(payload.project);
        }

        if (router.canGoBack()) {
            router.push({
                pathname: '/capture-modal',
                params,
            });
        } else {
            router.replace({
                pathname: '/capture-modal',
                params,
            });
        }
    }, [router]);

    useEffect(() => {
        if (!hasShareIntent) return;
        const sharedText = typeof shareText === 'string'
            ? shareText
            : typeof shareWebUrl === 'string'
                ? shareWebUrl
                : '';
        if (sharedText.trim()) {
            router.replace({
                pathname: '/capture-modal',
                params: { text: encodeURIComponent(sharedText.trim()) },
            });
        } else {
            void logError(new Error('Share intent payload missing text'), { scope: 'share-intent' });
            showToast({
                title: resolveText('share.unavailable', 'Share unavailable'),
                message: resolveText('share.readFailed', 'Mindwtr could not read text or a URL from the shared item.'),
                tone: 'warning',
            });
        }
        resetShareIntent();
    }, [hasShareIntent, resolveText, resetShareIntent, router, shareText, shareWebUrl, showToast]);

    useEffect(() => {
        if (!dataReady) return;
        if (!incomingUrl) return;
        if (lastHandledUrl.current === incomingUrl) return;

        const featurePayload = parseOpenFeatureUrl(incomingUrl);
        if (featurePayload) {
            lastHandledUrl.current = incomingUrl;
            router.replace(resolveOpenFeaturePath(featurePayload.feature));
            return;
        }
        if (isOpenFeatureUrl(incomingUrl)) {
            lastHandledUrl.current = incomingUrl;
            router.replace('/inbox');
            return;
        }

        const payload = parseShortcutCaptureUrl(incomingUrl);
        if (!payload) {
            if (!isShortcutCaptureUrl(incomingUrl)) return;
            lastHandledUrl.current = incomingUrl;
            void logWarn('Invalid shortcut capture URL', {
                scope: 'shortcuts',
                extra: { url: incomingUrl },
            });
            showToast({
                title: resolveText('shortcuts.captureUnavailable', 'Capture shortcut unavailable'),
                message: resolveText('shortcuts.missingTitle', 'Mindwtr could not read a task title from that shortcut link.'),
                tone: 'warning',
            });
            return;
        }

        lastHandledUrl.current = incomingUrl;
        try {
            openCaptureConfirmation(payload);
        } catch (error) {
            lastHandledUrl.current = null;
            void logError(error, { scope: 'shortcuts', extra: { url: incomingUrl } });
        }
    }, [dataReady, incomingUrl, resolveText, openCaptureConfirmation, router, showToast]);
}

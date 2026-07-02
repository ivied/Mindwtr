import { useEffect, useRef } from 'react';

import { parseContextAutomationUrl } from '@/lib/context-automation';
import {
  __resetContextAutomationDedupeForTests,
  handleContextAutomationPayload,
  wasContextAutomationRecentlyHandled,
} from '@/lib/context-automation-handler';

type ResolveText = (key: string, fallback: string) => string;

type UseRootLayoutContextAutomationParams = {
  dataReady: boolean;
  incomingUrl: string | null;
  returnToBackground?: () => void;
  resolveText: ResolveText;
};

export { __resetContextAutomationDedupeForTests };

export function useRootLayoutContextAutomation({
  dataReady,
  incomingUrl,
  returnToBackground,
  resolveText,
}: UseRootLayoutContextAutomationParams) {
  const lastHandledUrl = useRef<string | null>(null);

  useEffect(() => {
    if (!dataReady) return;
    if (!incomingUrl) return;
    if (lastHandledUrl.current === incomingUrl) return;

    const payload = parseContextAutomationUrl(incomingUrl);
    if (!payload) return;

    if (wasContextAutomationRecentlyHandled(payload)) {
      lastHandledUrl.current = incomingUrl;
      returnToBackground?.();
      return;
    }

    lastHandledUrl.current = incomingUrl;

    void handleContextAutomationPayload(payload, resolveText).finally(() => {
      returnToBackground?.();
    });
  }, [dataReady, incomingUrl, resolveText, returnToBackground]);
}

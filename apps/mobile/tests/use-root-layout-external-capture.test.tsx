import React from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useRootLayoutExternalCapture } from '@/hooks/root-layout/use-root-layout-external-capture';

vi.mock('@/lib/app-log', () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

type RouterMock = {
  canGoBack: ReturnType<typeof vi.fn>;
  push: ReturnType<typeof vi.fn>;
  replace: ReturnType<typeof vi.fn>;
};

function TestHarness({
  hasShareIntent = false,
  incomingUrl,
  resetShareIntent = vi.fn(),
  router,
  shareText = null,
  shareWebUrl = null,
  showToast,
}: {
  hasShareIntent?: boolean;
  incomingUrl: string | null;
  resetShareIntent?: ReturnType<typeof vi.fn>;
  router: RouterMock;
  shareText?: string | null;
  shareWebUrl?: string | null;
  showToast: ReturnType<typeof vi.fn>;
}) {
  useRootLayoutExternalCapture({
    dataReady: true,
    hasShareIntent,
    incomingUrl,
    resolveText: (_key: string, fallback: string) => fallback,
    resetShareIntent,
    router,
    shareText,
    shareWebUrl,
    showToast,
  });
  return null;
}

describe('useRootLayoutExternalCapture', () => {
  let router: RouterMock;
  let showToast: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    router = {
      canGoBack: vi.fn(() => false),
      push: vi.fn(),
      replace: vi.fn(),
    };
    showToast = vi.fn();
  });

  it('opens shared text capture with the shared text as the task title', () => {
    const resetShareIntent = vi.fn();

    act(() => {
      create(
        <TestHarness
          hasShareIntent
          incomingUrl={null}
          resetShareIntent={resetShareIntent}
          router={router}
          shareText="The paragraph I selected in another app"
          showToast={showToast}
        />
      );
    });

    expect(router.replace).toHaveBeenCalledWith({
      pathname: '/capture-modal',
      params: {
        initialValue: 'The%20paragraph%20I%20selected%20in%20another%20app',
      },
    });
    const params = router.replace.mock.calls[0][0].params;
    expect(params.text).toBeUndefined();
    expect(params.initialProps).toBeUndefined();
    expect(resetShareIntent).toHaveBeenCalledTimes(1);
  });

  it('uses shared text as the task title and preserves a distinct URL in the note', () => {
    act(() => {
      create(
        <TestHarness
          hasShareIntent
          incomingUrl={null}
          router={router}
          shareText="Read this before the project review"
          shareWebUrl="https://example.com/review-notes"
          showToast={showToast}
        />
      );
    });

    const params = router.replace.mock.calls[0][0].params;
    expect(params.initialValue).toBe('Read%20this%20before%20the%20project%20review');
    expect(JSON.parse(decodeURIComponent(params.initialProps))).toEqual({
      description: 'https://example.com/review-notes',
    });
  });

  it('uses a shared URL as the task title when no text is available', () => {
    act(() => {
      create(
        <TestHarness
          hasShareIntent
          incomingUrl={null}
          router={router}
          shareWebUrl="https://example.com/review-notes"
          showToast={showToast}
        />
      );
    });

    expect(router.replace).toHaveBeenCalledWith({
      pathname: '/capture-modal',
      params: {
        initialValue: 'https%3A%2F%2Fexample.com%2Freview-notes',
      },
    });
  });

  it('opens a confirmation modal for App Actions capture links', () => {
    act(() => {
      create(
        <TestHarness
          incomingUrl="mindwtr:///capture?title=Call%20dentist&note=Tomorrow&tags=phone&project=Home"
          router={router}
          showToast={showToast}
        />
      );
    });

    expect(router.replace).toHaveBeenCalledWith({
      pathname: '/capture-modal',
      params: {
        initialValue: 'Call%20dentist',
        initialProps: expect.any(String),
        project: 'Home',
      },
    });
    const params = router.replace.mock.calls[0][0].params;
    expect(JSON.parse(decodeURIComponent(params.initialProps))).toEqual({
      description: 'Tomorrow',
      tags: ['#phone'],
    });
  });

  it('handles repeated App Actions captures when the request id changes', () => {
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(
        <TestHarness
          incomingUrl="mindwtr:///capture?title=Call%20dentist&requestId=first"
          router={router}
          showToast={showToast}
        />
      );
    });

    act(() => {
      tree.update(
        <TestHarness
          incomingUrl="mindwtr:///capture?title=Call%20dentist&requestId=second"
          router={router}
          showToast={showToast}
        />
      );
    });

    expect(router.replace).toHaveBeenCalledTimes(2);
    expect(router.replace).toHaveBeenNthCalledWith(1, {
      pathname: '/capture-modal',
      params: {
        initialValue: 'Call%20dentist',
      },
    });
    expect(router.replace).toHaveBeenNthCalledWith(2, {
      pathname: '/capture-modal',
      params: {
        initialValue: 'Call%20dentist',
      },
    });
  });

  it('routes App Actions feature links through the feature inventory map', () => {
    act(() => {
      create(
        <TestHarness
          incomingUrl="mindwtr:///open-feature?feature=focus"
          router={router}
          showToast={showToast}
        />
      );
    });

    expect(router.replace).toHaveBeenCalledWith('/focus');
    expect(router.push).not.toHaveBeenCalled();
  });
});

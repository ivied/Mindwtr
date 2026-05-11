import { describe, it, expect, mock } from 'bun:test'
import { runOnce, type RunnerDeps } from './runner'
import { CaptureDeduper } from './filter/dedup'
import type { DisplayCapture, ScreenshotProvider } from './capture/screenshot'

function makeScreenshotProvider(
  displays: Array<{ primary?: boolean; width?: number; height?: number; name?: string }> = [
    { primary: true, width: 3456, height: 2234, name: 'primary' },
  ]
): ScreenshotProvider {
  const captures: DisplayCapture[] = displays.map((d, i) => ({
    display: {
      index: i,
      id: i,
      name: d.name ?? `display-${i}`,
      primary: d.primary ?? i === 0,
      width: d.width ?? 1920,
      height: d.height ?? 1080,
    },
    png: Buffer.from(`png-${i}`),
  }))
  return {
    capture: async () => captures[0]!.png,
    captureAll: async () => captures,
  }
}

function deps(overrides: Partial<RunnerDeps> = {}): RunnerDeps {
  return {
    screenshot: makeScreenshotProvider(),
    ocr: { recognize: async () => 'plenty of text here', shutdown: async () => {} },
    window: {
      current: async () => ({
        app: 'Safari',
        title: 'BBC News',
        bounds: { x: 100, y: 100, width: 800, height: 600 },
      }),
    },
    rules: { excludedApps: [], excludedTitles: [] },
    pauseFlagPath: '',
    minOcrLength: 5,
    sink: mock(async () => {}),
    multiDisplay: true,
    wikiOnlyApps: [],
    ...overrides,
  }
}

describe('runOnce', () => {
  it('captures and sends when nothing is filtered', async () => {
    const sink = mock(async () => {})
    const result = await runOnce(deps({ sink }))
    expect(result).toBeNull()
    expect(sink).toHaveBeenCalledTimes(1)
    const calls = (sink as unknown as { mock: { calls: [{ app: string; ocrText: string }][] } })
      .mock.calls
    expect(calls[0][0]).toMatchObject({ app: 'Safari', ocrText: 'plenty of text here' })
  })

  it('returns "paused" when pause flag is present', async () => {
    const tmp = `/tmp/gtd-test-pause-${Date.now()}`
    await Bun.write(tmp, '')
    const sink = mock(async () => {})
    const result = await runOnce(deps({ sink, pauseFlagPath: tmp }))
    expect(result).toBe('paused')
    expect(sink).not.toHaveBeenCalled()
    await Bun.file(tmp).delete?.().catch(() => {})
  })

  it('returns "no-window" when active window is null', async () => {
    const sink = mock(async () => {})
    const result = await runOnce(deps({ sink, window: { current: async () => null } }))
    expect(result).toBe('no-window')
    expect(sink).not.toHaveBeenCalled()
  })

  it('returns "excluded" when app matches exclusion rules', async () => {
    const sink = mock(async () => {})
    const result = await runOnce(
      deps({
        sink,
        window: { current: async () => ({ app: '1Password', title: 'Vault' }) },
        rules: { excludedApps: ['1password'], excludedTitles: [] },
      })
    )
    expect(result).toBe('excluded')
    expect(sink).not.toHaveBeenCalled()
  })

  it('returns "low-ocr" when OCR text is shorter than threshold', async () => {
    const sink = mock(async () => {})
    const result = await runOnce(
      deps({
        sink,
        ocr: { recognize: async () => 'hi', shutdown: async () => {} },
        minOcrLength: 10,
      })
    )
    expect(result).toBe('low-ocr')
    expect(sink).not.toHaveBeenCalled()
  })

  it('returns "duplicate" when dedup considers it a repeat', async () => {
    const sink = mock(async () => {})
    let now = 1_000_000
    const dedup = new CaptureDeduper(undefined, () => now)

    const first = await runOnce(deps({ sink, dedup }))
    expect(first).toBeNull()
    expect(sink).toHaveBeenCalledTimes(1)

    now += 1_000
    const second = await runOnce(deps({ sink, dedup }))
    expect(second).toBe('duplicate')
    expect(sink).toHaveBeenCalledTimes(1)
  })

  it('propagates errors from sink', async () => {
    const sink = mock(async () => {
      throw new Error('network down')
    })
    await expect(runOnce(deps({ sink }))).rejects.toThrow('network down')
  })

  it('archives all displays but only sends the active one', async () => {
    const sink = mock(async () => {})
    const archive = mock(async () => {})
    const result = await runOnce(
      deps({
        sink,
        archive,
        screenshot: makeScreenshotProvider([
          { primary: true, width: 3456, height: 2234, name: 'built-in' },
          { primary: false, width: 1920, height: 1080, name: 'external' },
        ]),
      })
    )
    expect(result).toBeNull()
    expect(archive).toHaveBeenCalledTimes(2)
    expect(sink).toHaveBeenCalledTimes(1)
  })

  it('marks non-active display capture as background', async () => {
    const sink = mock(async () => {})
    const archive = mock(async (_capture: unknown, _png: unknown) => {})
    await runOnce(
      deps({
        sink,
        archive,
        screenshot: makeScreenshotProvider([
          { primary: true, width: 3456, height: 2234, name: 'built-in' },
          { primary: false, width: 1920, height: 1080, name: 'external' },
        ]),
      })
    )
    const calls = (archive as unknown as { mock: { calls: [{ app: string; isActiveDisplay: boolean }, Buffer][] } })
      .mock.calls
    const active = calls.find((c) => c[0].isActiveDisplay)!
    const inactive = calls.find((c) => !c[0].isActiveDisplay)!
    expect(active[0].app).toBe('Safari')
    expect(inactive[0].app).toBe('background')
  })

  it('returns "wiki-only" when focused app matches wikiOnlyApps', async () => {
    const sink = mock(async () => {})
    const archive = mock(async () => {})
    const result = await runOnce(
      deps({
        sink,
        archive,
        window: {
          current: async () => ({
            app: 'Code',
            title: 'project.ts — GTD_automation',
            bounds: { x: 100, y: 100, width: 800, height: 600 },
          }),
        },
        wikiOnlyApps: ['Code', 'Cursor'],
      })
    )
    expect(result).toBe('wiki-only')
    expect(archive).toHaveBeenCalledTimes(1)
    expect(sink).not.toHaveBeenCalled()
  })

  it('routes only the active display through wiki-only filter (background still archives)', async () => {
    const sink = mock(async () => {})
    const archive = mock(async () => {})
    const result = await runOnce(
      deps({
        sink,
        archive,
        window: {
          current: async () => ({
            app: 'Code',
            title: 'editor',
            bounds: { x: 100, y: 100, width: 800, height: 600 },
          }),
        },
        wikiOnlyApps: ['Code'],
        screenshot: makeScreenshotProvider([
          { primary: true, width: 3456, height: 2234, name: 'built-in' },
          { primary: false, width: 1920, height: 1080, name: 'external' },
        ]),
      })
    )
    expect(result).toBe('wiki-only')
    expect(archive).toHaveBeenCalledTimes(2)
    expect(sink).not.toHaveBeenCalled()
  })
})

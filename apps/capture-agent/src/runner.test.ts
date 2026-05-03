import { describe, it, expect, mock } from 'bun:test'
import { runOnce, type RunnerDeps } from './runner'

function deps(overrides: Partial<RunnerDeps> = {}): RunnerDeps {
  return {
    screenshot: { capture: async () => Buffer.from('png') },
    ocr: { recognize: async () => 'plenty of text here', shutdown: async () => {} },
    window: { current: async () => ({ app: 'Safari', title: 'BBC News' }) },
    rules: { excludedApps: [], excludedTitles: [] },
    pauseFlagPath: '',
    minOcrLength: 5,
    sink: mock(async () => {}),
    ...overrides,
  }
}

describe('runOnce', () => {
  it('captures and sends when nothing is filtered', async () => {
    const sink = mock(async () => {})
    const result = await runOnce(deps({ sink }))
    expect(result).toBeNull()
    expect(sink).toHaveBeenCalledTimes(1)
    const calls = (sink as unknown as { mock: { calls: [{ app: string; ocrText: string }][] } }).mock.calls
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

  it('propagates errors from sink', async () => {
    const sink = mock(async () => {
      throw new Error('network down')
    })
    await expect(runOnce(deps({ sink }))).rejects.toThrow('network down')
  })
})

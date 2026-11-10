import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunsApi } from './client'
import { withImages } from './runner'

const api = (bytes: Record<string, Uint8Array>): RunsApi =>
  ({
    attachment: async (_run: string, id: string) => {
      const b = bytes[id]
      if (!b) throw new Error('404')
      return b
    },
  }) as unknown as RunsApi

describe('screenshots attached to a reply', () => {
  it('saves them on the host and tells the agent where to look', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'att-'))
    const reply = await withImages(
      api({ a1: new Uint8Array([1, 2, 3]) }),
      'run-1',
      { kind: 'answer', text: 'вот ошибка', images: [{ id: 'a1', name: 'err.png', mime: 'image/png' }] },
      dir
    )
    const file = join(dir, 'run-1', 'a1.png')
    expect([...readFileSync(file)]).toEqual([1, 2, 3])
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(reply.text).toStartWith('вот ошибка')
    expect(reply.text).toContain(file)
    expect(reply.text).toContain('Read')
  })

  it('works without text and says so when an image could not be fetched', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'att-'))
    const reply = await withImages(
      api({ ok: new Uint8Array([9]) }),
      'run-2',
      {
        kind: 'message',
        text: '',
        images: [
          { id: 'ok', name: 'a.jpg', mime: 'image/jpeg' },
          { id: 'gone', name: 'b.png', mime: 'image/png' },
        ],
      },
      dir
    )
    expect(reply.text).toContain(join(dir, 'run-2', 'ok.jpg'))
    expect(reply.text).toContain('Ещё 1 изобр. не удалось получить')
  })

  it('leaves a plain reply untouched', async () => {
    const plain = { kind: 'answer' as const, text: 'да' }
    expect(await withImages(api({}), 'r', plain, '/nonexistent')).toBe(plain)
  })
})

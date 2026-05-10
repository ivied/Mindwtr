/**
 * Tiny parser for the strict YAML frontmatter shape produced by md-writer.
 * Values are either plain numbers or backslash-escaped quoted strings.
 * No nested structures, no lists — keep this dumb on purpose.
 */

export interface ParsedCapture {
  meta: Record<string, string | number>
  body: string
}

export function parseCaptureMd(text: string): ParsedCapture {
  if (!text.startsWith('---\n')) {
    return { meta: {}, body: text }
  }
  const end = text.indexOf('\n---\n', 4)
  if (end < 0) return { meta: {}, body: text }

  const fmBlock = text.slice(4, end)
  const body = text.slice(end + 5).replace(/^\n/, '')

  const meta: Record<string, string | number> = {}
  for (const line of fmBlock.split('\n')) {
    const m = line.match(/^([a-z_]+):\s*(.+)$/)
    if (!m) continue
    const [, key, raw] = m
    meta[key!] = parseValue(raw!)
  }
  return { meta, body }
}

function parseValue(raw: string): string | number {
  const trimmed = raw.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  const n = Number(trimmed)
  if (!Number.isNaN(n)) return n
  return trimmed
}

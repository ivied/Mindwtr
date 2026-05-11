/**
 * Parser/serializer for `wiki/entities/<slug>.md` frontmatter.
 *
 * Shared by every curator pass — GC needs `mention_count` + `last_seen`,
 * merger needs aliases + related, synthesizer needs body + aliases.
 *
 * Format example:
 *   ---
 *   slug: amir
 *   name: "Amir"
 *   type: person
 *   aliases: ["Amir", "Амир"]
 *   first_seen: 2026-05-10T00:00:00.000Z
 *   last_seen: 2026-05-11T00:00:00.000Z
 *   mention_count: 5
 *   related: ["a-slug":3, "b-slug":2]
 *   ---
 *
 * The `related` key uses a non-standard "slug":count syntax our writer
 * emits. Parser handles it; serializer preserves it for round-trip.
 */

export interface EntityFrontmatter {
  slug: string
  name: string
  type: string
  aliases: string[]
  firstSeen: string
  lastSeen: string
  mentionCount: number
  related: Array<{ slug: string; count: number }>
}

export interface ParsedEntity {
  frontmatter: EntityFrontmatter
  /** Body after the closing `---` line, unchanged. */
  body: string
}

export function parseEntityMd(text: string): ParsedEntity | null {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/)
  if (!m) return null
  const fmBlock = m[1] ?? ''
  const body = m[2] ?? ''

  const slug = readScalar(fmBlock, 'slug')
  const name = readScalar(fmBlock, 'name')
  const type = readScalar(fmBlock, 'type')
  if (!slug || !name || !type) return null

  return {
    frontmatter: {
      slug,
      name,
      type,
      aliases: readStringList(fmBlock, 'aliases'),
      firstSeen: readScalar(fmBlock, 'first_seen') ?? '',
      lastSeen: readScalar(fmBlock, 'last_seen') ?? '',
      mentionCount: Number(readScalar(fmBlock, 'mention_count') ?? '0') || 0,
      related: readRelated(fmBlock),
    },
    body,
  }
}

/** Serializer round-tripping the same shape md-writer emits. */
export function serializeEntityMd(parsed: ParsedEntity): string {
  const fm = parsed.frontmatter
  const lines: string[] = []
  lines.push('---')
  lines.push(`slug: ${fm.slug}`)
  lines.push(`name: "${escapeStr(fm.name)}"`)
  lines.push(`type: ${fm.type}`)
  lines.push(`aliases: [${fm.aliases.map((a) => `"${escapeStr(a)}"`).join(', ')}]`)
  lines.push(`first_seen: ${fm.firstSeen}`)
  lines.push(`last_seen: ${fm.lastSeen}`)
  lines.push(`mention_count: ${fm.mentionCount}`)
  const relatedStr = fm.related
    .map(({ slug, count }) => `"${escapeStr(slug)}":${count}`)
    .join(', ')
  lines.push(`related: [${relatedStr}]`)
  lines.push('---')
  return `${lines.join('\n')}\n\n${parsed.body.replace(/^\n+/, '')}`
}

function readScalar(fm: string, key: string): string | null {
  const re = new RegExp(`^${escapeRe(key)}:\\s*(.+?)\\s*$`, 'm')
  const m = fm.match(re)
  if (!m) return null
  return unquote(m[1] ?? '')
}

function readStringList(fm: string, key: string): string[] {
  const re = new RegExp(`^${escapeRe(key)}:\\s*\\[(.*?)\\]\\s*$`, 'm')
  const m = fm.match(re)
  if (!m) return []
  const inner = m[1] ?? ''
  if (!inner.trim()) return []
  return inner
    .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((p) => unquote(p.trim()))
    .filter((s) => s.length > 0)
}

function readRelated(fm: string): Array<{ slug: string; count: number }> {
  const re = /^related:\s*\[(.*?)\]\s*$/m
  const m = fm.match(re)
  if (!m) return []
  const inner = m[1] ?? ''
  if (!inner.trim()) return []
  const out: Array<{ slug: string; count: number }> = []
  // tokenize as "slug":N entries separated by commas (slug may contain hyphens)
  const re2 = /"([^"]+)"\s*:\s*(\d+)/g
  let mm: RegExpExecArray | null
  while ((mm = re2.exec(inner)) !== null) {
    out.push({ slug: mm[1]!, count: Number(mm[2]!) || 0 })
  }
  return out
}

function unquote(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  return s
}

function escapeStr(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

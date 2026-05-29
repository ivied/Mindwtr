/**
 * Detector for "the system observing its own *running UI*" captures.
 *
 * When the user looks at the running GTD/Mindwtr app, the screen shows a task
 * list where MANY unrelated tasks appear at once. Co-occurrence from such a
 * capture is meaningless — every on-screen task "relates" to every other —
 * so we don't record edges from it (the mention is still kept).
 *
 * IMPORTANT — only the *running app* counts, NOT real work that merely
 * involves the GTD project:
 *   - editing the GTD source code (has "Inbox"/"Next Actions" as string
 *     literals) is real work → must NOT be filtered.
 *   - discussing the project is real work → must NOT be filtered.
 * So we match only precise, unambiguous markers of the live app/wiki:
 * its served URL, or the wiki entity-page frontmatter. We deliberately do
 * NOT match on sidebar word lists — those appear in source code too and
 * caused massive over-filtering.
 */

// The served Mindwtr web app (Sergey views it in the browser).
const APP_URL_MARKERS = ['gtd.kurdy.uk', 'localhost:5173']

export function isSelfObservingCapture(text: string): boolean {
  if (!text) return false
  const lower = text.toLowerCase()

  // The running web app's own URL is on screen.
  for (const url of APP_URL_MARKERS) {
    if (lower.includes(url)) return true
  }

  // A wiki entity page being viewed/edited (frontmatter markers together).
  if (lower.includes('mention_count:') && lower.includes('related:')) return true

  return false
}

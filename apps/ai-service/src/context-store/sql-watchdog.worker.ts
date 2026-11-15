/**
 * Runs beside the main thread and reports a SQL statement that has been
 * executing for a long time. The main thread cannot do it itself: bun:sqlite
 * is synchronous, so while a statement runs nothing else does.
 */
type Init = { data: { shared: SharedArrayBuffer; limitMs: number } }

;(globalThis as unknown as { onmessage: (e: Init) => void }).onmessage = ({ data }) => {
  const started = new Float64Array(data.shared, 0, 1)
  const length = new Int32Array(data.shared, 8, 1)
  const text = new Uint8Array(data.shared, 16)
  let reportedFor = 0
  let reportedAt = 0
  setInterval(() => {
    const since = started[0]
    if (!since) return
    const now = Date.now()
    if (now - since < data.limitMs) return
    if (reportedFor === since && now - reportedAt < 60_000) return
    reportedFor = since
    reportedAt = now
    const sql = new TextDecoder().decode(text.slice(0, Math.min(length[0], text.length)))
    console.warn(`[stuck-sql] running ${Math.round((now - since) / 1000)}s: ${sql}`)
  }, 2000)
}

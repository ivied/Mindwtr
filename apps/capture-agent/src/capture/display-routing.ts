/**
 * Decides which display the active window is on. The mapping problem on
 * macOS is messy (secondary displays can be placed left/right/above/below
 * the primary) and screenshot-desktop doesn't expose layout. We make a
 * simple, defensive call:
 *
 * - With one display, the active window is on it.
 * - With multiple, if the active window's center falls inside the primary
 *   display's pixel rect (0,0 → primary.width,primary.height), the active
 *   display is the primary. Otherwise — without layout info — the best we
 *   can do is pick the largest non-primary as a guess.
 *
 * Returns the index of the active display, or -1 if unknown.
 */

export interface DisplayRect {
  primary: boolean
  width: number
  height: number
}

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

export function findActiveDisplayIndex(
  bounds: Bounds | undefined,
  displays: DisplayRect[]
): number {
  if (displays.length === 0) return -1
  if (displays.length === 1) return 0
  if (!bounds) return primaryIndex(displays)

  const cx = bounds.x + bounds.width / 2
  const cy = bounds.y + bounds.height / 2

  // Direct hit on primary's pixel rect → primary.
  const primaryIdx = primaryIndex(displays)
  if (primaryIdx >= 0) {
    const p = displays[primaryIdx]!
    if (cx >= 0 && cx < p.width && cy >= 0 && cy < p.height) return primaryIdx
  }

  // Not on primary — without layout info, pick a non-primary display as
  // a best guess. Defaults to the first non-primary.
  for (let i = 0; i < displays.length; i++) {
    if (!displays[i]!.primary) return i
  }
  return -1
}

function primaryIndex(displays: DisplayRect[]): number {
  for (let i = 0; i < displays.length; i++) if (displays[i]!.primary) return i
  return -1
}

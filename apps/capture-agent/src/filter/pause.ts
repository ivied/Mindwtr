/**
 * Pause flag: if a file exists at `pauseFlagPath`, the agent skips capture.
 * Lets the user pause the agent without restarting (`touch ~/.gtd-paused`).
 */

import { stat } from 'node:fs/promises'

export async function isPaused(pauseFlagPath: string): Promise<boolean> {
  if (!pauseFlagPath) return false
  try {
    await stat(pauseFlagPath)
    return true
  } catch {
    return false
  }
}

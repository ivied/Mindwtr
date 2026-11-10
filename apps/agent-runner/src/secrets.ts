/**
 * Long-lived secrets for the agents.
 *
 * One file on the host (0600), outside the repo. The runner is the only writer:
 * a value arrives from the UI through ai-service when the user answers a
 * provisioning agent's request, and is merged into every agent's environment
 * at the start of each turn. Agents see `$NAME`, never the file.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const DEFAULT_SECRETS_FILE = join(homedir(), '.config', 'gtd-agents', 'secrets.env')

const NAME = /^[A-Z][A-Z0-9_]{2,63}$/

export function parseSecrets(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=')
    if (eq <= 0 || line.startsWith('#')) continue
    const name = line.slice(0, eq).trim()
    if (NAME.test(name)) out[name] = line.slice(eq + 1)
  }
  return out
}

export class SecretsFile {
  constructor(readonly path: string = DEFAULT_SECRETS_FILE) {}

  load(): Record<string, string> {
    try {
      return existsSync(this.path) ? parseSecrets(readFileSync(this.path, 'utf8')) : {}
    } catch {
      return {}
    }
  }

  private write(all: Record<string, string>): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const body =
      '# Secrets for GTD agents. Written by agent-runner; one NAME=value per line.\n' +
      Object.entries(all)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n') +
      '\n'
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, body, { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, this.path)
  }

  set(name: string, value: string): void {
    if (!NAME.test(name)) throw new Error(`bad secret name: ${name}`)
    this.write({ ...this.load(), [name]: value.replace(/[\r\n]/g, '') })
  }

  remove(names: string[]): void {
    const all = this.load()
    let changed = false
    for (const n of names) {
      if (n in all) {
        delete all[n]
        changed = true
      }
    }
    if (changed) this.write(all)
  }
}

/** Replace secret values in anything that is about to leave the host. */
export function redact<T>(value: T, secrets: Record<string, string>): T {
  const pairs = Object.entries(secrets).filter(([, v]) => v.length >= 6)
  if (pairs.length === 0) return value
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      let out = v
      for (const [name, secret] of pairs) if (out.includes(secret)) out = out.split(secret).join(`[секрет ${name}]`)
      return out
    }
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]))
    }
    return v
  }
  return walk(value) as T
}

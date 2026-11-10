import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ContextStore } from '../context-store/store'
import { MuteRuleStore } from './mute-rules'

let dir: string
let contextStore: ContextStore
let rules: MuteRuleStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gtd-mute-'))
  contextStore = ContextStore.open({ dbPath: join(dir, 'test.db') })
  rules = new MuteRuleStore(contextStore.rawDb)
})

afterEach(() => {
  contextStore.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('MuteRuleStore', () => {
  it('creates, lists and deletes rules', () => {
    const rule = rules.create({ title: 'Meet the delivery at door 7', sourceChannel: 'screen_capture' })
    expect(rule).not.toBeNull()
    expect(rules.list()).toHaveLength(1)
    expect(rules.delete(rule!.id)).toBe(true)
    expect(rules.list()).toHaveLength(0)
  })

  it('refuses rules with fewer than 2 keywords (too broad)', () => {
    expect(rules.create({ title: 'Нажать' })).toBeNull()
    expect(rules.list()).toHaveLength(0)
  })

  it('matches paraphrases with enough keyword overlap', () => {
    rules.create({ title: 'Meet the delivery at door 7', sourceChannel: 'screen_capture' })
    // "meet delivery door" — 3 of 4 rule keywords present → muted.
    expect(rules.findMatch('Meet delivery person at the door', 'screen_capture')).not.toBeNull()
    // Unrelated title → not muted.
    expect(rules.findMatch('Send the quarterly report to Kate', 'screen_capture')).toBeNull()
  })

  it('respects the source channel when the rule has one', () => {
    rules.create({ title: 'Meet the delivery at door 7', sourceChannel: 'screen_capture' })
    expect(rules.findMatch('Meet the delivery at door 7', 'slack_channel')).toBeNull()
  })

  it('channel-less rules match any channel', () => {
    rules.create({ title: 'Meet the delivery at door 7' })
    expect(rules.findMatch('Meet the delivery at door 7', 'slack_channel')).not.toBeNull()
  })
})

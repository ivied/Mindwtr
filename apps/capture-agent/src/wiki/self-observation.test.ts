import { describe, it, expect } from 'bun:test'
import { isSelfObservingCapture } from './self-observation'

describe('isSelfObservingCapture', () => {
  it('flags the running web app by its served URL', () => {
    expect(isSelfObservingCapture('viewing https://gtd.kurdy.uk/ai-agent')).toBe(true)
    expect(isSelfObservingCapture('localhost:5173 task board')).toBe(true)
  })

  it('flags a wiki entity page (frontmatter markers)', () => {
    expect(isSelfObservingCapture('slug: foo\nmention_count: 5\nrelated: [a:2]')).toBe(true)
  })

  it('does NOT flag editing the GTD source code (sidebar labels as literals)', () => {
    const code = `const nav = ['Inbox', 'Next Actions', 'Waiting For', 'Someday', 'AI Agent']`
    expect(isSelfObservingCapture(code)).toBe(false)
  })

  it('does NOT flag a real work screen that merely says "inbox" once', () => {
    expect(isSelfObservingCapture('Cleaning up my email inbox before the call')).toBe(false)
  })

  it('does NOT flag ordinary code/editor content', () => {
    expect(isSelfObservingCapture('function foo() { return bar.baz() } // TODO refactor')).toBe(false)
  })

  it('empty/whitespace is not self-observing', () => {
    expect(isSelfObservingCapture('')).toBe(false)
    expect(isSelfObservingCapture('   ')).toBe(false)
  })
})

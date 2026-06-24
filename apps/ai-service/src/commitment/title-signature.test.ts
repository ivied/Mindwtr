import { describe, it, expect } from 'bun:test'
import { normalize, buildSignature, signatureForRecord } from './title-signature'
import type { ProposalRecord } from '../proposal-store/types'
import type { CreatePayload, ModifyPayload } from '../proposal-store/payloads'

describe('normalize', () => {
  it('lowercases, strips punctuation, drops stopwords, sorts words', () => {
    expect(normalize('Send the Report to Alice!')).toBe('alice report send')
  })

  it('is order-independent (bag of words)', () => {
    expect(normalize('Report to Alice')).toBe(normalize('Alice the Report'))
  })

  it('drops EN and RU stopwords', () => {
    expect(normalize('позвонить в банк по поводу счёта')).toBe(
      normalize('счёта банк позвонить поводу')
    )
  })

  it('drops single-character tokens', () => {
    expect(normalize('a b cd')).toBe('cd')
  })
})

describe('buildSignature', () => {
  it('joins normalized title/whoTo/byWhen with pipes', () => {
    expect(buildSignature('Pay Acme invoice', 'Acme', 'Friday')).toBe(
      'acme invoice pay|acme|friday'
    )
  })

  it('treats null whoTo/byWhen as empty', () => {
    expect(buildSignature('Pay Acme invoice', null, null)).toBe('acme invoice pay||')
  })

  it('matches wording drift via normalization', () => {
    expect(buildSignature('Send Alice the X', 'Alice', null)).toBe(
      buildSignature('Send the X to Alice', 'Alice', null)
    )
  })
})

function createRecord(payload: CreatePayload | ModifyPayload): ProposalRecord {
  return {
    id: 'p1',
    type: payload.kind === 'create' ? 'create' : 'modify',
    targetTaskIds: [],
    sourceCaptureId: null,
    sourceAgent: 'commitment-detector',
    status: 'pending',
    currentPayload: payload,
    currentVersion: 1,
    originSnapshot: null,
    createdAt: new Date().toISOString(),
    resolvedAt: null,
    resolvedBy: null,
  }
}

describe('signatureForRecord', () => {
  it('builds signature from create payload title + metadata', () => {
    const payload: CreatePayload = {
      kind: 'create',
      task: {
        title: 'Pay Acme invoice',
        status: 'inbox',
        tags: [],
        description: '',
        metadata: { ai_who_to: 'Acme', ai_by_when: 'Friday' },
      },
      traceback: { captureExcerpt: '', sourceChannel: 'screen_capture' },
    }
    expect(signatureForRecord(createRecord(payload))).toBe('acme invoice pay|acme|friday')
  })

  it('returns null for non-create payloads', () => {
    const payload: ModifyPayload = { kind: 'modify', taskId: 't1', diff: [] }
    expect(signatureForRecord(createRecord(payload))).toBeNull()
  })

  it('returns null when payload is missing', () => {
    const rec = createRecord({
      kind: 'create',
      task: { title: 'x', status: 'inbox', tags: [], description: '', metadata: {} },
      traceback: { captureExcerpt: '', sourceChannel: 'screen_capture' },
    })
    rec.currentPayload = null
    expect(signatureForRecord(rec)).toBeNull()
  })
})

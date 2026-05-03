/**
 * L0 pre-filter — fast, cheap regex check that decides whether a capture
 * is worth sending to the LLM proposer. The point is cost: most captures
 * are noise, so killing them with a regex saves $$ vs always calling LLM.
 *
 * Rule: a capture passes L0 iff at least one commitment-lexicon hit OR
 * one strong context hit (deadline word, mention keyword, money pattern).
 * False positives are fine — Proposer will say is_actionable=false for them.
 * False negatives are dangerous — we lose actionable items silently.
 *
 * Lexicons are union of EN + RU. Add words conservatively.
 */

const COMMITMENT_VERBS = [
  // EN
  "i'll",
  "i will",
  'i need to',
  'remind me',
  'follow up',
  'follow-up',
  'get back',
  'will send',
  'will reply',
  'will respond',
  'will pay',
  'will call',
  'will check',
  'will review',
  'have to',
  'should ',
  'must ',
  'todo',
  // RU verbs (1st person + imperative-ish + future)
  'сделаю',
  'сделать ',
  'переведу',
  'отправлю',
  'отвечу',
  'позвоню',
  'напишу',
  'напомнить',
  'напомни',
  'купить',
  'купи',
  'проверить',
  'проверю',
  'перезвонить',
  'перезвоню',
  'скину',
  'скинуть',
  'выслать',
  'отдам',
  'оплачу',
  'оплатить',
  'забронир',
  'нужно ',
  'надо ',
  'не забыть',
]

const DEADLINE_WORDS = [
  'today',
  'tomorrow',
  'tonight',
  'asap',
  'urgent',
  'eod',
  'deadline',
  'due',
  'by friday',
  'by monday',
  'by tuesday',
  'by wednesday',
  'by thursday',
  'by saturday',
  'by sunday',
  'next week',
  'this week',
  'сегодня',
  'завтра',
  'послезавтра',
  'срочно',
  'дедлайн',
  'крайний срок',
  'до пятницы',
  'до понедельника',
  'до вторника',
  'до среды',
  'до четверга',
  'до субботы',
  'до воскресенья',
  'на этой неделе',
  'на следующей неделе',
]

/** Money / payment patterns (USD/EUR/RUB explicit). */
const MONEY_REGEX = /\$\s?\d|€\s?\d|\d+\s?(?:руб|rub|usd|eur|долл)/i

/** Phone numbers may signal a callback / contact action. */
const PHONE_REGEX = /(?:\+?\d[\s\-]?){7,}/

export interface L0Result {
  pass: boolean
  reasons: string[]
}

/**
 * Returns whether the text passes L0. When pass=true, `reasons` lists
 * which lexicons matched — useful for debugging/calibration logs.
 */
export function l0Filter(text: string): L0Result {
  if (!text || text.length < 20) return { pass: false, reasons: ['too-short'] }

  const lower = text.toLowerCase()
  const reasons: string[] = []

  for (const verb of COMMITMENT_VERBS) {
    if (lower.includes(verb)) {
      reasons.push(`verb:${verb.trim()}`)
      break
    }
  }
  for (const word of DEADLINE_WORDS) {
    if (lower.includes(word)) {
      reasons.push(`deadline:${word.trim()}`)
      break
    }
  }
  if (MONEY_REGEX.test(text)) reasons.push('money')
  if (PHONE_REGEX.test(text)) reasons.push('phone')

  return { pass: reasons.length > 0, reasons }
}

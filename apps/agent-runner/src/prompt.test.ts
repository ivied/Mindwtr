import { describe, expect, it } from 'bun:test'
import { SYSTEM_APPEND, buildFirstPrompt } from './prompt'

const run = { taskId: 't1', taskTitle: 'Инвойсы HiQ: загрузить инвойс в Remote', taskDescription: '' }

describe('memory in the first prompt', () => {
  it('puts what memory knows right after the task, before the accesses', () => {
    const prompt = buildFirstPrompt(run, [], '# Что известно из памяти\n## Подтверждено пользователем — считай это верным\n- Инвойсы HiQ идут через PayPal')
    const at = (needle: string) => prompt.indexOf(needle)
    expect(at('# Задача из Inbox')).toBeLessThan(at('# Что известно из памяти'))
    expect(at('# Что известно из памяти')).toBeLessThan(at('# Подключённые доступы'))
    expect(prompt).toContain('Инвойсы HiQ идут через PayPal')
  })

  it('says so when memory found nothing, so the agent does not assume it was checked and empty of meaning', () => {
    expect(buildFirstPrompt(run)).toContain('по этой задаче память ничего не нашла')
  })

  it('tells the agent that confirmed facts outrank the task title and that the title is not a fact', () => {
    expect(SYSTEM_APPEND).toContain('Подтверждено пользователем')
    expect(SYSTEM_APPEND).toContain('Заголовок задачи — не факт')
    expect(SYSTEM_APPEND).toContain('lessons')
  })
})

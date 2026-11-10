import { describe, expect, it } from 'vitest';
import type { AgentRun, AgentRunEvent } from '../../lib/agent-runs-client';
import {
    buildSteps,
    changeRows,
    elapsedMs,
    formatElapsed,
    laneOf,
    laneOfRun,
    lastSaid,
    needsYou,
    nowLine,
    queuedLine,
    resumeCommand,
    runnerOnline,
    usageLine,
    waitsOnProvision,
} from './model';

const run = (over: Partial<AgentRun> = {}): AgentRun => ({
    id: 'r1',
    kind: 'task',
    parentRunId: null,
    taskId: 't1',
    taskTitle: 'Продлить домен',
    taskDescription: '',
    state: 'running',
    sessionId: null,
    cwd: null,
    pending: null,
    result: null,
    costUsd: 0,
    durationMs: 0,
    turnStartedAt: null,
    stepCount: 0,
    claimedBy: null,
    heartbeatAt: null,
    error: null,
    createdAt: '2026-11-09T12:00:00.000Z',
    updatedAt: '2026-11-09T12:00:00.000Z',
    ...over,
});

const ev = (seq: number, kind: AgentRunEvent['kind'], payload: Record<string, unknown>): AgentRunEvent => ({
    runId: 'r1',
    seq,
    ts: '2026-11-09T12:00:00.000Z',
    kind,
    payload,
});

describe('lanes and decision order', () => {
    it('puts every parked state in the "you" lane and hides closed runs', () => {
        expect(laneOf('queued')).toBe('queued');
        expect(laneOf('running')).toBe('running');
        for (const s of ['question', 'confirm', 'done', 'stopped', 'error'] as const) expect(laneOf(s)).toBe('you');
        expect(laneOf('closed')).toBeNull();
    });

    it('offers blockers before finished work, oldest first within a kind', () => {
        const order = needsYou([
            run({ id: 'done', state: 'done' }),
            run({ id: 'q-new', state: 'question', updatedAt: '2026-11-09T13:00:00.000Z' }),
            run({ id: 'working', state: 'running' }),
            run({ id: 'confirm', state: 'confirm' }),
            run({ id: 'q-old', state: 'question', updatedAt: '2026-11-09T11:00:00.000Z' }),
        ]).map((r) => r.id);
        expect(order).toEqual(['q-old', 'q-new', 'confirm', 'done']);
    });
});

describe('access requests', () => {
    const asking = run({
        id: 'ask',
        state: 'confirm',
        pending: { kind: 'access', service: 'Remote', purpose: 'остаток отпуска', scope: 'read', provisionRunId: null },
    });
    const connecting = run({
        id: 'wait',
        state: 'confirm',
        pending: { kind: 'access', service: 'Remote', purpose: '', scope: 'read', provisionRunId: 'p1' },
    });
    const key = run({
        id: 'key',
        kind: 'provision',
        state: 'question',
        pending: { kind: 'secret', name: 'REMOTE_API_TOKEN', label: 'API-токен Remote', hint: '', url: '' },
    });

    it('asks the user to decide, but not while another agent is connecting the access', () => {
        expect(needsYou([asking, connecting, key]).map((r) => r.id)).toEqual(['key', 'ask']);
        expect(laneOfRun(asking)).toBe('you');
        expect(laneOfRun(connecting)).toBe('queued');
        expect(waitsOnProvision(connecting)).toBe(true);
    });

    it('says in one line what is needed', () => {
        expect(nowLine(asking)).toBe('Просит доступ: Remote (только чтение)');
        expect(nowLine(connecting)).toBe('Доступ к «Remote» подключается');
        expect(nowLine(key)).toBe('Нужен ключ: API-токен Remote');
        const signIn = run({
            kind: 'provision',
            state: 'question',
            pending: { kind: 'oauth', name: 'remote', label: 'Remote.com', url: 'https://x.example/a', state: 's'.repeat(20), hint: '', local: false },
        });
        expect(nowLine(signIn)).toBe('Нужен вход: Remote.com');
        expect(needsYou([signIn])).toHaveLength(1);
    });
});

describe('daily limit', () => {
    it('tells a held run apart from one waiting for a free agent', () => {
        const fresh = run({ state: 'queued' });
        expect(queuedLine(fresh)).toBe('Ждёт свободного агента');
        expect(queuedLine(fresh, 'quota')).toContain('недельной нормы');
        expect(nowLine(fresh, [], 'budget')).toContain('стартует завтра');
        // A run that already started is not held by the limit.
        expect(queuedLine(run({ state: 'queued', sessionId: 's' }), 'quota')).toContain('Продолжит');
    });

    it('shows the share of the weekly quota when it is metered', () => {
        expect(usageLine({ spentTodayUsd: 21.99, dailyBudgetUsd: 100, quotaTodayPct: 3.6, dailyQuotaPct: 10 })).toBe(
            'сегодня 4% из 10% недельной нормы · ≈$21.99',
        );
        expect(usageLine({ spentTodayUsd: 2, dailyBudgetUsd: 15 })).toBe('сегодня $2.00 из $15.00');
    });
});

describe('timers', () => {
    it('counts the turn in flight against the server clock', () => {
        const now = Date.parse('2026-11-09T12:01:05.000Z');
        const r = run({ durationMs: 30_000, turnStartedAt: '2026-11-09T12:01:00.000Z' });
        expect(elapsedMs(r, now)).toBe(35_000);
        expect(elapsedMs({ ...r, state: 'done' }, now)).toBe(30_000);
        expect(formatElapsed(35_000)).toBe('0:35');
        expect(formatElapsed(3_725_000)).toBe('1:02:05');
    });

    it('treats a runner that stopped polling as offline', () => {
        const now = Date.parse('2026-11-09T12:01:00.000Z');
        expect(runnerOnline('2026-11-09T12:00:50.000Z', now)).toBe(true);
        expect(runnerOnline('2026-11-09T12:00:10.000Z', now)).toBe(false);
        expect(runnerOnline(null, now)).toBe(false);
    });
});

describe('work log', () => {
    const events = [
        ev(1, 'say', { text: 'Ищу тред' }),
        ev(2, 'tool', { toolUseId: 'a', tool: 'Shell', call: 'ls', input: '{}' }),
        ev(3, 'tool', { toolUseId: 'b', tool: 'Субагент', call: 'логи' }),
        ev(4, 'say', { text: 'читаю логи', parent: 'b' }),
        ev(5, 'tool_result', { toolUseId: 'a', output: 'a.txt', isError: false }),
        ev(6, 'user', { text: 'проверь ещё Slack' }),
    ];

    it('joins results to their call and keeps unanswered calls waiting', () => {
        const steps = buildSteps(events);
        expect(steps.map((s) => s.kind)).toEqual(['say', 'tool', 'tool', 'say', 'user']);
        expect(steps[1]).toMatchObject({ tool: 'Shell', output: 'a.txt', waiting: false });
        expect(steps[2]).toMatchObject({ tool: 'Субагент', waiting: true });
        expect(steps[3]!.nested).toBe(true);
    });

    it('notes screenshots sent with a message', () => {
        const steps = buildSteps([
            ev(1, 'user', { text: 'вот ошибка', images: [{ id: 'a' }, { id: 'b' }] }),
            ev(2, 'user', { text: '', images: [{ id: 'c' }] }),
        ]);
        expect(steps.map((s) => s.text)).toEqual(['вот ошибка [изображений: 2]', '[изображений: 1]']);
    });

    it('shows the latest step for a working run and ignores subagent chatter as context', () => {
        const steps = buildSteps(events.slice(0, 4));
        expect(nowLine(run(), buildSteps(events.slice(0, 2)))).toBe('Shell: ls');
        expect(lastSaid(steps)).toBe('Ищу тред');
    });
});

describe('collapsed line and result rows', () => {
    it('says what a parked run needs', () => {
        expect(nowLine(run({ state: 'question', pending: { kind: 'question', question: 'На сколько лет?', options: [] } }))).toBe(
            'На сколько лет?',
        );
        expect(
            nowLine(run({ state: 'confirm', pending: { kind: 'confirm', action: 'Отправить', target: '#deals', draft: '' } })),
        ).toBe('Отправить → #deals');
        expect(nowLine(run({ state: 'stopped', error: 'runner lost' }))).toBe('Раннер перестал отвечать');
        expect(nowLine(run({ state: 'queued', sessionId: 's' }))).toContain('Продолжит');
    });

    it('lists only the changes the agent proposed', () => {
        const r = run({
            state: 'done',
            result: { summary: 'ок', evidence: [], changes: { status: 'waiting', contexts: ['@покупки'] } },
        });
        expect(changeRows(r)).toEqual([
            ['Статус', 'Inbox → Ожидание'],
            ['Контексты', '@покупки'],
        ]);
        expect(changeRows(run())).toEqual([]);
    });

    it('builds the terminal command from the session and its directory', () => {
        expect(resumeCommand(run())).toBeNull();
        expect(resumeCommand(run({ sessionId: 'abc', cwd: '/Users/me' }))).toBe('cd /Users/me && claude --resume abc');
    });
});

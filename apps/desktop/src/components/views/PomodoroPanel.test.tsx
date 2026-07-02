import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { useTaskStore, type Task } from '@mindwtr/core';
import { LanguageProvider } from '../../contexts/language-context';
import { DESKTOP_POMODORO_SESSION_STORAGE_KEY, PomodoroPanel } from './PomodoroPanel';
const nowIso = '2026-07-01T12:00:00.000Z';
const task: Task = {
    id: 'task-1',
    title: 'Write RFC reply',
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: nowIso,
    updatedAt: nowIso,
};

const renderPanel = () => render(
    <LanguageProvider>
        <PomodoroPanel tasks={[task]} />
    </LanguageProvider>
);

describe('PomodoroPanel desktop persistence', () => {
    beforeEach(() => {
        window.localStorage.clear();
        useTaskStore.setState({
            tasks: [task],
            _allTasks: [task],
            settings: {
                gtd: {
                    pomodoro: {
                        linkTask: true,
                    },
                },
            },
            error: null,
            highlightTaskId: null,
        });
    });

    it('restores device-local timer state and task history from local storage', () => {
        window.localStorage.setItem(DESKTOP_POMODORO_SESSION_STORAGE_KEY, JSON.stringify({
            durations: { focusMinutes: 25, breakMinutes: 5 },
            timerState: {
                phase: 'focus',
                remainingSeconds: 1200,
                isRunning: false,
                completedFocusSessions: 0,
            },
            selectedTaskId: 'task-1',
            updatedAtMs: Date.now(),
            sessionHistory: {
                totalCompletedFocusSessions: 4,
                completedFocusSessionsByTaskId: {
                    'task-1': 2,
                },
            },
        }));

        const { getByLabelText, getByText } = renderPanel();

        expect(getByText('Focus sessions completed: 4')).toBeInTheDocument();
        expect((getByLabelText('Timer task') as HTMLSelectElement).value).toBe('task-1');
    });

    it('persists timer state changes to device-local storage', () => {
        const { getByRole } = renderPanel();

        fireEvent.click(getByRole('button', { name: 'Start' }));

        const stored = JSON.parse(window.localStorage.getItem(DESKTOP_POMODORO_SESSION_STORAGE_KEY) ?? '{}');
        expect(stored.timerState).toMatchObject({
            phase: 'focus',
            isRunning: true,
            completedFocusSessions: 0,
        });
        expect(stored.sessionHistory).toEqual({
            totalCompletedFocusSessions: 0,
            completedFocusSessionsByTaskId: {},
        });
    });
});

import { useCallback, useState } from 'react';
import { Check, RotateCcw, X } from 'lucide-react';
import { useTaskStore } from '@mindwtr/core';
import type { Task } from '@mindwtr/core';
import { reportError } from '../lib/report-error';

/**
 * Action bar shown under @ai-agent tasks sitting in ai-stage:review or
 * ai-stage:error. Closes the human-in-the-loop: the user either accepts the
 * agent's result, sends it back with feedback for another round, or rejects
 * the whole task.
 *
 * All three are plain task mutations — they sync to Mindwtr cloud, which
 * fires the task-changes webhook, which OpenClaw reads on its next cron tick.
 * The feedback is appended to the description as a "## User feedback" block
 * so the agent sees the full conversation when it re-runs.
 */

const STAGE_PREFIX = 'ai-stage:';
const LOCK_PREFIX = 'locked-by:';
const ROUND_PREFIX = 'ai-round:';

function stripAgentRuntimeTags(tags: string[]): string[] {
    return tags.filter(
        (t) => !t.startsWith(STAGE_PREFIX) && !t.startsWith(LOCK_PREFIX) && !t.startsWith(ROUND_PREFIX)
    );
}

function readRound(tags: string[]): number {
    for (const t of tags) {
        if (t.startsWith(ROUND_PREFIX)) {
            const n = Number(t.slice(ROUND_PREFIX.length));
            if (Number.isFinite(n)) return n;
        }
    }
    return 0;
}

export function AiAgentReviewControls({ task }: { task: Task }) {
    const updateTask = useTaskStore((s) => s.updateTask);
    const [feedbackMode, setFeedbackMode] = useState(false);
    const [feedback, setFeedback] = useState('');
    const [busy, setBusy] = useState(false);

    const tags = task.tags ?? [];
    const isError = tags.includes('ai-stage:error');
    const round = readRound(tags);

    const onAccept = useCallback(async () => {
        setBusy(true);
        try {
            // Accept → mark done immediately, strip the agent runtime tags so
            // the card leaves the lane. assignedTo stays for provenance.
            await updateTask(task.id, {
                status: 'done',
                tags: stripAgentRuntimeTags(tags),
            });
        } catch (err) {
            reportError('Failed to accept AI task', err);
        } finally {
            setBusy(false);
        }
    }, [task.id, tags, updateTask]);

    const onRedo = useCallback(async () => {
        setBusy(true);
        try {
            const fb = feedback.trim();
            const stamp = new Date().toISOString();
            const note = fb || '(redo requested — no specific notes)';
            const description =
                (task.description ?? '') + `\n\n## User feedback (${stamp})\n${note}`;
            await updateTask(task.id, {
                description,
                tags: [...stripAgentRuntimeTags(tags), 'ai-stage:queued', `ai-round:${round + 1}`],
            });
            setFeedback('');
            setFeedbackMode(false);
        } catch (err) {
            reportError('Failed to requeue AI task', err);
        } finally {
            setBusy(false);
        }
    }, [task.id, task.description, tags, feedback, round, updateTask]);

    const onReject = useCallback(async () => {
        setBusy(true);
        try {
            await updateTask(task.id, {
                status: 'archived',
                tags: stripAgentRuntimeTags(tags),
            });
        } catch (err) {
            reportError('Failed to reject AI task', err);
        } finally {
            setBusy(false);
        }
    }, [task.id, tags, updateTask]);

    return (
        <div
            className="border-t border-amber-500/20 bg-amber-500/5 px-3 py-2"
            onClick={(e) => e.stopPropagation()}
        >
            {feedbackMode ? (
                <div className="space-y-2">
                    <textarea
                        autoFocus
                        value={feedback}
                        onChange={(e) => setFeedback(e.target.value)}
                        placeholder="What should the agent do differently? (optional)"
                        rows={2}
                        className="w-full resize-none rounded border border-border bg-background px-2 py-1 text-xs"
                    />
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={onRedo}
                            disabled={busy}
                            className="inline-flex items-center gap-1 rounded bg-amber-600 px-2 py-0.5 text-xs text-white hover:bg-amber-700 disabled:opacity-50"
                        >
                            <RotateCcw className="h-3 w-3" /> Send back to agent
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                setFeedbackMode(false);
                                setFeedback('');
                            }}
                            disabled={busy}
                            className="rounded border border-border px-2 py-0.5 text-xs hover:bg-muted disabled:opacity-50"
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            ) : (
                <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">
                        {isError ? 'Agent failed' : 'Agent finished'}
                        {round > 0 ? ` · round ${round + 1}` : ''}
                    </span>
                    <span className="flex-1" />
                    <button
                        type="button"
                        onClick={onAccept}
                        disabled={busy}
                        title="Accept the result and mark the task done"
                        className="inline-flex items-center gap-1 rounded bg-emerald-600 px-2 py-0.5 text-xs text-white hover:bg-emerald-700 disabled:opacity-50"
                    >
                        <Check className="h-3 w-3" /> Accept
                    </button>
                    <button
                        type="button"
                        onClick={() => setFeedbackMode(true)}
                        disabled={busy}
                        title="Send back to the agent with feedback for another round"
                        className="inline-flex items-center gap-1 rounded border border-amber-500/50 px-2 py-0.5 text-xs text-amber-700 hover:bg-amber-500/10 dark:text-amber-300 disabled:opacity-50"
                    >
                        <RotateCcw className="h-3 w-3" /> Redo
                    </button>
                    <button
                        type="button"
                        onClick={onReject}
                        disabled={busy}
                        title="Reject — archive the task"
                        className="inline-flex items-center gap-1 rounded border border-border px-2 py-0.5 text-xs hover:bg-muted disabled:opacity-50"
                    >
                        <X className="h-3 w-3" /> Reject
                    </button>
                </div>
            )}
        </div>
    );
}

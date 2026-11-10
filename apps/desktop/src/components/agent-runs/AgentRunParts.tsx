/**
 * Building blocks of the Inbox agent runs zone: state chip, the terminal-like
 * work log, and the action block (answer / confirm / accept / message).
 */

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, ImagePlus, KeyRound, Loader2, Play, Square, X } from 'lucide-react';
import type { AccessScope, AgentRun, AgentRunState, HoldReason, ReplyImage, ReplyKind } from '../../lib/agent-runs-client';
import { STATE_LABEL, accessKindLabel, changeRows, queuedLine, scopeLabel, type LogStep } from './model';
import { cn } from '../../lib/utils';
import { MAX_REPLY_IMAGES, imageFiles, prepareImage, type PickedImage } from './images';

export const TONE: Record<AgentRunState, { text: string; bg: string; dot: string; border: string }> = {
    queued: { text: 'text-muted-foreground', bg: 'bg-muted', dot: 'bg-muted-foreground', border: 'border-border' },
    running: { text: 'text-primary', bg: 'bg-primary/10', dot: 'bg-primary', border: 'border-primary/40' },
    question: {
        text: 'text-amber-700 dark:text-amber-300',
        bg: 'bg-amber-500/10',
        dot: 'bg-amber-500',
        border: 'border-amber-500/50',
    },
    confirm: {
        text: 'text-violet-700 dark:text-violet-300',
        bg: 'bg-violet-500/10',
        dot: 'bg-violet-500',
        border: 'border-violet-500/50',
    },
    done: {
        text: 'text-emerald-700 dark:text-emerald-300',
        bg: 'bg-emerald-500/10',
        dot: 'bg-emerald-500',
        border: 'border-emerald-500/40',
    },
    stopped: { text: 'text-red-700 dark:text-red-300', bg: 'bg-red-500/10', dot: 'bg-red-500', border: 'border-red-500/40' },
    error: { text: 'text-red-700 dark:text-red-300', bg: 'bg-red-500/10', dot: 'bg-red-500', border: 'border-red-500/40' },
    closed: { text: 'text-muted-foreground', bg: 'bg-muted', dot: 'bg-muted-foreground', border: 'border-border' },
};

export function StateChip({ state }: { state: AgentRunState }) {
    const tone = TONE[state];
    return (
        <span
            className={cn(
                'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold',
                tone.text,
                tone.bg,
            )}
        >
            <span
                className={cn(
                    'h-1.5 w-1.5 rounded-full',
                    tone.dot,
                    state === 'running' && 'animate-pulse motion-reduce:animate-none',
                )}
            />
            {STATE_LABEL[state]}
        </span>
    );
}

/** Terminal-like log of what the agent did. Sticks to the bottom while it grows. */
export function AgentRunLog({ steps, running, className }: { steps: LogStep[]; running: boolean; className?: string }) {
    const ref = useRef<HTMLDivElement>(null);
    const stick = useRef(true);

    useEffect(() => {
        const el = ref.current;
        if (el && stick.current) el.scrollTop = el.scrollHeight;
    }, [steps.length, running]);

    return (
        <div
            ref={ref}
            onScroll={(e) => {
                const el = e.currentTarget;
                stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
            }}
            className={cn(
                'flex flex-col gap-2 overflow-auto bg-muted/40 px-3 py-3 font-mono text-[12px] leading-relaxed',
                className,
            )}
        >
            {steps.length === 0 && !running ? (
                <div className="text-muted-foreground">Прогон ещё не начался.</div>
            ) : null}
            {steps.map((s) => (
                <LogLine key={s.seq} step={s} />
            ))}
            {running ? (
                <div className="pl-5">
                    <span className="inline-block h-3.5 w-1.5 animate-pulse bg-primary align-middle motion-reduce:animate-none" />
                </div>
            ) : null}
        </div>
    );
}

function LogLine({ step }: { step: LogStep }) {
    const nest = step.nested ? 'ml-2 border-l-2 border-violet-500/40 pl-2' : '';
    if (step.kind === 'tool') {
        return (
            <details className={cn('group min-w-0', nest)}>
                <summary className="flex cursor-pointer list-none gap-2 [&::-webkit-details-marker]:hidden">
                    <span
                        className={cn(
                            'shrink-0',
                            step.isError ? 'text-red-500' : 'text-primary',
                            step.waiting && 'animate-pulse motion-reduce:animate-none',
                        )}
                    >
                        ●
                    </span>
                    <span className="min-w-0 break-words">
                        <b className="font-semibold">{step.tool}</b>{' '}
                        <span className="text-muted-foreground">{step.call}</span>
                    </span>
                </summary>
                <div className="ml-5 mt-1 space-y-1 border-l-2 border-border pl-2 text-muted-foreground">
                    {step.input ? <pre className="whitespace-pre-wrap break-words">{step.input}</pre> : null}
                    {step.waiting ? (
                        <div>выполняется…</div>
                    ) : (
                        <pre className={cn('whitespace-pre-wrap break-words', step.isError && 'text-red-600 dark:text-red-400')}>
                            {step.output || '(пустой вывод)'}
                        </pre>
                    )}
                </div>
            </details>
        );
    }
    const mark =
        step.kind === 'user' ? '›' : step.kind === 'done' ? '✓' : step.kind === 'error' ? '✕' : '●';
    const color =
        step.kind === 'user'
            ? 'text-amber-700 dark:text-amber-300'
            : step.kind === 'done'
              ? 'text-emerald-700 dark:text-emerald-300'
              : step.kind === 'error'
                ? 'text-red-600 dark:text-red-400'
                : '';
    return (
        <div className={cn('flex min-w-0 gap-2', color, nest)}>
            <span className={cn('shrink-0', step.kind === 'say' && 'text-muted-foreground')}>{mark}</span>
            <span className="min-w-0 whitespace-pre-wrap break-words">{step.text}</span>
        </div>
    );
}

function MessageForm({
    placeholder,
    button,
    disabled,
    onSubmit,
}: {
    placeholder: string;
    button: string;
    disabled: boolean;
    onSubmit: (text: string, images: ReplyImage[]) => void;
}) {
    const [text, setText] = useState('');
    const [images, setImages] = useState<PickedImage[]>([]);
    const [problem, setProblem] = useState('');
    const fileRef = useRef<HTMLInputElement>(null);
    const imagesRef = useRef(images);
    imagesRef.current = images;
    useEffect(() => () => imagesRef.current.forEach((i) => URL.revokeObjectURL(i.preview)), []);

    const add = async (files: File[]) => {
        if (!files.length) return;
        const room = MAX_REPLY_IMAGES - imagesRef.current.length;
        setProblem(files.length > room ? `Не больше ${MAX_REPLY_IMAGES} изображений в одном сообщении.` : '');
        try {
            const picked = await Promise.all(files.slice(0, Math.max(0, room)).map(prepareImage));
            setImages((prev) => [...prev, ...picked]);
        } catch {
            setProblem('Не удалось прочитать изображение.');
        }
    };
    const drop = (index: number) =>
        setImages((prev) => {
            const gone = prev[index];
            if (gone) URL.revokeObjectURL(gone.preview);
            return prev.filter((_, i) => i !== index);
        });
    const submit = (e: FormEvent) => {
        e.preventDefault();
        const value = text.trim();
        if (!value && !images.length) return;
        onSubmit(value, images);
        images.forEach((i) => URL.revokeObjectURL(i.preview));
        setText('');
        setImages([]);
        setProblem('');
    };
    return (
        <form
            onSubmit={submit}
            className="flex flex-col gap-2"
            onDragOver={(e) => {
                if (e.dataTransfer.types.includes('Files')) e.preventDefault();
            }}
            onDrop={(e) => {
                const files = imageFiles(e.dataTransfer);
                if (!files.length) return;
                e.preventDefault();
                void add(files);
            }}
        >
            {images.length ? (
                <ul className="flex flex-wrap gap-2">
                    {images.map((img, i) => (
                        <li key={img.preview} className="relative">
                            <img
                                src={img.preview}
                                alt={img.name}
                                className="h-16 w-24 rounded-md border border-border object-cover"
                            />
                            <button
                                type="button"
                                aria-label={`Убрать изображение ${img.name}`}
                                onClick={() => drop(i)}
                                className="absolute -right-1.5 -top-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full border border-border bg-background text-muted-foreground hover:text-foreground"
                            >
                                <X className="h-3 w-3" />
                            </button>
                        </li>
                    ))}
                </ul>
            ) : null}
            <div className="flex flex-wrap gap-2">
                <input
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onPaste={(e) => {
                        const files = imageFiles(e.clipboardData);
                        if (!files.length) return;
                        e.preventDefault();
                        void add(files);
                    }}
                    placeholder={placeholder}
                    aria-label={placeholder}
                    className="min-w-0 flex-1 basis-48 rounded-md border border-input bg-background px-2.5 py-1.5 text-sm"
                />
                <input
                    ref={fileRef}
                    type="file"
                    accept="image/*"
                    multiple
                    hidden
                    onChange={(e) => {
                        void add(Array.from(e.target.files ?? []));
                        e.target.value = '';
                    }}
                />
                <button
                    type="button"
                    disabled={disabled}
                    title="Приложить скриншот (можно вставить из буфера или перетащить)"
                    aria-label="Приложить скриншот"
                    onClick={() => fileRef.current?.click()}
                    className="inline-flex items-center rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
                >
                    <ImagePlus className="h-4 w-4" />
                </button>
                <button
                    type="submit"
                    disabled={disabled || (!text.trim() && !images.length)}
                    className="rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50"
                >
                    {button}
                </button>
            </div>
            {problem ? <p className="text-xs text-red-700 dark:text-red-300">{problem}</p> : null}
        </form>
    );
}

const primaryBtn =
    'inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50';
const plainBtn =
    'inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50';

/** Password field for a key: the value goes straight to the server, never into the run's log. */
function SecretForm({ name, disabled, onSubmit }: { name: string; disabled: boolean; onSubmit: (value: string) => void }) {
    const [value, setValue] = useState('');
    const submit = (e: FormEvent) => {
        e.preventDefault();
        const v = value.trim();
        if (!v) return;
        onSubmit(v);
        setValue('');
    };
    return (
        <form onSubmit={submit} className="flex flex-wrap gap-2">
            <input
                type="password"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={name}
                aria-label={`Ключ ${name}`}
                autoComplete="off"
                spellCheck={false}
                className="min-w-0 flex-1 basis-48 rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-sm"
            />
            <button type="submit" disabled={disabled || !value.trim()} className={primaryBtn}>
                <KeyRound className="h-4 w-4" />
                Сохранить ключ
            </button>
        </form>
    );
}

/** Field for the address the browser ended on after a sign-in made on another device. */
function SignInUrlForm({ disabled, onSubmit }: { disabled: boolean; onSubmit: (url: string) => void }) {
    const [url, setUrl] = useState('');
    const submit = (e: FormEvent) => {
        e.preventDefault();
        const value = url.trim();
        if (!value) return;
        onSubmit(value);
        setUrl('');
    };
    return (
        <form onSubmit={submit} className="flex flex-wrap gap-2">
            <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                placeholder="http://127.0.0.1:…/callback?code=…"
                aria-label="Адрес из вкладки, открывшейся после входа"
                className="min-w-0 flex-1 basis-48 rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-xs"
            />
            <button type="submit" disabled={disabled || !url.trim()} className={plainBtn}>
                Готово
            </button>
        </form>
    );
}

export interface RunActionHandlers {
    onAccess: (decision: 'grant' | 'deny', scope?: AccessScope) => void;
    onSecret: (value: string) => void;
    onSignInUrl: (url: string) => void;
    onReply: (kind: ReplyKind, text?: string, images?: ReplyImage[]) => void;
    onStop: () => void;
    onAccept: (apply: boolean, lessons?: number[]) => void;
}

/** What the user can do with a run right now, by state. */
export function AgentRunActions({
    run,
    busy,
    onReply,
    onStop,
    onAccept,
    onAccess,
    onSecret,
    onSignInUrl,
    hold = null,
}: { run: AgentRun; busy: boolean; hold?: HoldReason | null } & RunActionHandlers) {
    // Lessons the user unticked on the result card; a new run starts with all of them kept.
    const [dropped, setDropped] = useState<ReadonlySet<number>>(new Set());
    useEffect(() => setDropped(new Set()), [run.id]);
    const lessons = run.result?.lessons ?? [];
    const kept = lessons.map((_, i) => i).filter((i) => !dropped.has(i));
    const tone = TONE[run.state];
    const frame = cn('flex flex-col gap-2.5 border-l-[3px] px-4 py-3', tone.border);
    const heading = cn('text-[11px] font-semibold uppercase tracking-wider', tone.text);

    if (run.state === 'question' && run.pending?.kind === 'secret') {
        const p = run.pending;
        return (
            <div className={frame}>
                <div className={heading}>Нужен ключ</div>
                <p className="text-base font-semibold leading-snug">{p.label}</p>
                {p.hint ? <p className="whitespace-pre-wrap text-sm text-muted-foreground">{p.hint}</p> : null}
                {p.url ? (
                    <a href={p.url} target="_blank" rel="noreferrer" className="break-all text-sm text-primary underline">
                        {p.url}
                    </a>
                ) : null}
                <SecretForm name={p.name} disabled={busy} onSubmit={onSecret} />
                <p className="text-xs text-muted-foreground">
                    Ключ сохранится на вашем Mac и будет доступен агентам как ${p.name}. В журнал прогона и в промпт он не
                    попадает.
                </p>
                <MessageForm
                    placeholder="Ключа нет или нужен другой способ"
                    button="Ответить"
                    disabled={busy}
                    onSubmit={(t, imgs) => onReply('answer', t, imgs)}
                />
            </div>
        );
    }

    if (run.state === 'question' && run.pending?.kind === 'oauth') {
        const p = run.pending;
        return (
            <div className={frame}>
                <div className={heading}>Нужен вход</div>
                <p className="text-base font-semibold leading-snug">{p.label}</p>
                {p.hint ? <p className="whitespace-pre-wrap text-sm text-muted-foreground">{p.hint}</p> : null}
                <div>
                    <a href={p.url} target="_blank" rel="noreferrer" className={primaryBtn}>
                        <KeyRound className="h-3.5 w-3.5" />
                        Войти в {p.label}
                    </a>
                </div>
                <p className="text-xs text-muted-foreground">
                    Вход откроется в новой вкладке. После него вкладка сообщит, что всё готово, и агент продолжит сам.
                    Токены сохранятся на вашем Mac у раннера и не зависят от аккаунта Claude.
                </p>
                {p.local ? (
                    <>
                        <p className="text-xs text-muted-foreground">
                            Этот сервис возвращает вход только на сам Mac с раннером. Если вы входите с другого
                            устройства, вкладка после входа покажет ошибку соединения — скопируйте её адрес целиком и
                            вставьте сюда.
                        </p>
                        <SignInUrlForm disabled={busy} onSubmit={onSignInUrl} />
                    </>
                ) : null}
                <MessageForm
                    placeholder="Войти не получается или нужен другой способ"
                    button="Ответить"
                    disabled={busy}
                    onSubmit={(t, imgs) => onReply('answer', t, imgs)}
                />
            </div>
        );
    }

    if (run.state === 'confirm' && run.pending?.kind === 'access') {
        const p = run.pending;
        if (p.provisionRunId) {
            return (
                <div className={frame}>
                    <p className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                        Доступ к «{p.service}» подключает отдельный агент. Задача продолжится, когда он закончит.
                    </p>
                    <div>
                        <button type="button" disabled={busy} className={plainBtn} onClick={() => onAccess('deny')}>
                            Не ждать, продолжить без доступа
                        </button>
                    </div>
                </div>
            );
        }
        return (
            <div className={frame}>
                <div className={heading}>Агент просит доступ</div>
                <p className="text-base font-semibold leading-snug">
                    {p.service} · {scopeLabel(p.scope)}
                </p>
                {p.purpose ? <p className="text-sm text-muted-foreground">{p.purpose}</p> : null}
                <div className="flex flex-wrap gap-2">
                    <button type="button" disabled={busy} className={primaryBtn} onClick={() => onAccess('grant', p.scope)}>
                        <KeyRound className="h-4 w-4" />
                        Подключить ({scopeLabel(p.scope)})
                    </button>
                    {p.scope === 'write' ? (
                        <button type="button" disabled={busy} className={plainBtn} onClick={() => onAccess('grant', 'read')}>
                            Только чтение
                        </button>
                    ) : null}
                    <button type="button" disabled={busy} className={plainBtn} onClick={() => onAccess('deny')}>
                        <X className="h-4 w-4" />
                        Не давать
                    </button>
                </div>
                <p className="text-xs text-muted-foreground">
                    Подключением займётся отдельный агент. Если понадобится ключ, он попросит его здесь же.
                </p>
            </div>
        );
    }

    if (run.state === 'done' && run.kind === 'provision') {
        const a = run.result?.access;
        return (
            <div className={frame}>
                <div className={heading}>{a ? 'Доступ подключён' : 'Доступ не подключён'}</div>
                <p className="whitespace-pre-wrap text-sm">{run.result?.summary ?? 'Агент завершил работу.'}</p>
                {a ? (
                    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
                        <dt className="text-muted-foreground">Доступ</dt>
                        <dd>
                            {a.name} · {accessKindLabel(a.kind)} · {scopeLabel(a.scope)}
                        </dd>
                        {a.hosts.length > 0 ? (
                            <>
                                <dt className="text-muted-foreground">Хосты</dt>
                                <dd className="break-words">{a.hosts.join(', ')}</dd>
                            </>
                        ) : null}
                        {a.notes ? (
                            <>
                                <dt className="text-muted-foreground">Как пользоваться</dt>
                                <dd className="whitespace-pre-wrap break-words">{a.notes}</dd>
                            </>
                        ) : null}
                    </dl>
                ) : null}
                {run.result && run.result.evidence.length > 0 ? (
                    <ul className="list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
                        {run.result.evidence.map((e, i) => (
                            <li key={i} className="break-words">
                                {e}
                            </li>
                        ))}
                    </ul>
                ) : null}
                <div className="flex flex-wrap gap-2">
                    <button type="button" disabled={busy} className={primaryBtn} onClick={() => onAccept(false)}>
                        <Check className="h-4 w-4" />
                        Понятно
                    </button>
                </div>
                <MessageForm
                    placeholder="Вернуть агенту с комментарием"
                    button="Вернуть"
                    disabled={busy}
                    onSubmit={(t, imgs) => onReply('message', t, imgs)}
                />
            </div>
        );
    }

    if (run.state === 'question' && run.pending?.kind === 'question') {
        return (
            <div className={frame}>
                <div className={heading}>Агент остановился и спрашивает</div>
                <p className="text-base font-semibold leading-snug">{run.pending.question}</p>
                {run.pending.options.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                        {run.pending.options.map((o) => (
                            <button key={o} type="button" disabled={busy} className={plainBtn} onClick={() => onReply('answer', o)}>
                                {o}
                            </button>
                        ))}
                    </div>
                ) : null}
                <MessageForm
                    placeholder="Или ответьте своими словами"
                    button="Ответить"
                    disabled={busy}
                    onSubmit={(t, imgs) => onReply('answer', t, imgs)}
                />
            </div>
        );
    }

    if (run.state === 'confirm' && run.pending?.kind === 'confirm') {
        return (
            <div className={frame}>
                <div className={heading}>Нужно подтверждение</div>
                <p className="text-base font-semibold leading-snug">{run.pending.action}</p>
                {run.pending.target ? <div className="text-xs text-muted-foreground">Куда: {run.pending.target}</div> : null}
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted px-3 py-2 font-sans text-sm">
                    {run.pending.draft}
                </pre>
                <div className="flex flex-wrap gap-2">
                    <button type="button" disabled={busy} className={primaryBtn} onClick={() => onReply('approve')}>
                        <Check className="h-4 w-4" />
                        Подтвердить
                    </button>
                    <button type="button" disabled={busy} className={plainBtn} onClick={() => onReply('reject')}>
                        <X className="h-4 w-4" />
                        Не делать
                    </button>
                </div>
                <MessageForm
                    placeholder="Попросить изменить"
                    button="Изменить"
                    disabled={busy}
                    onSubmit={(t, imgs) => onReply('message', t, imgs)}
                />
            </div>
        );
    }

    if (run.state === 'done') {
        const rows = changeRows(run);
        return (
            <div className={frame}>
                <div className={heading}>Результат</div>
                <p className="whitespace-pre-wrap text-sm">{run.result?.summary ?? 'Агент завершил работу.'}</p>
                {run.result && run.result.evidence.length > 0 ? (
                    <ul className="list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
                        {run.result.evidence.map((e, i) => (
                            <li key={i} className="break-words">
                                {e}
                            </li>
                        ))}
                    </ul>
                ) : null}
                {rows.length > 0 ? (
                    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
                        {rows.map(([k, v]) => (
                            <div key={k} className="contents">
                                <dt className="text-muted-foreground">{k}</dt>
                                <dd className="whitespace-pre-wrap break-words">{v}</dd>
                            </div>
                        ))}
                    </dl>
                ) : null}
                {lessons.length > 0 ? (
                    <fieldset className="flex flex-col gap-1.5 rounded-md border border-border px-3 py-2">
                        <legend className="px-1 text-xs font-medium text-muted-foreground">
                            Запомнить для следующих агентов
                        </legend>
                        {lessons.map((l, i) => (
                            <label key={i} className="flex items-start gap-2 text-sm">
                                <input
                                    type="checkbox"
                                    className="mt-0.5"
                                    checked={!dropped.has(i)}
                                    onChange={() =>
                                        setDropped((prev) => {
                                            const next = new Set(prev);
                                            if (next.has(i)) next.delete(i);
                                            else next.add(i);
                                            return next;
                                        })
                                    }
                                />
                                <span className="min-w-0 break-words">
                                    {l.statement}
                                    {l.entity ? <span className="text-muted-foreground"> · {l.entity}</span> : null}
                                </span>
                            </label>
                        ))}
                        <p className="text-xs text-muted-foreground">
                            Отмеченное сохранится в память как подтверждённое вами и будет важнее всего, что агенты
                            найдут сами.
                        </p>
                    </fieldset>
                ) : null}
                <div className="flex flex-wrap gap-2">
                    <button type="button" disabled={busy} className={primaryBtn} onClick={() => onAccept(true, kept)}>
                        <Check className="h-4 w-4" />
                        {rows.length > 0 ? 'Принять и применить' : 'Принять'}
                    </button>
                    <button type="button" disabled={busy} className={plainBtn} onClick={() => onAccept(false, kept)}>
                        Закрыть без изменений
                    </button>
                </div>
                <MessageForm
                    placeholder="Вернуть агенту с комментарием"
                    button="Вернуть"
                    disabled={busy}
                    onSubmit={(t, imgs) => onReply('message', t, imgs)}
                />
            </div>
        );
    }

    if (run.state === 'running') {
        return (
            <div className={frame}>
                <MessageForm
                    placeholder="Написать агенту (прочитает, когда закончит текущий ход)"
                    button="Отправить"
                    disabled={busy}
                    onSubmit={(t, imgs) => onReply('message', t, imgs)}
                />
                <div>
                    <button type="button" disabled={busy} className={plainBtn} onClick={onStop}>
                        <Square className="h-3.5 w-3.5" />
                        Остановить
                    </button>
                </div>
            </div>
        );
    }

    if (run.state === 'stopped' || run.state === 'error') {
        return (
            <div className={frame}>
                <div className={heading}>{run.state === 'error' ? 'Прогон завершился ошибкой' : 'Прогон остановлен'}</div>
                {run.error && run.error !== 'runner lost' ? <p className="text-sm text-muted-foreground">{run.error}</p> : null}
                <div className="flex flex-wrap gap-2">
                    <button type="button" disabled={busy} className={primaryBtn} onClick={() => onReply('resume')}>
                        <Play className="h-3.5 w-3.5" />
                        Продолжить
                    </button>
                    <button type="button" disabled={busy} className={plainBtn} onClick={() => onAccept(false)}>
                        Закрыть прогон
                    </button>
                </div>
                <MessageForm
                    placeholder="Продолжить с указанием"
                    button="Отправить"
                    disabled={busy}
                    onSubmit={(t, imgs) => onReply('message', t, imgs)}
                />
            </div>
        );
    }

    // queued
    const held = !run.sessionId && hold !== null;
    return (
        <div className={frame}>
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
                {held ? null : <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />}
                {queuedLine(run, hold)}.
            </p>
            <div>
                <button type="button" disabled={busy} className={plainBtn} onClick={onStop}>
                    <Square className="h-3.5 w-3.5" />
                    Убрать из очереди
                </button>
            </div>
        </div>
    );
}

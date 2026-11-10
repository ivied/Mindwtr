/**
 * "What the agents know from you": facts the user stated or confirmed. They
 * live in memory as confirmed facts and go into every run whose task mentions
 * the same project or person (general ones go into every run).
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { BookOpen, ChevronDown, ChevronUp, X } from 'lucide-react';
import { addKnowledge, listKnowledge, removeKnowledge, type KnowledgeItem } from '../../lib/agent-runs-client';

export function AgentKnowledge({ refresh }: { refresh: number }) {
    const [items, setItems] = useState<KnowledgeItem[]>([]);
    const [available, setAvailable] = useState(true);
    const [open, setOpen] = useState(false);
    const [statement, setStatement] = useState('');
    const [entity, setEntity] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            const res = await listKnowledge();
            setItems(res.items);
            setAvailable(res.available);
            setError(null);
        } catch (err) {
            setError((err as Error).message);
        }
    }, []);
    useEffect(() => {
        void load();
    }, [load, refresh]);

    const run = async (fn: () => Promise<unknown>) => {
        setBusy(true);
        try {
            await fn();
            await load();
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusy(false);
        }
    };
    const submit = (e: FormEvent) => {
        e.preventDefault();
        const text = statement.trim();
        if (text.length < 8) return;
        void run(async () => {
            await addKnowledge(text, entity.trim());
            setStatement('');
            setEntity('');
        });
    };

    if (!available) return null;
    return (
        <div className="border-t border-border">
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
                className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
            >
                {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                <BookOpen className="h-3.5 w-3.5" />
                Что агенты знают от вас · {items.length}
            </button>
            {open ? (
                <div className="flex flex-col gap-3 border-t border-border px-3 py-3">
                    <p className="text-sm text-muted-foreground">
                        Факты, которые вы сказали или подтвердили. Агент получает их в начале работы и считает верными:
                        они важнее заголовка задачи и всего, что он найдёт в переписке.
                    </p>
                    {items.length > 0 ? (
                        <ul className="flex flex-col divide-y divide-border">
                            {items.map((item) => (
                                <li key={item.id} className="flex items-start gap-3 py-2">
                                    <span className="min-w-0 flex-1 break-words text-sm">
                                        {item.statement}
                                        <span className="text-muted-foreground">
                                            {' '}
                                            · {item.entity ?? 'для всех задач'}
                                        </span>
                                    </span>
                                    <button
                                        type="button"
                                        disabled={busy}
                                        aria-label={`Убрать: ${item.statement}`}
                                        title="Убрать"
                                        onClick={() => void run(() => removeKnowledge(item.id))}
                                        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground hover:text-foreground disabled:opacity-50"
                                    >
                                        <X className="h-3.5 w-3.5" />
                                    </button>
                                </li>
                            ))}
                        </ul>
                    ) : null}
                    <form onSubmit={submit} className="flex flex-wrap gap-2">
                        <input
                            value={statement}
                            onChange={(e) => setStatement(e.target.value)}
                            placeholder="Инвойсы HiQ выставляются через PayPal, не через Remote"
                            aria-label="Факт для агентов"
                            className="min-w-0 flex-[3] basis-64 rounded-md border border-input bg-background px-2.5 py-1.5 text-sm"
                        />
                        <input
                            value={entity}
                            onChange={(e) => setEntity(e.target.value)}
                            placeholder="О чём: HiQ (можно пусто)"
                            aria-label="Проект, человек или сервис, к которому относится факт"
                            className="min-w-0 flex-1 basis-40 rounded-md border border-input bg-background px-2.5 py-1.5 text-sm"
                        />
                        <button
                            type="submit"
                            disabled={busy || statement.trim().length < 8}
                            className="rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50"
                        >
                            Запомнить
                        </button>
                    </form>
                    {error ? <p className="text-xs text-red-700 dark:text-red-300">{error}</p> : null}
                </div>
            ) : null}
        </div>
    );
}

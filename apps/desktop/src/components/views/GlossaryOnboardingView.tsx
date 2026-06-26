/**
 * Glossary Onboarding view — cold-start seeding of the decoder-ring glossary.
 *
 * "Scan my tasks" asks the AI Service to read the user's existing tasks and
 * propose shorthand it doesn't understand (project codenames, acronyms,
 * internal terms). The user then confirms (optionally editing the meaning),
 * marks it as a person, or rejects each candidate. Confirmed decodings feed the
 * KNOWN_GLOSSARY block the Proposer/Enricher use; rejected ones are remembered
 * so the same term is never re-proposed.
 *
 * This is the "pleybook with confirmations" surface: the LLM guesses, the user
 * approves/corrects/dismisses, and the decision sticks.
 */

import { useState, useEffect, useCallback } from 'react';
import { BookMarked, Loader2, Check, X, Pencil, RefreshCw } from 'lucide-react';
import { cn } from '../../lib/utils';
import {
    isGlossaryAvailable,
    scanOnboarding,
    listGlossary,
    confirmGlossary,
    rejectGlossary,
    type GlossaryCandidate,
    type GlossaryRecord,
    type GlossaryKind,
} from '../../lib/glossary-client';

const KINDS: GlossaryKind[] = ['project', 'term', 'technology', 'organization'];

export function GlossaryOnboardingView() {
    const available = isGlossaryAvailable();
    const [candidates, setCandidates] = useState<GlossaryCandidate[]>([]);
    const [confirmed, setConfirmed] = useState<GlossaryRecord[]>([]);
    const [scanning, setScanning] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [scannedTasks, setScannedTasks] = useState<number | null>(null);
    const [busySlug, setBusySlug] = useState<string | null>(null);

    const loadExisting = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const [cand, conf] = await Promise.all([
                listGlossary('candidate'),
                listGlossary('confirmed'),
            ]);
            setCandidates(
                cand.items.map((r) => ({
                    slug: r.slug,
                    term: r.term,
                    expansion: r.expansion,
                    kind: r.kind,
                    confidence: r.confidence,
                    mentionCount: r.mentionCount,
                    grade: r.expansion ? 'high' : 'needs_input',
                    evidence: '',
                })),
            );
            setConfirmed(conf.items);
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (available) void loadExisting();
        else setLoading(false);
    }, [available, loadExisting]);

    const onScan = useCallback(async () => {
        setScanning(true);
        setError(null);
        try {
            const res = await scanOnboarding();
            setScannedTasks(res.scannedTasks);
            setCandidates(res.candidates);
            // refresh confirmed counts after a scan (re-surfaced rows excluded)
            const conf = await listGlossary('confirmed');
            setConfirmed(conf.items);
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setScanning(false);
        }
    }, []);

    const onConfirm = useCallback(
        async (slug: string, input: { expansion: string; term: string; kind: GlossaryKind }) => {
            setBusySlug(slug);
            try {
                await confirmGlossary({ slug, ...input });
                setCandidates((prev) => prev.filter((c) => c.slug !== slug));
                const conf = await listGlossary('confirmed');
                setConfirmed(conf.items);
            } catch (err) {
                setError((err as Error).message);
            } finally {
                setBusySlug(null);
            }
        },
        [],
    );

    const onReject = useCallback(async (slug: string) => {
        setBusySlug(slug);
        try {
            await rejectGlossary(slug);
            setCandidates((prev) => prev.filter((c) => c.slug !== slug));
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusySlug(null);
        }
    }, []);

    if (!available) {
        return (
            <div className="max-w-2xl mx-auto py-16 text-center text-muted-foreground">
                <BookMarked className="w-10 h-10 mx-auto mb-4 opacity-40" />
                <p>AI Service не настроен (VITE_AI_SERVICE_URL / TOKEN).</p>
            </div>
        );
    }

    return (
        <div className="max-w-3xl mx-auto">
            <div className="flex items-start justify-between gap-4 mb-6">
                <div>
                    <h1 className="text-2xl font-semibold flex items-center gap-2">
                        <BookMarked className="w-6 h-6 text-primary" />
                        Onboarding словаря
                    </h1>
                    <p className="text-sm text-muted-foreground mt-1">
                        Просканируй задачи — ассистент предложит расшифровки сокращений и
                        кодовых имён. Подтверди, поправь или отклони каждое.
                    </p>
                    {scannedTasks !== null && (
                        <p className="text-xs text-muted-foreground mt-1">
                            Просмотрено задач: {scannedTasks} · подтверждено: {confirmed.length}
                        </p>
                    )}
                </div>
                <button
                    onClick={onScan}
                    disabled={scanning}
                    className={cn(
                        'inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium',
                        'bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50',
                    )}
                >
                    {scanning ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                    {scanning ? 'Сканирую…' : 'Сканировать задачи'}
                </button>
            </div>

            {error && (
                <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
                    {error}
                </div>
            )}

            {loading ? (
                <div className="py-16 text-center text-muted-foreground">
                    <Loader2 className="w-6 h-6 mx-auto animate-spin" />
                </div>
            ) : (
                <>
                    <section className="mb-8">
                        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">
                            На подтверждение ({candidates.length})
                        </h2>
                        {candidates.length === 0 ? (
                            <p className="text-sm text-muted-foreground">
                                Нет кандидатов. Нажми «Сканировать задачи».
                            </p>
                        ) : (
                            <div className="space-y-3">
                                {candidates.map((c) => (
                                    <CandidateCard
                                        key={c.slug}
                                        candidate={c}
                                        busy={busySlug === c.slug}
                                        onConfirm={onConfirm}
                                        onReject={onReject}
                                    />
                                ))}
                            </div>
                        )}
                    </section>

                    {confirmed.length > 0 && (
                        <section>
                            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">
                                Подтверждено ({confirmed.length})
                            </h2>
                            <div className="space-y-1.5">
                                {confirmed.map((r) => (
                                    <div
                                        key={r.slug}
                                        className="flex items-baseline gap-2 rounded-md border border-border/50 px-3 py-2 text-sm"
                                    >
                                        <span className="font-medium">{r.term}</span>
                                        {r.expansion && <span className="text-muted-foreground">= {r.expansion}</span>}
                                        <span className="ml-auto text-xs text-muted-foreground">{r.kind}</span>
                                    </div>
                                ))}
                            </div>
                        </section>
                    )}
                </>
            )}
        </div>
    );
}

interface CandidateCardProps {
    candidate: GlossaryCandidate;
    busy: boolean;
    onConfirm: (slug: string, input: { expansion: string; term: string; kind: GlossaryKind }) => void;
    onReject: (slug: string) => void;
}

function CandidateCard({ candidate, busy, onConfirm, onReject }: CandidateCardProps) {
    const [expansion, setExpansion] = useState(candidate.expansion);
    const [term, setTerm] = useState(candidate.term);
    const [kind, setKind] = useState<GlossaryKind>(candidate.kind);
    const [editingTerm, setEditingTerm] = useState(false);

    const needsInput = candidate.grade === 'needs_input';

    return (
        <div
            className={cn(
                'rounded-lg border px-4 py-3',
                needsInput ? 'border-amber-400/50 bg-amber-50/40 dark:bg-amber-950/10' : 'border-border/60',
            )}
        >
            <div className="flex items-center gap-2 mb-2">
                {editingTerm ? (
                    <input
                        value={term}
                        onChange={(e) => setTerm(e.target.value)}
                        className="rounded border border-border bg-background px-2 py-1 text-sm font-medium"
                        autoFocus
                        onBlur={() => setEditingTerm(false)}
                    />
                ) : (
                    <button
                        className="font-semibold text-base hover:underline inline-flex items-center gap-1"
                        onClick={() => setEditingTerm(true)}
                        title="Изменить термин"
                    >
                        {term}
                        <Pencil className="w-3 h-3 opacity-40" />
                    </button>
                )}
                <select
                    value={kind}
                    onChange={(e) => setKind(e.target.value as GlossaryKind)}
                    className="rounded border border-border bg-background px-1.5 py-0.5 text-xs"
                >
                    {KINDS.map((k) => (
                        <option key={k} value={k}>
                            {k}
                        </option>
                    ))}
                </select>
                {needsInput && (
                    <span className="text-xs text-amber-600 dark:text-amber-400">нужно пояснение</span>
                )}
                {typeof candidate.confidence === 'number' && (
                    <span className="ml-auto text-xs text-muted-foreground">
                        {Math.round(candidate.confidence * 100)}%
                    </span>
                )}
            </div>

            {candidate.evidence && (
                <p className="text-xs text-muted-foreground mb-2 italic">«{candidate.evidence}»</p>
            )}

            <input
                value={expansion}
                onChange={(e) => setExpansion(e.target.value)}
                placeholder={needsInput ? 'Что это значит?' : 'Расшифровка'}
                className="w-full rounded border border-border bg-background px-2.5 py-1.5 text-sm mb-3"
            />

            <div className="flex items-center gap-2">
                <button
                    onClick={() => onConfirm(candidate.slug, { expansion, term, kind })}
                    disabled={busy}
                    className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                    {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                    Подтвердить
                </button>
                <button
                    onClick={() => onReject(candidate.slug)}
                    disabled={busy}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
                >
                    <X className="w-3.5 h-3.5" />
                    Отклонить
                </button>
            </div>
        </div>
    );
}

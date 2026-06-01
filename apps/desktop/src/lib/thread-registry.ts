/**
 * Thread registry (desktop) — now sourced from ai-service (/v1/threads), which
 * scans ~/.claude/projects. No static copy lives here anymore; these are pure
 * helpers over a list the caller has already fetched via listThreads().
 */

import type { RegistryThread } from './proposals-client';

export type { RegistryThread };

export interface RegistryRepo {
    slug: string;
    label: string;
}

/** Case-insensitive search over alias / repo / summary, most-recent first. */
export function searchThreads(threads: RegistryThread[], query: string): RegistryThread[] {
    const q = query.trim().toLowerCase();
    const matched = q
        ? threads.filter(
              (t) =>
                  t.alias.toLowerCase().includes(q) ||
                  t.repoLabel.toLowerCase().includes(q) ||
                  t.summary.toLowerCase().includes(q)
          )
        : threads;
    return [...matched].sort((a, b) => b.lastTouched.localeCompare(a.lastTouched));
}

export function findThread(threads: RegistryThread[], sessionId: string): RegistryThread | undefined {
    return threads.find((t) => t.sessionId === sessionId);
}

/** Distinct repos present in the thread list, for the "new thread in…" options. */
export function reposFromThreads(threads: RegistryThread[]): RegistryRepo[] {
    const seen = new Map<string, string>();
    for (const t of threads) {
        if (t.repo === 'home') continue;
        if (!seen.has(t.repo)) seen.set(t.repo, t.repoLabel);
    }
    return [...seen.entries()].map(([slug, label]) => ({ slug, label }));
}

export function repoLabel(threads: RegistryThread[], slug: string): string {
    return threads.find((t) => t.repo === slug)?.repoLabel ?? slug;
}

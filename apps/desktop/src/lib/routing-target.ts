/**
 * Routing target — WHERE an @ai-agent task runs.
 *
 * The Enricher proposes a target and the user can override it (chip on the
 * card, or the "Send to agent" quick action). The target is carried as a
 * task tag so it rides the existing tag-based agent state machine
 * (`ai-stage:*`, `locked-by:*`, `ai-round:*`):
 *
 *   ai-target:openclaw            → OpenClaw worker (cloud, fresh context)
 *   ai-target:mac:<sessionId>     → resume a local Claude Code thread on the Mac
 *   ai-target:mac-new:<repoSlug>  → start a fresh Claude Code thread in <repo>
 *
 * Whichever worker (OpenClaw, or the local Mac executor) polls Mindwtr cloud
 * picks up only the tasks whose target matches it. No worker reaches into
 * another machine — they each claim their own.
 */

import { findThread, repoLabel, type RegistryThread } from './thread-registry';

export type RoutingTarget =
    | { kind: 'openclaw' }
    | { kind: 'mac-thread'; sessionId: string }
    | { kind: 'mac-new'; repo: string };

const TARGET_PREFIX = 'ai-target:';
const STAGE_PREFIX = 'ai-stage:';

export const AI_AGENT_ASSIGNEE = '@ai-agent';

export function parseRoutingTarget(tags: string[] | undefined): RoutingTarget | null {
    const raw = (tags ?? []).find((t) => t.startsWith(TARGET_PREFIX));
    if (!raw) return null;
    const body = raw.slice(TARGET_PREFIX.length);
    if (body === 'openclaw') return { kind: 'openclaw' };
    if (body.startsWith('mac-new:')) return { kind: 'mac-new', repo: body.slice('mac-new:'.length) };
    if (body.startsWith('mac:')) return { kind: 'mac-thread', sessionId: body.slice('mac:'.length) };
    return null;
}

export function targetToTag(target: RoutingTarget): string {
    switch (target.kind) {
        case 'openclaw':
            return `${TARGET_PREFIX}openclaw`;
        case 'mac-thread':
            return `${TARGET_PREFIX}mac:${target.sessionId}`;
        case 'mac-new':
            return `${TARGET_PREFIX}mac-new:${target.repo}`;
    }
}

export function targetsEqual(a: RoutingTarget | null, b: RoutingTarget | null): boolean {
    if (!a || !b) return a === b;
    if (a.kind !== b.kind) return false;
    if (a.kind === 'mac-thread' && b.kind === 'mac-thread') return a.sessionId === b.sessionId;
    if (a.kind === 'mac-new' && b.kind === 'mac-new') return a.repo === b.repo;
    return true;
}

/** Replace any existing routing target tag with the chosen one. */
export function withRoutingTarget(tags: string[] | undefined, target: RoutingTarget): string[] {
    const base = (tags ?? []).filter((t) => !t.startsWith(TARGET_PREFIX));
    return [...base, targetToTag(target)];
}

/** Tags for sending a fresh task into the agent lane (manual "Send to agent"). */
export function queueForAgentTags(
    tags: string[] | undefined,
    target: RoutingTarget = { kind: 'openclaw' }
): string[] {
    const base = (tags ?? []).filter(
        (t) => !t.startsWith(TARGET_PREFIX) && !t.startsWith(STAGE_PREFIX)
    );
    return [...base, `${STAGE_PREFIX}queued`, targetToTag(target)];
}

/** Short human label for the chip, e.g. "Mac · Upwork API" or "OpenClaw". */
export function routingTargetLabel(
    target: RoutingTarget | null,
    threads: RegistryThread[] = []
): string {
    if (!target) return 'Куда запустить?';
    switch (target.kind) {
        case 'openclaw':
            return 'OpenClaw';
        case 'mac-thread': {
            const thread = findThread(threads, target.sessionId);
            return thread ? `Mac · ${thread.alias}` : `Mac · #${target.sessionId.slice(0, 8)}`;
        }
        case 'mac-new':
            return `Mac · новый · ${repoLabel(threads, target.repo)}`;
    }
}

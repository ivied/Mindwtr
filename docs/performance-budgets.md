# Performance Budgets

Mindwtr uses generated large-store tests to catch performance regressions before users hit them. The suite collects no user telemetry.

## Command

Run the current budget suite from the repository root:

```bash
bun run test:perf
```

This runs:

- `packages/core/src/performance-large-store.test.ts`
- `apps/mobile/tests/large-store-performance.test.tsx`

The core suite generates stores with 1k, 10k, and 50k tasks, many projects, many sections, mixed statuses, due dates, start dates, tags, contexts, deleted records, and a project with many selected-project tasks.

## Core Budgets

Budgets are intentionally explicit and conservative. They should only change in PRs that explain the measured reason.

| Operation | 1k tasks | 10k tasks | 50k tasks | Growth Guard |
| --- | ---: | ---: | ---: | ---: |
| Project detail lookup and sort | 25ms | 90ms | 450ms | 50k <= 12x 10k |
| Project summary aggregation | 20ms | 70ms | 300ms | 50k <= 10x 10k |
| Focus derivation | 40ms | 500ms | 2500ms | 50k <= 12x 10k |
| Search/filter/sort derivation | 30ms | 130ms | 650ms | 50k <= 12x 10k |
| One-task normalized update | 20ms | 80ms | 350ms | 50k <= 10x 10k |

The absolute budgets catch obvious regressions. The growth guard catches bad scaling, especially O(n^2) patterns that may still pass on small datasets. Growth comparisons use a 5ms denominator floor so very fast 10k measurements do not fail only because of runner timing noise.

## When To Add A Budget

Add or update a budget when a PR touches a hot path:

- capture open or first keystroke readiness
- project detail opening
- Focus, Inbox, or Projects derivation
- search/filter/sort logic
- project/context/tag summaries
- task mutation or persistence
- large list rendering

Prefer core tests for pure derivation and platform tests for render or native-thread behavior. Release-mode profiling belongs in issue #649; this suite is the CI regression radar.

Related roadmap issues: #645, #646, #647, #648, #649.

#!/usr/bin/env bun
/**
 * One-off migration: legacy `proposal-ai` Mindwtr tasks → first-class Proposal
 * entities (type=create) + delete the original Mindwtr task.
 *
 * Why: the 2026-04-24 design represented proposals as inbox tasks tagged with
 * `proposal-ai` and prefixed with `[AI]`. Under the 2026-05-05 redesign,
 * proposals are a separate entity. This script back-fills any leftover legacy
 * tasks into the new model so users see them on the Proposals screen instead
 * of cluttering inbox.
 *
 * Usage:
 *   MINDWTR_CLOUD_URL=... MINDWTR_AUTH_TOKEN=... DATA_DIR=... \
 *     bun run scripts/migrate-legacy-proposals.ts [--dry-run] [--keep-tasks]
 *
 * Flags:
 *   --dry-run    print what would happen, don't write anything.
 *   --keep-tasks don't delete original Mindwtr tasks (useful for verification).
 */

import { join } from 'node:path'
import { MindwtrClient } from '../src/api/mindwtr-client'
import { ContextStore } from '../src/context-store/store'
import { ProposalStore } from '../src/proposal-store/store'
import type { CreatePayload } from '../src/proposal-store/payloads'

const PROPOSAL_TAG = 'proposal-ai'
const TITLE_PREFIX_RE = /^\[AI\]\s*/i

interface CliFlags {
  dryRun: boolean
  keepTasks: boolean
}

function parseFlags(argv: string[]): CliFlags {
  return {
    dryRun: argv.includes('--dry-run'),
    keepTasks: argv.includes('--keep-tasks'),
  }
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2))

  const cloudUrl = process.env.MINDWTR_CLOUD_URL ?? 'http://localhost:8787'
  const authToken = process.env.MINDWTR_AUTH_TOKEN ?? ''
  const dataDir = process.env.DATA_DIR ?? '/app/data'

  if (!authToken) {
    console.error('MINDWTR_AUTH_TOKEN is required')
    process.exit(1)
  }

  const mindwtr = new MindwtrClient({ baseUrl: cloudUrl, authToken })
  const contextStore = ContextStore.open({ dbPath: join(dataDir, 'context.db') })
  const store = new ProposalStore(contextStore.rawDb)

  console.log(
    `[migrate] cloud=${cloudUrl} dataDir=${dataDir} dry=${flags.dryRun} keepTasks=${flags.keepTasks}`
  )

  // Best-effort fetch: list inbox tasks (the cloud REST may not support tag
  // filter on listTasks, so we filter client-side).
  let tasks
  try {
    tasks = await mindwtr.listTasks({ status: 'inbox', limit: 1000 })
  } catch (err) {
    console.error('[migrate] listTasks failed:', (err as Error).message)
    process.exit(2)
  }

  const legacy = tasks.filter((t) => t.tags.includes(PROPOSAL_TAG))
  console.log(`[migrate] found ${legacy.length} legacy proposal-ai task(s)`)

  let migrated = 0
  let deleted = 0
  for (const task of legacy) {
    const cleanTitle = task.title.replace(TITLE_PREFIX_RE, '').trim()
    const cleanTags = task.tags.filter((t) => t !== PROPOSAL_TAG)

    const payload: CreatePayload = {
      kind: 'create',
      task: {
        title: cleanTitle,
        status: 'inbox',
        tags: cleanTags,
        description: task.description ?? '',
        metadata: {
          ai_origin: true,
          migrated_from_task_id: task.id,
        },
      },
      traceback: {
        captureExcerpt: '(migrated from legacy proposal-ai task; original capture unavailable)',
        sourceChannel: 'legacy_migration',
      },
    }

    if (flags.dryRun) {
      console.log(`[migrate]  · would migrate task ${task.id}: "${cleanTitle}"`)
      continue
    }

    const created = store.create({
      type: 'create',
      targetTaskIds: [],
      sourceAgent: 'commitment-detector',
      payload,
      summary: `Migrated from legacy task ${task.id}`,
    })
    store.audit({
      proposalId: created.id,
      event: 'created',
      actor: 'system',
      meta: { migrated_from_task_id: task.id },
    })
    migrated += 1

    if (!flags.keepTasks) {
      try {
        await mindwtr.deleteTask(task.id)
        deleted += 1
      } catch (err) {
        console.warn(
          `[migrate]   ! failed to delete legacy task ${task.id}: ${(err as Error).message}`
        )
      }
    }
    console.log(`[migrate]  ✓ task ${task.id} → proposal ${created.id}`)
  }

  console.log(
    `[migrate] done — migrated=${migrated} deleted=${deleted} skipped=${legacy.length - migrated}`
  )
  contextStore.close()
}

main().catch((err) => {
  console.error('[migrate] fatal:', err)
  process.exit(1)
})

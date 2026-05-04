/**
 * Notion → mindwtr import.
 *
 * Reads dumped Notion JSON from /tmp/notion-export/ and produces:
 *   migration/imported-app-data.json   AppData ready for PUT /v1/data
 *   migration/notion-mapping.json      notion_id ↔ mindwtr_id (incl. epic/subprojects)
 *   migration/import-summary.txt       counts + warnings
 *
 * Usage:
 *   bun run scripts/notion-import.ts          # dry-run, write files only
 *   bun run scripts/notion-import.ts --apply  # also PUT /v1/data to local cloud
 */

import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

// ---------- Paths ----------
const DUMP_DIR = '/tmp/notion-export';
const OUT_DIR = resolve(import.meta.dir, '..', 'migration');
const APP_DATA_PATH = resolve(OUT_DIR, 'imported-app-data.json');
const MAPPING_PATH = resolve(OUT_DIR, 'notion-mapping.json');
const SUMMARY_PATH = resolve(OUT_DIR, 'import-summary.txt');

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

// ---------- Notion DB IDs (from discovery) ----------
const DB_IDS = {
    Inbox: '20a64547-3b73-4c02-8804-91cf4c7e7e6b',
    Tasks: 'f73f7b25-3a7d-41f2-9b68-69c5b26101f0',
    Projects: 'dae453a4-371b-40d2-8b07-e6a18f0a499a',
    Areas: '90943d3d-5737-4a86-a062-08c4658d6ced',
    Someday: 'e2e3b203-6024-4dd4-9d77-ca80dbe8d602',
    Reference: 'f033d984-93c7-4bd4-aad7-1aa285d995f9',
    Archive: 'ade41855-2cac-4757-a4b6-646a8fe4e756',
} as const;

// One project gets active status by user instruction; the other 36 no-status → archived.
const NO_STATUS_KEEP_ACTIVE = new Set<string>([
    'SynapseTyepe Михаилу',
]);

// ---------- Notion property helpers ----------
type NotionPage = { id: string; url: string; created_time: string; last_edited_time: string; properties: Record<string, any>; archived?: boolean; in_trash?: boolean };

const titleText = (props: any, name = 'Name'): string => {
    const p = props[name] ?? props['Task'];
    if (!p || p.type !== 'title') return '';
    return (p.title || []).map((t: any) => t.plain_text || '').join('');
};
const richText = (props: any, name: string): string => {
    const p = props[name];
    if (!p || p.type !== 'rich_text') return '';
    return (p.rich_text || []).map((t: any) => t.plain_text || '').join('');
};
const selectName = (props: any, name: string): string | null => {
    const p = props[name];
    if (!p || p.type !== 'select' || !p.select) return null;
    return p.select.name || null;
};
const statusName = (props: any, name: string): string | null => {
    const p = props[name];
    if (!p || p.type !== 'status' || !p.status) return null;
    return p.status.name || null;
};
const checkboxVal = (props: any, name: string): boolean => {
    const p = props[name];
    return Boolean(p && p.type === 'checkbox' && p.checkbox);
};
const multiSelectNames = (props: any, name: string): string[] => {
    const p = props[name];
    if (!p || p.type !== 'multi_select') return [];
    return (p.multi_select || []).map((s: any) => s.name).filter(Boolean);
};
const relationIds = (props: any, name: string): string[] => {
    const p = props[name];
    if (!p || p.type !== 'relation') return [];
    return (p.relation || []).map((r: any) => r.id);
};
const dateStart = (props: any, name: string): string | null => {
    const p = props[name];
    if (!p || p.type !== 'date' || !p.date) return null;
    return p.date.start || null;
};
const peopleField = (props: any, name: string): Array<{ id: string; name?: string }> => {
    const p = props[name];
    if (!p || p.type !== 'people') return [];
    return (p.people || []).map((u: any) => ({ id: u.id, name: u.name }));
};
const urlField = (props: any, name: string): string | null => {
    const p = props[name];
    if (!p || p.type !== 'url') return null;
    return p.url || null;
};

// ---------- Output types (subset of mindwtr packages/core/src/types.ts) ----------
type TaskStatus = 'inbox' | 'next' | 'waiting' | 'someday' | 'reference' | 'done' | 'archived';
type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';
type AttachmentKind = 'file' | 'link';
interface Attachment { id: string; kind: AttachmentKind; title: string; uri: string; createdAt: string; updatedAt: string }
interface Area { id: string; name: string; color?: string; icon?: string; order: number; createdAt: string; updatedAt: string }
interface Project { id: string; title: string; status: 'active' | 'someday' | 'waiting' | 'archived'; color: string; order: number; tagIds: string[]; isSequential?: boolean; supportNotes?: string; attachments?: Attachment[]; dueDate?: string; areaId?: string; areaTitle?: string; createdAt: string; updatedAt: string }
interface Task { id: string; title: string; status: TaskStatus; priority?: TaskPriority; assignedTo?: string; startTime?: string; dueDate?: string; tags: string[]; contexts: string[]; description?: string; attachments?: Attachment[]; projectId?: string; areaId?: string; completedAt?: string; createdAt: string; updatedAt: string; order?: number; metadata?: Record<string, unknown> }

// ---------- Load dumps ----------
const loadRows = (name: keyof typeof DB_IDS): NotionPage[] => JSON.parse(readFileSync(`${DUMP_DIR}/rows-${name}.json`, 'utf-8'));

const rowsAreas = loadRows('Areas');
const rowsProjects = loadRows('Projects');
const rowsTasks = loadRows('Tasks');
const rowsInbox = loadRows('Inbox');
const rowsSomeday = loadRows('Someday');
const rowsReference = loadRows('Reference');
const rowsArchive = loadRows('Archive');
// Recurring intentionally skipped per user decision.

// ---------- Build Areas ----------
const PROJECT_COLOR_PALETTE = ['#6366F1', '#8B5CF6', '#EC4899', '#F59E0B', '#10B981', '#06B6D4', '#3B82F6', '#EF4444', '#84CC16', '#A855F7'];
const AREA_COLOR_PALETTE = ['#6366F1', '#10B981', '#F59E0B', '#EC4899', '#06B6D4', '#A855F7', '#EF4444', '#84CC16'];

const notionAreaToMindwtr = new Map<string, string>(); // notion_id -> mindwtr_id
const areas: Area[] = rowsAreas.map((row, idx) => {
    const id = randomUUID();
    notionAreaToMindwtr.set(row.id, id);
    const name = titleText(row.properties) || '<Untitled Area>';
    return {
        id, name,
        color: AREA_COLOR_PALETTE[idx % AREA_COLOR_PALETTE.length],
        order: idx,
        createdAt: row.created_time,
        updatedAt: row.last_edited_time,
    };
});

// ---------- Project status mapping ----------
const mapProjectStatus = (notionStatus: string | null, title: string, hasActiveTasks: boolean, hasDoneTasks: boolean): Project['status'] => {
    if (notionStatus === 'Completed') return 'archived';
    if (notionStatus === 'In Progress') return 'active';
    if (notionStatus === 'On Hold') return 'someday';
    // No status: per user decision
    if (NO_STATUS_KEEP_ACTIVE.has(title)) return 'active';
    return 'archived'; // 36 of 37 → archived
};

// ---------- First pass: build project task index for sequential & status decisions ----------
type TaskBucketCounts = { active: number; done: number; nextAction: number; emptyBucket: number };
const projectTaskCounts = new Map<string, TaskBucketCounts>();

for (const row of rowsTasks) {
    const isDone = checkboxVal(row.properties, 'Done');
    const bucket = selectName(row.properties, 'Bucket');
    for (const pid of relationIds(row.properties, 'Project')) {
        const counts = projectTaskCounts.get(pid) ?? { active: 0, done: 0, nextAction: 0, emptyBucket: 0 };
        if (isDone || bucket === 'Done') counts.done++;
        else {
            counts.active++;
            if (bucket === 'Next Action') counts.nextAction++;
            else if (bucket === null) counts.emptyBucket++;
        }
        projectTaskCounts.set(pid, counts);
    }
}

// ---------- Build Projects ----------
const notionProjectToMindwtr = new Map<string, string>();
const projects: Project[] = [];

// Sort by created_time so display order is stable
const projectsSorted = [...rowsProjects].sort((a, b) => a.created_time.localeCompare(b.created_time));

for (let idx = 0; idx < projectsSorted.length; idx++) {
    const row = projectsSorted[idx]!;
    const id = randomUUID();
    notionProjectToMindwtr.set(row.id, id);
    const title = titleText(row.properties) || '<Untitled Project>';
    const status = selectName(row.properties, 'Status');
    const counts = projectTaskCounts.get(row.id) ?? { active: 0, done: 0, nextAction: 0, emptyBucket: 0 };
    const finalStatus = mapProjectStatus(status, title, counts.active > 0, counts.done > 0);

    // Sequential: live project AND only-backlog pattern
    // "Only backlog" = no Next Action tasks AND ≥1 active task with empty bucket
    const isSequential = finalStatus === 'active' && counts.nextAction === 0 && counts.emptyBucket >= 1;

    const areaIds = relationIds(row.properties, 'Areas');
    const areaId = areaIds.length > 0 ? notionAreaToMindwtr.get(areaIds[0]!) : undefined;
    const areaTitle = areaId ? areas.find(a => a.id === areaId)?.name : undefined;

    const dueDate = dateStart(row.properties, 'Deadline') ?? undefined;
    const successCriteria = richText(row.properties, 'Success criteria');
    const notes = richText(row.properties, 'Notes');
    const supportNotesParts = [successCriteria && `Success criteria: ${successCriteria}`, notes].filter(Boolean);
    const supportNotes = supportNotesParts.length ? supportNotesParts.join('\n\n') : undefined;

    const attachments: Attachment[] = [{
        id: randomUUID(), kind: 'link', title: 'Notion original', uri: row.url,
        createdAt: row.created_time, updatedAt: row.last_edited_time,
    }];

    projects.push({
        id, title, status: finalStatus,
        color: PROJECT_COLOR_PALETTE[idx % PROJECT_COLOR_PALETTE.length]!,
        order: idx,
        tagIds: [],
        isSequential: isSequential || undefined,
        supportNotes,
        attachments,
        dueDate: dueDate ?? undefined,
        areaId, areaTitle,
        createdAt: row.created_time,
        updatedAt: row.last_edited_time,
    });
}

// ---------- Task helpers ----------
const PRIORITY_MAP: Record<string, TaskPriority> = { '!!!': 'urgent', '!!': 'high', '!': 'medium' };

const buildAttachments = (row: NotionPage): Attachment[] => [{
    id: randomUUID(), kind: 'link', title: 'Notion original', uri: row.url,
    createdAt: row.created_time, updatedAt: row.last_edited_time,
}];

const taskMetadata = (row: NotionPage, sourceDb: string) => ({
    notion_id: row.id,
    notion_url: row.url,
    source_db: sourceDb,
});

const normalizeContext = (ctx: string): string => `@${ctx.toLowerCase().replace(/\s+/g, '-')}`;

const peopleToAssignedAndDescAddon = (people: Array<{id: string; name?: string}>): { assignedTo?: string; descAddon?: string } => {
    if (people.length === 0) return {};
    const first = people[0]!;
    const assignedTo = first.name?.trim() || first.id;
    if (people.length === 1) return { assignedTo };
    const others = people.slice(1).map(p => p.name?.trim() || p.id).join(', ');
    return { assignedTo, descAddon: `Also waiting on: ${others}` };
};

// ---------- Build Tasks: source 'Tasks' DB ----------
const notionTaskToMindwtr = new Map<string, string>();
const allTasks: Task[] = [];

interface RawTask { id: string; row: NotionPage; status: TaskStatus; projectId?: string; assignedTo?: string; descAddon?: string; sourceDb: string }
const rawTasksByProject = new Map<string, RawTask[]>(); // for sequential ordering

for (const row of rowsTasks) {
    const isDone = checkboxVal(row.properties, 'Done');
    const bucket = selectName(row.properties, 'Bucket');
    let status: TaskStatus;
    if (isDone || bucket === 'Done') status = 'done';
    else if (bucket === 'Next Action') status = 'next';
    else if (bucket === 'Waiting For') status = 'waiting';
    else if (bucket === 'Calendar') status = 'next';
    else if (bucket === 'Review') status = 'inbox';
    else status = 'inbox'; // empty Bucket → inbox per user

    const id = randomUUID();
    notionTaskToMindwtr.set(row.id, id);

    const projNotionIds = relationIds(row.properties, 'Project');
    const projectId = projNotionIds.length > 0 ? notionProjectToMindwtr.get(projNotionIds[0]!) : undefined;

    const people = peopleField(row.properties, 'Assign');
    const { assignedTo, descAddon } = peopleToAssignedAndDescAddon(people);

    const raw: RawTask = { id, row, status, projectId, assignedTo, descAddon, sourceDb: 'Tasks' };
    if (projectId && status === 'next') {
        const list = rawTasksByProject.get(projectId) ?? [];
        list.push(raw);
        rawTasksByProject.set(projectId, list);
    }

    const title = titleText(row.properties).trim() || '<Untitled Task>';
    const notes = richText(row.properties, 'Notes');
    const url = urlField(row.properties, 'URL');
    const descParts = [notes, descAddon, url ? `URL: ${url}` : ''].filter(Boolean);
    const description = descParts.length ? descParts.join('\n\n') : undefined;

    const due = dateStart(row.properties, 'Due');
    const start = dateStart(row.properties, 'Start Date');
    const priority = bucket && false ? undefined : PRIORITY_MAP[selectName(row.properties, 'Priority') || ''];
    const contexts = multiSelectNames(row.properties, 'Context').map(normalizeContext);

    const completedAt = (status === 'done' || status === 'archived') ? row.last_edited_time : undefined;

    allTasks.push({
        id, title, status,
        priority,
        assignedTo,
        startTime: start ?? undefined,
        dueDate: due ?? undefined,
        tags: [],
        contexts,
        description,
        attachments: buildAttachments(row),
        projectId,
        completedAt,
        createdAt: row.created_time,
        updatedAt: row.last_edited_time,
        metadata: taskMetadata(row, 'Tasks'),
    });
}

// ---------- Build Tasks: 'Inbox' DB ----------
for (const row of rowsInbox) {
    const isDone = checkboxVal(row.properties, 'Done');
    const bucket = selectName(row.properties, 'Bucket');
    let status: TaskStatus;
    if (isDone) status = 'done';
    else if (bucket === 'Next Action') status = 'next';
    else if (bucket === 'Waiting For') status = 'waiting';
    else if (bucket === 'Calendar') status = 'next';
    else status = 'inbox';

    const id = randomUUID();
    notionTaskToMindwtr.set(row.id, id);

    const title = titleText(row.properties).trim() || '<Untitled Inbox Item>';
    const notes = richText(row.properties, 'Notes');
    const url = urlField(row.properties, 'URL');
    const descParts = [notes, url ? `URL: ${url}` : ''].filter(Boolean);
    const description = descParts.length ? descParts.join('\n\n') : undefined;

    const start = dateStart(row.properties, 'Start Date');
    const completedAt = (status === 'done') ? row.last_edited_time : undefined;

    allTasks.push({
        id, title, status,
        startTime: start ?? undefined,
        tags: [], contexts: [],
        description,
        attachments: buildAttachments(row),
        completedAt,
        createdAt: row.created_time,
        updatedAt: row.last_edited_time,
        metadata: taskMetadata(row, 'Inbox'),
    });
}

// ---------- Build Tasks: 'Someday' DB ----------
for (const row of rowsSomeday) {
    const isDone = checkboxVal(row.properties, 'Done');
    const status: TaskStatus = isDone ? 'done' : 'someday';

    const id = randomUUID();
    notionTaskToMindwtr.set(row.id, id);

    const title = titleText(row.properties).trim() || '<Untitled Someday>';
    const notes = richText(row.properties, 'Notes');
    const url = urlField(row.properties, 'URL');
    const descParts = [notes, url ? `URL: ${url}` : ''].filter(Boolean);
    const description = descParts.length ? descParts.join('\n\n') : undefined;

    const start = dateStart(row.properties, 'Start Date');
    const projNotionIds = relationIds(row.properties, 'Project');
    const projectId = projNotionIds.length > 0 ? notionProjectToMindwtr.get(projNotionIds[0]!) : undefined;
    const priority = PRIORITY_MAP[selectName(row.properties, 'Priority') || ''];
    const completedAt = isDone ? row.last_edited_time : undefined;

    allTasks.push({
        id, title, status, priority,
        startTime: start ?? undefined,
        tags: [], contexts: [],
        description,
        attachments: buildAttachments(row),
        projectId,
        completedAt,
        createdAt: row.created_time,
        updatedAt: row.last_edited_time,
        metadata: taskMetadata(row, 'Someday'),
    });
}

// ---------- Build Tasks: 'Reference' DB ----------
for (const row of rowsReference) {
    const id = randomUUID();
    notionTaskToMindwtr.set(row.id, id);

    const title = titleText(row.properties).trim() || '<Untitled Reference>';
    const notes = richText(row.properties, 'Notes');
    const url = urlField(row.properties, 'URL');
    const descParts = [notes, url ? `URL: ${url}` : ''].filter(Boolean);
    const description = descParts.length ? descParts.join('\n\n') : undefined;

    const projNotionIds = relationIds(row.properties, 'Projects');
    const projectId = projNotionIds.length > 0 ? notionProjectToMindwtr.get(projNotionIds[0]!) : undefined;
    const tags = multiSelectNames(row.properties, 'Tags').map(t => t.toLowerCase());

    allTasks.push({
        id, title, status: 'reference',
        tags, contexts: [],
        description,
        attachments: buildAttachments(row),
        projectId,
        createdAt: row.created_time,
        updatedAt: row.last_edited_time,
        metadata: taskMetadata(row, 'Reference'),
    });
}

// ---------- Build Tasks: 'Archive' DB ----------
for (const row of rowsArchive) {
    const id = randomUUID();
    notionTaskToMindwtr.set(row.id, id);

    const title = titleText(row.properties).trim() || '<Untitled Archive>';
    const tags = multiSelectNames(row.properties, 'Tags').map(t => t.toLowerCase());

    allTasks.push({
        id, title, status: 'archived',
        tags, contexts: [],
        attachments: buildAttachments(row),
        completedAt: row.last_edited_time,
        createdAt: row.created_time,
        updatedAt: row.last_edited_time,
        metadata: taskMetadata(row, 'Archive'),
    });
}

// ---------- Sequential ordering: assign Task.order in sequential projects ----------
let sequentialProjectsCount = 0;
for (const project of projects) {
    if (!project.isSequential) continue;
    sequentialProjectsCount++;
    const tasksInProj = rawTasksByProject.get(project.id) ?? [];
    // Sort by createdAt ascending — first-created becomes first-active
    tasksInProj.sort((a, b) => a.row.created_time.localeCompare(b.row.created_time));
    for (let i = 0; i < tasksInProj.length; i++) {
        const t = allTasks.find(x => x.id === tasksInProj[i]!.id);
        if (t) t.order = i;
    }
}

// ---------- Build mapping JSON ----------
type MappingEntry = { mindwtr_id: string; notion_url: string; title: string; parent_notion_ids?: string[]; children_notion_ids?: string[]; project_notion_ids?: string[] };
const mapping = {
    generated_at: new Date().toISOString(),
    counts: { areas: areas.length, projects: projects.length, tasks: allTasks.length },
    areas: {} as Record<string, MappingEntry>,
    projects: {} as Record<string, MappingEntry>,
    tasks: {} as Record<string, MappingEntry>,
};

for (const row of rowsAreas) {
    const mid = notionAreaToMindwtr.get(row.id);
    if (!mid) continue;
    mapping.areas[row.id] = { mindwtr_id: mid, notion_url: row.url, title: titleText(row.properties) };
}
for (const row of rowsProjects) {
    const mid = notionProjectToMindwtr.get(row.id);
    if (!mid) continue;
    const epicIds = relationIds(row.properties, 'Epic');
    const subIds = relationIds(row.properties, 'Subprojects');
    mapping.projects[row.id] = {
        mindwtr_id: mid, notion_url: row.url, title: titleText(row.properties),
        ...(epicIds.length && { parent_notion_ids: epicIds }),
        ...(subIds.length && { children_notion_ids: subIds }),
    };
}
const allTaskRows = [...rowsTasks, ...rowsInbox, ...rowsSomeday, ...rowsReference, ...rowsArchive];
for (const row of allTaskRows) {
    const mid = notionTaskToMindwtr.get(row.id);
    if (!mid) continue;
    const projRel = relationIds(row.properties, 'Project').concat(relationIds(row.properties, 'Projects'));
    mapping.tasks[row.id] = {
        mindwtr_id: mid, notion_url: row.url, title: titleText(row.properties),
        ...(projRel.length && { project_notion_ids: projRel }),
    };
}

// ---------- Build AppData ----------
const appData = {
    tasks: allTasks,
    projects,
    sections: [],
    areas,
    settings: {},
};

// ---------- Write outputs ----------
writeFileSync(APP_DATA_PATH, JSON.stringify(appData, null, 2));
writeFileSync(MAPPING_PATH, JSON.stringify(mapping, null, 2));

// ---------- Summary ----------
const statusCounts = (xs: Task[]) => xs.reduce<Record<string, number>>((acc, t) => { acc[t.status] = (acc[t.status] ?? 0) + 1; return acc; }, {});
const projectStatusCounts = projects.reduce<Record<string, number>>((acc, p) => { acc[p.status] = (acc[p.status] ?? 0) + 1; return acc; }, {});
const sourceCounts: Record<string, number> = {};
for (const t of allTasks) {
    const src = String(t.metadata?.source_db ?? '?');
    sourceCounts[src] = (sourceCounts[src] ?? 0) + 1;
}
const tasksWithProject = allTasks.filter(t => t.projectId).length;
const tasksWithAssignee = allTasks.filter(t => t.assignedTo).length;

const summary = `Notion → mindwtr import — dry-run summary
Generated: ${new Date().toISOString()}

Areas:    ${areas.length}
Projects: ${projects.length}
  by status: ${JSON.stringify(projectStatusCounts)}
  isSequential=true: ${sequentialProjectsCount}
Tasks:    ${allTasks.length}
  by source DB: ${JSON.stringify(sourceCounts)}
  by status:    ${JSON.stringify(statusCounts(allTasks))}
  with projectId: ${tasksWithProject}
  with assignedTo: ${tasksWithAssignee}

Mapping file:  ${MAPPING_PATH}
AppData file:  ${APP_DATA_PATH}
   size: ${(JSON.stringify(appData).length / 1024 / 1024).toFixed(2)} MB
`;
writeFileSync(SUMMARY_PATH, summary);
console.log(summary);

// ---------- Apply (optional) ----------
if (process.argv.includes('--apply')) {
    const cloudUrl = process.env.MINDWTR_CLOUD_URL ?? 'http://localhost:8787';
    const token = process.env.MINDWTR_AUTH_TOKEN ?? 'dev-token-gtd-automation-2026';
    console.log(`\nApplying via PUT ${cloudUrl}/v1/data ...`);
    const response = await fetch(`${cloudUrl}/v1/data`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(appData),
    });
    const text = await response.text();
    console.log(`HTTP ${response.status}\n${text.slice(0, 500)}`);
    if (!response.ok) process.exit(1);
} else {
    console.log('\nDry-run complete. Re-run with --apply to PUT to cloud.');
}

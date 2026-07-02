import { strFromU8, unzipSync } from 'fflate';

import { DEFAULT_AREA_COLOR, DEFAULT_PROJECT_COLOR } from './color-constants';
import { safeParseDate } from './date';
import { normalizeRecurrenceForLoad } from './recurrence';
import { ensureDeviceId, normalizeTagId } from './store-helpers';
import type { AppData, Area, ChecklistItem, Project, Task, TaskPriority, TaskStatus } from './types';
import { generateDeterministicUUID, generateUUID as uuidv4 } from './uuid';

const TICKTICK_REQUIRED_COLUMNS = ['TITLE', 'LIST NAME'];
const TICKTICK_DELIMITER = ',';
const TICKTICK_ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];
const TICKTICK_AREA_FALLBACK = 'TickTick Area';
const TICKTICK_PROJECT_FALLBACK = 'TickTick Import';
const TICKTICK_TASK_FALLBACK = 'Imported TickTick Task';
const TICKTICK_IMPORT_SUFFIX = ' (TickTick)';
const TICKTICK_IMPORT_ID_NAMESPACE = 'mindwtr:ticktick-import:v1';
const TICKTICK_CHECKLIST_UNCHECKED = '▫';
const TICKTICK_CHECKLIST_CHECKED = '▪';

const createTickTickImportId = (kind: 'area' | 'project' | 'task', sourceKey: string): string => (
    generateDeterministicUUID(`${TICKTICK_IMPORT_ID_NAMESPACE}:${kind}:${sourceKey}`)
);

type TickTickFileInput = {
    bytes?: ArrayBuffer | Uint8Array | null;
    fileName: string;
    text?: string | null;
};

type TickTickWarningCounters = {
    childTasksConverted: number;
    emptyExports: number;
    emptyTitleRows: number;
    invalidCsvFiles: number;
    nestedZipFiles: number;
    nonCsvEntries: number;
    orphanChildTasks: number;
    unclosedQuotedFiles: number;
    unknownStatuses: number;
    unsupportedRepeats: number;
};

type NormalizedTickTickRecord = {
    areaSourceKey?: string;
    checklist: ChecklistItem[];
    completedAt?: string;
    content: string;
    createdAt?: string;
    dueDate?: string;
    isCompleted: boolean;
    order: number;
    parentId?: string;
    priority?: TaskPriority;
    projectSourceKey: string;
    recurrence?: Task['recurrence'];
    repeatText?: string;
    sourceId: string;
    sourceIndex: number;
    startTime?: string;
    status: TaskStatus;
    tags: string[];
    title: string;
    updatedAt?: string;
};

export type ParsedTickTickArea = {
    name: string;
    order: number;
    sourceKey: string;
};

export type ParsedTickTickProject = {
    areaSourceKey?: string;
    name: string;
    order: number;
    sourceKey: string;
};

export type ParsedTickTickTask = {
    areaSourceKey?: string;
    checklist: ChecklistItem[];
    completedAt?: string;
    createdAt?: string;
    description?: string;
    dueDate?: string;
    order: number;
    priority?: TaskPriority;
    projectSourceKey?: string;
    recurrence?: Task['recurrence'];
    sourceId: string;
    startTime?: string;
    status: TaskStatus;
    tags: string[];
    title: string;
    updatedAt?: string;
};

export type ParsedTickTickImportData = {
    areas: ParsedTickTickArea[];
    projects: ParsedTickTickProject[];
    tasks: ParsedTickTickTask[];
    warnings: string[];
};

export type TickTickImportProjectPreview = {
    areaName?: string;
    name: string;
    taskCount: number;
};

export type TickTickImportPreview = {
    areaCount: number;
    checklistItemCount: number;
    fileName: string;
    projectCount: number;
    projects: TickTickImportProjectPreview[];
    recurringCount: number;
    taskCount: number;
    warnings: string[];
};

export type TickTickImportParseResult = {
    errors: string[];
    parsedData: ParsedTickTickImportData | null;
    preview: TickTickImportPreview | null;
    valid: boolean;
    warnings: string[];
};

export type TickTickImportExecutionResult = {
    data: AppData;
    importedAreaCount: number;
    importedChecklistItemCount: number;
    importedProjectCount: number;
    importedTaskCount: number;
    warnings: string[];
};

const createWarningCounters = (): TickTickWarningCounters => ({
    childTasksConverted: 0,
    emptyExports: 0,
    emptyTitleRows: 0,
    invalidCsvFiles: 0,
    nestedZipFiles: 0,
    nonCsvEntries: 0,
    orphanChildTasks: 0,
    unclosedQuotedFiles: 0,
    unknownStatuses: 0,
    unsupportedRepeats: 0,
});

const appendWarning = (warnings: string[], count: number, singular: string, plural = singular): void => {
    if (count <= 0) return;
    warnings.push(count === 1 ? singular : plural.replace('{count}', String(count)));
};

const buildWarnings = (counters: TickTickWarningCounters): string[] => {
    const warnings: string[] = [];
    appendWarning(
        warnings,
        counters.childTasksConverted,
        '1 TickTick child task was imported as a checklist item on its parent task.',
        '{count} TickTick child tasks were imported as checklist items on their parent tasks.'
    );
    appendWarning(
        warnings,
        counters.orphanChildTasks,
        '1 TickTick child task had no matching parent and was imported as a normal task.',
        '{count} TickTick child tasks had no matching parent and were imported as normal tasks.'
    );
    appendWarning(
        warnings,
        counters.unsupportedRepeats,
        '1 TickTick repeat rule could not be mapped and will be imported once.',
        '{count} TickTick repeat rules could not be mapped and will be imported once.'
    );
    appendWarning(
        warnings,
        counters.unknownStatuses,
        '1 TickTick task status could not be mapped and was imported to Inbox.',
        '{count} TickTick task statuses could not be mapped and were imported to Inbox.'
    );
    appendWarning(
        warnings,
        counters.emptyTitleRows,
        '1 TickTick row with an empty title was skipped.',
        '{count} TickTick rows with empty titles were skipped.'
    );
    appendWarning(
        warnings,
        counters.nonCsvEntries,
        '1 non-CSV file inside the TickTick archive was skipped.',
        '{count} non-CSV files inside the TickTick archive were skipped.'
    );
    appendWarning(
        warnings,
        counters.nestedZipFiles,
        '1 nested ZIP file inside the TickTick archive was skipped.',
        '{count} nested ZIP files inside the TickTick archive were skipped.'
    );
    appendWarning(
        warnings,
        counters.unclosedQuotedFiles,
        '1 TickTick CSV file ended with an unclosed quoted field and was imported best-effort.',
        '{count} TickTick CSV files ended with unclosed quoted fields and were imported best-effort.'
    );
    appendWarning(
        warnings,
        counters.invalidCsvFiles,
        '1 TickTick CSV file could not be parsed and was skipped.',
        '{count} TickTick CSV files could not be parsed and were skipped.'
    );
    appendWarning(
        warnings,
        counters.emptyExports,
        '1 TickTick export contained no importable tasks.',
        '{count} TickTick exports contained no importable tasks.'
    );
    return warnings;
};

const basename = (value: string): string => {
    const parts = String(value || '').split(/[\\/]/u);
    return parts[parts.length - 1] || value;
};

const toUint8Array = (value?: ArrayBuffer | Uint8Array | null): Uint8Array | null => {
    if (!value) return null;
    return value instanceof Uint8Array ? value : new Uint8Array(value);
};

const isZipBytes = (bytes: Uint8Array): boolean =>
    bytes.length >= TICKTICK_ZIP_SIGNATURE.length
    && TICKTICK_ZIP_SIGNATURE.every((byte, index) => bytes[index] === byte);

const decodeTextBytes = (bytes: Uint8Array): string => {
    try {
        return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    } catch {
        return strFromU8(bytes, true);
    }
};

const sanitizeCsvText = (raw: string): string => String(raw || '').replace(/^\uFEFF/u, '');

const parseCsvRows = (text: string, delimiter: string): { hasUnclosedQuote: boolean; rows: string[][] } => {
    const rows: string[][] = [];
    let currentRow: string[] = [];
    let currentCell = '';
    let inQuotes = false;

    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        const next = text[index + 1];
        if (inQuotes) {
            if (char === '"') {
                if (next === '"') {
                    currentCell += '"';
                    index += 1;
                } else {
                    inQuotes = false;
                }
            } else {
                currentCell += char;
            }
            continue;
        }

        if (char === '"') {
            inQuotes = true;
            continue;
        }
        if (char === delimiter) {
            currentRow.push(currentCell);
            currentCell = '';
            continue;
        }
        if (char === '\r' || char === '\n') {
            if (char === '\r' && next === '\n') index += 1;
            currentRow.push(currentCell);
            rows.push(currentRow);
            currentRow = [];
            currentCell = '';
            continue;
        }
        currentCell += char;
    }

    currentRow.push(currentCell);
    if (currentRow.length > 1 || currentRow[0] !== '' || rows.length === 0) {
        rows.push(currentRow);
    }

    return {
        rows: rows.filter((row) => row.some((cell) => cell.length > 0)),
        hasUnclosedQuote: inQuotes,
    };
};

const normalizeHeaderCell = (value: string): string => value.trim().toUpperCase();

const buildHeaderIndex = (headerRow: string[]): Map<string, number> => {
    const index = new Map<string, number>();
    headerRow.forEach((cell, cellIndex) => {
        const normalized = normalizeHeaderCell(cell);
        if (normalized && !index.has(normalized)) index.set(normalized, cellIndex);
    });
    return index;
};

const findHeaderRowIndex = (rows: string[][]): number => rows.findIndex((row) => {
    const headerIndex = buildHeaderIndex(row);
    return TICKTICK_REQUIRED_COLUMNS.every((column) => headerIndex.has(column));
});

const getCell = (row: string[], headerIndex: Map<string, number>, key: string): string => {
    const index = headerIndex.get(key);
    if (index === undefined) return '';
    return String(row[index] ?? '').trim();
};

const normalizeSourcePart = (value: string, fallback: string): string => {
    const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '');
    return normalized || fallback;
};

const toNumber = (value: string, fallback: number): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const toBoolean = (value: string): boolean => /^(?:true|1|y|yes)$/iu.test(value.trim());

const dedupeStrings = (values: string[]): string[] => {
    const seen = new Set<string>();
    const result: string[] = [];
    values.forEach((value) => {
        const trimmed = value.trim();
        if (!trimmed) return;
        const normalized = trimmed.toLowerCase();
        if (seen.has(normalized)) return;
        seen.add(normalized);
        result.push(trimmed);
    });
    return result;
};

const joinDescription = (parts: Array<string | undefined>): string | undefined => {
    const normalized = parts.map((part) => String(part || '').trim()).filter(Boolean);
    return normalized.length > 0 ? normalized.join('\n\n') : undefined;
};

const parseTickTickTags = (value: string): string[] => dedupeStrings(
    value
        .split(/[,;\s]+/u)
        .map((tag) => normalizeTagId(tag.replace(/^#+/u, '')))
        .filter(Boolean)
);

const normalizeTickTickDateInput = (value: string): string => value.trim().replace(/([+-]\d{2})(\d{2})$/u, '$1:$2');

const parseTickTickTimestamp = (value: string): string | undefined => {
    const trimmed = normalizeTickTickDateInput(value);
    if (!trimmed) return undefined;
    const parsed = safeParseDate(trimmed);
    return parsed ? parsed.toISOString() : undefined;
};

const formatDateInTimeZone = (date: Date, timeZone: string): string => {
    const trimmedZone = timeZone.trim();
    if (!trimmedZone) return date.toISOString().slice(0, 10);
    try {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: trimmedZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        }).formatToParts(date);
        const year = parts.find((part) => part.type === 'year')?.value;
        const month = parts.find((part) => part.type === 'month')?.value;
        const day = parts.find((part) => part.type === 'day')?.value;
        if (year && month && day) return `${year}-${month}-${day}`;
    } catch {
        // Fall back to UTC below when the runtime lacks this IANA timezone.
    }
    return date.toISOString().slice(0, 10);
};

const parseTickTickTaskDate = (value: string, isAllDay: boolean, timeZone: string): string | undefined => {
    const trimmed = normalizeTickTickDateInput(value);
    if (!trimmed) return undefined;
    if (/^\d{4}-\d{2}-\d{2}$/u.test(trimmed)) return trimmed;
    const exportedDate = trimmed.match(/^(\d{4}-\d{2}-\d{2})(?:[T\s]|$)/u)?.[1];
    if (isAllDay && !timeZone.trim() && exportedDate) return exportedDate;
    const parsed = safeParseDate(trimmed);
    if (!parsed) return undefined;
    return isAllDay ? formatDateInTimeZone(parsed, timeZone) : parsed.toISOString();
};

const parsePriority = (value: string): TaskPriority | undefined => {
    const priority = Math.trunc(toNumber(value, 0));
    if (priority >= 5) return 'high';
    if (priority >= 3) return 'medium';
    if (priority >= 1) return 'low';
    return undefined;
};

const parseRecurrence = (value: string, counters: TickTickWarningCounters): Task['recurrence'] | undefined => {
    const repeatLines = value
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean);
    if (repeatLines.length === 0) return undefined;
    const recurrence = normalizeRecurrenceForLoad(repeatLines[0]);
    if (recurrence) return recurrence;
    counters.unsupportedRepeats += 1;
    return undefined;
};

const parseChecklistContent = (content: string): { checklist: ChecklistItem[]; description?: string } => {
    const checklist: ChecklistItem[] = [];
    const descriptionLines: string[] = [];
    content.replace(/\r/gu, '\n').split('\n').forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        if (trimmed.startsWith(TICKTICK_CHECKLIST_UNCHECKED) || trimmed.startsWith(TICKTICK_CHECKLIST_CHECKED)) {
            const isCompleted = trimmed.startsWith(TICKTICK_CHECKLIST_CHECKED);
            const title = trimmed.slice(1).trim();
            if (title) {
                checklist.push({ id: uuidv4(), title, isCompleted });
            }
            return;
        }
        descriptionLines.push(trimmed);
    });
    return {
        checklist,
        description: joinDescription(descriptionLines),
    };
};

const createProjectSourceKey = (folderName: string, listName: string): string => {
    const folderPart = folderName.trim()
        ? `folder:${normalizeSourcePart(folderName, 'none')}`
        : 'folder:none';
    const listPart = `list:${normalizeSourcePart(listName, 'inbox')}`;
    return `${folderPart}/${listPart}`;
};

const resolveTaskStatus = (
    statusValue: string,
    completedAt: string | undefined,
    counters: TickTickWarningCounters
): { isCompleted: boolean; status: TaskStatus } => {
    const status = Math.trunc(toNumber(statusValue, 0));
    if (status === 2) return { status: 'archived', isCompleted: true };
    if (completedAt || status === 1) return { status: 'done', isCompleted: true };
    if (status === 0) return { status: 'inbox', isCompleted: false };
    counters.unknownStatuses += 1;
    return { status: 'inbox', isCompleted: false };
};

const appendSubtaskDetails = (parts: string[], child: NormalizedTickTickRecord): void => {
    const details: string[] = [];
    if (child.content.trim()) details.push(child.content.trim());
    if (child.repeatText) details.push(`Repeats in TickTick: ${child.repeatText}`);
    if (child.startTime) details.push(`Start: ${child.startTime}`);
    if (child.dueDate) details.push(`Due: ${child.dueDate}`);
    if (details.length > 0) {
        parts.push(`Subtask "${child.title}": ${details.join(' | ')}`);
    }
};

const parseTickTickRows = (csvText: string, counters: TickTickWarningCounters): ParsedTickTickImportData => {
    const { rows, hasUnclosedQuote } = parseCsvRows(sanitizeCsvText(csvText), TICKTICK_DELIMITER);
    if (hasUnclosedQuote) counters.unclosedQuotedFiles += 1;
    if (rows.length === 0) {
        counters.emptyExports += 1;
        return { areas: [], projects: [], tasks: [], warnings: [] };
    }

    const headerRowIndex = findHeaderRowIndex(rows);
    if (headerRowIndex === -1) {
        throw new Error('TickTick CSV is missing required columns: List Name, Title');
    }
    const headerIndex = buildHeaderIndex(rows[headerRowIndex] || []);
    const missingRequired = TICKTICK_REQUIRED_COLUMNS.filter((column) => !headerIndex.has(column));
    if (missingRequired.length > 0) {
        throw new Error(`TickTick CSV is missing required columns: ${missingRequired.join(', ')}`);
    }

    const areasByKey = new Map<string, ParsedTickTickArea>();
    const projectsByKey = new Map<string, ParsedTickTickProject>();
    const records: NormalizedTickTickRecord[] = [];

    for (let rowIndex = headerRowIndex + 1; rowIndex < rows.length; rowIndex += 1) {
        const row = rows[rowIndex] || [];
        const title = getCell(row, headerIndex, 'TITLE').trim();
        const content = getCell(row, headerIndex, 'CONTENT').replace(/\r/gu, '\n').trim();
        if (!title) {
            if (row.some((cell) => String(cell || '').trim().length > 0)) counters.emptyTitleRows += 1;
            continue;
        }

        const folderName = getCell(row, headerIndex, 'FOLDER NAME').trim();
        const listName = getCell(row, headerIndex, 'LIST NAME').trim() || TICKTICK_PROJECT_FALLBACK;
        const sourceIndex = records.length;
        const areaSourceKey = folderName ? `folder:${normalizeSourcePart(folderName, `folder-${sourceIndex + 1}`)}` : undefined;
        const projectSourceKey = createProjectSourceKey(folderName, listName);
        const order = toNumber(getCell(row, headerIndex, 'ORDER'), sourceIndex);
        const timeZone = getCell(row, headerIndex, 'TIMEZONE');
        const isAllDay = toBoolean(getCell(row, headerIndex, 'IS ALL DAY'));
        const completedAt = parseTickTickTimestamp(getCell(row, headerIndex, 'COMPLETED TIME'));
        const status = resolveTaskStatus(getCell(row, headerIndex, 'STATUS'), completedAt, counters);
        const isChecklist = toBoolean(getCell(row, headerIndex, 'IS CHECK LIST'))
            || getCell(row, headerIndex, 'KIND').toUpperCase() === 'CHECKLIST';
        const checklistData = isChecklist ? parseChecklistContent(content) : { checklist: [], description: content || undefined };
        const repeatText = getCell(row, headerIndex, 'REPEAT');
        const recurrence = parseRecurrence(repeatText, counters);
        const sourceId = getCell(row, headerIndex, 'TASKID') || `row-${rowIndex + 1}`;

        if (areaSourceKey && !areasByKey.has(areaSourceKey)) {
            areasByKey.set(areaSourceKey, {
                sourceKey: areaSourceKey,
                name: folderName || TICKTICK_AREA_FALLBACK,
                order: areasByKey.size,
            });
        }
        if (!projectsByKey.has(projectSourceKey)) {
            projectsByKey.set(projectSourceKey, {
                sourceKey: projectSourceKey,
                name: listName,
                order: projectsByKey.size,
                ...(areaSourceKey ? { areaSourceKey } : {}),
            });
        }

        records.push({
            areaSourceKey,
            checklist: checklistData.checklist,
            completedAt,
            content: checklistData.description || '',
            createdAt: parseTickTickTimestamp(getCell(row, headerIndex, 'CREATED TIME')),
            dueDate: parseTickTickTaskDate(getCell(row, headerIndex, 'DUE DATE'), isAllDay, timeZone),
            isCompleted: status.isCompleted,
            order,
            parentId: getCell(row, headerIndex, 'PARENTID') || undefined,
            priority: parsePriority(getCell(row, headerIndex, 'PRIORITY')),
            projectSourceKey,
            recurrence,
            repeatText: repeatText || undefined,
            sourceId,
            sourceIndex,
            startTime: parseTickTickTaskDate(getCell(row, headerIndex, 'START DATE'), isAllDay, timeZone),
            status: status.status,
            tags: parseTickTickTags(getCell(row, headerIndex, 'TAGS')),
            title,
            updatedAt: completedAt || parseTickTickTimestamp(getCell(row, headerIndex, 'CREATED TIME')),
        });
    }

    const recordById = new Map(records.map((record) => [record.sourceId, record]));
    const checklistChildrenByParent = new Map<string, NormalizedTickTickRecord[]>();
    const convertedChildIds = new Set<string>();
    const resolveChecklistParent = (record: NormalizedTickTickRecord): NormalizedTickTickRecord | null => {
        if (!record.parentId) return null;
        let parent = recordById.get(record.parentId);
        if (!parent) {
            counters.orphanChildTasks += 1;
            return null;
        }

        const visited = new Set<string>([record.sourceId, parent.sourceId]);
        while (parent.parentId) {
            const grandparent = recordById.get(parent.parentId);
            if (!grandparent) return parent;
            if (visited.has(grandparent.sourceId)) return null;
            visited.add(grandparent.sourceId);
            parent = grandparent;
        }
        return parent;
    };

    records.forEach((record) => {
        const parent = resolveChecklistParent(record);
        if (!parent) return;
        const children = checklistChildrenByParent.get(parent.sourceId) ?? [];
        children.push(record);
        checklistChildrenByParent.set(parent.sourceId, children);
        convertedChildIds.add(record.sourceId);
        counters.childTasksConverted += 1;
    });

    const parsedTasks: ParsedTickTickTask[] = [];
    records.forEach((record) => {
        if (convertedChildIds.has(record.sourceId)) return;
        const descriptionParts = [record.content];
        const childChecklistItems = (checklistChildrenByParent.get(record.sourceId) ?? [])
            .sort((left, right) => left.order - right.order || left.sourceIndex - right.sourceIndex)
            .map((child) => {
                appendSubtaskDetails(descriptionParts, child);
                record.tags = dedupeStrings([...record.tags, ...child.tags]);
                return {
                    id: uuidv4(),
                    title: child.title || TICKTICK_TASK_FALLBACK,
                    isCompleted: child.isCompleted,
                };
            });
        parsedTasks.push({
            sourceId: record.sourceId,
            title: record.title || TICKTICK_TASK_FALLBACK,
            order: record.sourceIndex,
            status: record.status,
            tags: dedupeStrings(record.tags),
            checklist: [...record.checklist, ...childChecklistItems],
            description: joinDescription(descriptionParts),
            completedAt: record.completedAt,
            priority: record.priority,
            dueDate: record.dueDate,
            startTime: record.startTime,
            recurrence: record.recurrence,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
            projectSourceKey: record.projectSourceKey,
            areaSourceKey: record.areaSourceKey,
        });
    });

    if (parsedTasks.length === 0) counters.emptyExports += 1;

    const usedProjectKeys = new Set(parsedTasks.map((task) => task.projectSourceKey).filter(Boolean));
    const projects = Array.from(projectsByKey.values()).filter((project) => usedProjectKeys.has(project.sourceKey));
    const usedAreaKeys = new Set(projects.map((project) => project.areaSourceKey).filter(Boolean) as string[]);
    const areas = Array.from(areasByKey.values()).filter((area) => usedAreaKeys.has(area.sourceKey));

    return {
        areas,
        projects,
        tasks: parsedTasks,
        warnings: [],
    };
};

const mergeParsedData = (target: ParsedTickTickImportData, source: ParsedTickTickImportData): void => {
    const areaKeys = new Set(target.areas.map((area) => area.sourceKey));
    const projectKeys = new Set(target.projects.map((project) => project.sourceKey));
    source.areas.forEach((area) => {
        if (areaKeys.has(area.sourceKey)) return;
        areaKeys.add(area.sourceKey);
        target.areas.push(area);
    });
    source.projects.forEach((project) => {
        if (projectKeys.has(project.sourceKey)) return;
        projectKeys.add(project.sourceKey);
        target.projects.push(project);
    });
    target.tasks.push(...source.tasks);
};

const buildPreview = (fileName: string, parsedData: ParsedTickTickImportData): TickTickImportPreview => {
    const taskCountByProject = new Map<string, number>();
    parsedData.tasks.forEach((task) => {
        if (!task.projectSourceKey) return;
        taskCountByProject.set(task.projectSourceKey, (taskCountByProject.get(task.projectSourceKey) ?? 0) + 1);
    });
    const areaNameByKey = new Map(parsedData.areas.map((area) => [area.sourceKey, area.name]));
    const projects = parsedData.projects.map((project) => ({
        name: project.name,
        areaName: project.areaSourceKey ? areaNameByKey.get(project.areaSourceKey) : undefined,
        taskCount: taskCountByProject.get(project.sourceKey) ?? 0,
    }));
    const checklistItemCount = parsedData.tasks.reduce((sum, task) => sum + task.checklist.length, 0);
    const recurringCount = parsedData.tasks.reduce((sum, task) => sum + (task.recurrence ? 1 : 0), 0);
    return {
        fileName,
        areaCount: parsedData.areas.length,
        projectCount: parsedData.projects.length,
        taskCount: parsedData.tasks.length,
        checklistItemCount,
        recurringCount,
        projects,
        warnings: parsedData.warnings,
    };
};

export const parseTickTickImportSource = (input: TickTickFileInput): TickTickImportParseResult => {
    const fileName = basename(input.fileName);
    const bytes = toUint8Array(input.bytes);
    const counters = createWarningCounters();
    const parsedData: ParsedTickTickImportData = { areas: [], projects: [], tasks: [], warnings: [] };

    const parseOneCsv = (csvText: string): void => {
        mergeParsedData(parsedData, parseTickTickRows(csvText, counters));
    };

    try {
        if (bytes && isZipBytes(bytes)) {
            const entries = unzipSync(bytes);
            for (const [entryName, entryBytes] of Object.entries(entries)) {
                const lowerName = entryName.toLowerCase();
                if (!entryName || entryName.endsWith('/')) continue;
                if (lowerName.endsWith('.zip')) {
                    counters.nestedZipFiles += 1;
                    continue;
                }
                if (!lowerName.endsWith('.csv')) {
                    counters.nonCsvEntries += 1;
                    continue;
                }
                try {
                    parseOneCsv(decodeTextBytes(entryBytes));
                } catch {
                    counters.invalidCsvFiles += 1;
                }
            }
        } else {
            const text = input.text ?? (bytes ? decodeTextBytes(bytes) : '');
            parseOneCsv(text);
        }
    } catch (error) {
        const warnings = buildWarnings(counters);
        return {
            valid: false,
            parsedData: null,
            preview: null,
            warnings,
            errors: [error instanceof Error && error.message ? error.message : 'Failed to parse the TickTick export.'],
        };
    }

    const warnings = buildWarnings(counters);
    parsedData.warnings = warnings;
    const errors = parsedData.tasks.length === 0 ? ['No importable TickTick tasks were found in the selected file.'] : [];
    return {
        valid: errors.length === 0,
        parsedData: errors.length === 0 ? parsedData : null,
        preview: errors.length === 0 ? buildPreview(fileName, parsedData) : null,
        warnings,
        errors,
    };
};

const resolveUniqueName = (title: string, usedTitles: Set<string>, fallback: string): string => {
    const trimmed = title.trim() || fallback;
    if (!usedTitles.has(trimmed.toLowerCase())) {
        usedTitles.add(trimmed.toLowerCase());
        return trimmed;
    }

    const base = `${trimmed}${TICKTICK_IMPORT_SUFFIX}`;
    if (!usedTitles.has(base.toLowerCase())) {
        usedTitles.add(base.toLowerCase());
        return base;
    }

    let suffix = 2;
    while (true) {
        const next = `${base} ${suffix}`;
        const normalized = next.toLowerCase();
        if (!usedTitles.has(normalized)) {
            usedTitles.add(normalized);
            return next;
        }
        suffix += 1;
    }
};

const resolveTimestamp = (value: string | undefined, fallback: string): string => {
    const parsed = safeParseDate(value);
    return parsed ? parsed.toISOString() : fallback;
};

const resolveImportedTaskStatus = (status: TaskStatus, projectId: string | undefined): TaskStatus => (
    status === 'inbox' && projectId ? 'next' : status
);

export const applyTickTickImport = (
    currentData: AppData,
    parsedData: ParsedTickTickImportData,
    options: { now?: Date | string } = {}
): TickTickImportExecutionResult => {
    const resolvedNow = options.now instanceof Date
        ? options.now
        : typeof options.now === 'string' && options.now.trim()
            ? new Date(options.now)
            : new Date();
    const nowIso = Number.isFinite(resolvedNow.getTime()) ? resolvedNow.toISOString() : new Date().toISOString();
    const deviceState = ensureDeviceId(currentData.settings ?? {});
    const settings = deviceState.settings;
    const nextData: AppData = {
        tasks: [...currentData.tasks],
        projects: [...currentData.projects],
        sections: [...currentData.sections],
        areas: [...currentData.areas],
        people: [...(currentData.people ?? [])],
        settings,
    };

    const usedAreaNames = new Set(nextData.areas.filter((area) => !area.deletedAt).map((area) => area.name.trim().toLowerCase()));
    const usedProjectTitles = new Set(nextData.projects.filter((project) => !project.deletedAt).map((project) => project.title.trim().toLowerCase()));
    const warnings = [...parsedData.warnings];
    const areaIdBySourceKey = new Map<string, string>();
    const projectIdBySourceKey = new Map<string, string>();
    const existingAreaById = new Map(nextData.areas.map((area) => [area.id, area]));
    const existingProjectById = new Map(nextData.projects.map((project) => [project.id, project]));
    const existingTaskIds = new Set(nextData.tasks.map((task) => task.id));
    let importedAreaCount = 0;
    let importedProjectCount = 0;
    let importedTaskCount = 0;
    let importedChecklistItemCount = 0;

    const nextAreaOrder = nextData.areas
        .filter((area) => !area.deletedAt)
        .reduce((max, area) => Math.max(max, Number.isFinite(area.order) ? area.order : -1), -1) + 1;

    parsedData.areas
        .slice()
        .sort((left, right) => left.order - right.order || left.sourceKey.localeCompare(right.sourceKey))
        .forEach((area, index) => {
            const areaId = createTickTickImportId('area', area.sourceKey);
            const existingArea = existingAreaById.get(areaId);
            if (existingArea) {
                if (!existingArea.deletedAt) areaIdBySourceKey.set(area.sourceKey, existingArea.id);
                return;
            }
            const areaName = resolveUniqueName(area.name, usedAreaNames, TICKTICK_AREA_FALLBACK);
            if (areaName !== area.name) {
                warnings.push(`Imported area "${area.name}" was renamed to "${areaName}" to avoid a name conflict.`);
            }
            const nextArea: Area = {
                id: areaId,
                name: areaName,
                color: DEFAULT_AREA_COLOR,
                order: nextAreaOrder + index,
                createdAt: nowIso,
                updatedAt: nowIso,
                rev: 1,
                revBy: deviceState.deviceId,
            };
            nextData.areas.push(nextArea);
            areaIdBySourceKey.set(area.sourceKey, nextArea.id);
            importedAreaCount += 1;
        });

    parsedData.projects
        .slice()
        .sort((left, right) => left.order - right.order || left.sourceKey.localeCompare(right.sourceKey))
        .forEach((project) => {
            const projectId = createTickTickImportId('project', project.sourceKey);
            const existingProject = existingProjectById.get(projectId);
            if (existingProject) {
                if (!existingProject.deletedAt) projectIdBySourceKey.set(project.sourceKey, existingProject.id);
                return;
            }
            const areaId = project.areaSourceKey ? areaIdBySourceKey.get(project.areaSourceKey) : undefined;
            const projectTitle = resolveUniqueName(project.name, usedProjectTitles, TICKTICK_PROJECT_FALLBACK);
            if (projectTitle !== project.name) {
                warnings.push(`Imported project "${project.name}" was renamed to "${projectTitle}" to avoid a title conflict.`);
            }
            const siblingMaxOrder = nextData.projects
                .filter((item) => !item.deletedAt && (item.areaId ?? undefined) === areaId)
                .reduce((max, item) => Math.max(max, Number.isFinite(item.order) ? item.order : -1), -1);
            const nextProject: Project = {
                id: projectId,
                title: projectTitle,
                status: 'active',
                color: DEFAULT_PROJECT_COLOR,
                order: siblingMaxOrder + 1,
                tagIds: [],
                createdAt: nowIso,
                updatedAt: nowIso,
                rev: 1,
                revBy: deviceState.deviceId,
                ...(areaId ? { areaId } : {}),
            };
            nextData.projects.push(nextProject);
            projectIdBySourceKey.set(project.sourceKey, nextProject.id);
            importedProjectCount += 1;
        });

    const getTaskBucketKey = (projectId?: string, areaId?: string): string => {
        if (projectId) return `project:${projectId}`;
        if (areaId) return `area:${areaId}`;
        return 'inbox';
    };

    const nextTaskOrderByBucket = new Map<string, number>();
    nextData.tasks.forEach((task) => {
        if (task.deletedAt) return;
        const bucket = getTaskBucketKey(task.projectId, task.areaId);
        const candidate = typeof task.order === 'number'
            ? task.order
            : typeof task.orderNum === 'number'
                ? task.orderNum
                : -1;
        nextTaskOrderByBucket.set(bucket, Math.max(nextTaskOrderByBucket.get(bucket) ?? -1, candidate));
    });
    nextTaskOrderByBucket.forEach((maxOrder, bucket) => {
        nextTaskOrderByBucket.set(bucket, maxOrder + 1);
    });

    const allocateTaskOrder = (projectId?: string, areaId?: string): number => {
        const bucket = getTaskBucketKey(projectId, areaId);
        const cached = nextTaskOrderByBucket.get(bucket);
        if (cached !== undefined) {
            nextTaskOrderByBucket.set(bucket, cached + 1);
            return cached;
        }
        const nextOrder = 0;
        nextTaskOrderByBucket.set(bucket, nextOrder + 1);
        return nextOrder;
    };

    parsedData.tasks.forEach((task) => {
        const taskId = createTickTickImportId('task', `${task.projectSourceKey ?? 'none'}:${task.sourceId}`);
        if (existingTaskIds.has(taskId)) return;
        const projectId = task.projectSourceKey ? projectIdBySourceKey.get(task.projectSourceKey) : undefined;
        const areaId = !projectId && task.areaSourceKey ? areaIdBySourceKey.get(task.areaSourceKey) : undefined;
        const order = allocateTaskOrder(projectId, areaId);
        const checklist = task.checklist.length > 0
            ? task.checklist.map((item) => ({
                id: uuidv4(),
                title: item.title,
                isCompleted: item.isCompleted,
            }))
            : undefined;
        const createdAt = resolveTimestamp(task.createdAt, nowIso);
        const updatedAt = resolveTimestamp(task.updatedAt, createdAt);
        const completedAt = task.status === 'done' || task.status === 'archived'
            ? task.completedAt ?? updatedAt
            : undefined;
        const status = resolveImportedTaskStatus(task.status, projectId);
        const nextTask: Task = {
            id: taskId,
            title: task.title,
            status,
            taskMode: checklist ? 'list' : 'task',
            priority: task.priority,
            contexts: [],
            tags: task.tags,
            description: task.description,
            startTime: task.startTime,
            dueDate: task.dueDate,
            recurrence: task.recurrence,
            completedAt,
            checklist,
            pushCount: 0,
            createdAt,
            updatedAt,
            rev: 1,
            revBy: deviceState.deviceId,
            order,
            orderNum: order,
            ...(projectId ? { projectId } : {}),
            ...(areaId ? { areaId } : {}),
        };
        nextData.tasks.push(nextTask);
        existingTaskIds.add(taskId);
        importedTaskCount += 1;
        importedChecklistItemCount += checklist?.length ?? 0;
    });

    return {
        data: nextData,
        importedAreaCount,
        importedProjectCount,
        importedTaskCount,
        importedChecklistItemCount,
        warnings,
    };
};

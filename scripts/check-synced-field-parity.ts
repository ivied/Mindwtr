#!/usr/bin/env bun
import { readFileSync } from 'node:fs';

type Entity = 'task' | 'project' | 'section';
type Surface = 'cloud' | 'sqlite';

const EXPECTED: Record<Entity, Record<Surface, string[]>> = {
    task: {
        cloud: [
            'title', 'status', 'priority', 'energyLevel', 'assignedTo', 'taskMode', 'startTime',
            'relativeStartOffset', 'dueDate', 'recurrence', 'showFutureRecurrence', 'pushCount',
            'tags', 'contexts', 'checklist', 'description', 'textDirection', 'attachments', 'location',
            'projectId', 'sectionId', 'areaId', 'isFocusedToday', 'timeEstimate',
            'suppressMindwtrReminders', 'repeatReminderMinutes', 'reviewAt', 'completedAt',
            'statusBeforeProjectArchive', 'completedAtBeforeProjectArchive',
            'isFocusedTodayBeforeProjectArchive', 'projectArchivedAt', 'rev', 'revBy', 'createdAt',
            'updatedAt', 'deletedAt', 'purgedAt', 'order', 'orderNum',
        ],
        sqlite: [
            'id', 'title', 'status', 'priority', 'energyLevel', 'assignedTo', 'taskMode', 'startTime',
            'relativeStartOffset', 'dueDate', 'recurrence', 'showFutureRecurrence', 'pushCount',
            'repeatReminderMinutes', 'tags', 'contexts', 'checklist', 'description', 'textDirection',
            'attachments', 'location', 'projectId', 'sectionId', 'areaId', 'orderNum', 'boardOrder',
            'isFocusedToday', 'timeEstimate', 'suppressMindwtrReminders', 'reviewAt', 'completedAt',
            'statusBeforeProjectArchive', 'completedAtBeforeProjectArchive',
            'isFocusedTodayBeforeProjectArchive', 'projectArchivedAt', 'rev', 'revBy', 'createdAt',
            'updatedAt', 'deletedAt', 'purgedAt',
        ],
    },
    project: {
        cloud: [
            'title', 'status', 'color', 'order', 'tagIds', 'isSequential', 'sequentialScope',
            'isFocused', 'supportNotes', 'attachments', 'dueDate', 'reviewAt', 'areaId', 'areaTitle',
            'rev', 'revBy', 'createdAt', 'updatedAt', 'deletedAt', 'purgedAt',
        ],
        sqlite: [
            'id', 'title', 'status', 'color', 'orderNum', 'tagIds', 'isSequential', 'sequentialScope',
            'isFocused', 'supportNotes', 'attachments', 'dueDate', 'reviewAt', 'areaId', 'areaTitle',
            'rev', 'revBy', 'createdAt', 'updatedAt', 'deletedAt', 'purgedAt',
        ],
    },
    section: {
        cloud: [
            'projectId', 'title', 'description', 'order', 'isCollapsed', 'rev', 'revBy', 'createdAt',
            'updatedAt', 'deletedAt', 'deletedAtBeforeProjectArchive', 'projectArchivedAt',
        ],
        sqlite: [
            'id', 'projectId', 'title', 'description', 'orderNum', 'isCollapsed', 'rev', 'revBy',
            'createdAt', 'updatedAt', 'deletedAt', 'deletedAtBeforeProjectArchive', 'projectArchivedAt',
        ],
    },
};

const PATHS = {
    coreSqliteAdapter: 'packages/core/src/sqlite-adapter.ts',
    coreSqliteSchema: 'packages/core/src/sqlite-schema.ts',
    desktopRustSchema: 'apps/desktop/src-tauri/src/lib.rs',
    desktopRustStorage: 'apps/desktop/src-tauri/src/storage.rs',
    swiftMapper: 'apps/mobile/modules/cloudkit-sync/ios/CloudKitRecordMapper.swift',
    objcMapper: 'apps/desktop/src-tauri/src/macos_cloudkit_bridge.m',
};

const read = (path: string) => readFileSync(path, 'utf8');

const unique = (fields: string[], label: string): string[] => {
    const seen = new Set<string>();
    const duplicates = fields.filter((field) => {
        if (seen.has(field)) return true;
        seen.add(field);
        return false;
    });
    if (duplicates.length > 0) {
        throw new Error(`${label} has duplicate fields: ${Array.from(new Set(duplicates)).join(', ')}`);
    }
    return fields;
};

const parseCoreTaskColumns = (source: string): string[] => {
    const match = source.match(/export const TASK_SQLITE_COLUMNS = \[([\s\S]*?)\] as const;/);
    if (!match) throw new Error('Could not find TASK_SQLITE_COLUMNS.');
    return unique(Array.from(match[1].matchAll(/'([^']+)'/g), (entry) => entry[1]), 'TASK_SQLITE_COLUMNS');
};

const parseCreateTableColumns = (source: string, table: string): string[] => {
    const match = source.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`));
    if (!match) throw new Error(`Could not find CREATE TABLE for ${table}.`);
    return unique(match[1]
        .split('\n')
        .map((line) => line.trim().replace(/,$/, ''))
        .filter(Boolean)
        .map((line) => line.split(/\s+/)[0])
        .filter((name) => !name.startsWith('FOREIGN') && !name.startsWith('PRIMARY')),
    `CREATE TABLE ${table}`);
};

const parseRustInsertColumns = (source: string, table: string): string[] => {
    const match = source.match(new RegExp(`INSERT OR REPLACE INTO ${table} \\(([^)]*)\\) VALUES`));
    if (!match) throw new Error(`Could not find Rust INSERT columns for ${table}.`);
    return unique(match[1].split(',').map((column) => column.trim()).filter(Boolean), `Rust INSERT ${table}`);
};

const parseSwiftFields = (source: string, entity: Entity): string[] => {
    const name = `${entity}FieldSpecs`;
    const match = source.match(new RegExp(`private static let ${name}: \\[FieldSpec\\] = \\[([\\s\\S]*?)\\n    \\]`));
    if (!match) throw new Error(`Could not find Swift ${name}.`);
    return unique(Array.from(match[1].matchAll(/jsKey: "([^"]+)"/g), (entry) => entry[1]), `Swift ${name}`);
};

const parseObjcFields = (source: string, entity: Entity): string[] => {
    const name = `k${entity[0].toUpperCase()}${entity.slice(1)}Fields`;
    const match = source.match(new RegExp(`static const MWFieldSpec ${name}\\[\\] = \\{([\\s\\S]*?)\\n\\};`));
    if (!match) throw new Error(`Could not find ObjC ${name}.`);
    return unique(Array.from(match[1].matchAll(/\{"([^"]+)"/g), (entry) => entry[1]), `ObjC ${name}`);
};

const compareSet = (label: string, actual: string[], expected: string[]): string[] => {
    const actualSet = new Set(actual);
    const expectedSet = new Set(expected);
    const missing = expected.filter((field) => !actualSet.has(field));
    const extra = actual.filter((field) => !expectedSet.has(field));
    if (missing.length === 0 && extra.length === 0) return [];
    const lines = [`${label}:`];
    if (missing.length > 0) lines.push(`  missing: ${missing.join(', ')}`);
    if (extra.length > 0) lines.push(`  extra: ${extra.join(', ')}`);
    return lines;
};

const failures: string[] = [];

const coreSqliteAdapter = read(PATHS.coreSqliteAdapter);
const coreSqliteSchema = read(PATHS.coreSqliteSchema);
const desktopRustSchema = read(PATHS.desktopRustSchema);
const desktopRustStorage = read(PATHS.desktopRustStorage);
const swiftMapper = read(PATHS.swiftMapper);
const objcMapper = read(PATHS.objcMapper);

failures.push(...compareSet('core TASK_SQLITE_COLUMNS', parseCoreTaskColumns(coreSqliteAdapter), EXPECTED.task.sqlite));

for (const entity of ['task', 'project', 'section'] as const) {
    const table = `${entity}s`;
    const expectedSqlite = EXPECTED[entity].sqlite;
    const expectedCloud = EXPECTED[entity].cloud;

    failures.push(...compareSet(`core SQLite schema ${table}`, parseCreateTableColumns(coreSqliteSchema, table), expectedSqlite));
    failures.push(...compareSet(`desktop Rust schema ${table}`, parseCreateTableColumns(desktopRustSchema, table), expectedSqlite));
    failures.push(...compareSet(`desktop Rust storage INSERT ${table}`, parseRustInsertColumns(desktopRustStorage, table), expectedSqlite));
    failures.push(...compareSet(`iOS CloudKit ${entity} fields`, parseSwiftFields(swiftMapper, entity), expectedCloud));
    failures.push(...compareSet(`macOS CloudKit ${entity} fields`, parseObjcFields(objcMapper, entity), expectedCloud));
}

if (failures.length > 0) {
    console.error('Synced field parity check failed. Update all schema/mapper field lists together.');
    console.error(failures.join('\n'));
    process.exit(1);
}

console.log('Synced field parity check passed.');

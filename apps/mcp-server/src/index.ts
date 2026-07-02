#!/usr/bin/env node
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod';

import { createCloudService } from './cloud-service.js';
import { getMindwtrToolErrorCode, ReadOnlyError, ValidationError } from './errors.js';
import {
  MAX_TASK_QUICK_ADD_LENGTH,
  MAX_TASK_TITLE_LENGTH,
  normalizeNullableTaskTokens,
  normalizeOptionalTaskTokens,
} from './input-validation.js';
import { createService, type MindwtrService } from './service.js';

const resolvePackageVersion = (): string => {
  try {
    const packageJsonPath = resolve(dirname(fileURLToPath(import.meta.url)), '../package.json');
    const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version.trim()) {
      return parsed.version;
    }
  } catch {
    // Fall back to a valid implementation version if package metadata is unavailable.
  }
  return '0.0.0';
};

type LogLevel = 'info' | 'error';
type LogEntry = {
  ts: string;
  level: LogLevel;
  scope: 'mcp';
  message: string;
  context?: Record<string, unknown>;
};

const writeLog = (entry: LogEntry) => {
  const line = `${JSON.stringify(entry)}\n`;
  process.stderr.write(line);
};

const logError = (message: string, error?: unknown) => {
  const context: Record<string, unknown> = {};
  if (error instanceof Error) {
    context.error = error.message;
    if (error.stack) context.stack = error.stack;
  } else if (error !== undefined) {
    context.error = String(error);
  }
  writeLog({
    ts: new Date().toISOString(),
    level: 'error',
    scope: 'mcp',
    message,
    context: Object.keys(context).length ? context : undefined,
  });
};

type McpTextContent = { type: 'text'; text: string };
type McpToolResponse = { content: McpTextContent[]; isError?: boolean };

const createMcpTextResponse = (payload: Record<string, unknown>): McpToolResponse => ({
  content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
});

const createMcpErrorResponse = (error: unknown): McpToolResponse => {
  const message = error instanceof Error ? error.message : String(error);
  const code = getMindwtrToolErrorCode(error);
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message, code }, null, 2) }],
    isError: true,
  };
};

const withMcpErrorHandling = <TInput>(
  scope: string,
  handler: (input: TInput) => Promise<McpToolResponse>,
) => async (input: TInput): Promise<McpToolResponse> => {
  try {
    return await handler(input);
  } catch (error) {
    logError(`Tool execution failed: ${scope}`, error);
    return createMcpErrorResponse(error);
  }
};

export const parseArgs = (argv: string[]) => {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg || !arg.startsWith('--')) continue;
    const keyValue = arg.slice(2);
    const equalsIndex = keyValue.indexOf('=');
    if (equalsIndex > 0) {
      const key = keyValue.slice(0, equalsIndex);
      const value = keyValue.slice(equalsIndex + 1);
      if (key) {
        flags[key] = value;
      }
      continue;
    }
    const key = keyValue;
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return flags;
};

export const parseBooleanFlag = (value: string | boolean | undefined): boolean | undefined => {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
  return true;
};

export const resolveServerModeFlags = (flags: Record<string, string | boolean>) => {
  const allowWrite = parseBooleanFlag(flags.write) ?? false;
  const explicitReadonly = parseBooleanFlag(flags.readonly);
  const keepAlive = !((parseBooleanFlag(flags.nowait) ?? false) || (parseBooleanFlag(flags.noWait) ?? false));
  return {
    allowWrite,
    readonly: explicitReadonly ?? !allowWrite,
    keepAlive,
  };
};

type ServerEnv = Record<string, string | undefined>;

type LocalServerConfig = {
  backend: 'local';
  dbPath?: string;
  readonly: boolean;
  keepAlive: boolean;
};

type CloudServerConfig = {
  backend: 'cloud';
  cloudUrl: string;
  cloudToken: string;
  allowInsecureHttp: boolean;
  readonly: true;
  keepAlive: boolean;
};

export type ServerConfig = LocalServerConfig | CloudServerConfig;

const readStringFlag = (flags: Record<string, string | boolean>, ...names: string[]): string | undefined => {
  for (const name of names) {
    const value = flags[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
};

export const resolveServerConfig = (
  flags: Record<string, string | boolean>,
  env: ServerEnv = process.env,
): ServerConfig => {
  const { allowWrite, readonly, keepAlive } = resolveServerModeFlags(flags);
  const cloudUrl = readStringFlag(flags, 'cloud-url', 'cloudUrl') ?? env.MINDWTR_MCP_CLOUD_URL;
  const cloudToken = readStringFlag(flags, 'cloud-token', 'cloudToken') ?? env.MINDWTR_MCP_CLOUD_TOKEN;

  if (cloudUrl || cloudToken) {
    if (!cloudUrl) throw new ValidationError('Cloud URL is required for Cloud MCP mode');
    if (!cloudToken) throw new ValidationError('Cloud token is required for Cloud MCP mode');
    if (allowWrite) throw new ValidationError('Cloud MCP mode is read-only; remove --write.');
    return {
      backend: 'cloud',
      cloudUrl,
      cloudToken,
      allowInsecureHttp: parseBooleanFlag(
        flags['cloud-allow-insecure-http']
        ?? flags.cloudAllowInsecureHttp
        ?? env.MINDWTR_MCP_CLOUD_ALLOW_INSECURE_HTTP
      ) ?? false,
      readonly: true,
      keepAlive,
    };
  }

  return {
    backend: 'local',
    dbPath: readStringFlag(flags, 'db'),
    readonly,
    keepAlive,
  };
};

const taskStatusSchema = z.enum(['inbox', 'next', 'waiting', 'someday', 'reference', 'done', 'archived']);
const taskStatusOrAllSchema = z.enum(['inbox', 'next', 'waiting', 'someday', 'reference', 'done', 'archived', 'all']);
const projectStatusSchema = z.enum(['active', 'someday', 'waiting', 'archived']);
const taskPrioritySchema = z.enum(['low', 'medium', 'high', 'urgent']);
const timeEstimateSchema = z.enum(['5min', '10min', '15min', '30min', '1hr', '2hr', '3hr', '4hr', '4hr+']);
const taskTokenSchema = z.string().trim().min(1).max(MAX_TASK_TITLE_LENGTH);
const isoDateLikeSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/,
    'Expected ISO date (YYYY-MM-DD) or ISO datetime'
  );

const listTasksSchema = z.object({
  status: taskStatusOrAllSchema.optional(),
  projectId: z.string().optional(),
  includeDeleted: z.boolean().optional(),
  limit: z.number().int().min(1).max(500).optional(),
  offset: z.number().int().min(0).max(100000).optional(),
  search: z.string().max(512).optional(),
  dueDateFrom: isoDateLikeSchema.optional(),
  dueDateTo: isoDateLikeSchema.optional(),
  sortBy: z.enum(['updatedAt', 'createdAt', 'dueDate', 'title', 'priority']).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
});

// Note: Don't use .refine() as it breaks MCP SDK's JSON schema conversion
const addTaskSchema = z.object({
  title: z.string().max(MAX_TASK_TITLE_LENGTH).optional().describe('Task title'),
  quickAdd: z.string().optional().describe('Quick-add string with natural language parsing (e.g. "Buy milk @errands #shopping /due:tomorrow +ProjectName")'),
  status: taskStatusSchema.optional().describe('Task status: inbox, next, waiting, someday, reference, done, archived'),
  projectId: z.string().optional().describe('Project ID to assign the task to'),
  sectionId: z.string().optional().describe('Project section ID to assign the task to'),
  dueDate: isoDateLikeSchema.optional().describe('Due date in ISO format'),
  startTime: isoDateLikeSchema.optional().describe('Start time in ISO format'),
  contexts: z.array(taskTokenSchema).optional().describe('Context tags (e.g. ["@home", "@work"])'),
  tags: z.array(taskTokenSchema).optional().describe('Tags (e.g. ["#urgent", "#personal"])'),
  description: z.string().optional().describe('Task description/notes'),
  priority: taskPrioritySchema.optional().describe('Priority level: low, medium, high, urgent'),
  energyLevel: z.enum(['low', 'medium', 'high']).optional().describe('Energy level: low, medium, high'),
  assignedTo: z.string().optional().describe('Person this task is assigned to or waiting for'),
  timeEstimate: timeEstimateSchema.optional().describe('Time estimate: 5min, 10min, 15min, 30min, 1hr, 2hr, 3hr, 4hr, 4hr+'),
});
const normalizeAddTaskInput = (data: z.infer<typeof addTaskSchema>) => {
  const hasTitle = typeof data.title === 'string' && data.title.trim().length > 0;
  const hasQuickAdd = typeof data.quickAdd === 'string' && data.quickAdd.trim().length > 0;
  if (!hasTitle && !hasQuickAdd) {
    throw new ValidationError('Either title or quickAdd is required');
  }
  if (hasTitle && hasQuickAdd) {
    throw new ValidationError('Provide either title or quickAdd, not both');
  }
  if (hasTitle && data.title!.trim().length > MAX_TASK_TITLE_LENGTH) {
    throw new ValidationError(`Task title too long (max ${MAX_TASK_TITLE_LENGTH} characters)`);
  }
  if (hasQuickAdd && data.quickAdd!.trim().length > MAX_TASK_QUICK_ADD_LENGTH) {
    throw new ValidationError(`Quick-add input too long (max ${MAX_TASK_QUICK_ADD_LENGTH} characters)`);
  }
  return {
    ...data,
    contexts: normalizeOptionalTaskTokens('contexts', data.contexts),
    tags: normalizeOptionalTaskTokens('tags', data.tags),
  };
};

const completeTaskSchema = z.object({
  id: z.string(),
});
const updateTaskSchema = z.object({
  id: z.string(),
  title: z.string().max(MAX_TASK_TITLE_LENGTH).optional(),
  status: taskStatusSchema.optional(),
  projectId: z.string().nullable().optional(),
  sectionId: z.string().nullable().optional(),
  dueDate: isoDateLikeSchema.nullable().optional(),
  startTime: isoDateLikeSchema.nullable().optional(),
  contexts: z.array(taskTokenSchema).nullable().optional(),
  tags: z.array(taskTokenSchema).nullable().optional(),
  description: z.string().nullable().optional(),
  priority: taskPrioritySchema.nullable().optional(),
  energyLevel: z.enum(['low', 'medium', 'high']).nullable().optional(),
  assignedTo: z.string().nullable().optional(),
  timeEstimate: timeEstimateSchema.nullable().optional(),
  reviewAt: isoDateLikeSchema.nullable().optional(),
  isFocusedToday: z.boolean().optional(),
});

const normalizeUpdateTaskInput = (data: z.infer<typeof updateTaskSchema>) => ({
  ...data,
  contexts: normalizeNullableTaskTokens('contexts', data.contexts),
  tags: normalizeNullableTaskTokens('tags', data.tags),
});

const deleteTaskSchema = z.object({
  id: z.string(),
});

const getTaskSchema = z.object({
  id: z.string(),
  includeDeleted: z.boolean().optional(),
});

const restoreTaskSchema = z.object({
  id: z.string(),
});

const listProjectsSchema = z.object({});
const listAreasSchema = z.object({});
const listPeopleSchema = z.object({
  includeDeleted: z.boolean().optional(),
});
const getProjectSchema = z.object({
  id: z.string(),
  includeDeleted: z.boolean().optional(),
});
const getPersonSchema = z.object({
  id: z.string(),
  includeDeleted: z.boolean().optional(),
});

const listSectionsSchema = z.object({
  projectId: z.string().optional(),
  includeDeleted: z.boolean().optional(),
});

const getSectionSchema = z.object({
  id: z.string(),
  includeDeleted: z.boolean().optional(),
});

const addProjectSchema = z.object({
  title: z.string().min(1).max(MAX_TASK_TITLE_LENGTH),
  color: z.string().optional(),
  status: projectStatusSchema.optional(),
  areaId: z.string().nullable().optional(),
  isSequential: z.boolean().optional(),
  isFocused: z.boolean().optional(),
  dueDate: isoDateLikeSchema.nullable().optional(),
  reviewAt: isoDateLikeSchema.nullable().optional(),
  supportNotes: z.string().nullable().optional(),
});
const updateProjectSchema = z.object({
  id: z.string(),
  title: z.string().min(1).max(MAX_TASK_TITLE_LENGTH).optional(),
  color: z.string().nullable().optional(),
  status: projectStatusSchema.optional(),
  areaId: z.string().nullable().optional(),
  isSequential: z.boolean().optional(),
  isFocused: z.boolean().optional(),
  dueDate: isoDateLikeSchema.nullable().optional(),
  reviewAt: isoDateLikeSchema.nullable().optional(),
  supportNotes: z.string().nullable().optional(),
});
const deleteProjectSchema = z.object({
  id: z.string(),
});

const addSectionSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().min(1).max(MAX_TASK_TITLE_LENGTH),
  description: z.string().nullable().optional(),
  order: z.number().int().optional(),
  isCollapsed: z.boolean().optional(),
});

const updateSectionSchema = z.object({
  id: z.string(),
  title: z.string().min(1).max(MAX_TASK_TITLE_LENGTH).optional(),
  description: z.string().nullable().optional(),
  order: z.number().int().optional(),
  isCollapsed: z.boolean().optional(),
});

const deleteSectionSchema = z.object({
  id: z.string(),
});
const addAreaSchema = z.object({
  name: z.string().min(1).max(200),
  color: z.string().optional(),
  icon: z.string().optional(),
});
const updateAreaSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(200).optional(),
  color: z.string().nullable().optional(),
  icon: z.string().nullable().optional(),
});
const deleteAreaSchema = z.object({
  id: z.string(),
});
const addPersonSchema = z.object({
  name: z.string().min(1).max(200),
  note: z.string().nullable().optional(),
  referenceLink: z.string().nullable().optional(),
});
const updatePersonSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(200).optional(),
  note: z.string().nullable().optional(),
  referenceLink: z.string().nullable().optional(),
});
const renamePersonSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(200),
  updateTasks: z.boolean().optional(),
});
const deletePersonSchema = z.object({
  id: z.string(),
});

export const registerMindwtrTools = (
  server: McpServer,
  service: MindwtrService,
  readonly: boolean,
  options: { readonlyMessage?: string } = {},
) => {
  const withReadonlyMcpErrorHandling = <TInput>(
    scope: string,
    handler: (input: TInput) => Promise<McpToolResponse>,
  ) => withMcpErrorHandling(scope, async (input: TInput) => {
    if (readonly) throw new ReadOnlyError(options.readonlyMessage);
    return await handler(input);
  });

  server.registerTool(
    'mindwtr_list_tasks',
    {
      description: 'List tasks from the configured Mindwtr backend. Supports filtering by status, project, date range, and search. Supports sorting by various fields.',
      inputSchema: listTasksSchema,
    },
    withMcpErrorHandling('mindwtr_list_tasks', async (input) => {
      const tasks = await service.listTasks({
        ...input,
      });
      return createMcpTextResponse({ tasks });
    }),
  );

  server.registerTool(
    'mindwtr_list_projects',
    {
      description: 'List projects from the configured Mindwtr backend.',
      inputSchema: listProjectsSchema,
    },
    withMcpErrorHandling('mindwtr_list_projects', async () => {
      const projects = await service.listProjects();
      return createMcpTextResponse({ projects });
    }),
  );

  server.registerTool(
    'mindwtr_get_project',
    {
      description: 'Get a single project by ID from the configured Mindwtr backend.',
      inputSchema: getProjectSchema,
    },
    withMcpErrorHandling('mindwtr_get_project', async (input) => {
      const project = await service.getProject({ id: input.id, includeDeleted: input.includeDeleted });
      return createMcpTextResponse({ project });
    }),
  );

  server.registerTool(
    'mindwtr_list_sections',
    {
      description: 'List project sections from the configured Mindwtr backend. Optionally filter by projectId.',
      inputSchema: listSectionsSchema,
    },
    withMcpErrorHandling('mindwtr_list_sections', async (input) => {
      const sections = await service.listSections(input);
      return createMcpTextResponse({ sections });
    }),
  );

  server.registerTool(
    'mindwtr_get_section',
    {
      description: 'Get a single project section by ID from the configured Mindwtr backend.',
      inputSchema: getSectionSchema,
    },
    withMcpErrorHandling('mindwtr_get_section', async (input) => {
      const section = await service.getSection({ id: input.id, includeDeleted: input.includeDeleted });
      return createMcpTextResponse({ section });
    }),
  );

  server.registerTool(
    'mindwtr_list_areas',
    {
      description: 'List areas from the configured Mindwtr backend.',
      inputSchema: listAreasSchema,
    },
    withMcpErrorHandling('mindwtr_list_areas', async () => {
      const areas = await service.listAreas();
      return createMcpTextResponse({ areas });
    }),
  );

  server.registerTool(
    'mindwtr_list_people',
    {
      description: 'List managed people from the configured Mindwtr backend.',
      inputSchema: listPeopleSchema,
    },
    withMcpErrorHandling('mindwtr_list_people', async (input) => {
      const people = await service.listPeople(input);
      return createMcpTextResponse({ people });
    }),
  );

  server.registerTool(
    'mindwtr_get_person',
    {
      description: 'Get a single managed person by ID from the configured Mindwtr backend.',
      inputSchema: getPersonSchema,
    },
    withMcpErrorHandling('mindwtr_get_person', async (input) => {
      const person = await service.getPerson({ id: input.id, includeDeleted: input.includeDeleted });
      return createMcpTextResponse({ person });
    }),
  );

  server.registerTool(
    'mindwtr_add_task',
    {
      description: 'Add a task to the configured Mindwtr backend.',
      inputSchema: addTaskSchema,
    },
    withReadonlyMcpErrorHandling('mindwtr_add_task', async (input) => {
      const normalizedInput = normalizeAddTaskInput(input);
      const task = await service.addTask({
        ...normalizedInput,
      });
      return createMcpTextResponse({ task });
    }),
  );

  server.registerTool(
    'mindwtr_update_task',
    {
      description: 'Update a task in the configured Mindwtr backend.',
      inputSchema: updateTaskSchema,
    },
    withReadonlyMcpErrorHandling('mindwtr_update_task', async (input) => {
      const task = await service.updateTask({
        ...normalizeUpdateTaskInput(input),
      });
      return createMcpTextResponse({ task });
    }),
  );

  server.registerTool(
    'mindwtr_complete_task',
    {
      description: 'Mark a task as done in the configured Mindwtr backend.',
      inputSchema: completeTaskSchema,
    },
    withReadonlyMcpErrorHandling('mindwtr_complete_task', async (input) => {
      const task = await service.completeTask(input.id);
      return createMcpTextResponse({ task });
    }),
  );

  server.registerTool(
    'mindwtr_delete_task',
    {
      description: 'Soft-delete a task in the configured Mindwtr backend.',
      inputSchema: deleteTaskSchema,
    },
    withReadonlyMcpErrorHandling('mindwtr_delete_task', async (input) => {
      const task = await service.deleteTask(input.id);
      return createMcpTextResponse({ task });
    }),
  );

  server.registerTool(
    'mindwtr_get_task',
    {
      description: 'Get a single task by ID from the configured Mindwtr backend.',
      inputSchema: getTaskSchema,
    },
    withMcpErrorHandling('mindwtr_get_task', async (input) => {
      const task = await service.getTask({ id: input.id, includeDeleted: input.includeDeleted });
      return createMcpTextResponse({ task });
    }),
  );

  server.registerTool(
    'mindwtr_restore_task',
    {
      description: 'Restore a soft-deleted task in the configured Mindwtr backend.',
      inputSchema: restoreTaskSchema,
    },
    withReadonlyMcpErrorHandling('mindwtr_restore_task', async (input) => {
      const task = await service.restoreTask(input.id);
      return createMcpTextResponse({ task });
    }),
  );

  server.registerTool(
    'mindwtr_add_project',
    {
      description: 'Add a project to the configured Mindwtr backend.',
      inputSchema: addProjectSchema,
    },
    withReadonlyMcpErrorHandling('mindwtr_add_project', async (input) => {
      const project = await service.addProject(input);
      return createMcpTextResponse({ project });
    }),
  );

  server.registerTool(
    'mindwtr_update_project',
    {
      description: 'Update a project in the configured Mindwtr backend.',
      inputSchema: updateProjectSchema,
    },
    withReadonlyMcpErrorHandling('mindwtr_update_project', async (input) => {
      const project = await service.updateProject(input);
      return createMcpTextResponse({ project });
    }),
  );

  server.registerTool(
    'mindwtr_delete_project',
    {
      description: 'Soft-delete a project in the configured Mindwtr backend.',
      inputSchema: deleteProjectSchema,
    },
    withReadonlyMcpErrorHandling('mindwtr_delete_project', async (input) => {
      const project = await service.deleteProject(input.id);
      return createMcpTextResponse({ project });
    }),
  );

  server.registerTool(
    'mindwtr_add_section',
    {
      description: 'Add a project-scoped section to the configured Mindwtr backend.',
      inputSchema: addSectionSchema,
    },
    withReadonlyMcpErrorHandling('mindwtr_add_section', async (input) => {
      const section = await service.addSection(input);
      return createMcpTextResponse({ section });
    }),
  );

  server.registerTool(
    'mindwtr_update_section',
    {
      description: 'Update a project section in the configured Mindwtr backend.',
      inputSchema: updateSectionSchema,
    },
    withReadonlyMcpErrorHandling('mindwtr_update_section', async (input) => {
      const section = await service.updateSection(input);
      return createMcpTextResponse({ section });
    }),
  );

  server.registerTool(
    'mindwtr_delete_section',
    {
      description: 'Soft-delete a project section in the configured Mindwtr backend. Tasks in the section are kept and moved to no section by core.',
      inputSchema: deleteSectionSchema,
    },
    withReadonlyMcpErrorHandling('mindwtr_delete_section', async (input) => {
      const section = await service.deleteSection(input.id);
      return createMcpTextResponse({ section });
    }),
  );

  server.registerTool(
    'mindwtr_add_area',
    {
      description: 'Add an area to the configured Mindwtr backend.',
      inputSchema: addAreaSchema,
    },
    withReadonlyMcpErrorHandling('mindwtr_add_area', async (input) => {
      const area = await service.addArea(input);
      return createMcpTextResponse({ area });
    }),
  );

  server.registerTool(
    'mindwtr_update_area',
    {
      description: 'Update an area in the configured Mindwtr backend.',
      inputSchema: updateAreaSchema,
    },
    withReadonlyMcpErrorHandling('mindwtr_update_area', async (input) => {
      const area = await service.updateArea(input);
      return createMcpTextResponse({ area });
    }),
  );

  server.registerTool(
    'mindwtr_delete_area',
    {
      description: 'Soft-delete an area in the configured Mindwtr backend.',
      inputSchema: deleteAreaSchema,
    },
    withReadonlyMcpErrorHandling('mindwtr_delete_area', async (input) => {
      const area = await service.deleteArea(input.id);
      return createMcpTextResponse({ area });
    }),
  );

  server.registerTool(
    'mindwtr_add_person',
    {
      description: 'Add a managed person to the configured Mindwtr backend.',
      inputSchema: addPersonSchema,
    },
    withReadonlyMcpErrorHandling('mindwtr_add_person', async (input) => {
      const person = await service.addPerson(input);
      return createMcpTextResponse({ person });
    }),
  );

  server.registerTool(
    'mindwtr_update_person',
    {
      description: 'Update managed person metadata in the configured Mindwtr backend.',
      inputSchema: updatePersonSchema,
    },
    withReadonlyMcpErrorHandling('mindwtr_update_person', async (input) => {
      const person = await service.updatePerson(input);
      return createMcpTextResponse({ person });
    }),
  );

  server.registerTool(
    'mindwtr_rename_person',
    {
      description: 'Rename a managed person. By default, matching task assignees are updated too.',
      inputSchema: renamePersonSchema,
    },
    withReadonlyMcpErrorHandling('mindwtr_rename_person', async (input) => {
      const person = await service.renamePerson(input);
      return createMcpTextResponse({ person });
    }),
  );

  server.registerTool(
    'mindwtr_delete_person',
    {
      description: 'Soft-delete a managed person in the configured Mindwtr backend.',
      inputSchema: deletePersonSchema,
    },
    withReadonlyMcpErrorHandling('mindwtr_delete_person', async (input) => {
      const person = await service.deletePerson(input.id);
      return createMcpTextResponse({ person });
    }),
  );
};

const attachLifecycleHandlers = (service: MindwtrService) => {
  const closeService = () => {
    void service.close().catch((error) => {
      logError('Failed to close database connection', error);
    });
  };

  process.on('exit', () => {
    closeService();
  });
  process.on('SIGINT', () => {
    closeService();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    closeService();
    process.exit(0);
  });
};

export async function startMcpServer(argv: string[] = process.argv.slice(2)) {
  const flags = parseArgs(argv);

  const config = resolveServerConfig(flags);

  const service = config.backend === 'cloud'
    ? createCloudService({
      url: config.cloudUrl,
      token: config.cloudToken,
      allowInsecureHttp: config.allowInsecureHttp,
    })
    : createService({ dbPath: config.dbPath, readonly: config.readonly });
  attachLifecycleHandlers(service);

  const server = new McpServer({
    name: 'mindwtr-mcp',
    version: resolvePackageVersion(),
  });

  registerMindwtrTools(server, service, config.readonly, {
    readonlyMessage: config.backend === 'cloud'
      ? 'Cloud MCP mode is read-only. Use the local database backend with --write for edits.'
      : undefined,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  if (config.keepAlive) {
    process.stdin.resume();
    process.stdin.on('end', () => process.exit(0));
    setInterval(() => {}, 1 << 30);
  }
}

if (import.meta.main) {
  startMcpServer().catch((error) => {
    logError('Failed to start server', error);
    process.exit(1);
  });
}

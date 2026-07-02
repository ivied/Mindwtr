import { cloudGetJson, normalizeCloudUrl, type AppData } from '@mindwtr/core';

import { NotFoundError, ReadOnlyError, ValidationError } from './errors.js';
import type {
  AddAreaInput,
  AddPersonInput,
  AddProjectInput,
  AddSectionInput,
  MindwtrService,
  RenamePersonInput,
  UpdateAreaInput,
  UpdatePersonInput,
  UpdateProjectInput,
  UpdateSectionInput,
} from './service.js';
import type {
  AddTaskInput,
  Area,
  GetPersonInput,
  GetProjectInput,
  GetSectionInput,
  GetTaskInput,
  ListPeopleInput,
  ListSectionsInput,
  ListTasksInput,
  Person,
  Project,
  Section,
  Task,
  TaskRow,
  UpdateTaskInput,
} from './queries.js';

export type CloudServiceOptions = {
  url: string;
  token: string;
  allowInsecureHttp?: boolean;
  fetcher?: typeof fetch;
  timeoutMs?: number;
};

const CLOUD_READONLY_MESSAGE = 'Cloud MCP mode is read-only. Use the local database backend with --write for edits.';

type CloudData = AppData & { people: NonNullable<AppData['people']> };

const emptyAppData = (): CloudData => ({
  tasks: [],
  projects: [],
  sections: [],
  areas: [],
  people: [],
  settings: {},
});

type SoftDeleted = { deletedAt?: string | null };

const isLive = <T extends SoftDeleted>(item: T): boolean => !item.deletedAt;

const normalizeCloudData = (data: AppData | null): CloudData => ({
  ...emptyAppData(),
  ...(data ?? {}),
  tasks: Array.isArray(data?.tasks) ? data.tasks : [],
  projects: Array.isArray(data?.projects) ? data.projects : [],
  sections: Array.isArray(data?.sections) ? data.sections : [],
  areas: Array.isArray(data?.areas) ? data.areas : [],
  people: Array.isArray(data?.people) ? data.people : [],
  settings: data?.settings && typeof data.settings === 'object' ? data.settings : {},
});

const normalizeLimit = (value: number | undefined): number => (
  Number.isFinite(value) ? Math.max(1, Math.min(500, value as number)) : 200
);

const normalizeOffset = (value: number | undefined): number => (
  Number.isFinite(value) ? Math.max(0, value as number) : 0
);

const dateKey = (value: string | undefined | null): string => (
  typeof value === 'string' && value.length >= 10 ? value.slice(0, 10) : ''
);

const matchesSearch = (task: Task, search: string | undefined): boolean => {
  const query = search?.trim().toLowerCase();
  if (!query) return true;
  const haystack = [
    task.title,
    task.description,
  ]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  return haystack.includes(query);
};

const priorityRank: Record<string, number> = {
  urgent: 4,
  high: 3,
  medium: 2,
  low: 1,
};

const taskSortValue = (task: Task, sortBy: NonNullable<ListTasksInput['sortBy']>): string | number => {
  if (sortBy === 'priority') return task.priority ? priorityRank[task.priority] ?? 0 : 0;
  const value = task[sortBy];
  return typeof value === 'string' ? value : '';
};

const sortTasks = (tasks: Task[], input: ListTasksInput): Task[] => {
  const sortBy = input.sortBy ?? 'updatedAt';
  const direction = input.sortOrder === 'asc' ? 1 : -1;
  return [...tasks].sort((left, right) => {
    const leftValue = taskSortValue(left, sortBy);
    const rightValue = taskSortValue(right, sortBy);
    if (leftValue < rightValue) return -1 * direction;
    if (leftValue > rightValue) return direction;
    return left.id.localeCompare(right.id);
  });
};

const mapProject = (project: AppData['projects'][number]): Project => ({
  ...project,
  orderNum: (project as Project).orderNum ?? project.order,
});

const mapArea = (area: AppData['areas'][number]): Area => area;
const mapSection = (section: AppData['sections'][number]): Section => section;
const mapPerson = (person: CloudData['people'][number]): Person => person;
const mapTask = (task: AppData['tasks'][number]): TaskRow => task;

const readOnly = async (): Promise<never> => {
  throw new ReadOnlyError(CLOUD_READONLY_MESSAGE);
};

export const createCloudService = (options: CloudServiceOptions): MindwtrService => {
  const url = options.url.trim();
  const token = options.token.trim();
  if (!url) throw new ValidationError('Cloud URL is required');
  if (!token) throw new ValidationError('Cloud token is required');
  const dataUrl = normalizeCloudUrl(url);

  const readData = async (): Promise<CloudData> => normalizeCloudData(await cloudGetJson<AppData>(dataUrl, {
    token,
    allowInsecureHttp: options.allowInsecureHttp,
    fetcher: options.fetcher,
    timeoutMs: options.timeoutMs,
  }));

  const findTask = async (input: GetTaskInput): Promise<TaskRow> => {
    const data = await readData();
    const task = data.tasks.find((item) => item.id === input.id && (input.includeDeleted || isLive(item)));
    if (!task) throw new NotFoundError(`Task not found: ${input.id}`);
    return mapTask(task);
  };

  const findProject = async (input: GetProjectInput): Promise<Project> => {
    const data = await readData();
    const project = data.projects.find((item) => item.id === input.id && (input.includeDeleted || isLive(item)));
    if (!project) throw new NotFoundError(`Project not found: ${input.id}`);
    return mapProject(project);
  };

  const findSection = async (input: GetSectionInput): Promise<Section> => {
    const data = await readData();
    const section = data.sections.find((item) => item.id === input.id && (input.includeDeleted || isLive(item)));
    if (!section) throw new NotFoundError(`Section not found: ${input.id}`);
    return mapSection(section);
  };

  const findPerson = async (input: GetPersonInput): Promise<Person> => {
    const data = await readData();
    const person = data.people.find((item) => item.id === input.id && (input.includeDeleted || isLive(item)));
    if (!person) throw new NotFoundError(`Person not found: ${input.id}`);
    return mapPerson(person);
  };

  return {
    listTasks: async (input) => {
      const data = await readData();
      const dueDateFrom = dateKey(input.dueDateFrom);
      const dueDateTo = dateKey(input.dueDateTo);
      const filtered = data.tasks.filter((task) => {
        if (!input.includeDeleted && !isLive(task)) return false;
        if (input.status && input.status !== 'all' && task.status !== input.status) return false;
        if (input.projectId && task.projectId !== input.projectId) return false;
        const due = dateKey(task.dueDate);
        if (dueDateFrom && (!due || due < dueDateFrom)) return false;
        if (dueDateTo && (!due || due > dueDateTo)) return false;
        return matchesSearch(task, input.search);
      });
      const offset = normalizeOffset(input.offset);
      return sortTasks(filtered, input).slice(offset, offset + normalizeLimit(input.limit)).map(mapTask);
    },
    listProjects: async () => {
      const data = await readData();
      return data.projects.filter(isLive).map(mapProject);
    },
    listSections: async (input: ListSectionsInput = {}) => {
      const data = await readData();
      return data.sections
        .filter((section) => (input.includeDeleted || isLive(section)) && (!input.projectId || section.projectId === input.projectId))
        .sort((left, right) => (
          left.projectId.localeCompare(right.projectId)
          || (left.order ?? 0) - (right.order ?? 0)
          || left.title.localeCompare(right.title)
        ))
        .map(mapSection);
    },
    listAreas: async () => {
      const data = await readData();
      return data.areas
        .filter(isLive)
        .sort((left, right) => ((left.order ?? 0) - (right.order ?? 0)) || right.updatedAt.localeCompare(left.updatedAt))
        .map(mapArea);
    },
    listPeople: async (input: ListPeopleInput = {}) => {
      const data = await readData();
      return data.people
        .filter((person) => input.includeDeleted || isLive(person))
        .sort((left, right) => left.name.toLowerCase().localeCompare(right.name.toLowerCase()) || right.updatedAt.localeCompare(left.updatedAt))
        .map(mapPerson);
    },
    getTask: findTask,
    getProject: findProject,
    getSection: findSection,
    getPerson: findPerson,
    addTask: (_input: AddTaskInput) => readOnly(),
    updateTask: (_input: UpdateTaskInput) => readOnly(),
    completeTask: (_id: string) => readOnly(),
    deleteTask: (_id: string) => readOnly(),
    restoreTask: (_id: string) => readOnly(),
    addProject: (_input: AddProjectInput) => readOnly(),
    updateProject: (_input: UpdateProjectInput) => readOnly(),
    deleteProject: (_id: string) => readOnly(),
    addSection: (_input: AddSectionInput) => readOnly(),
    updateSection: (_input: UpdateSectionInput) => readOnly(),
    deleteSection: (_id: string) => readOnly(),
    addArea: (_input: AddAreaInput) => readOnly(),
    updateArea: (_input: UpdateAreaInput) => readOnly(),
    deleteArea: (_id: string) => readOnly(),
    addPerson: (_input: AddPersonInput) => readOnly(),
    updatePerson: (_input: UpdatePersonInput) => readOnly(),
    renamePerson: (_input: RenamePersonInput) => readOnly(),
    deletePerson: (_id: string) => readOnly(),
    close: async () => undefined,
  };
};

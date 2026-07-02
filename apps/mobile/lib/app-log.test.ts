import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storeState = {
  settings: {
    diagnostics: {
      loggingEnabled: true,
    },
  },
};

const legacyFileSystemMocks = vi.hoisted(() => {
  const files = new Map<string, string>();
  const directories = new Set<string>();
  const documentDirectory = 'file://document/';
  const logDir = 'file://document/logs';

  return {
    documentDirectory: documentDirectory as string | null,
    files,
    deleteAsync: vi.fn(async (uri: string) => {
      files.delete(uri);
      directories.delete(uri);
    }),
    getInfoAsync: vi.fn(async (uri: string) => ({
      exists: files.has(uri) || directories.has(uri),
      isDirectory: directories.has(uri),
      size: files.get(uri)?.length ?? 0,
    })),
    makeDirectoryAsync: vi.fn(async (uri: string) => {
      directories.add(uri);
    }),
    readAsStringAsync: vi.fn(async (uri: string) => files.get(uri) ?? ''),
    reset: () => {
      files.clear();
      directories.clear();
      directories.add(logDir);
      legacyFileSystemMocks.documentDirectory = documentDirectory;
    },
    writeAsStringAsync: vi.fn(async (uri: string, contents: string) => {
      files.set(uri, contents);
    }),
  };
});

vi.mock('@mindwtr/core', () => ({
  getBreadcrumbs: () => [],
  sanitizeForLog: (value: string) => value,
  sanitizeLogContext: (value?: Record<string, unknown>) => (
    value
      ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, String(entry)]))
      : undefined
  ),
  sanitizeUrl: (value: string) => value,
  useTaskStore: {
    getState: () => storeState,
  },
}));

vi.mock('expo-file-system', () => ({
  Directory: class Directory {
    exists = false;
    uri: string;
    constructor(uri: string) {
      this.uri = uri;
    }
    create() {}
    delete() {}
  },
  File: class File {
    exists = false;
    uri: string;
    constructor(uri: string) {
      this.uri = uri;
    }
    create() {}
    delete() {}
    text = async () => '';
    write() {}
  },
  Paths: {},
}));

vi.mock('expo-file-system/legacy', () => legacyFileSystemMocks);

import { clearLog, ensureLogFilePath, getLogPath, logInfo, setLogBackend, type LogBackend } from './app-log';

describe('app-log', () => {
  const backend: Required<LogBackend> = {
    appendLogLine: vi.fn(async () => 'file://test.log'),
    getLogPath: vi.fn(async () => 'file://test.log'),
    ensureLogFilePath: vi.fn(async () => 'file://test.log'),
    clearLog: vi.fn(async () => undefined),
  };

  beforeEach(() => {
    vi.stubGlobal('__DEV__', true);
    vi.clearAllMocks();
    legacyFileSystemMocks.reset();
    storeState.settings = {
      diagnostics: {
        loggingEnabled: true,
      },
    };
    setLogBackend(backend);
  });

  afterEach(() => {
    setLogBackend(null);
    vi.unstubAllGlobals();
  });

  it('routes log writes through an injected backend', async () => {
    await expect(logInfo('Hello', { scope: 'sync' })).resolves.toBe('file://test.log');
    expect(backend.appendLogLine).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'info',
        scope: 'sync',
        message: 'Hello',
      }),
      { force: undefined },
    );
  });

  it('preserves the logging-enabled guard when a custom backend is installed', async () => {
    storeState.settings = {
      diagnostics: {
        loggingEnabled: false,
      },
    };

    await expect(logInfo('Hello', { scope: 'sync' })).resolves.toBeNull();
    expect(backend.appendLogLine).not.toHaveBeenCalled();

    await expect(logInfo('Forced', { scope: 'sync', force: true })).resolves.toBe('file://test.log');
    expect(backend.appendLogLine).toHaveBeenCalledTimes(1);
  });

  it('delegates log file helpers to the injected backend', async () => {
    await expect(getLogPath()).resolves.toBe('file://test.log');
    await expect(ensureLogFilePath()).resolves.toBe('file://test.log');
    await clearLog();

    expect(backend.getLogPath).toHaveBeenCalledTimes(1);
    expect(backend.ensureLogFilePath).toHaveBeenCalledTimes(1);
    expect(backend.clearLog).toHaveBeenCalledTimes(1);
  });

  it('uses the legacy Expo file-system fallback without warning when the primary log file is unavailable', async () => {
    setLogBackend(null);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await expect(logInfo('Hello', { scope: 'sync' })).resolves.toBe('file://document/logs/mindwtr.log');
      expect(legacyFileSystemMocks.writeAsStringAsync).toHaveBeenCalledWith(
        'file://document/logs/mindwtr.log',
        expect.stringContaining('Hello'),
        { encoding: 'utf8' },
      );
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('falls back to the dev console when Expo Go cannot provide a writable log file', async () => {
    setLogBackend(null);
    legacyFileSystemMocks.documentDirectory = null;
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await expect(logInfo('Hello console', { scope: 'sync' })).resolves.toBeNull();
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('[Mindwtr sync] Hello console'));
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('append log line failed'));
    } finally {
      infoSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});

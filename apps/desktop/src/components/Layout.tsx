import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import {
    Calendar,
    Inbox,
    CheckSquare,
    Archive,
    Kanban,
    Tag,
    CheckCircle2,
    ChevronDown,
    Folder,
    Settings,
    Target,
    Search,
    ChevronsLeft,
    ChevronsRight,
    Trash2,
    PauseCircle,
    Book,
    Clock3,
    BookOpen,
    AlertTriangle,
    Sparkles,
    BookMarked,
    Bot,
    Radar,
    Plus,
    RefreshCw,
    type LucideIcon,
} from 'lucide-react';
import { isProceduralAvailable } from '../lib/procedural-client';
import { isGlossaryAvailable } from '../lib/glossary-client';
import { RecordingBanner } from './RecordingBanner';
import { SafeReloadButton } from './SafeReloadButton';
import { cn } from '../lib/utils';
import { shallow, useTaskStore, safeFormatDate, tFallback } from '@mindwtr/core';
import { useLanguage } from '../contexts/language-context';
import { useUiStore } from '../store/ui-store';
import { useObsidianStore } from '../store/obsidian-store';
import { reportError } from '../lib/report-error';
import { ToastHost } from './ToastHost';
import { AREA_FILTER_ALL, resolveAreaFilter, taskMatchesAreaFilter } from '@mindwtr/core';
import { SyncService } from '../lib/sync-service';
import { SidebarAreaFilter } from './ui/SidebarAreaFilter';
import { hasCalendarTaskDragData } from '../lib/calendar-task-drag';

interface LayoutProps {
    children: React.ReactNode;
    currentView: string;
    onViewChange: (view: string) => void;
}

type NavItem = {
    id: string;
    labelKey?: string;
    fallbackLabel?: string;
    icon: LucideIcon;
    count?: number;
    tone?: 'primary' | 'normal' | 'recessed';
};

type NavSection = {
    key: string;
    label: string;
    items: NavItem[];
};

const SECTION_COLLAPSE_STORAGE_KEY = 'mindwtr:sidebar:collapsedSections';
const DEFAULT_COLLAPSED_SECTION_KEYS: string[] = [];

function createDefaultCollapsedSections(): Set<string> {
    return new Set(DEFAULT_COLLAPSED_SECTION_KEYS);
}

function loadCollapsedSections(): Set<string> {
    if (typeof window === 'undefined') return new Set();
    try {
        const raw = window.localStorage.getItem(SECTION_COLLAPSE_STORAGE_KEY);
        if (!raw) return createDefaultCollapsedSections();
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? new Set(parsed.filter((v): v is string => typeof v === 'string')) : createDefaultCollapsedSections();
    } catch {
        return createDefaultCollapsedSections();
    }
}

function saveCollapsedSections(keys: Set<string>) {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage.setItem(SECTION_COLLAPSE_STORAGE_KEY, JSON.stringify(Array.from(keys)));
    } catch {
        // storage unavailable — fall back to in-memory only
    }
}

export function Layout({ children, currentView, onViewChange }: LayoutProps) {
    const { tasks, projects, areas, settings, updateSettings, error, setError } = useTaskStore((state) => ({
        tasks: state.tasks,
        projects: state.projects,
        areas: state.areas,
        settings: state.settings,
        updateSettings: state.updateSettings,
        error: state.error,
        setError: state.setError,
    }), shallow);
    const { t } = useLanguage();
    const isCollapsed = settings?.sidebarCollapsed ?? false;
    const calendarDragNavTimeoutRef = useRef<number | null>(null);
    const isFocusMode = useUiStore((state) => state.isFocusMode);
    const showToast = useUiStore((state) => state.showToast);
    const isObsidianEnabled = useObsidianStore((state) => state.config.enabled);
    const [syncStatus, setSyncStatus] = useState(() => SyncService.getSyncStatus());
    const [isManualSyncing, setIsManualSyncing] = useState(false);
    const [isOnline, setIsOnline] = useState(() => (typeof navigator !== 'undefined' ? navigator.onLine : true));
    const [cleartextSyncWarning, setCleartextSyncWarning] = useState<string | null>(null);
    const searchShortcutHint = useMemo(() => (
        typeof navigator !== 'undefined' && /mac/i.test(navigator.platform) ? '⌘K' : 'Ctrl+K'
    ), []);
    const lastSyncAt = settings?.lastSyncAt;
    const lastSyncStatus = settings?.lastSyncStatus;
    const lastSyncError = settings?.lastSyncError?.trim();
    const lastSyncStats = settings?.lastSyncStats;

    // Compute sync freshness bucket on a 60-second timer instead of every render
    // to prevent idle re-render flicker from Date.now() changing each frame.
    const getSyncFreshnessBucket = useCallback((syncAt: string | undefined): 'fresh' | 'stale' | 'old' | 'none' => {
        if (!syncAt) return 'none';
        const ageMs = Math.max(0, Date.now() - Date.parse(syncAt));
        if (ageMs > 2 * 60 * 60 * 1000) return 'old';
        if (ageMs > 30 * 60 * 1000) return 'stale';
        return 'fresh';
    }, []);
    const [syncFreshness, setSyncFreshness] = useState(() => getSyncFreshnessBucket(lastSyncAt));
    const lastSyncAtRef = useRef(lastSyncAt);
    const shownConflictToastKeyRef = useRef<string | null>(null);
    lastSyncAtRef.current = lastSyncAt;
    useEffect(() => {
        setSyncFreshness(getSyncFreshnessBucket(lastSyncAt));
        const timer = setInterval(() => {
            setSyncFreshness(getSyncFreshnessBucket(lastSyncAtRef.current));
        }, 60_000);
        return () => clearInterval(timer);
    }, [lastSyncAt, getSyncFreshnessBucket]);

    const syncConflictNotice = tFallback(t,
        'settings.syncConflictNotice',
        'Sync conflict resolved with last-write-wins. Open sync settings to review the details.'
    );
    const syncConflictToastKey = useMemo(() => {
        if (lastSyncStatus !== 'conflict') return null;
        if (!lastSyncStats) return `${lastSyncAt ?? 'unknown'}:${lastSyncStatus}`;
        const conflictEntities = [
            ['tasks', lastSyncStats.tasks],
            ['projects', lastSyncStats.projects],
            ['sections', lastSyncStats.sections],
            ['areas', lastSyncStats.areas],
        ] as const;
        const countParts = conflictEntities.map(([name, stats]) => `${name}:${stats.conflicts || 0}`);
        const conflictIds = conflictEntities
            .flatMap(([, stats]) => stats.conflictIds || [])
            .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
            .sort();
        const conflictSamples = conflictEntities
            .flatMap(([name, stats]) => (stats.conflictSamples || []).map((sample) => [
                name,
                sample.id,
                sample.winner,
                (sample.reasons || []).join('+'),
                sample.localComparableHash,
                sample.incomingComparableHash,
            ].join(':')))
            .sort();
        return `${countParts.join('|')}:ids:${conflictIds.join(',')}:samples:${conflictSamples.join(',')}`;
    }, [lastSyncAt, lastSyncStats, lastSyncStatus]);
    useEffect(() => {
        if (lastSyncStatus !== 'conflict' || !syncConflictToastKey) return;
        if (shownConflictToastKeyRef.current === syncConflictToastKey) return;
        shownConflictToastKeyRef.current = syncConflictToastKey;
        showToast(syncConflictNotice, 'info', 6000);
    }, [lastSyncStatus, showToast, syncConflictNotice, syncConflictToastKey]);

    const syncFreshnessDotClass = syncStatus.inFlight
        ? 'bg-emerald-400'
        : !isOnline
        ? 'bg-destructive'
        : lastSyncStatus === 'error'
            ? 'bg-orange-400'
            : lastSyncStatus === 'conflict'
                ? 'bg-amber-400'
            : syncFreshness === 'none'
                ? 'bg-muted-foreground/40'
                : syncFreshness === 'old'
                    ? 'bg-destructive'
                    : syncFreshness === 'stale'
                        ? 'bg-amber-400'
                        : 'bg-emerald-400';
    const fullSyncTimestamp = lastSyncAt ? safeFormatDate(lastSyncAt, 'PPpp', lastSyncAt) : t('settings.lastSyncNever');
    const syncTooltip = !isOnline
        ? (t('common.offline') || 'Offline')
        : lastSyncStatus === 'error' && lastSyncError
            ? `${tFallback(t, 'settings.lastSyncError', 'Sync failed')}: ${lastSyncError}\n${tFallback(t, 'settings.lastSync', 'Last sync')}: ${fullSyncTimestamp}`
            : lastSyncStatus === 'conflict'
                ? `${tFallback(t, 'settings.lastSyncConflict', 'Conflicts resolved')}\n${syncConflictNotice}\n${tFallback(t, 'settings.lastSync', 'Last sync')}: ${fullSyncTimestamp}`
            : `${tFallback(t, 'settings.lastSync', 'Last sync')}: ${fullSyncTimestamp}`;
    const syncStatusLabel = syncStatus.inFlight
        ? tFallback(t, 'settings.syncing', 'Syncing...')
        : !isOnline
            ? tFallback(t, 'common.offline', 'Offline')
            : lastSyncStatus === 'error'
                ? tFallback(t, 'settings.lastSyncError', 'Sync failed')
                : lastSyncStatus === 'conflict'
                    ? tFallback(t, 'settings.lastSyncConflict', 'Conflicts resolved')
                    : syncFreshness === 'old'
                        ? tFallback(t, 'settings.syncStatusOld', 'Old')
                        : syncFreshness === 'stale'
                            ? tFallback(t, 'settings.syncStatusStale', 'Stale')
                            : syncFreshness === 'fresh'
                                ? tFallback(t, 'settings.syncStatusFresh', 'Fresh')
                                : tFallback(t, 'settings.syncStatusNever', 'Not synced');
    const syncStatusLabelClass = syncStatus.inFlight
        ? 'text-muted-foreground'
        : !isOnline || lastSyncStatus === 'error' || syncFreshness === 'old'
        ? 'text-destructive'
        : lastSyncStatus === 'conflict' || syncFreshness === 'stale'
            ? 'text-amber-600 dark:text-amber-300'
            : 'text-muted-foreground';
    const syncNowLabel = tFallback(t, 'settings.syncNow', 'Sync now');
    const manualSyncBusy = syncStatus.inFlight || isManualSyncing;
    const formatCompactSyncTime = useCallback((iso: string) => {
        const date = new Date(iso);
        if (Number.isNaN(date.getTime())) return iso;
        return new Intl.DateTimeFormat(undefined, {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        }).format(date);
    }, []);
    const compactSyncTimeLabel = lastSyncAt
        ? formatCompactSyncTime(lastSyncAt)
        : tFallback(t, 'settings.lastSyncNever', 'Never');
    const dismissLabel = t('common.dismiss');
    const dismissText = dismissLabel && dismissLabel !== 'common.dismiss' ? dismissLabel : 'Dismiss';
    const areaById = useMemo(() => new Map(areas.map((area) => [area.id, area])), [areas]);
    const projectMap = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
    const resolvedAreaFilter = useMemo(
        () => resolveAreaFilter(settings?.filters?.areaId, areas),
        [settings?.filters?.areaId, areas],
    );
    const sortedAreas = useMemo(() => [...areas].sort((a, b) => a.order - b.order), [areas]);
    const inboxCount = useMemo(() => {
        let count = 0;
        for (const task of tasks) {
            if (task.deletedAt) continue;
            if (task.status !== 'inbox') continue;
            if (!taskMatchesAreaFilter(task, resolvedAreaFilter, projectMap, areaById)) continue;
            count += 1;
        }
        return count;
    }, [tasks, resolvedAreaFilter, projectMap, areaById]);
    const waitingCount = useMemo(() => {
        let count = 0;
        for (const task of tasks) {
            if (task.deletedAt) continue;
            if (task.status !== 'waiting') continue;
            if (!taskMatchesAreaFilter(task, resolvedAreaFilter, projectMap, areaById)) continue;
            count += 1;
        }
        return count;
    }, [tasks, resolvedAreaFilter, projectMap, areaById]);
    const aiAgentCount = useMemo(() => {
        let count = 0;
        for (const task of tasks) {
            if (task.deletedAt) continue;
            if (task.assignedTo !== '@ai-agent') continue;
            if (task.status === 'done' || task.status === 'archived') continue;
            if (!taskMatchesAreaFilter(task, resolvedAreaFilter, projectMap, areaById)) continue;
            count += 1;
        }
        return count;
    }, [tasks, resolvedAreaFilter, projectMap, areaById]);
    const wideViews = new Set([
        'inbox',
        'next',
        'focus',
        'someday',
        'reference',
        'waiting',
        'done',
        'archived',
        'trash',
        'review',
        'projects',
        'contexts',
        'search',
        'agenda',
        'obsidian',
        'ai-agent',
    ]);
    const isWideView = wideViews.has(currentView);
    const fullWidthViews = new Set([
        'board',
        'projects',
        'contexts',
        'obsidian',
        'settings',
        'control-center',
    ]);
    const isFullWidthView = fullWidthViews.has(currentView);

    const navSections = useMemo<NavSection[]>(() => ([
        {
            key: 'focus',
            label: t('nav.sectionFocus') || 'Focus',
            items: [
                { id: 'inbox', labelKey: 'nav.inbox', icon: Inbox, count: inboxCount, tone: 'primary' },
                { id: 'agenda', labelKey: 'nav.agenda', icon: Target, tone: 'primary' },
                // Waiting promoted into Focus: most AI-suggested cards land
                // here and the user wanted one-click visibility instead of
                // hunting through Lists.
                { id: 'waiting', labelKey: 'nav.waiting', icon: PauseCircle, count: waitingCount },
                // AI Agent lane: tasks the Enricher delegated to @ai-agent.
                // Their `status` stays accurate per GTD (next/waiting); this
                // view filters by `assignedTo` so delegated work doesn't
                // pollute the real Next/Waiting lists.
                { id: 'ai-agent', labelKey: 'nav.aiAgent', fallbackLabel: 'AI Agent', icon: Bot, count: aiAgentCount },
            ],
        },
        {
            key: 'lists',
            label: t('nav.sectionLists') || 'Lists',
            items: [
                { id: 'projects', labelKey: 'nav.projects', icon: Folder, tone: 'primary' },
                { id: 'someday', labelKey: 'nav.someday', icon: Clock3 },
                { id: 'reference', labelKey: 'nav.reference', icon: Book },
            ],
        },
        {
            key: 'organize',
            label: t('nav.sectionOrganize') || 'Organize',
            items: [
                { id: 'calendar', labelKey: 'nav.calendar', icon: Calendar },
                { id: 'review', labelKey: 'nav.review', icon: CheckCircle2 },
                { id: 'contexts', labelKey: 'nav.contexts', icon: Tag },
                ...(isObsidianEnabled
                    ? [{ id: 'obsidian', labelKey: 'nav.obsidian', fallbackLabel: 'Obsidian', icon: BookOpen }]
                    : []),
                ...(isProceduralAvailable()
                    ? [{ id: 'ai-playbook', labelKey: 'nav.aiPlaybook', fallbackLabel: 'AI Playbook', icon: Sparkles }]
                    : []),
                ...(isGlossaryAvailable()
                    ? [{ id: 'glossary-onboarding', labelKey: 'nav.glossaryOnboarding', fallbackLabel: 'Словарь', icon: BookMarked }]
                    : []),
                { id: 'control-center', labelKey: 'nav.controlCenter', fallbackLabel: 'Центр управления', icon: Radar },
                { id: 'board', labelKey: 'nav.board', icon: Kanban },
            ],
        },
        {
            key: 'archive',
            label: t('nav.sectionArchive') || 'Archive',
            items: [
                { id: 'done', labelKey: 'nav.done', icon: CheckSquare, tone: 'recessed' },
                { id: 'archived', labelKey: 'nav.archived', icon: Archive, tone: 'recessed' },
                { id: 'trash', labelKey: 'nav.trash', icon: Trash2, tone: 'recessed' },
            ],
        },
    ]), [inboxCount, waitingCount, aiAgentCount, isObsidianEnabled, t]);

    const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => loadCollapsedSections());

    useEffect(() => {
        saveCollapsedSections(collapsedSections);
    }, [collapsedSections]);

    // Auto-expand the section containing the active view so it's never hidden.
    useEffect(() => {
        const activeSection = navSections.find((section) => section.items.some((item) => item.id === currentView));
        if (!activeSection) return;
        setCollapsedSections((prev) => {
            if (!prev.has(activeSection.key)) return prev;
            const next = new Set(prev);
            next.delete(activeSection.key);
            return next;
        });
    }, [currentView, navSections]);

    const toggleSection = useCallback((key: string) => {
        setCollapsedSections((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    }, []);
    const clearCalendarDragNavTimeout = useCallback(() => {
        if (calendarDragNavTimeoutRef.current === null) return;
        window.clearTimeout(calendarDragNavTimeoutRef.current);
        calendarDragNavTimeoutRef.current = null;
    }, []);

    useEffect(() => clearCalendarDragNavTimeout, [clearCalendarDragNavTimeout]);

    const handleCalendarNavDragEnter = useCallback((event: DragEvent<HTMLButtonElement>) => {
        if (!hasCalendarTaskDragData(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        if (currentView === 'calendar' || calendarDragNavTimeoutRef.current !== null) return;
        calendarDragNavTimeoutRef.current = window.setTimeout(() => {
            onViewChange('calendar');
            calendarDragNavTimeoutRef.current = null;
        }, 350);
    }, [currentView, onViewChange]);
    const handleCalendarNavDragOver = useCallback((event: DragEvent<HTMLButtonElement>) => {
        if (!hasCalendarTaskDragData(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
    }, []);
    const handleCalendarNavDragLeave = useCallback((event: DragEvent<HTMLButtonElement>) => {
        const relatedTarget = event.relatedTarget;
        if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) return;
        clearCalendarDragNavTimeout();
    }, [clearCalendarDragNavTimeout]);
    const handleCalendarNavDrop = useCallback((event: DragEvent<HTMLButtonElement>) => {
        if (!hasCalendarTaskDragData(event.dataTransfer)) return;
        event.preventDefault();
        clearCalendarDragNavTimeout();
        if (currentView !== 'calendar') {
            onViewChange('calendar');
        }
    }, [clearCalendarDragNavTimeout, currentView, onViewChange]);

    const triggerSearch = () => {
        window.dispatchEvent(new CustomEvent('mindwtr:open-search'));
    };

    const triggerInboxCapture = () => {
        window.dispatchEvent(new CustomEvent('mindwtr:quick-add', {
            detail: { initialProps: { status: 'inbox' } },
        }));
    };
    const addTaskLabel = tFallback(t, 'nav.addTask', 'Add Task');
    const inboxLabel = tFallback(t, 'nav.inbox', 'Inbox');
    const inboxCaptureLabel = `${addTaskLabel} (${inboxLabel})`;
    const searchTitleLabel = tFallback(t, 'search.title', 'Search');
    const searchScopeLabel = tFallback(t, 'search.scopeHint', 'Tasks, projects, people');

    const savedSearches = settings?.savedSearches || [];

    const toggleSidebar = () => {
        updateSettings({ sidebarCollapsed: !isCollapsed }).catch((error) => reportError('Failed to update settings', error));
    };

    const handleManualSyncNow = useCallback(async () => {
        if (manualSyncBusy) return;
        setIsManualSyncing(true);
        try {
            const result = await SyncService.performSync();
            if (result.skipped === 'requeued') {
                showToast('Local changes arrived during sync. Retry queued.', 'info');
            } else if (result.success) {
                showToast(tFallback(t, 'settings.lastSyncSuccess', 'Sync completed'), 'success');
            } else {
                showToast(result.error || tFallback(t, 'settings.lastSyncError', 'Sync failed'), 'error');
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            reportError('Sync failed', error);
            showToast(`${tFallback(t, 'settings.lastSyncError', 'Sync failed')}: ${message}`, 'error');
        } finally {
            setIsManualSyncing(false);
        }
    }, [manualSyncBusy, showToast, t]);

    useEffect(() => {
        if (areas.length === 0) return;
        if (!settings?.filters?.areaId) {
            updateSettings({ filters: { ...(settings?.filters ?? {}), areaId: AREA_FILTER_ALL } })
                .catch((error) => reportError('Failed to set default area filter', error));
            return;
        }
        if (resolvedAreaFilter === settings?.filters?.areaId) return;
        updateSettings({ filters: { ...(settings?.filters ?? {}), areaId: resolvedAreaFilter } })
            .catch((error) => reportError('Failed to update area filter', error));
    }, [areas.length, resolvedAreaFilter, settings?.filters?.areaId, updateSettings]);

    useEffect(() => {
        const handleOnline = () => setIsOnline(true);
        const handleOffline = () => setIsOnline(false);
        window.addEventListener('online', handleOnline);
        window.addEventListener('offline', handleOffline);
        return () => {
            window.removeEventListener('online', handleOnline);
            window.removeEventListener('offline', handleOffline);
        };
    }, []);

    useEffect(() => {
        return SyncService.subscribeSyncStatus(setSyncStatus);
    }, []);

    const refreshCleartextSyncWarning = useCallback(async () => {
        try {
            const backend = await SyncService.getSyncBackend();
            if (backend === 'webdav') {
                const config = await SyncService.getWebDavConfig({ silent: true });
                if (config.url.trim().toLowerCase().startsWith('http://')) {
                    setCleartextSyncWarning(tFallback(t,
                        'settings.cleartextSyncWarningWebdav',
                        'WebDAV sync is using HTTP. Only local or private-network endpoints are allowed; data is not encrypted.'
                    ));
                    return;
                }
            } else if (backend === 'cloud' && await SyncService.getCloudProvider() === 'selfhosted') {
                const config = await SyncService.getCloudConfig({ silent: true });
                if (config.url.trim().toLowerCase().startsWith('http://')) {
                    setCleartextSyncWarning(tFallback(t,
                        'settings.cleartextSyncWarningCloud',
                        'Self-hosted sync is using HTTP. Only local or private-network endpoints are allowed; data is not encrypted.'
                    ));
                    return;
                }
            }
            setCleartextSyncWarning(null);
        } catch {
            setCleartextSyncWarning(null);
        }
    }, [t]);

    useEffect(() => {
        void refreshCleartextSyncWarning();
        const handleStorage = () => void refreshCleartextSyncWarning();
        const handleFocus = () => void refreshCleartextSyncWarning();
        window.addEventListener('storage', handleStorage);
        window.addEventListener('focus', handleFocus);
        const timer = setInterval(() => {
            void refreshCleartextSyncWarning();
        }, 30_000);
        return () => {
            window.removeEventListener('storage', handleStorage);
            window.removeEventListener('focus', handleFocus);
            clearInterval(timer);
        };
    }, [refreshCleartextSyncWarning]);

    const handleAreaFilterChange = (value: string) => {
        updateSettings({ filters: { ...(settings?.filters ?? {}), areaId: value } })
            .catch((error) => reportError('Failed to update area filter', error));
    };


    return (
        <div className="flex h-screen overflow-hidden bg-background text-foreground">
            <a
                href="#main-content"
                className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:px-3 focus:py-2 focus:rounded-md focus:bg-primary focus:text-primary-foreground"
            >
                {tFallback(t, 'accessibility.skipToContent', 'Skip to content')}
            </a>
            {/* Sidebar */}
            {!isFocusMode && (
                <aside className={cn(
                    "border-r border-border bg-card flex flex-col transition-all duration-150",
                    isCollapsed ? "w-16 p-2" : "w-64 px-3 pt-5 pb-3"
                )}>
                <div className={cn("flex items-center gap-2 px-1.5 mb-6", isCollapsed && "justify-center")}>
                    {!isCollapsed && (
                        <img
                            src="/logo.png"
                            alt="Mindwtr"
                            className="w-7 h-7 rounded-md"
                        />
                    )}
                    {!isCollapsed && <h1 className="text-base font-semibold tracking-tight">{t('app.name')}</h1>}
                    <button
                        onClick={toggleSidebar}
                        className={cn(
                            "ml-auto p-1 rounded-md hover:bg-accent transition-colors text-muted-foreground focus-visible:ring-2 focus-visible:ring-primary/40",
                            isCollapsed && "ml-0"
                        )}
                        title={t('keybindings.toggleSidebar')}
                        aria-label={t('keybindings.toggleSidebar')}
                    >
                        {isCollapsed ? <ChevronsRight className="w-4 h-4" /> : <ChevronsLeft className="w-4 h-4" />}
                    </button>
                </div>

                {/* Search Button */}
                <button
                    onClick={triggerSearch}
                    className={cn(
                        "w-full flex items-center gap-2.5 px-2.5 py-2 mb-4 rounded-md border border-border/70 bg-background/60 text-[13px] font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-primary/40",
                        isCollapsed && "justify-center px-2"
                    )}
                    title={`${searchTitleLabel} (${searchShortcutHint})`}
                    aria-label={searchTitleLabel}
                >
                    <Search className="w-3.5 h-3.5 text-primary" />
                    {!isCollapsed && (
                        <>
                            <span className="flex min-w-0 flex-1 flex-col text-left leading-tight">
                                <span>{searchTitleLabel}</span>
                                <span className="truncate text-[11px] font-normal text-muted-foreground">{searchScopeLabel}</span>
                            </span>
                            <span className="rounded border border-border/70 bg-muted/35 px-1.5 py-0.5 text-[10px] text-muted-foreground">{searchShortcutHint}</span>
                        </>
                    )}
                </button>

                <button
                    onClick={triggerInboxCapture}
                    className={cn(
                        "w-full flex h-9 items-center gap-2.5 px-2.5 mb-6 rounded-md border border-primary/40 bg-primary/5 text-sm font-semibold text-primary transition-colors hover:bg-primary/10 hover:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary/40",
                        isCollapsed && "h-10 justify-center px-2"
                    )}
                    title={inboxCaptureLabel}
                    aria-label={inboxCaptureLabel}
                >
                    <Plus className="w-4 h-4" />
                    {!isCollapsed && (
                        <span className="flex-1 text-left">{addTaskLabel}</span>
                    )}
                </button>

                <div className="flex-1 min-h-0 overflow-y-auto pr-1">
                    {savedSearches.length > 0 && (
                        <div className={cn("mb-2 space-y-1", isCollapsed && "mb-2")}>
                            {!isCollapsed && (
                                <div className="px-2 text-[10px] font-semibold text-muted-foreground uppercase tracking-[0.16em]">
                                    {t('search.savedSearches')}
                                </div>
                            )}
                            {savedSearches.map((search) => (
                                <button
                                    key={search.id}
                                    onClick={() => onViewChange(`savedSearch:${search.id}`)}
                                    className={cn(
                                        "w-full flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-inset",
                                        currentView === `savedSearch:${search.id}`
                                            ? "bg-primary/5 text-primary"
                                            : "hover:bg-accent text-muted-foreground",
                                        isCollapsed && "justify-center px-2"
                                    )}
                                    title={search.name}
                                >
                                    <Search className="w-4 h-4" />
                                    {!isCollapsed && <span className="truncate">{search.name}</span>}
                                </button>
                            ))}
                        </div>
                    )}

                    <nav className="space-y-3.5 pb-2" data-sidebar-nav>
                        {navSections.map((section) => {
                            const isSectionCollapsed = !isCollapsed && collapsedSections.has(section.key);
                            const sectionId = `sidebar-section-${section.key}`;
                            return (
                            <div key={section.key} className="space-y-1">
                                {!isCollapsed && (
                                    <button
                                        type="button"
                                        onClick={() => toggleSection(section.key)}
                                        aria-expanded={!isSectionCollapsed}
                                        aria-controls={sectionId}
                                        className="group w-full flex h-7 items-center gap-1 rounded-md px-2.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-[0.16em] transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 cursor-pointer"
                                    >
                                        <ChevronDown
                                            className={cn(
                                                "w-3 h-3 transition-transform duration-150 opacity-70",
                                                isSectionCollapsed && "-rotate-90"
                                            )}
                                        />
                                        <span>{section.label}</span>
                                    </button>
                                )}
                                <div id={sectionId} className={cn("space-y-1", isSectionCollapsed && "hidden")}>
                                {section.items.map((item) => {
                                    const itemLabel = item.labelKey ? tFallback(t, item.labelKey, item.fallbackLabel ?? item.id) : (item.fallbackLabel ?? item.id);
                                    const isActiveItem = currentView === item.id;
                                    const tone = item.tone ?? 'normal';
                                    const inactiveItemClass = tone === 'primary'
                                        ? 'text-foreground hover:bg-accent/80 hover:text-foreground'
                                        : tone === 'recessed'
                                            ? 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
                                            : 'text-muted-foreground hover:bg-accent/70 hover:text-foreground';
                                    const inactiveIconClass = tone === 'primary'
                                        ? 'text-primary/80'
                                        : tone === 'recessed'
                                            ? 'text-muted-foreground/80'
                                            : 'text-muted-foreground';
                                    const itemWeightClass = isActiveItem
                                        ? 'font-medium'
                                        : tone === 'primary'
                                            ? 'font-semibold'
                                            : tone === 'recessed'
                                                ? 'font-normal'
                                                : 'font-medium';
                                    return (
                                    <button
                                        key={item.id}
                                        onClick={() => onViewChange(item.id)}
                                        onDragEnter={item.id === 'calendar' ? handleCalendarNavDragEnter : undefined}
                                        onDragOver={item.id === 'calendar' ? handleCalendarNavDragOver : undefined}
                                        onDragLeave={item.id === 'calendar' ? handleCalendarNavDragLeave : undefined}
                                        onDrop={item.id === 'calendar' ? handleCalendarNavDrop : undefined}
                                        data-sidebar-item
                                        data-view={item.id}
                                        className={cn(
                                            "w-full flex items-center rounded-md text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-inset",
                                            itemWeightClass,
                                            isActiveItem ? "bg-primary/5 text-primary" : inactiveItemClass,
                                            isCollapsed ? "h-10 justify-center px-2" : "h-9 justify-between px-2.5"
                                        )}
                                        aria-current={isActiveItem ? 'page' : undefined}
                                        title={itemLabel}
                                    >
                                        <div className={cn("flex min-w-0 items-center gap-2.5", isCollapsed && "gap-0")}>
                                            <item.icon className={cn("w-4 h-4 shrink-0", isActiveItem ? "text-primary" : inactiveIconClass)} />
                                            {!isCollapsed && <span className="truncate">{itemLabel}</span>}
                                        </div>
                                        {!isCollapsed && item.count !== undefined && item.count > 0 && (
                                            <span className={cn(
                                                "inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold",
                                                isActiveItem
                                                    ? "bg-primary text-primary-foreground"
                                                    : "bg-muted text-muted-foreground"
                                            )}>
                                                {item.count}
                                            </span>
                                        )}
                                    </button>
                                    );
                                })}
                                </div>
                            </div>
                            );
                        })}
                    </nav>
                </div>

                <div className="mt-auto border-t border-border/60 px-2 pb-2 pt-2">
                    <div className={cn("pb-2", isCollapsed && "flex justify-center")}>
                        <SidebarAreaFilter
                            areas={sortedAreas}
                            value={resolvedAreaFilter}
                            onChange={handleAreaFilterChange}
                            ariaLabel={t('projects.areaFilter')}
                            allAreasLabel={t('projects.allAreas')}
                            noAreaLabel={t('projects.noArea')}
                            collapsed={isCollapsed}
                        />
                    </div>
                    <div className={cn(!isCollapsed && "border-t border-border/50 pt-2")}>
                        <SafeReloadButton isCollapsed={isCollapsed} showToast={showToast} />
                        <div className={cn("flex gap-1.5", isCollapsed ? "flex-col items-center" : "items-stretch")}>
                            <button
                                onClick={() => onViewChange('settings')}
                                className={cn(
                                    "group relative w-full rounded-md text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-inset",
                                    isCollapsed ? "flex h-10 items-center justify-center px-0" : "min-w-0 flex-1 px-2 py-1.5",
                                    currentView === 'settings'
                                        ? "bg-primary/5 text-primary"
                                        : "text-muted-foreground hover:bg-accent/70 hover:text-accent-foreground"
                                )}
                                aria-current={currentView === 'settings' ? 'page' : undefined}
                                title={!isCollapsed ? `${t('nav.settings')} • ${syncTooltip}` : t('nav.settings')}
                                aria-label={isCollapsed ? `${t('nav.settings')}. ${syncTooltip}` : t('nav.settings')}
                            >
                                <span className={cn(
                                    "flex min-w-0",
                                    isCollapsed ? "items-center justify-center" : "flex-col items-stretch gap-1.5"
                                )}>
                                    <span className="inline-flex min-w-0 items-center gap-2 text-sm font-medium">
                                        <Settings className="h-4 w-4 shrink-0" />
                                        {!isCollapsed && <span>{t('nav.settings')}</span>}
                                    </span>
                                    {!isCollapsed && (
                                        <span
                                            className={cn(
                                                "inline-flex min-w-0 items-center gap-1.5 pl-6 text-[11px] leading-none text-muted-foreground",
                                                (!isOnline || lastSyncStatus === 'error' || lastSyncStatus === 'conflict' || syncFreshness === 'old' || syncFreshness === 'stale') && "text-foreground"
                                            )}
                                            title={syncTooltip}
                                            role="status"
                                            aria-live="polite"
                                            aria-label={syncTooltip}
                                        >
                                            <span
                                                className={cn(
                                                    "h-1.5 w-1.5 shrink-0 rounded-full",
                                                    syncFreshnessDotClass,
                                                    syncStatus.inFlight && "animate-pulse"
                                                )}
                                                aria-hidden="true"
                                            />
                                            <span className={cn("min-w-0 truncate", syncStatusLabelClass)}>
                                                {syncStatusLabel}
                                            </span>
                                            <span className="shrink-0 text-muted-foreground" aria-hidden="true">
                                                ·
                                            </span>
                                            <span className="shrink-0 tabular-nums text-muted-foreground">
                                                {compactSyncTimeLabel}
                                            </span>
                                        </span>
                                    )}
                                </span>
                                {isCollapsed && (
                                    <span
                                        className={cn(
                                            "absolute right-1.5 top-1.5 h-2 w-2 rounded-full ring-2 ring-card",
                                            syncFreshnessDotClass,
                                            syncStatus.inFlight && "animate-pulse"
                                        )}
                                        title={syncTooltip}
                                        aria-hidden="true"
                                    />
                                )}
                            </button>
                            <button
                                type="button"
                                onClick={handleManualSyncNow}
                                disabled={manualSyncBusy}
                                className={cn(
                                    "inline-flex shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-60",
                                    "hover:bg-accent/70 hover:text-accent-foreground",
                                    isCollapsed ? "h-10 w-10" : "w-10"
                                )}
                                title={`${syncNowLabel}. ${syncTooltip}`}
                                aria-label={`${syncNowLabel}. ${syncTooltip}`}
                            >
                                <RefreshCw className={cn("h-4 w-4", manualSyncBusy && "animate-spin")} aria-hidden="true" />
                            </button>
                        </div>
                    </div>
                </div>
                </aside>
            )}

            {/* Main Content */}
            <main
                id="main-content"
                className="flex-1 overflow-auto flex flex-col"
                data-main-content
                tabIndex={-1}
                role="main"
                aria-label={tFallback(t, 'accessibility.mainContent', 'Main content')}
            >
                <RecordingBanner onNavigatePlaybook={() => onViewChange('ai-playbook')} />
                <div className={cn(
                    "mx-auto p-8 h-full",
                    isFocusMode
                        ? "max-w-[800px]"
                        : isFullWidthView
                            ? "w-full max-w-none"
                            : (isWideView || currentView === 'calendar')
                            ? "w-full max-w-6xl"
                            : "max-w-4xl"
                )}>
                    {error && (
                        <div
                            role="alert"
                            aria-live="assertive"
                            className="mb-4 flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                        >
                            <span>{error}</span>
                            <button
                                type="button"
                                className="text-destructive/80 hover:text-destructive underline underline-offset-2"
                                onClick={() => setError(null)}
                            >
                                {dismissText}
                            </button>
                        </div>
                    )}
                    {cleartextSyncWarning && (
                        <div
                            role="status"
                            aria-live="polite"
                            className="mb-4 flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-100"
                        >
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" aria-hidden="true" />
                            <span>{cleartextSyncWarning}</span>
                        </div>
                    )}
                    {children}
                </div>
            </main>
            <ToastHost />
        </div>
    );
}

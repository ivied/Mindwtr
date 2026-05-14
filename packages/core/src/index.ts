export type {
    AppData,
    AppSettings,
    AiSettings,
    AppearanceSettings,
    Area,
    Attachment,
    AttachmentKind,
    AttachmentSettings,
    CalendarSettings,
    ChecklistItem,
    DiagnosticsSettings,
    FeatureSettings,
    InboxProcessingMode,
    FilterSettings,
    PendingRemoteAttachmentDelete,
    Project,
    GtdSettings,
    MigrationSettings,
    MobileQuickAccessView,
    NotificationSettings,
    Recurrence,
    RecurrenceByDay,
    RecurrenceRule,
    RecurrenceStrategy,
    RecurrenceWeekday,
    DateRange,
    FilterCriteria,
    FilterPriority,
    SavedFilter,
    SavedFilterView,
    SavedSearch,
    Section,
    SettingsSyncGroup,
    SettingsSyncPreferences,
    SettingsSyncUpdatedAt,
    SortField,
    Task,
    TaskEditorSettings,
    TaskEditorFieldId,
    TaskEditorPresentation,
    TaskEditorSectionId,
    TaskEnergyLevel,
    TaskMode,
    TaskPriority,
    TaskSortBy,
    TaskStatus,
    TextDirection,
    TimeEstimate,
    WindowSettings,
    SpeechToTextSettings,
} from './types';

export {
    noopStorage,
    SEARCH_RESULT_LIMIT,
} from './storage';
export type {
    SearchProjectResult,
    SearchResults,
    SearchTaskResult,
    StorageAdapter,
    TaskQueryOptions,
} from './storage';

export {
    applyTaskUpdates,
    flushPendingSave,
    getStorageAdapter,
    resetForTests,
    setStorageAdapter,
    shallow,
    useProjectById,
    useTaskById,
    useTaskStore,
    useVisibleTaskIds,
} from './store';

export type {
    StoreActionResult,
    TaskStore,
} from './store-types';

export {
    appendSyncHistory,
    CLOCK_SKEW_THRESHOLD_MS,
    filterDeleted,
    mergeAppData,
    mergeAppDataWithStats,
    normalizeAppData,
    performSyncCycle,
    purgeExpiredTombstones,
    SYNC_REPAIR_REV_BY,
} from './sync';
export type {
    ClockSkewDirection,
    ClockSkewWarning,
    ConflictReason,
    EntityMergeStats,
    MergeConflictSample,
    MergeResult,
    MergeStats,
    SyncCycleIO,
    SyncCycleResult,
    SyncHistoryEntry,
    SyncStep,
} from './sync';

export {
    repairMergedSyncReferences,
} from './sync-normalization';

export {
    areSyncPayloadsEqual,
    assertNoPendingAttachmentUploads,
    computeStableValueFingerprint,
    computeSyncPayloadFingerprint,
    filterNotDeleted,
    findPendingAttachmentUploads,
    injectExternalCalendars,
    normalizeCloudUrl,
    normalizeWebdavUrl,
    persistExternalCalendars,
    sanitizeAppDataForRemote,
    toStableSyncJson,
} from './sync-helpers';
export type {
    PendingAttachmentUpload,
    SoftDeletable,
} from './sync-helpers';

export {
    CLOUD_PROVIDER_DROPBOX,
    CLOUD_PROVIDER_SELF_HOSTED,
    createAbortableFetch,
    DEFAULT_ATTACHMENT_CLEANUP_INTERVAL_MS,
    getInMemoryAppDataSnapshot,
    LocalSyncAbort,
    normalizeCloudProvider,
    shouldRunAttachmentCleanup,
} from './sync-client-helpers';
export type {
    CloudProvider,
} from './sync-client-helpers';

export {
    cloneAppData,
    createWebdavDownloadBackoff,
    getErrorStatus,
    isWebdavRateLimitedError,
} from './sync-runtime-utils';

export {
    createSyncOrchestrator,
    runPreSyncAttachmentPhase,
} from './sync-orchestrator';
export type {
    PreSyncAttachmentBackend,
    PreSyncAttachmentCloudProvider,
    PreSyncAttachmentOperation,
    PreSyncAttachmentPhaseResult,
    RunPreSyncAttachmentPhaseOptions,
    SyncOrchestrator,
    SyncOrchestratorControls,
} from './sync-orchestrator';

export {
    canAutoSync,
    coerceSupportedSyncBackend,
    formatSyncErrorMessage,
    getFileSyncDir,
    isLikelyOfflineSyncError,
    isRemoteSyncBackend,
    isSyncFilePath,
    normalizePath,
    normalizeSyncBackend,
    resolveSyncBackend,
    sanitizeSyncErrorMessage,
} from './sync-service-utils';
export type {
    AutoSyncConfig,
    SyncBackend,
    SyncCloudProvider,
} from './sync-service-utils';

export {
    buildTaskUpdatesFromSpeechResult,
    extractWaitingPerson,
    FOCUS_NEXT_DUE_SOON_WINDOW_DAYS,
    getChecklistProgress,
    getFocusSequentialFirstTaskIds,
    getSequentialFirstTaskIds,
    getStatusColor,
    getTaskAgeDays,
    getTaskAgeLabel,
    getTaskAreaId,
    getTaskStaleness,
    getTaskUrgency,
    getWaitingPerson,
    isFocusSequentialCandidate,
    isTaskFutureStart,
    rescheduleTask,
    shouldShowTaskForStart,
    sortFocusNextActions,
    sortTasks,
    sortTasksBy,
    STATUS_COLORS,
} from './task-utils';
export type {
    SpeechResultLike,
    SpeechUpdatePlan,
} from './task-utils';

export {
    collectTaskTokenUsage,
    getFrequentTaskTokens,
    getRecentTaskTokens,
    getUsedTaskTokens,
} from './task-token-usage';
export type {
    TaskTokenUsage,
} from './task-token-usage';

export {
    buildBulkTaskTokenUpdates,
    collectBulkTaskTokens,
    normalizeBulkTaskTokenInput,
} from './bulk-task-tokens';
export type {
    BulkTaskTokenField,
    BulkTaskTokenMode,
    BulkTaskTokenUpdate,
} from './bulk-task-tokens';

export {
    ENERGY_CONTEXTS,
    LOCATION_CONTEXTS,
    PRESET_CONTEXTS,
    PRESET_TAGS,
} from './contexts';
export type {
    EnergyContext,
    LocationContext,
    PresetContext,
    PresetTag,
} from './contexts';

export {
    formatI18nTemplate,
    getEnglishI18nValue,
    getI18nKeyForEnglishText,
    tFallback,
    translateText,
    translateWithFallback,
} from './i18n';
export type {
    Language,
    TranslateFn,
} from './i18n';

export {
    getSystemDefaultLanguage,
    loadStoredLanguage,
    loadStoredLanguageSync,
    resolveLanguageFromLocale,
    saveStoredLanguage,
    saveStoredLanguageSync,
} from './i18n/i18n-storage';

export {
    getTranslations,
    getTranslationsSync,
    loadTranslations,
} from './i18n/i18n-loader';

export {
    isSupportedLanguage,
    LANGUAGE_STORAGE_KEY,
    SUPPORTED_LANGUAGES,
} from './i18n/i18n-constants';

export {
    buildRRuleString,
    createNextRecurringTask,
    getRecurrenceCompletedOccurrencesValue,
    getRecurrenceCountValue,
    getRecurrenceUntilValue,
    isRecurrenceRule,
    normalizeRecurrenceForLoad,
    parseRRuleString,
    RECURRENCE_RULES,
} from './recurrence';

export {
    getLocalizedWeekdayButtons,
    getLocalizedWeekdayLabel,
    getLocalizedWeekdayLabels,
    MONTHLY_WEEKDAY_LABELS,
    WEEKDAY_BUTTONS,
    WEEKDAY_FULL_LABELS,
    WEEKDAY_ORDER,
} from './recurrence-constants';

export {
    getStaleItems,
} from './review-utils';

export {
    filterProjectsBySelectedArea,
    filterProjectsNeedingNextAction,
    getProjectNextActionCandidates,
    getProjectNextActionPromptData,
    getProjectsByArea,
    getProjectsByTag,
    isSelectableProjectForTaskAssignment,
    isTaskInActiveProject,
    projectHasNextAction,
    shouldPromptForProjectNextAction,
} from './project-utils';

export {
    DEFAULT_FOCUS_TASK_LIMIT,
    FOCUS_TASK_LIMIT_OPTIONS,
    MAX_FOCUS_TASK_LIMIT,
    MIN_FOCUS_TASK_LIMIT,
    formatFocusTaskLimitText,
    normalizeFocusTaskLimit,
} from './focus-utils';

export {
    generateUUID,
} from './uuid';

export {
    configureDateFormatting,
    getQuickDate,
    hasTimeComponent,
    isDueForReview,
    isQuickDatePresetSelected,
    normalizeClockTimeInput,
    normalizeDateFormatSetting,
    normalizeTimeFormatSetting,
    QUICK_DATE_PRESETS,
    resolveDateLocaleTag,
    safeFormatDate,
    safeParseDate,
    safeParseDueDate,
} from './date';
export type {
    DateFormatSetting,
    QuickDatePreset,
    TimeFormatSetting,
} from './date';

export {
    parseQuickAdd,
    parseQuickAddDateCommands,
} from './quick-add';
export type {
    QuickAddDateCommandsResult,
    QuickAddDetectedDate,
    QuickAddResult,
} from './quick-add';

export {
    AREA_FILTER_ALL,
    AREA_FILTER_NONE,
    projectMatchesAreaFilter,
    resolveAreaFilter,
    taskMatchesAreaFilter,
} from './area-filter';
export type {
    AreaFilterValue,
} from './area-filter';

export {
    addCalendarMinutes,
    CALENDAR_TIME_ESTIMATE_OPTIONS,
    DEFAULT_CALENDAR_DAY_END_HOUR,
    DEFAULT_CALENDAR_DAY_START_HOUR,
    DEFAULT_CALENDAR_SNAP_MINUTES,
    findFreeSlotForDay,
    formatCalendarDurationLabel,
    formatCalendarTimeInputValue,
    isSlotFreeForDay,
    minutesToTimeEstimate,
    normalizeCalendarDurationMinutes,
    parseCalendarTimeOnDate,
    timeEstimateToMinutes,
} from './calendar-scheduling';

export {
    getNextScheduledAt,
    getUpcomingSchedules,
    isDueWithinMinutes,
    parseTimeOfDay,
} from './schedule-utils';

export {
    getDailyDigestSummary,
} from './digest-utils';
export type {
    DailyDigestSummary,
} from './digest-utils';

export {
    filterProjectsBySearch,
    filterTasksBySearch,
    matchesProject,
    matchesTask,
    parseSearchQuery,
    searchAll,
} from './search';
export type {
    SearchClause,
    SearchComparator,
    SearchQuery,
    SearchTerm,
} from './search';

export {
    applyFilter,
    hasActiveFilterCriteria,
    normalizeDateRange,
    normalizeFilterCriteria,
    normalizeSavedFilter,
    normalizeSavedFilters,
    markSavedFilterDeleted,
    SAVED_FILTER_NO_PROJECT_ID,
    taskMatchesFilterCriteria,
} from './saved-filters';
export {
    buildAdvancedFilterCriteriaChips,
    removeAdvancedFilterCriteriaChip,
} from './saved-filter-labels';
export type {
    SavedFilterCriteriaChip,
    SavedFilterCriteriaChipOptions,
} from './saved-filter-labels';

export {
    matchesHierarchicalToken,
    normalizePrefixedToken,
} from './hierarchy-utils';

export {
    applyMarkdownToolbarAction,
    continueMarkdownOnEnter,
    continueMarkdownOnTextChange,
    extractChecklistFromMarkdown,
    getActiveMarkdownReferenceQuery,
    insertMarkdownReferenceAtQuery,
    MARKDOWN_TOOLBAR_ACTIONS,
    normalizeMarkdownInternalLinks,
    parseInlineMarkdown,
    parseMarkdownReferenceHref,
    parseMarkdownReferenceToken,
    sanitizeMarkdownReferenceLabel,
    searchMarkdownReferences,
    serializeMarkdownReference,
    serializeMarkdownReferenceHref,
    stripMarkdown,
} from './markdown';
export type {
    ActiveMarkdownReferenceQuery,
    InlineToken,
    MarkdownChecklistItem,
    MarkdownReference,
    MarkdownReferenceEntityType,
    MarkdownReferenceSearchOptions,
    MarkdownReferenceSearchResult,
    MarkdownReferenceTarget,
    MarkdownSelection,
    MarkdownToolbarAction,
    MarkdownToolbarActionId,
    MarkdownToolbarResult,
} from './markdown';

export {
    buildObsidianFileTaskId,
    buildObsidianTaskId,
    extractObsidianTags,
    extractObsidianWikiLinks,
    normalizeObsidianRelativePath,
    normalizeObsidianTagValue,
    parseObsidianNoteFrontmatter,
    parseObsidianTasksFromMarkdown,
    uniqueObsidianStrings,
} from './obsidian-parser';
export type {
    ObsidianFrontmatter,
    ObsidianSourceRef,
    ObsidianTask,
    ObsidianTaskFormat,
    ObsidianTaskNotesData,
    ObsidianTaskNotesStatus,
    ParseObsidianTasksOptions,
    ParseObsidianTasksResult,
} from './obsidian-parser';

export {
    DEFAULT_TASKNOTES_FOLDER,
    parseTaskNotesFile,
} from './tasknotes-parser';
export type {
    ParseTaskNotesFileOptions,
    ParseTaskNotesFileResult,
} from './tasknotes-parser';

export {
    webdavDeleteFile,
    webdavFileExists,
    webdavGetFile,
    webdavGetJson,
    webdavHeadFile,
    webdavMakeDirectory,
    webdavPutFile,
    webdavPutJson,
    buildHttpRemoteFileFingerprint,
} from './webdav';
export type {
    RemoteFileMetadata,
    WebDavOptions,
} from './webdav';

export {
    cloudDeleteFile,
    cloudGetFile,
    cloudGetJson,
    cloudHeadJson,
    cloudPutFile,
    cloudPutJson,
} from './cloud';
export type {
    CloudOptions,
} from './cloud';

export {
    assertConnectionAllowed,
    assertSecureUrl,
    concatChunks,
    createProgressStream,
    DEFAULT_TIMEOUT_MS,
    fetchWithTimeout,
    isAbortError,
    isAllowedInsecureUrl,
    isConnectionAllowed,
    SYNC_LOCAL_INSECURE_URL_OPTIONS,
    toArrayBuffer,
    toUint8Array,
} from './http-utils';
export type {
    ConnectionAllowedOptions,
    InsecureUrlOptions,
} from './http-utils';

export {
    isRetryableError,
    isRetryableWebdavReadError,
    isWebdavInvalidJsonError,
    withRetry,
} from './retry-utils';
export type {
    RetryOptions,
} from './retry-utils';

export {
    createSerializedAsyncQueue,
} from './async-queue';
export type {
    SerializedAsyncQueue,
} from './async-queue';

export {
    computeSha256Hex,
} from './attachment-hash';

export {
    createCompactLinkTitle,
    getAttachmentDisplayTitle,
    normalizeAttachmentInput,
    normalizeLinkAttachmentInput,
} from './attachment-link-utils';
export type {
    NormalizedAttachmentInput,
} from './attachment-link-utils';

export {
    validateAttachmentForUpload,
} from './attachment-validation';
export type {
    AttachmentValidationConfig,
    AttachmentValidationError,
    ValidationResult,
} from './attachment-validation';

export {
    AttachmentProgressTracker,
    globalProgressTracker,
} from './attachment-progress';
export type {
    AttachmentProgress,
    ProgressCallback,
} from './attachment-progress';

export {
    findDeletedAttachmentsForFileCleanup,
    findOrphanedAttachments,
    removeAttachmentsByIdFromData,
    removeOrphanedAttachmentsFromData,
} from './attachment-cleanup';
export type {
    CleanupResult,
} from './attachment-cleanup';

export {
    parseIcs,
} from './ics';
export type {
    ExternalCalendarEvent,
    ExternalCalendarSubscription,
    ParseIcsOptions,
} from './ics';

export {
    normalizeTaskForLoad,
    normalizeTaskStatus,
    TASK_STATUS_ORDER,
    TASK_STATUS_SET,
    TASK_STATUS_VALUES,
} from './task-status';

export {
    detectTextDirection,
    isRtlLanguage,
    resolveAutoTextDirection,
    resolveTaskTextDirection,
    resolveTextDirection,
} from './text-direction';

export {
    createAIProvider,
} from './ai/ai-service';

export type {
    AIProvider,
    AIProviderConfig,
    AIProviderId,
    AIReasoningEffort,
    AIRequestOptions,
    AudioCaptureMode,
    AudioFieldStrategy,
    BreakdownInput,
    BreakdownResponse,
    ClarifyInput,
    ClarifyOption,
    ClarifyResponse,
    ClarifySuggestion,
    CopilotInput,
    CopilotResponse,
    ReviewAction,
    ReviewAnalysisInput,
    ReviewAnalysisResponse,
    ReviewSnapshotItem,
    ReviewSuggestion,
} from './ai/types';

export {
    ANTHROPIC_COPILOT_DEFAULT_MODEL,
    ANTHROPIC_DEFAULT_MODEL,
    ANTHROPIC_MODEL_OPTIONS,
    DEFAULT_ANTHROPIC_THINKING_BUDGET,
    DEFAULT_GEMINI_THINKING_BUDGET,
    DEFAULT_REASONING_EFFORT,
    GEMINI_COPILOT_DEFAULT_MODEL,
    GEMINI_DEFAULT_MODEL,
    GEMINI_MODEL_OPTIONS,
    getCopilotModelOptions,
    getDefaultAIConfig,
    getDefaultCopilotModel,
    getModelOptions,
    OPENAI_COPILOT_DEFAULT_MODEL,
    OPENAI_DEFAULT_MODEL,
    OPENAI_MODEL_OPTIONS,
} from './ai/catalog';

export {
    buildAIConfig,
    buildCopilotConfig,
    getAIKeyStorageKey,
    loadAIKeyFromStorage,
    loadAIKeyFromStorageSync,
    saveAIKeyToStorage,
    saveAIKeyToStorageSync,
} from './ai-config';

export {
    SQLITE_BASE_SCHEMA,
    SQLITE_FTS_SCHEMA,
    SQLITE_INDEX_SCHEMA,
    SQLITE_SCHEMA,
    SQLITE_SCHEMA_VERSION,
} from './sqlite-schema';

export {
    mapSqliteTaskRow,
    SqliteAdapter,
} from './sqlite-adapter';
export type {
    CalendarSyncEntry,
    SqliteClient,
} from './sqlite-adapter';

export {
    consoleLogger,
    logError,
    logInfo,
    logWarn,
    sanitizeForLog,
    sanitizeLogContext,
    sanitizeLogMessage,
    sanitizeUrl,
    setLogger,
} from './logger';
export type {
    LogCategory,
    Logger,
    LogLevel,
    LogMeta,
    LogPayload,
} from './logger';

export {
    addBreadcrumb,
    clearBreadcrumbs,
    getBreadcrumbs,
} from './log-breadcrumbs';

export {
    advancePomodoroState,
    createPomodoroCustomPreset,
    createPomodoroState,
    DEFAULT_POMODORO_DURATIONS,
    formatPomodoroClock,
    getPomodoroPhaseSeconds,
    getPomodoroPresetOptions,
    POMODORO_PRESETS,
    resetPomodoroState,
    sanitizePomodoroDurations,
    tickPomodoroState,
} from './pomodoro';
export type {
    PomodoroAdvanceResult,
    PomodoroAutoStartOptions,
    PomodoroDurations,
    PomodoroEvent,
    PomodoroPhase,
    PomodoroPreset,
    PomodoroState,
    PomodoroTickResult,
} from './pomodoro';

export {
    AREA_PRESET_COLORS,
    DEFAULT_AREA_COLOR,
    DEFAULT_PROJECT_COLOR,
} from './color-constants';

export {
    HEARTBEAT_LAST_SENT_DAY_KEY,
    HEARTBEAT_OPT_OUT_SENT_KEY,
    resetHeartbeatOptOutMarker,
    sendDailyHeartbeat,
    sendHeartbeatOptOut,
} from './analytics-heartbeat';
export type {
    AnalyticsHeartbeatEvent,
    SendDailyHeartbeatOptions,
    SendHeartbeatOptOutOptions,
} from './analytics-heartbeat';

export {
    isDropboxPathConflictTag,
    parseDropboxApiErrorTag,
    parseDropboxMetadataRev,
    resolveDropboxPath,
} from './dropbox-sync-utils';

export {
    BACKUP_FILE_PREFIX,
    createBackupFileName,
    sanitizeSerializedJsonText,
    serializeBackupData,
    validateBackupJson,
} from './backup-transfer';
export type {
    BackupMetadata,
    BackupValidation,
} from './backup-transfer';

export type {
    ParsedTodoistProject,
    ParsedTodoistTask,
    TodoistImportExecutionResult,
    TodoistImportParseResult,
    TodoistImportPreview,
    TodoistImportProjectPreview,
} from './todoist-import';
export type {
    DgtImportExecutionResult,
    DgtImportParseResult,
    DgtImportPreview,
    DgtImportProjectPreview,
    ParsedDgtArea,
    ParsedDgtImportData,
    ParsedDgtProject,
    ParsedDgtTask,
} from './dgt-import';
export type {
    OmniFocusImportExecutionResult,
    OmniFocusImportParseResult,
    OmniFocusImportPreview,
    OmniFocusImportProjectPreview,
    ParsedOmniFocusArea,
    ParsedOmniFocusImportData,
    ParsedOmniFocusProject,
    ParsedOmniFocusTask,
} from './omnifocus-import';

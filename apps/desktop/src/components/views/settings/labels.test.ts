import { describe, expect, it } from 'vitest';

import { getSettingsLabelFallback, labelFallback, zhHantLabelOverrides } from './labels';

const reportedZhHantLabels = {
    searchPlaceholder: '搜索設置…',
    lookAndFeel: '外觀與風格',
    input: '輸入',
    windowBehavior: '窗口行為',
    textSizeDesc: '調整桌面應用的介面文字。',
    showTaskAge: '顯示任務年齡',
    showTaskAgeDesc: '在任務元數據中顯示任務創建距今多久。',
    defaultScheduleTime: '默認安排時間',
    defaultScheduleTimeDesc: '可選。選擇日期後自動填入開始、截止和回顧時間。留空則保持僅日期。',
    undoNotifications: '撤銷通知',
    undoNotificationsDesc: '在將任務標記為已完成或刪除後顯示可撤銷提示。',
    launchAtStartup: '開機自動啟動',
    launchAtStartupDesc: '登錄這台電腦時自動啟動 Mindwtr。',
    localApiServer: '啟用本地 API 伺服器',
    localApiPortDesc: '僅限 localhost。默認：3456。',
    localApiStopped: '關閉',
    taskEditorPresentation: '編輯器打開方式',
    taskEditorPresentationDesc: '選擇在桌面端編輯任務時的打開方式。',
    taskEditorPresentationInline: '側邊預覽',
    taskEditorPresentationInlineDesc: '在當前視圖內打開編輯器，適合快速編輯。',
    taskEditorPresentationModal: '彈窗',
    taskEditorPresentationModalDesc: '在居中的彈窗中打開編輯器，適合專注編輯。',
    dataTransfer: '數據傳輸',
    dataTransferDesc: '導出完整備份、從備份恢復本地數據，或導入 Todoist、DGT GTD 與 OmniFocus 導出文件。',
    exportBackupDesc: '將當前本地數據保存為 JSON 備份文件。',
    restoreBackup: '恢復備份',
    restoreBackupDesc: '從 Mindwtr 備份 JSON 文件替換本地數據。',
    importTodoist: '從 Todoist 導入',
    importTodoistDesc: '將 Todoist 的 CSV 或 ZIP 導出導入為 Mindwtr 項目。',
    importTickTick: '從 TickTick 導入',
    importTickTickDesc: '將 TickTick 的 CSV 或 ZIP 備份導入為 Mindwtr 的領域、項目和任務。',
    importDgt: '從 DGT GTD 導入',
    importDgtDesc: '將 DGT GTD 的 JSON 或 ZIP 導出導入為 Mindwtr 的領域、項目和任務。',
    importOmniFocus: '從 OmniFocus 導入',
    importOmniFocusDesc: '將 OmniFocus 的 CSV、JSON 或 ZIP 導出導入為 Mindwtr 項目和收集箱任務。',
    backgroundSync: '後台同步',
    backgroundSyncDesc: '桌面端會在啟動時、應用重新獲得焦點時、Mindwtr 運行時每 15 分鐘一次，以及任務/項目變更後短暫延遲同步。關閉到托盤可保持運行；開機自動啟動可在登錄後啟動。退出應用會停止桌面後台同步。',
    attachmentsCleanupPendingDeletes: '待處理遠程刪除',
    attachmentsCleanupPendingDeletesClear: '清除待處理刪除',
    calendarChooseLocalFile: '選擇本地 .ics 文件',
    obsidianVault: 'Obsidian 資料庫導入',
    obsidianVaultDesc: '從本地 Obsidian 資料庫導入任務。Obsidian 保留筆記與捕獲來源，Mindwtr 管理原生承諾事項。',
} as const;

describe('settings label fallbacks', () => {
    it('uses Traditional Chinese overrides for reported desktop settings labels', () => {
        expect(zhHantLabelOverrides).toMatchObject(reportedZhHantLabels);
        expect(getSettingsLabelFallback('zh-Hant')).toMatchObject(reportedZhHantLabels);
    });

    it('keeps Simplified Chinese fallbacks unchanged for zh', () => {
        const labels = getSettingsLabelFallback('zh');

        expect(labels.searchPlaceholder).toBe(labelFallback.zh.searchPlaceholder);
        expect(labels.searchPlaceholder).toBe('搜索设置…');
    });
});

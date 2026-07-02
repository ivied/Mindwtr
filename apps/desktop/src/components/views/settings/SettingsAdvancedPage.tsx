import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { SettingsLabels } from './labels';
import type { LocalApiServerStatus } from '../../../lib/local-api-server';
import type { DesktopRenderingConfig } from '../../../lib/desktop-rendering';

type SettingsAdvancedPageProps = {
    t: SettingsLabels;
    isTauri: boolean;
    localApiStatus: LocalApiServerStatus;
    localApiPortInput: string;
    localApiBusy: boolean;
    localApiPortError: string;
    networkProxyUrl: string;
    desktopRenderingConfig: DesktopRenderingConfig;
    desktopRenderingBusy: boolean;
    onLocalApiToggle: (enabled: boolean) => void;
    onLocalApiPortInputChange: (value: string) => void;
    onLocalApiPortCommit: () => void;
    onNetworkProxyUrlChange: (value: string) => void;
    onSaveNetworkProxy: () => Promise<void> | void;
    onDesktopRenderingToggle: (disableHardwareAcceleration: boolean) => void;
};

const inputCls =
    'h-8 w-24 rounded-md border border-border bg-muted/50 px-2.5 text-right text-[13px] text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-60';

function SectionHeader({ children }: { children: ReactNode }) {
    return (
        <h3 className="text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">
            {children}
        </h3>
    );
}

function SettingsCard({ children }: { children: ReactNode }) {
    return (
        <div className="bg-card border border-border rounded-lg divide-y divide-border/50">
            {children}
        </div>
    );
}

function SettingsRow({
    title,
    description,
    children,
}: {
    title: string;
    description?: ReactNode;
    children: ReactNode;
}) {
    return (
        <div className="px-4 py-3 flex items-center justify-between gap-6">
            <div className="min-w-0">
                <div className="text-[13px] font-medium">{title}</div>
                {description && <div className="text-xs text-muted-foreground mt-0.5">{description}</div>}
            </div>
            <div className="flex items-center gap-2 shrink-0">{children}</div>
        </div>
    );
}

function Toggle({
    disabled = false,
    enabled,
    label,
    onChange,
}: {
    disabled?: boolean;
    enabled: boolean;
    label: string;
    onChange: () => void;
}) {
    return (
        <button
            type="button"
            disabled={disabled}
            aria-label={label}
            onClick={onChange}
            className={`inline-flex h-[22px] w-10 items-center rounded-full transition-colors ${
                enabled ? 'bg-primary' : 'bg-muted'
            } ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
            aria-pressed={enabled}
        >
            <span
                className={`inline-block h-[18px] w-[18px] transform rounded-full bg-white transition-transform ${
                    enabled ? 'translate-x-[20px]' : 'translate-x-[2px]'
                }`}
            />
        </button>
    );
}

export function SettingsAdvancedPage({
    t,
    isTauri,
    localApiStatus,
    localApiPortInput,
    localApiBusy,
    localApiPortError,
    networkProxyUrl,
    desktopRenderingConfig,
    desktopRenderingBusy,
    onLocalApiToggle,
    onLocalApiPortInputChange,
    onLocalApiPortCommit,
    onNetworkProxyUrlChange,
    onSaveNetworkProxy,
    onDesktopRenderingToggle,
}: SettingsAdvancedPageProps) {
    const [networkProxyOpen, setNetworkProxyOpen] = useState(false);
    const statusText = !isTauri
        ? t.localApiUnavailable
        : localApiStatus.running && localApiStatus.url
            ? localApiStatus.url
            : t.localApiStopped;
    const errorText = localApiPortError || localApiStatus.error || '';

    return (
        <div className="space-y-5">
            <SectionHeader>{t.automation}</SectionHeader>
            <SettingsCard>
                <SettingsRow title={t.localApiServer} description={statusText}>
                    <Toggle
                        disabled={!isTauri || localApiBusy}
                        enabled={localApiStatus.enabled}
                        label={t.localApiServer}
                        onChange={() => onLocalApiToggle(!localApiStatus.enabled)}
                    />
                </SettingsRow>
                <SettingsRow title={t.localApiPort} description={t.localApiPortDesc}>
                    <input
                        aria-label={t.localApiPort}
                        className={inputCls}
                        disabled={!isTauri || localApiBusy}
                        inputMode="numeric"
                        min={1024}
                        max={65535}
                        type="number"
                        value={localApiPortInput}
                        onBlur={onLocalApiPortCommit}
                        onChange={(event) => onLocalApiPortInputChange(event.target.value)}
                    />
                </SettingsRow>
                {localApiStatus.enabled && localApiStatus.token && (
                    <SettingsRow title={t.localApiToken} description={t.localApiTokenDesc}>
                        <code className="max-w-[320px] break-all rounded border border-border bg-muted/60 px-2 py-1 text-[11px] text-muted-foreground">
                            {localApiStatus.token}
                        </code>
                    </SettingsRow>
                )}
                {localApiStatus.enabled && (
                    <div className="px-4 py-3 text-xs text-muted-foreground">
                        {t.localApiSecurityNote}
                    </div>
                )}
                {errorText && (
                    <div className="px-4 py-3 text-xs text-destructive">
                        {errorText}
                    </div>
                )}
            </SettingsCard>
            {isTauri && (
                <>
                    <SectionHeader>{t.rendering}</SectionHeader>
                    <SettingsCard>
                        <SettingsRow title={t.softwareRendering} description={t.softwareRenderingDesc}>
                            <Toggle
                                disabled={desktopRenderingBusy}
                                enabled={desktopRenderingConfig.disableHardwareAcceleration}
                                label={t.softwareRendering}
                                onChange={() => onDesktopRenderingToggle(!desktopRenderingConfig.disableHardwareAcceleration)}
                            />
                        </SettingsRow>
                    </SettingsCard>
                    <SectionHeader>{t.network}</SectionHeader>
                    <SettingsCard>
                        <div>
                            <button
                                type="button"
                                onClick={() => setNetworkProxyOpen((open) => !open)}
                                aria-expanded={networkProxyOpen}
                                className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left"
                            >
                                <div className="min-w-0">
                                    <div className="text-[13px] font-medium">{t.networkProxyUrl}</div>
                                    <div className="text-xs text-muted-foreground mt-0.5">
                                        {t.networkProxyUrlDesc}
                                    </div>
                                </div>
                                {networkProxyOpen ? (
                                    <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                                ) : (
                                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                                )}
                            </button>
                            {networkProxyOpen && (
                                <div className="border-t border-border/50 px-4 py-3 space-y-2">
                                    <div className="flex flex-col gap-2 sm:flex-row">
                                        <input
                                            aria-label={t.networkProxyUrl}
                                            type="text"
                                            value={networkProxyUrl}
                                            onChange={(event) => onNetworkProxyUrlChange(event.target.value)}
                                            placeholder="http://proxy-host:port"
                                            className="min-w-0 flex-1 rounded-md border border-border bg-muted/50 px-2.5 py-2 text-[13px] font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                                        />
                                        <button
                                            type="button"
                                            onClick={onSaveNetworkProxy}
                                            className="rounded-md bg-secondary px-4 py-2 text-sm font-medium text-secondary-foreground hover:bg-secondary/90"
                                        >
                                            {t.networkProxySave}
                                        </button>
                                    </div>
                                    <div className="text-xs text-muted-foreground">
                                        {t.networkProxyUrlHint}
                                    </div>
                                </div>
                            )}
                        </div>
                    </SettingsCard>
                </>
            )}
        </div>
    );
}

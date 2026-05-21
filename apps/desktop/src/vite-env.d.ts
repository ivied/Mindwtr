/// <reference types="vite/client" />

interface ImportMetaEnv {
    readonly VITE_ANALYTICS_HEARTBEAT_URL?: string;
    readonly VITE_DISABLE_HEARTBEAT?: string;
    readonly VITE_DROPBOX_APP_KEY?: string;
    readonly VITE_AI_SERVICE_URL?: string;
    readonly VITE_AI_SERVICE_TOKEN?: string;
    readonly VITE_CLOUD_URL?: string;
    readonly VITE_CLOUD_TOKEN?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}

export const allowedEnglishMirrorTerms = [
    'Mindwtr',
    'WebDAV',
    'CalDAV',
    'Dropbox',
    'iCloud',
    'CloudKit',
    'GitHub',
    'OpenAI',
    'Gemini',
    'Anthropic',
    'Claude',
    'Pomodoro',
    'GTD',
    'ICS',
    'URL',
    'URI',
    'API',
    'AI',
    'OK',
    'HTTP',
    'HTTPS',
    'JSON',
    'CSV',
    'PDF',
    'Markdown',
    'TaskNotes',
    'Todoist',
    'OmniFocus',
    'DGT',
    'Vim',
    'Emacs',
    'Nord',
] as const;

const translatableEnglishPattern = /[A-Za-z]{3,}/;

export function stripAllowedEnglishTerms(value: string): string {
    let next = value
        .replace(/https?:\/\/\S+/gi, '')
        .replace(/\{\{\s*[A-Za-z0-9_]+\s*\}\}/g, '')
        .replace(/\/[A-Za-z][A-Za-z0-9:_-]*/g, '')
        .replace(/[+#@!][A-Za-z][A-Za-z0-9:_-]*/g, '');

    for (const term of allowedEnglishMirrorTerms) {
        next = next.replace(new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), '');
    }
    return next;
}

export function hasTranslatableEnglishText(value: string): boolean {
    return translatableEnglishPattern.test(stripAllowedEnglishTerms(value));
}

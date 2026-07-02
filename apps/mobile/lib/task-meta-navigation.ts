import { router } from 'expo-router';

type TaskOpenTab = 'view' | 'task';

const navigateToTaskMetaScreen = (
    pathname: '/projects-screen' | '/contexts',
    params: { projectId?: string; token?: string }
) => {
    // Use public NAVIGATE semantics so repeated same-screen taps update params
    // without building an unbounded back stack.
    router.navigate({ pathname, params });
};

export function openProjectScreen(projectId: string) {
    if (!projectId) return;
    navigateToTaskMetaScreen('/projects-screen', { projectId });
}

export function openContextsScreen(token: string) {
    if (!token) return;
    navigateToTaskMetaScreen('/contexts', { token });
}

export function openTaskScreen(taskId: string, projectId?: string, taskTab: TaskOpenTab = 'view') {
    if (!taskId) return;
    const openToken = String(Date.now());
    if (projectId) {
        router.push({
            pathname: '/projects-screen',
            params: { projectId, taskId, openToken, taskTab },
        });
        return;
    }
    router.push({
        pathname: '/focus',
        params: { taskId, openToken, taskTab },
    });
}

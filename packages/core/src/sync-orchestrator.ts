export interface SyncOrchestratorControls<Arg> {
    requestFollowUp: (nextArg?: Arg) => void;
}

interface CreateSyncOrchestratorOptions<Arg, Result> {
    runCycle: (arg: Arg, controls: SyncOrchestratorControls<Arg>) => Promise<Result>;
    onQueueStateChange?: (queued: boolean) => void;
    onDrained?: () => void;
    onQueuedRunComplete?: (result: Result) => void;
    onQueuedRunError?: (error: unknown) => void;
}

export interface SyncOrchestrator<Arg, Result> {
    run: (arg: Arg) => Promise<Result>;
    requestFollowUp: (nextArg?: Arg) => void;
    reset: () => void;
    getState: () => { inFlight: boolean; queued: boolean };
}

export const createSyncOrchestrator = <Arg, Result>(
    options: CreateSyncOrchestratorOptions<Arg, Result>
): SyncOrchestrator<Arg, Result> => {
    const { runCycle, onQueueStateChange, onDrained, onQueuedRunComplete, onQueuedRunError } = options;
    let inFlight: Promise<Result> | null = null;
    let queued = false;
    let queuedArg: Arg | undefined;

    const setQueued = (next: boolean) => {
        if (queued === next) return;
        queued = next;
        onQueueStateChange?.(next);
    };

    const requestFollowUp = (nextArg?: Arg) => {
        if (nextArg !== undefined) queuedArg = nextArg;
        setQueued(true);
    };

    const run = (arg: Arg): Promise<Result> => {
        if (inFlight) {
            requestFollowUp(arg);
            return inFlight;
        }

        setQueued(false);
        const cycleArg = queuedArg ?? arg;
        queuedArg = undefined;

        let resolveDeferred!: (value: Result) => void;
        let rejectDeferred!: (error: unknown) => void;
        const current = new Promise<Result>((resolve, reject) => {
            resolveDeferred = resolve;
            rejectDeferred = reject;
        });
        inFlight = current;
        try {
            void runCycle(cycleArg, {
                requestFollowUp: (nextArg?: Arg) => requestFollowUp(nextArg ?? cycleArg),
            }).then(
                (result) => resolveDeferred(result),
                (error) => rejectDeferred(error),
            );
        } catch (error) {
            rejectDeferred(error);
        }

        current.finally(() => {
            if (inFlight !== current) return;
            inFlight = null;

            if (!queued) {
                onDrained?.();
                return;
            }

            const nextArg = queuedArg ?? cycleArg;
            setQueued(false);
            queuedArg = undefined;
            void run(nextArg)
                .then((result) => {
                    onQueuedRunComplete?.(result);
                })
                .catch((error) => {
                    onQueuedRunError?.(error);
                });
        });

        return current;
    };

    return {
        run,
        requestFollowUp,
        reset: () => {
            inFlight = null;
            queuedArg = undefined;
            setQueued(false);
        },
        getState: () => ({
            inFlight: !!inFlight,
            queued,
        }),
    };
};

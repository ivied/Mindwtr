export type SerializedAsyncQueue = {
    run: <T>(fn: () => Promise<T> | T) => Promise<T>;
};

export const createSerializedAsyncQueue = (): SerializedAsyncQueue => {
    let tail: Promise<void> = Promise.resolve();

    return {
        run: <T>(fn: () => Promise<T> | T): Promise<T> => {
            const result = tail.then(() => fn());
            tail = result.then(
                () => undefined,
                () => undefined,
            );
            return result;
        },
    };
};

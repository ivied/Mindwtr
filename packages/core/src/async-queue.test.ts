import { describe, expect, it } from 'vitest';
import { createSerializedAsyncQueue } from './async-queue';

const createDeferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((res) => {
        resolve = res;
    });
    return { promise, resolve };
};

describe('serialized async queue', () => {
    it('runs queued work in insertion order', async () => {
        const queue = createSerializedAsyncQueue();
        const firstGate = createDeferred();
        const events: string[] = [];

        const first = queue.run(async () => {
            events.push('first:start');
            await firstGate.promise;
            events.push('first:end');
            return 'first';
        });
        const second = queue.run(async () => {
            events.push('second');
            return 'second';
        });

        await Promise.resolve();
        expect(events).toEqual(['first:start']);

        firstGate.resolve();
        await expect(first).resolves.toBe('first');
        await expect(second).resolves.toBe('second');
        expect(events).toEqual(['first:start', 'first:end', 'second']);
    });

    it('propagates failures without breaking later work', async () => {
        const queue = createSerializedAsyncQueue();
        const events: string[] = [];

        const failed = queue.run(async () => {
            events.push('failed');
            throw new Error('boom');
        });
        const next = queue.run(async () => {
            events.push('next');
            return 'ok';
        });

        await expect(failed).rejects.toThrow('boom');
        await expect(next).resolves.toBe('ok');
        expect(events).toEqual(['failed', 'next']);
    });
});

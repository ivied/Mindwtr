export type PromptTestKind = 'announcement' | 'donation' | 'update' | 'review';

const listeners = new Set<(kind: PromptTestKind) => void>();

export function emitPromptTest(kind: PromptTestKind): void {
  listeners.forEach((listener) => listener(kind));
}

export function subscribePromptTest(handler: (kind: PromptTestKind) => void): () => void {
  listeners.add(handler);
  return () => {
    listeners.delete(handler);
  };
}

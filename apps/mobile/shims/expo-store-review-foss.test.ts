import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

type StoreReviewShim = {
  hasAction: () => Promise<boolean>;
  isAvailableAsync: () => Promise<boolean>;
  requestReview: () => Promise<void>;
  storeUrl: () => string | null;
};

const createMetroNamespace = (moduleExports: Record<string, unknown>) => {
  const namespace: Record<string, unknown> = {};
  Object.keys(moduleExports).forEach((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(moduleExports, key);
    Object.defineProperty(
      namespace,
      key,
      descriptor?.get
        ? descriptor
        : {
          enumerable: true,
          get: () => moduleExports[key],
        }
    );
  });
  namespace.default = moduleExports;
  return namespace;
};

describe('FOSS expo-store-review shim', () => {
  it('supports Metro namespace interop without a read-only default export', async () => {
    const shim = require('./expo-store-review-foss.js') as StoreReviewShim & Record<string, unknown>;

    expect(Object.prototype.hasOwnProperty.call(shim, 'default')).toBe(false);
    expect(() => createMetroNamespace(shim)).not.toThrow();
    expect(await shim.hasAction()).toBe(false);
    expect(await shim.isAvailableAsync()).toBe(false);
    expect(shim.storeUrl()).toBeNull();
  });
});

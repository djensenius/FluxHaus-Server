import { vi } from 'vite-plus/test';

const originalFn = vi.fn.bind(vi);

vi.fn = ((implementation?: (...args: unknown[]) => unknown) => {
  if (typeof implementation === 'function') {
    // Jest allowed arrow-function mock implementations to be used with `new`.
    // Vitest requires constructable implementations for constructor mocks, so
    // wrap provided implementations in a normal function for migration parity.
    const constructable = function mockImplementation(this: unknown, ...args: unknown[]) {
      return implementation.apply(this, args);
    };
    return originalFn(constructable);
  }
  return originalFn();
}) as typeof vi.fn;

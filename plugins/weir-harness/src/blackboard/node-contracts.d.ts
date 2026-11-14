// Node contract consumed by the blackboard runtime. AsyncLocalStorage keeps the
// fork source attached to the host's fork call across its await points, so two
// concurrent forks can never attribute a child to the wrong source.
//
// `checkJs` runs with `types: []` (no @types/node), so the Node surface this
// module compiles against is declared by hand next to its only consumer — the
// same pattern as src/file-lease/node-contracts.d.ts. Ambient declarations
// merge, so this file only adds what the bundle lacks.
declare module 'node:async_hooks' {
  export class AsyncLocalStorage<T> {
    run<R>(store: T, callback: () => R): R;
    getStore(): T | undefined;
    disable(): void;
  }
}

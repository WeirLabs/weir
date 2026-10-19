// Node contracts consumed by the lease CLIENT subtree, declared next to the code
// that uses them.
//
// `checkJs` runs with `types: []` (no @types/node), so the Node surface this
// package compiles against is declared by hand. types/platform.d.ts covers what
// the rest of the bundle consumes and src/lease-broker/node-contracts.d.ts
// covers the daemon; the client is the only consumer of `node:url`, of
// `spawn`, and of the `execPath` named export, so those stay here. Ambient
// declarations merge, which is why this file extends `node:child_process` and
// `node:process` instead of redeclaring them.

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
}

declare module 'node:child_process' {
  export interface ChildProcess {
    readonly pid?: number;
    readonly exitCode: number | null;
    readonly signalCode: string | null;
    unref(): void;
    kill(signal?: string): boolean;
    on(event: 'exit', listener: (code: number | null, signal: string | null) => void): ChildProcess;
    on(event: 'error', listener: (error: Error) => void): ChildProcess;
  }
  export function spawn(
    file: string,
    args: string[],
    options: {
      env: Record<string, string | undefined>;
      detached: boolean;
      stdio: string;
      windowsHide: boolean;
    },
  ): ChildProcess;
}

// `node:process` really does export `execPath` as a named export; the shared
// declaration only models the default export, which has no `execPath` field.
declare module 'node:process' {
  export const execPath: string;
}

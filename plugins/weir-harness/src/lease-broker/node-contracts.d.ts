// Node transport contracts consumed by the lease-broker daemon, declared next
// to the code that uses them.
//
// `checkJs` runs with `types: []` (no @types/node), so the Node surface this
// package compiles against is declared in types/platform.d.ts. That file covers
// the modules the rest of the bundle consumes; the daemon is the only consumer
// of `node:net`, `node:os`, the global `process`, and `unlinkSync`, and its
// subtree is a self-contained pure-Node module (no DSH, no cordis), so its
// daemon-only contracts stay here. Ambient declarations merge with the shared
// ones, which is why the added `unlinkSync` below extends `node:fs` instead of
// redeclaring it.

declare module 'node:net' {
  interface SocketError extends Error {
    code?: string;
  }
  export interface Socket {
    destroyed: boolean;
    setEncoding(encoding: string): void;
    setNoDelay(noDelay?: boolean): void;
    write(chunk: string): boolean;
    end(data?: string): void;
    destroy(error?: Error): void;
    on(event: 'data', listener: (chunk: string) => void): Socket;
    on(event: 'close' | 'end', listener: () => void): Socket;
    on(event: 'error', listener: (error: SocketError) => void): Socket;
    once(event: 'connect', listener: () => void): Socket;
    once(event: 'error', listener: (error: SocketError) => void): Socket;
  }
  export interface Server {
    listen(options: { path: string }, callback?: () => void): Server;
    close(callback?: () => void): Server;
    on(event: 'connection', listener: (socket: Socket) => void): Server;
    on(event: 'error' | 'close', listener: (error?: SocketError) => void): Server;
  }
  export function createServer(options: { allowHalfOpen?: boolean }, connectionListener?: (socket: Socket) => void): Server;
  export function createConnection(options: { path: string }): Socket;
}

declare module 'node:os' {
  export function tmpdir(): string;
  export function homedir(): string;
}

declare module 'node:fs' {
  export function unlinkSync(path: string): void;
}

// The global `process` that arrives with the compiler's own libs is not the
// Node one (no `exit`/`on`/`stderr`/`getuid`), so the daemon imports the module
// explicitly instead of relying on the global.
declare module 'node:process' {
  const process: {
    platform: string;
    pid: number;
    env: Record<string, string | undefined>;
    getuid?: () => number;
    exit(code?: number): never;
    on(event: string, listener: (...args: any[]) => void): void;
    stderr: { write(chunk: string): boolean };
  };
  export default process;
}

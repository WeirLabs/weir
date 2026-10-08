// Augmentations of the narrow checked-graph platform contract
// (types/platform.d.ts) for the capability-store liveness/lock modules: the
// edit-lock reservation reuses them, which pulls them into the checked graph.
// Same discipline as the base contract — runtime modules remain supplied by
// Node; these declarations only describe what the checked graph uses.
declare module 'node:fs' {
  export function writeFileSync(path: string, data: string, options?: { mode?: number }): void;
  export function renameSync(from: string, to: string): void;
  export function unlinkSync(path: string): void;
  export function fsyncSync(fd: number): void;
}
declare module 'node:fs/promises' {
  export function link(existingPath: string, newPath: string): Promise<void>;
  export function mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<string | undefined>;
  export function readFile(path: string, encoding: 'utf8'): Promise<string>;
  export function unlink(path: string): Promise<void>;
}
declare module 'node:crypto' {
  export function randomBytes(size: number): Buffer;
}
declare module 'node:child_process' {
  export function execFile(file: string, args: string[], options: { encoding: 'utf8'; timeout?: number }, callback: (error: Error | null, stdout: string) => void): void;
}
declare module 'node:os' {
  export function hostname(): string;
}
declare var process: {
  pid: number;
  platform: string;
  kill(pid: number, signal?: number): void;
};

/** The host timer handle (Node `Timeout`): the checked graph needs `unref`. */
interface PlatformTimer {
  unref?: () => void;
  hasRef?: () => boolean;
}
declare function setInterval(handler: (...args: never[]) => void, timeout?: number): PlatformTimer;
declare function clearInterval(handle: PlatformTimer | number | undefined): void;
declare function setTimeout(handler: (...args: never[]) => void, timeout?: number): PlatformTimer;
declare function clearTimeout(handle: PlatformTimer | number | undefined): void;

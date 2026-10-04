// Narrow platform contracts used by the checked maintenance dependency graph.
// Runtime modules remain supplied by Node and the host; no shipped dependency.
declare class Buffer extends Uint8Array {
  static alloc(size: number): Buffer;
  static from(value: string | Uint8Array, encoding?: string): Buffer;
  equals(other: Uint8Array): boolean;
  subarray(start?: number, end?: number): Buffer;
  toString(encoding?: string): string;
}
declare module 'node:path' {
  export function join(...paths: string[]): string;
  export function resolve(...paths: string[]): string;
  export function dirname(path: string): string;
  export function basename(path: string): string;
  export function isAbsolute(path: string): boolean;
  export function relative(from: string, to: string): string;
  export function parse(path: string): { root: string };
  export const sep: string;
}
declare module 'node:crypto' {
  interface Hash { update(value: string | Uint8Array): Hash; digest(encoding: 'hex'): string }
  export function createHash(algorithm: string): Hash;
  export function randomUUID(): string;
}
declare module 'node:fs' {
  export interface Stats { dev: number; ino: number; mode: number; size: number; mtimeMs: number; ctimeMs: number; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }
  export function lstatSync(path: string): Stats;
  export function lstatSync(path: string, options: { bigint: true }): Omit<Stats, 'dev' | 'ino' | 'mode' | 'size' | 'mtimeMs' | 'ctimeMs'> & { readonly dev: bigint; readonly ino: bigint; readonly mode: bigint; readonly size: bigint; readonly mtimeMs: bigint; readonly ctimeMs: bigint };
  export function fstatSync(fd: number): Stats;
  export function readdirSync(path: string): string[];
  export function realpathSync(path: string): string;
  export namespace realpathSync { function native(path: string): string }
  export function openSync(path: string, flags: number | string, mode?: number): number;
  export function closeSync(fd: number): void;
  export function readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number): number;
  export function readFileSync(path: string | URL, encoding: 'utf8'): string;
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, options?: { recursive?: boolean; mode?: number }): string | undefined;
  export function appendFileSync(path: string, value: string): void;
  export function rmdirSync(path: string): void;
  export const constants: { O_RDONLY: number; O_DIRECTORY: number; O_NOFOLLOW: number; O_NONBLOCK: number };
}
declare module 'node:fs/promises' {
  export interface FileHandle { stat(): Promise<import('node:fs').Stats>; writeFile(bytes: string, encoding: string): Promise<void>; readFile(): Promise<Buffer>; sync(): Promise<void>; close(): Promise<void> }
  export function open(path: string, flags: string | number, mode?: number): Promise<FileHandle>;
  export function rename(from: string, to: string): Promise<void>;
  export function lstat(path: string): Promise<import('node:fs').Stats>;
  export function readdir(path: string): Promise<string[]>;
}
declare module 'node:child_process' {
  export function execFileSync(file: string, args: string[], options: { cwd: string; encoding: 'utf8'; timeout?: number; stdio: string[] }): string;
}
declare module 'react' {
  export class Component<P = { t?: (key: string) => string; children?: unknown }, S = unknown> { constructor(props: P); props: P; state: S }
  export function useState<S>(initial: S): [S, (next: S | ((previous: S) => S)) => void];
}
declare module 'react/jsx-runtime' {
  export function jsx(type: unknown, props: object, key?: string | number): unknown;
  export const jsxs: typeof jsx;
}
interface Window {
  __ModuleLoader__: { load(definition: { id: string; chunk: string; factory: (require: { (id: 'react'): typeof import('react'); (id: 'react/jsx-runtime'): typeof import('react/jsx-runtime') }) => object }): void };
}

// Existing LSP subsystem contract consumed by settings; implementation tested separately.
export function wireLspAdmin(ctx: unknown, servers: () => Record<string, unknown> | undefined): () => void;

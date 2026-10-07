// Environment facts endpoint contract consumed by the settings row;
// implementation tested separately (same shadow pattern as src/lsp/admin.d.ts).
export function registerEnvEndpoints(scope: unknown, deps?: { platform?: string }): () => void;
export function wireEnvAdmin(ctx: unknown, deps?: { platform?: string }): () => void;

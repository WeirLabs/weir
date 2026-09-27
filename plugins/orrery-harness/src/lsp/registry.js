// LSP server registry: default server definitions per language plus
// language detection by file extension and workspace manifests.

export const LANGUAGE_IDS = {
  '.ts': 'typescript',
  '.tsx': 'typescriptreact',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascriptreact',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.pyi': 'python',
  '.go': 'go',
  '.rs': 'rust',
}

/** Language family per LSP languageId (server registry key). */
export const LANGUAGE_FAMILY = {
  typescript: 'typescript',
  typescriptreact: 'typescript',
  javascript: 'typescript',
  javascriptreact: 'typescript',
  python: 'python',
  go: 'go',
  rust: 'rust',
}

export const DEFAULT_SERVERS = {
  typescript: {
    command: 'typescript-language-server',
    args: ['--stdio'],
    manifests: ['package.json', 'tsconfig.json'],
    installHint: 'npm install -g typescript-language-server typescript',
  },
  python: {
    command: 'basedpyright-langserver',
    args: ['--stdio'],
    manifests: ['pyproject.toml', 'requirements.txt', 'setup.py'],
    installHint: 'pip install basedpyright',
  },
  go: {
    command: 'gopls',
    args: [],
    manifests: ['go.mod'],
    installHint: 'go install golang.org/x/tools/gopls@latest',
  },
  rust: {
    command: 'rust-analyzer',
    args: [],
    manifests: ['Cargo.toml'],
    installHint: 'rustup component add rust-analyzer',
  },
}

/** LSP languageId for a file path, or undefined for unknown types. */
export function languageIdForFile(filePath) {
  const match = /\.[A-Za-z0-9]+$/.exec(filePath)
  if (!match) return undefined
  return LANGUAGE_IDS[match[0].toLowerCase()]
}

/** Server family key for a languageId. */
export function familyForLanguageId(languageId) {
  return LANGUAGE_FAMILY[languageId]
}

/** Merge user `lsp.servers` config over the defaults (per-language overlay). */
export function buildRegistry(configServers) {
  const registry = { ...DEFAULT_SERVERS }
  for (const [language, entry] of Object.entries(configServers ?? {})) {
    registry[language] = { ...registry[language], ...entry }
  }
  return registry
}

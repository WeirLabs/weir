// LSP server registry: default server definitions per language plus
// language detection by file extension and workspace manifests.
//
// Recipe sources (community registries, imported as pure data):
// - nvim-lspconfig (Neovim): https://github.com/neovim/nvim-lspconfig
//   (ts_ls / basedpyright / gopls / rust_analyzer / bashls / dockerls /
//    yamlls / lua_ls / clangd)
// - vscode-langservers-extracted (npm): pre-packaged html/css/json/markdown
//   servers — https://github.com/hrsh7th/vscode-langservers-extracted
// - lsp-mode (Emacs) & Helix languages.toml consulted for cross-checks.

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
  '.json': 'json',
  '.jsonc': 'jsonc',
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.sh': 'bash',
  '.bash': 'bash',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.lua': 'lua',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.hpp': 'cpp',
  '.cxx': 'cpp',
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
  json: 'json',
  jsonc: 'json',
  html: 'html',
  css: 'css',
  markdown: 'markdown',
  bash: 'bash',
  dockerfile: 'dockerfile',
  yaml: 'yaml',
  lua: 'lua',
  c: 'cpp',
  cpp: 'cpp',
}

export const DEFAULT_SERVERS = {
  typescript: {
    command: 'typescript-language-server',
    args: ['--stdio'],
    manifests: ['package.json', 'tsconfig.json'],
    installHint: 'npm install -g typescript-language-server typescript',
    install: { command: 'npm', args: ['install', '-g', 'typescript-language-server', 'typescript'] },
  },
  python: {
    command: 'basedpyright-langserver',
    args: ['--stdio'],
    manifests: ['pyproject.toml', 'requirements.txt', 'setup.py'],
    installHint: 'pipx install basedpyright',
    install: { command: 'pipx', args: ['install', 'basedpyright'] },
  },
  go: {
    command: 'gopls',
    args: [],
    versionArgs: ['version'],
    manifests: ['go.mod'],
    installHint: 'go install golang.org/x/tools/gopls@latest',
    install: { command: 'go', args: ['install', 'golang.org/x/tools/gopls@latest'] },
  },
  rust: {
    command: 'rust-analyzer',
    args: [],
    manifests: ['Cargo.toml'],
    installHint: 'rustup component add rust-analyzer',
    install: { command: 'rustup', args: ['component', 'add', 'rust-analyzer'] },
  },
  json: {
    command: 'vscode-json-language-server',
    args: ['--stdio'],
    // no --version support: the extracted servers throw without a connection
    versionArgs: [],
    manifests: ['package.json'],
    installHint: 'npm install -g vscode-langservers-extracted',
    install: { command: 'npm', args: ['install', '-g', 'vscode-langservers-extracted'] },
  },
  html: {
    command: 'vscode-html-language-server',
    args: ['--stdio'],
    // no --version support: the extracted servers throw without a connection
    versionArgs: [],
    manifests: ['*.html'],
    installHint: 'npm install -g vscode-langservers-extracted',
    install: { command: 'npm', args: ['install', '-g', 'vscode-langservers-extracted'] },
  },
  css: {
    command: 'vscode-css-language-server',
    args: ['--stdio'],
    // no --version support: the extracted servers throw without a connection
    versionArgs: [],
    manifests: ['*.css'],
    installHint: 'npm install -g vscode-langservers-extracted',
    install: { command: 'npm', args: ['install', '-g', 'vscode-langservers-extracted'] },
  },
  markdown: {
    command: 'vscode-markdown-language-server',
    args: ['--stdio'],
    // no --version support: the extracted servers throw without a connection
    versionArgs: [],
    manifests: ['*.md'],
    installHint: 'npm install -g vscode-langservers-extracted',
    install: { command: 'npm', args: ['install', '-g', 'vscode-langservers-extracted'] },
  },
  bash: {
    command: 'bash-language-server',
    args: ['start'],
    manifests: ['*.sh'],
    installHint: 'npm install -g bash-language-server',
    install: { command: 'npm', args: ['install', '-g', 'bash-language-server'] },
  },
  dockerfile: {
    command: 'dockerfile-language-server-nodejs',
    args: ['--stdio'],
    manifests: ['Dockerfile'],
    installHint: 'npm install -g dockerfile-language-server-nodejs',
    install: { command: 'npm', args: ['install', '-g', 'dockerfile-language-server-nodejs'] },
  },
  yaml: {
    command: 'yaml-language-server',
    args: ['--stdio'],
    manifests: ['*.yml', '*.yaml'],
    installHint: 'npm install -g yaml-language-server',
    install: { command: 'npm', args: ['install', '-g', 'yaml-language-server'] },
  },
  lua: {
    command: 'lua-language-server',
    args: [],
    manifests: ['*.lua'],
    installHint: 'brew install lua-language-server (macOS); see https://luals.github.io for other platforms',
    install: {
      darwin: { command: 'brew', args: ['install', 'lua-language-server'] },
    },
  },
  cpp: {
    command: 'clangd',
    args: [],
    manifests: ['*.c', '*.cpp', 'compile_commands.json'],
    installHint: 'brew install llvm (macOS); sudo apt-get install clangd (Debian/Ubuntu)',
    install: {
      darwin: { command: 'brew', args: ['install', 'llvm'] },
      linux: { command: 'sudo', args: ['apt-get', 'install', '-y', 'clangd'] },
    },
  },
}

/** LSP languageId for a file path, or undefined for unknown types. */
export function languageIdForFile(filePath) {
  if (!filePath) return undefined
  const basename = filePath.split('/').pop()
  if (basename === 'Dockerfile') return 'dockerfile'
  const match = /\.[A-Za-z0-9]+$/.exec(filePath)
  if (!match) return undefined
  return LANGUAGE_IDS[match[0].toLowerCase()]
}

/** Server family key for a languageId. */
export function familyForLanguageId(languageId) {
  return LANGUAGE_FAMILY[languageId]
}

/** Language ids served by one family (panel display). */
export function languageIdsForFamily(family) {
  return Object.entries(LANGUAGE_FAMILY).filter(([, value]) => value === family).map(([id]) => id)
}

/** Platform-resolved install spec for a registry entry, or undefined. */
export function installSpecFor(entry, platform = process.platform) {
  const install = entry?.install
  if (!install) return undefined
  if (Array.isArray(install.args)) return install // single-spec form
  return install[platform] ?? install.default
}

/** Display form of the install command for a registry entry. */
export function displayInstallCommand(entry, platform = process.platform) {
  const spec = installSpecFor(entry, platform)
  if (!spec) return entry?.installHint ?? ''
  return [spec.command, ...(spec.args ?? [])].join(' ')
}

/** Merge user `lsp.servers` config over the defaults (per-language overlay). */
export function buildRegistry(configServers) {
  const registry = { ...DEFAULT_SERVERS }
  for (const [language, entry] of Object.entries(configServers ?? {})) {
    registry[language] = { ...registry[language], ...entry }
  }
  return registry
}

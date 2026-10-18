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

/**
 * Built-in catalog. An entry may carry `platforms: { darwin?, linux?, win32?,
 * default? }`; every row has the entry shape (all fields optional) and
 * overrides only the fields it declares for that platform (D1). A family whose
 * data is identical on every platform declares it once as the shared base
 * (npm/pipx/go/rustup); the rest keep a platform-NEUTRAL base plus one row per
 * platform, so no platform ever sees another platform's installer (D5).
 */
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
    installHint: 'install LuaLS from https://luals.github.io',
    platforms: {
      darwin: {
        installHint: 'brew install lua-language-server',
        install: { command: 'brew', args: ['install', 'lua-language-server'] },
      },
      linux: {
        // no package-managed LuaLS on Linux: hint only, pointing at the release
        // page (a one-click install would be a guess, not a recipe)
        installHint: 'no package-managed LuaLS on Linux — download it from https://github.com/LuaLS/lua-language-server/releases',
      },
      win32: {
        installHint: 'winget install --id LuaLS.lua-language-server -e --accept-source-agreements --accept-package-agreements',
        install: { command: 'winget', args: ['install', '--id', 'LuaLS.lua-language-server', '-e', '--accept-source-agreements', '--accept-package-agreements'] },
      },
    },
  },
  cpp: {
    command: 'clangd',
    args: [],
    manifests: ['*.c', '*.cpp', 'compile_commands.json'],
    installHint: 'install clangd from https://clangd.llvm.org/installation',
    platforms: {
      darwin: {
        installHint: 'brew install llvm',
        install: { command: 'brew', args: ['install', 'llvm'] },
      },
      linux: {
        installHint: 'sudo apt-get install clangd',
        install: { command: 'sudo', args: ['apt-get', 'install', '-y', 'clangd'] },
      },
      win32: {
        installHint: 'winget install --id LLVM.LLVM -e --accept-source-agreements --accept-package-agreements',
        install: { command: 'winget', args: ['install', '--id', 'LLVM.LLVM', '-e', '--accept-source-agreements', '--accept-package-agreements'] },
      },
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

/**
 * Resolve one entry for a platform: `{...entry, ...platforms[platform]}` with
 * the `platforms` key removed (D1/D2). An entry without a `platforms` map is
 * returned unchanged — the platform is never guessed. A platform with no row
 * (and no `default` row) keeps the entry's base fields, which are
 * platform-neutral by contract — never another platform's recipe (D5).
 */
export function serverForPlatform(entry, platform = process.platform) {
  const platforms = entry?.platforms
  if (!platforms || typeof platforms !== 'object' || Array.isArray(platforms)) return entry
  const row = platforms[platform] ?? platforms.default
  const resolved = { ...entry, ...(row && typeof row === 'object' ? row : {}) }
  delete resolved.platforms
  return resolved
}

/**
 * Platform-resolved install spec for a registry entry, or undefined. The entry
 * is resolved first when it declares `platforms`. A single spec is identified
 * by `install.command` being a string (a platform map never has a `command`
 * key — D7); anything else is the legacy platform map, kept so existing user
 * configs keep resolving.
 */
export function installSpecFor(entry, platform = process.platform) {
  const resolved = entry?.platforms ? serverForPlatform(entry, platform) : entry
  const install = resolved?.install
  if (!install) return undefined
  if (typeof install.command === 'string') return install // single-spec form
  return install[platform] ?? install.default
}

/**
 * Display form of the install command for a registry entry. Where the platform
 * declares no install spec the fallback is the RESOLVED entry's `installHint`
 * — never another platform's command.
 */
export function displayInstallCommand(entry, platform = process.platform) {
  const resolved = entry?.platforms ? serverForPlatform(entry, platform) : entry
  const spec = installSpecFor(resolved, platform)
  if (!spec) return resolved?.installHint ?? ''
  return [spec.command, ...(spec.args ?? [])].join(' ')
}

/**
 * Merge user `lspServers` config over the platform-resolved catalog. Built-ins
 * resolve first; each user override is then merged onto the resolved built-in
 * and resolved again, so a user row overrides only the fields it declares and
 * a user platform row wins over the built-in one (D2/D6).
 */
export function buildRegistry(configServers, platform = process.platform) {
  const registry = {}
  for (const [language, entry] of Object.entries(DEFAULT_SERVERS)) {
    registry[language] = serverForPlatform(entry, platform)
  }
  for (const [language, entry] of Object.entries(configServers ?? {})) {
    registry[language] = serverForPlatform({ ...registry[language], ...entry }, platform)
  }
  return registry
}

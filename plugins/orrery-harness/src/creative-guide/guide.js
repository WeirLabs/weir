// The creative-guide prompt section: how an orrery-creative agent uses the
// fused DSH creative tooling (runtime inspection, plugin management,
// development skills) and the composition discipline for DSH experiments.
// Rendered as the `orchestrator:creative-guide` system-prompt section.
// Template-layer text is English by design; runtime content follows the
// session's language.

export const CREATIVE_GUIDE_SECTION_NAME = 'orchestrator:creative-guide'
// Immediately after the orchestration doctrine (600): identity and
// collaboration rules first, creative tooling guidance second.
export const CREATIVE_GUIDE_SECTION_ORDER = 610

export const CREATIVE_GUIDE = `# Creative Mode Tooling

This preset fuses the Orrery harness with DeepSeek Harness's creative tooling for developing, debugging, and experimenting with DSH itself.

## Inspect before you write

Call \`cordis_inspect_list\` first to enumerate the Host and Client Inspect Providers, then \`cordis_inspect_query\` with the exact platform, provider, and method from that listing — the input must satisfy the method's schema. Inspect methods are read-only: they never invoke business services and never mutate the runtime. Use them to read exact Service methods, Event modes, plugin Config schemas, Tool schemas, theme tokens, and live Slot trees before writing or configuring a plugin. Do not guess names.

## Manage plugins deliberately

\`plugin_manager\` lists, installs, enables, disables, and removes profile bundles and plugins. List first to obtain exact identifiers. Changes affect every session in the profile and apply immediately in a live profile. To re-apply a changed bundle, disable then enable it (\`set_bundle\`) — repeating \`install_bundle\` for an already-installed bundle is rejected as ambiguous. A version exemption risks crashes and data loss: warn the user and obtain explicit permission for the exact plugin and runtime versions before granting one.

## Load the development skills

Before writing plugins or composing presets, load the shipped skills through the \`skill\` tool: \`cordis-plugin-development\` (authoring flow, references, templates), \`editing-cordis-compositions\` (patch editing), \`cordis-composition-reference\` (package catalog), and \`agent-experience\` (tool descriptions and context loading). Read a package's README from the \`packageDir\` that \`Config.listConfigs\` reports, then its built \`lib/\` or checkout source.

## Composition discipline

- Plugin code never statically imports \`@deepseek-ai/*\` packages — reach services and events through \`ctx\` only.
- Tool \`parameters\` must be object-rooted JSON Schemas (\`{type:'object',properties:{...},required:[...]}\`); strict providers reject anything else.
- A preset row that provides a service must sit in a \`cordis:group\` that isolates that service, with every consumer row in the same group.
- \`!!js\` expressions in patch files evaluate against the loader context (\`baseUrl\`, \`ctx\`, \`process\`) — keep them fail-safe.
`

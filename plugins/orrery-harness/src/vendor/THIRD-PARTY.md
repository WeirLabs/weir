# Vendored third-party sources

These files exist because bare npm package specifiers do not resolve from a
link-installed bundle inside the desktop Electron host (see docs/spikes.md
S14). They are byte-faithful copies (except the import rewrite noted in
schemastery.js) of the DSH fork packages extracted from the packaged host
asar. The DSH fork — unlike upstream schemastery — carries the volatile-schema
machinery that the Settings auto-page projector (`dsh-settings` volatileForm)
requires.

| File | Source package | Version | License | Provenance |
|---|---|---|---|---|
| `cosmokit.js` | `@deepseek-ai/cosmokit` | 1.8.5 | MIT (Shigma cosmokit) | packaged host asar |
| `schemastery.js` | `@deepseek-ai/schemastery` | 3.18.4 | MIT (Shigma schemastery) | packaged host asar |

Refresh procedure: re-extract `@deepseek-ai/schemastery` (`lib/index.mjs`)
and `@deepseek-ai/cosmokit` (`lib/index.js`) from the packaged host asar,
re-apply the import rewrite in schemastery.js (`@deepseek-ai/cosmokit` →
`./cosmokit.js`), bump the versions above.

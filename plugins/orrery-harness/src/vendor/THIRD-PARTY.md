# Vendored third-party sources

These files exist because bare npm package specifiers do not resolve from a
link-installed bundle inside the desktop Electron host (see docs/spikes.md
S14). They are byte-faithful copies (except the import rewrite noted in
schemastery.js) with their original licenses:

| File | Source package | Version | License | Author |
|---|---|---|---|---|
| `cosmokit.js` | [cosmokit](https://github.com/shigma/cosmokit) | 1.8.1 | MIT | Shigma |
| `schemastery.js` | [schemastery](https://github.com/shigma/schemastery) | 3.18.0 | MIT | Shigma |

Refresh procedure: `pnpm add schemastery` in a scratch workspace, re-copy
`lib/index.mjs` of both packages, re-apply the import rewrite to
`from './cosmokit.js'`, bump the versions above.

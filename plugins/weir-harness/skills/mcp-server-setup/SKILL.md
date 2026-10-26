---
name: mcp-server-setup
description: "Install, add, or configure a new MCP server with credential-safe preview, exact Host confirmation, strict discovery, and separate session Apply. Do not use for merely calling or discussing an existing MCP tool."
metadata:
  short-description: Credential-safe MCP server installation
---

# MCP Server Setup

Use this workflow for genuine requests to install, add, or configure a new MCP
server. It is not a tool-repair or general MCP discussion workflow.

## Boundaries

- Weir supports `stdio` and `streamable-http` only. Do not propose legacy SSE,
  OAuth flows, a marketplace, or adoption of an unmanaged server.
- Never ask the user to paste a token, password, private endpoint, or other
  secret into chat. Use an existing DSH credential reference such as
  `{ "ref": "GITHUB_TOKEN" }`. A reference may include a non-secret `prefix`.
- Every environment or HTTP-header value on this tool surface is a credential
  reference. Mark each sensitive stdio argument with a reference object instead
  of placing its value in a plain argument string.
- Any URL containing userinfo, a query, or a fragment is sensitive. Supply the
  whole URL through a credential reference; do not put it in the plan.
- Installation never selects the server, changes a default, or Applies a
  capability set. Do not imply that a mounted server is already authorized.

## 1. Establish the plan

Read the server author's current documentation when it is available. Identify
the transport, executable or endpoint, non-secret arguments, required credential
references, working directory, and relevant timeout/reconnect options. Keep the
plan within the `mcp_install` schema. Unknown fields and cross-transport fields
are rejected.

For stdio, `command` and non-secret `args` describe the process. For
`streamable-http`, use `url` and credential-referenced `headers`; stdio fields
are forbidden. `failOnStartupError` is not configurable: initial mounting is
always strict. Discovering zero tools is still a valid result.

Example stdio plan shape (references, not secrets):

```json
{
  "action": "preview",
  "plan": {
    "identity": "github",
    "label": "GitHub",
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@example/mcp-server", { "ref": "MCP_CLI_TOKEN" }],
    "env": { "GITHUB_TOKEN": { "ref": "GITHUB_TOKEN" } }
  }
}
```

Example HTTP plan shape:

```json
{
  "action": "preview",
  "plan": {
    "identity": "private-docs",
    "transport": "streamable-http",
    "url": { "ref": "PRIVATE_MCP_URL" },
    "headers": {
      "Authorization": { "ref": "PRIVATE_MCP_TOKEN", "prefix": "Bearer " }
    }
  }
}
```

## 2. Preview before installation

Call `mcp_install` with `action: "preview"` and the plan. Check the bounded
redacted plan, digest, target conflicts, namespace conflicts, capabilities, and
validation outcome. Preview does not start a process, contact the server, write
credentials or configuration, or change selection. Correct the plan and preview
again when necessary.

`mcp_install` is single-server and fresh-identity only. Do not use it to edit,
restart, remove, batch-import, or set a default. Use the management UI or the
shared `/capabilities` MCP commands for those operations.

## 3. Let the Host obtain approval

After a clean preview, call `mcp_install` with `action: "install"` and the same
plan. The Host displays the exact redacted plan, its digest, and process or
network effects. Only the user can approve that card. There is no `confirmed`
argument; chat text, custom answers, and extra selections are not approval.

Cancellation, close, timeout, missing confirmation support, delegated callers,
ownership changes, plan changes, registry changes, and namespace changes stop
before probe or write. Report the outcome and request a fresh preview when
required; never fabricate approval or retry an unchanged conflict in a loop.

## 4. Interpret the actual outcome

An approved install probes before registration. A failed probe does not create
a registry entry. A mounted result reports the real identity, incarnation,
generation, and bounded discovery summary.

- `mounted`: registration and strict mount succeeded.
- `saved-degraded`: configuration was saved (`saved: true`) but strict mounting
  failed. This is not installation success; offer Edit, Test, or Restart.
- `owner-changed` or `indeterminate`: inspect actual registry/mount facts. Never
  claim rollback or zero effects.
- `cleanup-failed` / `cleanup-unknown`: follow the recovery action; do not start
  an immediate same-name replacement.

Do not run an arbitrary discovered tool as an installation test. Discovery and
the reported mount outcome are the evidence.

## 5. Keep authorization separate

After a mounted result, direct the user to the separate **Select for this
session** action and explicit **Apply**. Installation and the optional
new-session default are independent of the current draft and accepted sets.
Editing or restarting preserves the registration incarnation; removing and
re-adding the same identity creates a new one and requires reauthorization.

Credential rotation takes effect on the next explicit probe or restart, not as
a claimed live reconnect. Local credential storage avoids registry/profile and
transcript disclosure; it is not an isolation boundary against a same-UID agent.

# AGENTS.md — Coding Agent Guide

This document defines architecture invariants, runtime constraints, and verification commands for AI agents working on `antigravity-context-monitor`.

## Architecture Overview

This plugin runs two coordinated entrypoints over one shared core (`sidecars/context-monitor/server.mjs`):

1. **Managed Sidecar (`sidecars/context-monitor/server.mjs`)**:
   - Started directly by Antigravity (`sidecar.json`, `restart_policy: "always"`).
   - Runs unsandboxed on the host, owns the background Auto-Compact watcher loop, serves HTTP APIs + live-reloaded `index.html`, and handles Windows desktop automation (`toast_confirm`, `ui_send`).
   - Direct execution is guarded (`isDirectRun`), so importing it from `mcp/server.mjs` never spawns duplicate HTTP servers or background timers.
2. **MCP App Server (`mcp/server.mjs`)**:
   - Exposes `open_context_monitor` with `com.google.antigravity/ui.entrypoints` for both `global` (left sidebar full-page) and `aux_pane` (right side pane).
   - Serves `ui://context-monitor/app.html` (`text/html;profile=mcp-app`) by dynamically injecting `@modelcontextprotocol/ext-apps` + a `window.fetch` shim into the live `sidecars/context-monitor/index.html` — single source of truth for UI.
3. **PreInvocation Hook (`hooks/context-guard.mjs`)**:
   - Reads the shared `plugin_data/context-monitor/auto-compact.json`.
   - Always bypasses `/compact` prompts immediately (`{}`).
   - Renders 0-token inline user notices via `metadata.user_markdown` and enforces `hook_guard` / `hook_block`.

## Critical Invariants (Do Not Break)

1. **Zero Native OS Form Controls in `index.html`**:
   - Never use `<select>`. Use the custom Palermo `.p-select-wrap` + `<input type="hidden">` dropdown component and register it with `initCustomSelect(id)`.
   - Keep `color-scheme: light` and custom thin scrollbars so Electron/Chromium never renders dark Windows scrollbars over light surfaces.
2. **Safe HTML Injection in `mcp/server.mjs`**:
   - When injecting bundled JS into `index.html`, always use a replacer callback: `baseHtml.replace('</head>', () => `${shimScripts}\n</head>`)`. Passing a replacement string directly breaks when minified bundles contain `$&`.
3. **PowerShell Encoding Safety in `sidecars/context-monitor/server.mjs`**:
   - Never pass inline multiline Chinese/Unicode scripts via `-Command` to Windows PowerShell 5.1. Always encode scripts as UTF-16LE Base64 with `-EncodedCommand` and set `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`.
4. **Zero External Dependencies in Sidecar & Hook**:
   - `sidecars/context-monitor/server.mjs`, `sidecars/context-monitor/index.html`, and `hooks/context-guard.mjs` must remain zero-dependency (Node built-ins + vanilla HTML/CSS/JS). Only `mcp/` uses `package.json` dependencies (`@modelcontextprotocol/sdk`, `@modelcontextprotocol/ext-apps`).
5. **Read-Only Local Data Guarantee**:
   - Never mutate Antigravity's conversation logs, transcripts, SQLite databases, or `~/.gemini/config/config.json`. Only read them; persist plugin state strictly under `plugin_data/context-monitor/auto-compact.json`.

## Verification Checklist

Run after editing any `.mjs` or `.html` file:

```bash
# 1. Syntax check backend, MCP App, and Hook
node --check sidecars/context-monitor/server.mjs
node --check mcp/server.mjs
node --check hooks/context-guard.mjs

# 2. Validate index.html (zero <select>, zero missing DOM IDs, valid inline JS, single </head>)
node -e "
const fs = require('fs'), cp = require('child_process');
const html = fs.readFileSync('sidecars/context-monitor/index.html', 'utf8');
const selects = (html.match(/<select\b/gi) || []).length;
const heads = (html.match(/<\/head>/gi) || []).length;
const ids = new Set([...html.matchAll(/\bid=['\"]([^'\"]+)['\"]/g)].map(m => m[1]));
const refs = [...html.matchAll(/getElementById\(['\"]([^'\"]+)['\"]\)/g)].map(m => m[1]);
const missing = [...new Set(refs.filter(r => !ids.has(r) && !r.startsWith('detail-') && r !== 'clearRankFilter'))];
console.log({ selects, heads, missing });
"
```

## UI Design Principles

- **Calm First Screen**: Keep low-frequency Auto-Compact configuration inside the right slide-over drawer (`#settingsDrawer`); keep the main view focused on the live context strip, 4 KPIs, unified analytics card, and compact request table.
- **No Redundant Switches**: Auto-match chart type to metric (line for cache hit rate, bar for tokens/requests/compactions). Cross-filter from the ranking list and chart bars using removable topbar filter chips rather than duplicate topbar dropdowns.

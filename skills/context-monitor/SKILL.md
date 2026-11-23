---
name: context-monitor
description: Open the Context & Cache Monitor sidecar dashboard, inspect Gemini context compaction (CHECKPOINT) and prefix cache hit rates, or configure the Auto-Compact threshold & Context Guard hook.
---

# Context & Cache Monitor

This plugin bundles:
1. **Sidecar Web UI (`sidecar://context-monitor/context-monitor/`)** — live Palermo-styled dashboard in Antigravity's auxiliary pane showing token usage, prefix cache hit rate, hourly/daily heatmaps, model breakdown, compaction/error/cache-drop logs, smart threshold advice, and Auto-Compact settings.
2. **PreInvocation Hook (`hooks/context-guard.mjs`)** — reads the shared config at `~/.gemini/antigravity/plugin_data/context-monitor/auto-compact.json` and guards active sessions when context tokens cross the configured threshold.

## Common Actions

- **Open the side panel**: Surface the clickable pill `[Context & Cache](sidecar://context-monitor/context-monitor/)` in your reply.
- **Manage plugin (enable / disable / uninstall)**: Link to `[context-monitor](customization://context-monitor)`.
- **Adjust Auto-Compact settings via chat**: Read or update `~/.gemini/antigravity/plugin_data/context-monitor/auto-compact.json` (fields: `enabled`, `thresholdK`, `mode` = `ui_send` | `hook_guard` | `hook_block` | `notify`, `idleSeconds`, `cooldownSeconds`). The sidecar and hook both pick up changes live.

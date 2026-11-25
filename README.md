<p align="center">
  <img src="assets/logo.svg" width="64" height="64" alt="Context &amp; Cache Monitor Logo" />
</p>

<h1 align="center">Context &amp; Cache Monitor for Antigravity</h1>

<p align="center">
  Observe Gemini context occupancy, prefix cache efficiency, and <code>CHECKPOINT</code> compactions directly inside Google Antigravity — and trigger <code>/compact</code> proactively before cache misses spike.
</p>

<p align="center">
  <b>English</b> ·
  <a href="docs/README.zh-CN.md">简体中文</a> ·
  <a href="docs/README.ja.md">日本語</a> ·
  <a href="docs/README.fr.md">Français</a> ·
  <a href="docs/README.de.md">Deutsch</a>
</p>

<p align="center">
  <sub>🤖 <b>For AI Agents &amp; LLMs:</b> Skip human prose — read <a href="llms.txt"><code>llms.txt</code></a> for machine-friendly install/API contracts and <a href="AGENTS.md"><code>AGENTS.md</code></a> for architecture invariants.</sub>
</p>

---

## Why This Plugin Exists

Long Gemini sessions inside Antigravity silently accumulate context until an automatic `CHECKPOINT` compaction fires — or until prefix cache drops force expensive cold recomputation. Antigravity does not expose a local switch to customize its compaction threshold, nor a native view into per-session cache health.

**Context & Cache Monitor** brings full visibility and calm, proactive control natively into Antigravity:

- **Left-Sidebar Full-Page MCP App** and **Right-Pane Sidecar Dashboard** sharing one live UI.
- **Calm, Distraction-Free First Screen**: A single live context bar at the top shows your active session's current occupancy, early warning line, and compaction threshold — while low-frequency settings stay tucked inside a slide-over drawer.
- **Dynamic Per-Model Thresholds**: Learns from your historical `CHECKPOINT` triggers and non-compaction cache drops to suggest an optimal compaction threshold per model. Manual overrides apply once by default and automatically return to adaptive mode after the next compaction (or can be locked).
- **3-Layer Context Lifecycle Architecture**:
  1. **Soft-Warning Subagent Offloading (`≥70%` threshold)**: Before context bloats to the compaction cliff, the `PreInvocation` hook guides the agent to offload multi-file searches, exploratory reads, and verbose test loops to isolated subagents (`invoke_subagent`) — preserving a 95%+ main-thread prefix cache hit rate.
  2. **Post-Compaction Deterministic Memory Ledger (`CHECKPOINT` recovery)**: On the very first turn after a compaction (`CHECKPOINT`), the hook automatically scans pre-checkpoint tool calls (`<15ms`, zero LLM cost) and re-injects an exact manifest of modified files, inspected line ranges, recent commands, and active task steps — curing post-compaction symbol/line-number amnesia.
  3. **Zero-Focus-Steal Silent Auto-Compact**: Only sends `/compact` (with double-Enter autocomplete pass-through, per-turn deduplication, native `Stop` hook `fullyIdle` verification, and multi-window foreground guard) when Antigravity is in the foreground and your keyboard/mouse are idle.
- **Dual-Layer RTK Output Condenser Integration**: Automatically detects local [`rtk`](https://github.com/rtk-ai/rtk) CLI to display real-time token savings (`rtk gain --daily --format json`) in the dashboard and cooperate with RTK in the `PreInvocation` hook. If `rtk` is not installed, zero-dependency pure-Node command output-budget rules automatically kick in at `≥70%` context, paired with a 1-click copy install guide in Settings.
- **Interactive Analytics & Cross-Filtering**: Switch between `24h Hourly` charts and a full-width `53-Week Activity Heatmap`. Click any model, session (with full search), or hour bar to cross-filter the entire dashboard with one-click removable filter chips.
- **5-Language Auto-Detection**: Automatically matches your system language (`English`, `简体中文`, `日本語`, `Français`, `Deutsch`) with a live topbar switcher.

---

## Quick Start

### Option A · Let Your AI Agent Install It (Recommended)

Paste this into Antigravity (or any coding agent):

```text
Read https://raw.githubusercontent.com/FableFatale/antigravity-context-monitor/main/llms.txt and install Context & Cache Monitor into my Antigravity plugins directory.
```

### Option B · Manual Installation

Requires **Node.js `>= 20`** and **Google Antigravity**.

**Windows (PowerShell):**

```powershell
git clone https://github.com/FableFatale/antigravity-context-monitor.git "$env:USERPROFILE\.gemini\config\plugins\context-monitor"
cd "$env:USERPROFILE\.gemini\config\plugins\context-monitor\mcp"
npm install
```

**macOS / Linux:**

```bash
git clone https://github.com/FableFatale/antigravity-context-monitor.git ~/.gemini/config/plugins/context-monitor
cd ~/.gemini/config/plugins/context-monitor/mcp
npm install
```

Then open **Antigravity → Plugins / Customizations**, enable **Context & Cache Monitor**, and launch it from:
- **Left Sidebar (Recommended)**: Click **Context & Cache** for the full-page MCP App view.
- **Right Side Pane**: Open **Context & Cache** from the `+` menu, or type `/context-monitor` in chat.

---

## Compaction Modes

Open the **Settings** drawer in the top-right corner of the dashboard to choose how the plugin reacts when a session reaches its threshold:

| Mode | Behavior | Platform |
| :--- | :--- | :--- |
| **Desktop Toast Confirmation** (`toast_confirm`) | Shows a lightweight, non-focus-stealing bottom-right toast. Click **Compact** to send `/compact` immediately, or **+20K** to defer. | Windows |
| **Unattended Auto-Compact** (`ui_send`) | Waits until the session is idle, sends `/compact` to the Antigravity window, and restores your clipboard afterward. | Windows |
| **Hook Soft Guard** (`hook_guard`) | Displays a 0-token inline notice via `PreInvocation` hook and nudges the agent to wrap up before hitting lossy compaction. | Windows / macOS / Linux |
| **Hook Hard Gate** (`hook_block`) | Pauses the next model invocation once the threshold is exceeded until you run `/compact`. | Windows / macOS / Linux |
| **Notify Only** (`notify`) | Copies `/compact` to your clipboard and alerts you without touching any window. | Windows / macOS / Linux |

---

## Privacy & Architecture

- **100% Local & Read-Only**: Zero telemetry, zero external network requests. Reads local Antigravity conversation logs and SQLite metadata strictly read-only, storing your preferences in Antigravity's native `plugin_data/context-monitor/auto-compact.json`.
- **Single-Source Architecture**: One zero-dependency Node.js engine (`sidecars/context-monitor/server.mjs`) powers both the managed Sidecar and the MCP App (`mcp/server.mjs`), paired with a lightweight `PreInvocation` hook (`hooks/context-guard.mjs`).

For complete file maps, API contracts, and contributor invariants, see [`llms.txt`](llms.txt) and [`AGENTS.md`](AGENTS.md).

---

## License

[MIT](LICENSE) © 2026 FableFatale

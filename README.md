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
- **Dynamic Idle TTL Guard**: Automatically derives idle-timeout compaction thresholds from your historical non-compaction cache-drop gaps and active threshold, compacting high-occupancy idle sessions before cache TTL expires (with manual override and hourly rate cap).
- **Dual-Layer RTK Output Condenser Integration**: Automatically detects local [`rtk`](https://github.com/rtk-ai/rtk) CLI to display real-time token savings (`rtk gain --daily --format json`) in the dashboard and cooperate with RTK in the `PreInvocation` hook. If `rtk` is not installed, zero-dependency pure-Node command output-budget rules automatically kick in at `≥70%` context, paired with a **1-click RTK CLI auto-installer** (`winget` / `brew` / official `install.sh` / `cargo`) and a top-right official repo info popover in Settings.
- **On-Demand In-App Plugin Updater**: Check for new GitHub releases and fast-forward update directly from the Settings drawer with **zero background network calls** (only contacts GitHub when you explicitly click **Check Updates**).
- **Interactive Analytics & Cross-Filtering**: Switch between `24h Hourly` charts and a full-width `53-Week Activity Heatmap`. Click any model, session (with full search), or hour bar to cross-filter the entire dashboard with one-click removable filter chips.
- **5-Language Auto-Detection**: Automatically matches your system language (`English`, `简体中文`, `日本語`, `Français`, `Deutsch`) with a live topbar switcher.

---

## Quick Start

### Option A · Let Your AI Agent Install It (Recommended)

Paste this into Antigravity (or any coding agent):

```text
Read https://raw.githubusercontent.com/FableFatale/antigravity-context-monitor/main/llms.txt and install Context & Cache Monitor into my Antigravity plugins directory.
```

### Option B · Antigravity CLI (`agy`)

Requires **Node.js `>= 20`**, **Git**, and the **Antigravity CLI (`agy`)**:

```bash
git clone https://github.com/FableFatale/antigravity-context-monitor.git
agy plugin validate ./antigravity-context-monitor
agy plugin install ./antigravity-context-monitor
```

Then install the MCP App server dependencies (if `mcp/node_modules` is not yet present):

**Windows (PowerShell):**

```powershell
cd "$env:USERPROFILE\.gemini\config\plugins\context-monitor\mcp"
npm install --omit=dev
```

**macOS / Linux:**

```bash
cd ~/.gemini/config/plugins/context-monitor/mcp
npm install --omit=dev
```

### Option C · Manual Installation (`git clone`)

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

## Updating

Your preferences and history stored in Antigravity's `plugin_data/context-monitor/` directory are always preserved across updates.

1. **In-App One-Click Update (Recommended)**:
   Open the **Settings** drawer → **Plugin Version & Updates** → click **Check Updates** (on-demand only — zero background network calls) → click **Update Now**. For git-based installs, this runs `git pull --ff-only origin main`, refreshes `mcp/` dependencies if `mcp/package.json` changed, and prompts you to reload the plugin.
2. **Let Your AI Agent Update It**:
   ```text
   Read https://raw.githubusercontent.com/FableFatale/antigravity-context-monitor/main/llms.txt and update my installed Context & Cache Monitor plugin to the latest version.
   ```
3. **Manual Git Pull**:
   - **Windows (PowerShell)**:
     ```powershell
     git -C "$env:USERPROFILE\.gemini\config\plugins\context-monitor" pull --ff-only origin main
     ```
   - **macOS / Linux**:
     ```bash
     git -C ~/.gemini/config/plugins/context-monitor pull --ff-only origin main
     ```
   If `mcp/package.json` changed, run `npm install --omit=dev` inside `mcp/`, then reload **Context & Cache Monitor** in Antigravity.

---

## Compaction Modes

Open the **Settings** drawer in the top-right corner of the dashboard to choose how the plugin reacts when a session reaches its threshold:

| Mode | Behavior | Platform |
| :--- | :--- | :--- |
| **Desktop Toast Confirmation** (`toast_confirm`) | Shows a lightweight confirmation prompt (bottom-right toast on Windows, native dialog on macOS). Click **Compact** to send `/compact` immediately, or **+20K** to defer. | Windows / macOS |
| **Unattended Auto-Compact** (`ui_send`) | Waits until the session is idle, sends `/compact` to the Antigravity window, and restores your clipboard afterward. | Windows / macOS |
| **Hook Soft Guard** (`hook_guard`) | Displays a 0-token inline notice via `PreInvocation` hook and nudges the agent to wrap up before hitting lossy compaction. | Windows / macOS / Linux |
| **Hook Hard Gate** (`hook_block`) | Pauses the next model invocation once the threshold is exceeded until you run `/compact`. | Windows / macOS / Linux |
| **Notify Only** (`notify`) | Copies `/compact` to your clipboard and alerts you without touching any window. | Windows / macOS / Linux |

---

## Privacy, Security & Architecture

- **100% Local & Read-Only by Default**: Zero telemetry, zero analytics, and zero background network requests. Reads local Antigravity conversation logs and SQLite metadata strictly read-only, storing your preferences in Antigravity's native `plugin_data/context-monitor/auto-compact.json`.
- **Single-Source Architecture**: One zero-dependency Node.js engine (`sidecars/context-monitor/server.mjs`) powers both the managed Sidecar and the MCP App (`mcp/server.mjs`), paired with a lightweight `PreInvocation` hook (`hooks/context-guard.mjs`).

### Local Execution & Security Disclosure

For Marketplace security review transparency, every optional local-execution or network capability in this plugin is **disabled by default or strictly user-triggered**:

| Capability | Trigger & Default State | Scope & Safeguards |
| :--- | :--- | :--- |
| **Transcript & SQLite Reading** | Active when plugin is enabled | Strictly read-only access to local Antigravity conversation transcripts and metadata. No data leaves your machine. |
| **Desktop `/compact` UI Automation** (`toast_confirm` / `ui_send`) | **Opt-in only** (requires user selection in Settings; `toast_confirm` requires an explicit click on **Compact**) | On Windows, runs a local PowerShell helper only when Antigravity is the active foreground window and keyboard/mouse input is idle; on macOS, uses native `osascript` + `pbcopy`/`pbpaste` (requires macOS Accessibility permission for keystrokes, otherwise falls back safely to clipboard); preserves and restores the user's clipboard after sending `/compact`. On Linux, falls back to clipboard + notification only and never spawns PowerShell. |
| **RTK CLI Auto-Installer** | **Explicit button click only** (**Install RTK** in Settings) | Invokes the OS package manager (`winget`, `brew`, official `install.sh`, or `cargo`) solely when the user clicks the install button. Never runs automatically. |
| **Plugin Update Check & Apply** | **Explicit button click only** (**Check Updates** / **Update Now** in Settings) | Zero background polling. Only contacts GitHub (`raw.githubusercontent.com` / `git ls-remote` / `api.github.com`) when clicked, and runs `git pull --ff-only origin main` only on explicit confirmation. |
| **Local `ConversationService` Metadata** | Active when `ANTIGRAVITY_LS_ADDRESS` & `ANTIGRAVITY_CSRF_TOKEN` are provided by Antigravity | Read-only localhost RPC (`ListConversations`) to enrich conversation titles and `runState`; gracefully falls back to local files when absent. |

For complete file maps, API contracts, and contributor invariants, see [`llms.txt`](llms.txt) and [`AGENTS.md`](AGENTS.md).

---

## License

[MIT](LICENSE) © 2026 FableFatale

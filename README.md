<p align="center">
  <img src="assets/logo.svg" width="64" height="64" alt="Context &amp; Cache Monitor Logo" />
</p>

<h1 align="center">Context &amp; Cache Monitor for Antigravity</h1>

<p align="center">
  <b>Antigravity 原生上下文水位、前缀缓存命中率与智能自动压缩插件</b><br/>
  Native Antigravity Plugin for Gemini Context Compaction (<code>CHECKPOINT</code>), Prefix Cache Hit Rate &amp; Auto-Compact Automation
</p>

<p align="center">
  <a href="#中文说明">中文文档</a> · <a href="#english-guide">English</a> · <a href="#安装指南--installation">安装指南 / Installation</a> · <a href="#架构与目录--architecture">架构 / Architecture</a>
</p>

---

<a id="中文说明"></a>
## 中文说明

**Context & Cache Monitor** 是一款为 **Google Antigravity** 打造的本地监控与自动化插件，集成了 **左侧边栏全屏 MCP App**、**右侧栏 Sidecar 仪表盘**、**`PreInvocation` 生命周期 Hook** 与 **Chat Skill**，帮助你实时掌握 Gemini 上下文水位与前缀缓存命中情况，并在触发高代价自动压缩（`CHECKPOINT`）前优雅介入。

### 核心特性

- **首屏极简实时水位带**：实时展示当前活跃会话的上下文水位、软预警线与压缩阈值刻度，一键开关自动压缩或立即发送 `/compact`。
- **右侧滑出配置抽屉**：低频配置（智能推荐阈值、阈值滑块/单次与锁定模式、触发行为、空闲等待与冷却秒数、最近触发记录）收进右侧抽屉，首屏清爽无干扰。
- **动态阈值引擎**：根据当前会话模型及近期历史 `CHECKPOINT` 触发水位与非压缩缓存骤降行为，自动计算推荐压缩临界值；手动微调默认仅生效于下一次压缩，压缩后自动恢复动态计算（亦可勾选锁定）。
- **用量分析与全页联动**：
  - 统一分析卡片支持 `Token / 请求 / 命中率 / 压缩` 切换（命中率自动折线，其余自动柱状）与 `24h 分时 / 53周热力图`（自适应容器宽高，点击任意日期直达当天分时）。
  - 右侧支持 `按模型 | 按会话` 排行与全量会话搜索，点击任意模型、会话或小时柱状图即可联动全页，并在顶栏以可一键清除的标签呈现。
- **清爽请求明细**：支持 `全部 / 压缩 / 缓存骤降 / 错误` 轻量筛选、关键词搜索、高水位/低命中筛选、多维度排序与点击展开错误/压缩详情。
- **5 种到达阈值后的自动化策略**：
  1. `toast_confirm`（推荐）：右下角弹出不抢占焦点的轻量桌面 Toast + 页面浮窗，点「确定压缩」立马发送 `/compact`（Windows 原生支持）。
  2. `ui_send`：会话空闲指定秒数后自动向 Antigravity 窗口发送 `/compact` 并还原剪贴板（无人值守，Windows 原生支持）。
  3. `hook_guard`：通过 `PreInvocation` Hook 注入 0-token 聊天内联提示，提醒模型收尾并避开高代价大搜索（全平台）。
  4. `hook_block`：超阈值时硬拦截下一轮调用，直到发送 `/compact` 后放行（全平台）。
  5. `notify`：强提醒并自动复制 `/compact` 到剪贴板，不操作窗口。
- **100% 本地与只读安全**：零外部遥测，仅只读解析本地 Antigravity 日志与会话元数据，所有配置持久化在官方 `plugin_data/context-monitor/auto-compact.json`。

---

<a id="english-guide"></a>
## English Guide

**Context & Cache Monitor** is a native **Google Antigravity** plugin combining a **full-page Left-Sidebar MCP App**, an **Aux-Pane Sidecar Dashboard**, a **`PreInvocation` Context Guard Hook**, and a **Chat Skill** to observe Gemini prefix caching, `CHECKPOINT` context compactions, and automate proactive `/compact` workflows.

### Highlights

- **Calm Hero Watermark Strip**: Live active-session context watermark with soft-warning and threshold tick markers, instant Auto-Compact toggle, and one-click `Compact Now`.
- **Slide-Over Settings Drawer**: Keeps low-frequency settings (smart per-model threshold recommendations, manual-next vs. locked threshold slider, trigger behavior, idle/cooldown timing, and trigger history) out of the main view.
- **Unified Usage Analytics & Cross-Filtering**: Switch between `24h Hourly` and responsive full-width `53-Week Heatmap`, cross-filter globally by clicking any model, conversation (with full search), or hour bar, with removable filter chips in the topbar.
- **5 Compaction Modes**: Non-focus-stealing Windows Desktop Toast confirmation (`toast_confirm`), unattended idle `/compact` automation (`ui_send`), cross-platform `PreInvocation` soft guard (`hook_guard`), hard block (`hook_block`), or clipboard notify (`notify`).
- **Local-First & Zero Telemetry**: Strictly read-only access to local Antigravity conversation logs/metadata; configuration stored locally in Antigravity `plugin_data`.

---

<a id="安装指南--installation"></a>
## 安装指南 / Installation

### 前置要求 / Prerequisites

- [Google Antigravity](https://antigravity.google/)（已支持 Plugin、Sidecar 与 MCP Apps）
- Node.js `>= 20`（建议 `>= 22`，需内置或可用的本地读取环境）

### 1. 克隆到 Antigravity 插件目录 / Clone into Plugins Directory

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

### 2. 在 Antigravity 中启用 / Enable in Antigravity

1. 打开 Antigravity **Plugins / Customizations** 面板，找到 **Context & Cache Monitor** 并启用（如未立即出现，重新加载窗口或刷新 MCP 服务器即可）。
2. 三种打开方式：
   - **左侧边栏（全屏推荐）**：点击左侧导航栏中的 **Context & Cache** 入口。
   - **右侧边栏**：点击右侧栏 `+` 菜单选择 **Context & Cache**，或在对话中使用 `/context-monitor`。
   - **对话指令**：直接让 Agent 执行「打开 Context & Cache 监控面板」或「设置自动压缩阈值为 200K」。

> **平台说明 / Platform Notes**:
> 监控面板、MCP App、Sidecar 服务、智能阈值计算与 `PreInvocation` Hook（`hook_guard` / `hook_block`）均支持 **Windows / macOS / Linux**；右下角桌面确认弹窗（`toast_confirm`）与自动向窗口发送 `/compact`（`ui_send`）当前为 **Windows** 原生实现。

---

<a id="架构与目录--architecture"></a>
## 架构与目录 / Architecture

```text
context-monitor/
├── plugin.json                      # Antigravity 插件清单与元数据
├── mcp_config.json                  # MCP App 服务配置（注册左侧边栏与右侧栏入口）
├── hooks.json                       # PreInvocation 生命周期 Hook 注册
├── assets/
│   └── logo.svg                     # 插件图标
├── mcp/
│   ├── package.json                 # MCP SDK & ext-apps 依赖
│   └── server.mjs                   # MCP App Server（动态注入 ext-apps 桥接）
├── sidecars/context-monitor/
│   ├── sidecar.json                 # Sidecar 托管进程声明
│   ├── server.mjs                   # 本地日志解析、动态阈值计算与自动压缩引擎（零外部依赖）
│   └── index.html                   # 单文件仪表盘 UI（零框架依赖，Palermo 轻量设计）
├── hooks/
│   └── context-guard.mjs            # PreInvocation Hook（0-token 内联横幅 / 护航 / 硬拦截）
└── skills/context-monitor/
    └── SKILL.md                     # /context-monitor 对话技能指引
```

---

## License

[MIT](./LICENSE) © 2026 FableFatale

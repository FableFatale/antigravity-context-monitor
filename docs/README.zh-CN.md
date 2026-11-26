<p align="center">
  <img src="../assets/logo.svg" width="64" height="64" alt="Context &amp; Cache Monitor Logo" />
</p>

<h1 align="center">Context &amp; Cache Monitor for Antigravity</h1>

<p align="center">
  在 Google Antigravity 中原生观测 Gemini 上下文占用、前缀缓存命中率与 <code>CHECKPOINT</code> 压缩行为，并在缓存骤降前优雅触发 <code>/compact</code>。
</p>

<p align="center">
  <a href="../README.md">English</a> ·
  <b>简体中文</b> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.de.md">Deutsch</a>
</p>

<p align="center">
  <sub>🤖 <b>致 AI Agent / LLM：</b> 无需通读面向人类的介绍文档——请直接阅读 <a href="../llms.txt"><code>llms.txt</code></a> 获取机器可读的安装步骤与接口契约，或查阅 <a href="../AGENTS.md"><code>AGENTS.md</code></a> 了解架构约束与验证方式。</sub>
</p>

---

## 为什么做这个插件

在 Antigravity 中进行长对话时，上下文会持续累积，直到系统在后台静默触发 `CHECKPOINT` 自动压缩，或是因上下文过长引发前缀缓存失效、导致昂贵的冷重算。Antigravity 本身并未提供自定义压缩阈值的本地开关，也缺少直观观测各会话缓存健康度的视图。

**Context & Cache Monitor** 将可观测性与克制的主动控制直接融进 Antigravity：

- **双原生入口，同一套界面**：同时支持 **左侧边栏全屏视图（MCP App）** 与 **右侧边栏面板（Sidecar UI）**，实时同步。
- **克制清爽的首屏体验**：顶部仅保留一行当前会话的实时上下文占用条（直观标出预警线与压缩阈值），搭配自动压缩开关与「立即压缩」；低频参数全部收进右上角滑出抽屉，日常打开零干扰。
- **按模型自适应阈值**：结合历史 `CHECKPOINT` 触发点与非压缩缓存骤降记录，为当前模型动态测算更合理的压缩阈值。手动微调默认仅作用于下一次压缩，压缩完成后自动恢复动态策略（也可按需锁定）。
- **三层上下文生命周期架构**：
  1. **源头节流 · 软预警子代理分流（≥70% 阈值）**：在进入软预警区间时，`PreInvocation` Hook 自动引导 Agent 将多文件检索、大范围代码调研与长输出测试分流至独立子代理（`invoke_subagent`），延缓主会话膨胀并保住 95%+ 前缀缓存命中率。
  2. **无损恢复 · 压缩后防失忆确定性账本（Post-CHECKPOINT）**：每次 `CHECKPOINT` 压缩完成后的首轮对话，自动用纯 Node.js（0 大模型开销，`<15ms`）提取压缩前修改/读取过的精确文件路径清单、行号范围与任务进度并注入上下文，彻底解决压缩后编造符号与行号的问题。
  3. **零抢焦点静默自动压缩**：仅在 Antigravity 处于前台、键鼠空闲且本轮未触发过时静默发送 `/compact`（内置双回车穿透 `/` 斜杠候选框与 Windows UIAutomation 输入框焦点归位）。
- **全页联动分析**：支持 `24 小时分时` 与自适应全宽 `53 周活跃热力图` 切换，命中率自动以折线呈现、用量自动以柱状呈现；点击右侧「按模型 / 按会话（含全量搜索）」或任意小时柱，即可一键联动全页筛选，并在顶栏以可随时关闭的标签呈现。
- **五国语言自适应**：自动匹配系统语言（简体中文 / English / 日本語 / Français / Deutsch），也支持在顶栏随时切换。

---

## 快速开始

### 方式一 · 交给你的 AI Agent 一键安装（推荐）

直接将下面这句话发给 Antigravity（或其他编程 Agent）：

```text
请阅读 https://raw.githubusercontent.com/FableFatale/antigravity-context-monitor/main/llms.txt，并帮我把 Context & Cache Monitor 插件安装到本机 Antigravity 插件目录。
```

### 方式二 · 手动安装

需要 **Node.js `>= 20`** 与 **Google Antigravity**。

**Windows（PowerShell）：**

```powershell
git clone https://github.com/FableFatale/antigravity-context-monitor.git "$env:USERPROFILE\.gemini\config\plugins\context-monitor"
cd "$env:USERPROFILE\.gemini\config\plugins\context-monitor\mcp"
npm install
```

**macOS / Linux：**

```bash
git clone https://github.com/FableFatale/antigravity-context-monitor.git ~/.gemini/config/plugins/context-monitor
cd ~/.gemini/config/plugins/context-monitor/mcp
npm install
```

随后打开 **Antigravity → Plugins / Customizations** 启用 **Context & Cache Monitor**，即可通过以下方式进入：
- **左侧边栏（推荐）**：点击 **Context & Cache** 打开全屏 MCP App 仪表盘。
- **右侧边栏**：通过 `+` 菜单打开 **Context & Cache**，或在对话中输入 `/context-monitor`。

---

## 压缩触发策略

点击面板右上角「压缩设置」打开右侧抽屉，按你的工作习惯选择到达阈值后的行为：

| 策略模式 | 行为说明 | 支持平台 |
| :--- | :--- | :--- |
| **桌面弹窗确认**（`toast_confirm`） | 在右下角弹出不抢占焦点的轻量提醒。点击「确定压缩」立即执行 `/compact`，也可点 `+20K` 延后本次阈值。 | Windows |
| **空闲全自动压缩**（`ui_send`） | 等待当前会话空闲指定秒数后，自动向 Antigravity 窗口发送 `/compact` 并在发送后还原剪贴板。 | Windows |
| **Hook 温和护航**（`hook_guard`） | 通过 `PreInvocation` Hook 注入 0-token 聊天内联提示，引导模型先收尾当前步骤，避开高代价大范围检索。 | Windows / macOS / Linux |
| **Hook 严格拦截**（`hook_block`） | 超出阈值后暂停下一轮模型调用，直到你主动执行 `/compact` 后恢复放行。 | Windows / macOS / Linux |
| **仅提醒并复制命令**（`notify`） | 自动复制 `/compact` 到剪贴板并给出提示，不触碰任何窗口。 | Windows / macOS / Linux |

---

## 隐私、安全与架构原则

- **100% 本地运行、默认严格只读**：零遥测、零统计埋点、零后台外部网络请求。仅只读解析本机 Antigravity 会话日志与 SQLite 元数据，个人配置保存在 Antigravity 官方目录 `plugin_data/context-monitor/auto-compact.json`。
- **单核心驱动**：零外部依赖的 Node.js 引擎（`sidecars/context-monitor/server.mjs`）同时驱动托管 Sidecar 与 MCP App（`mcp/server.mjs`），配合轻量 `PreInvocation` Hook（`hooks/context-guard.mjs`）协同工作。

### 本地执行与安全透明声明

为方便插件市场安全审核与用户评估，本插件所有可选的本机执行或网络能力均遵循 **「默认关闭或仅在用户主动点击时触发」** 原则：

| 能力项 | 触发条件与默认状态 | 作用范围与安全保护 |
| :--- | :--- | :--- |
| **会话日志与 SQLite 读取** | 插件启用后生效 | 仅对本机 Antigravity 会话记录与元数据执行严格只读解析，数据不离开本机。 |
| **Windows `/compact` 界面自动化**（`toast_confirm` / `ui_send`） | **需用户主动开启**（`toast_confirm` 模式下还需手动点击「确定压缩」） | 仅在 Antigravity 为当前前台窗口且键鼠空闲时调用本机 PowerShell 发送 `/compact`，发送后自动还原用户剪贴板；macOS / Linux 不会执行。 |
| **RTK CLI 一键安装器** | **仅在点击设置页「安装 RTK」按钮时触发** | 调用系统包管理器（`winget` / `brew` / 官方 `install.sh` / `cargo`），绝不在后台静默自动运行。 |
| **插件更新检查与一键更新** | **仅在点击「检查更新 / 立即更新」时触发** | 无后台轮询；仅在点击时访问 GitHub 比对版本号，并在用户二次确认后执行 `git pull --ff-only origin main`。 |
| **本机 `ConversationService` 元数据读取** | 当 Antigravity 注入 `ANTIGRAVITY_LS_ADDRESS` 与 `ANTIGRAVITY_CSRF_TOKEN` 时生效 | 仅对本机回环地址调用只读 RPC (`ListConversations`) 以补全会话标题与运行态；环境变量不存在时自动回退到本地文件读取。 |

完整的目录地图、接口契约与开发约束，请查阅面向 AI 与贡献者的 [`llms.txt`](../llms.txt) 和 [`AGENTS.md`](../AGENTS.md)。

---

## 开源协议

[MIT](../LICENSE) © 2026 FableFatale

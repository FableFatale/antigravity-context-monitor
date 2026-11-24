<p align="center">
  <img src="../assets/logo.svg" width="64" height="64" alt="Context &amp; Cache Monitor Logo" />
</p>

<h1 align="center">Context &amp; Cache Monitor for Antigravity</h1>

<p align="center">
  Google Antigravity 内で Gemini のコンテキスト使用量、プレフィックスキャッシュヒット率、<code>CHECKPOINT</code> 圧縮をリアルタイムに可視化し、キャッシュ失効前に <code>/compact</code> をスマートに実行するネイティブプラグイン。
</p>

<p align="center">
  <a href="../README.md">English</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <b>日本語</b> ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.de.md">Deutsch</a>
</p>

<p align="center">
  <sub>🤖 <b>AI エージェント / LLM 向け：</b> 人間向け解説をスキップし、インストール手順と API 仕様は <a href="../llms.txt"><code>llms.txt</code></a>、アーキテクチャ規約と検証コマンドは <a href="../AGENTS.md"><code>AGENTS.md</code></a> を直接参照してください。</sub>
</p>

---

## 開発の背景

Antigravity で長い Gemini セッションを続けると、いつの間にかコンテキストが膨らみ、自動 `CHECKPOINT` 圧縮が走ったり、プレフィックスキャッシュのヒット率が急落して高コストな再計算が発生したりします。しかし Antigravity 標準では圧縮しきい値のカスタマイズやセッション別のキャッシュ監視画面は用意されていません。

**Context & Cache Monitor** は、静かで洗練された監視・自動圧縮体験を Antigravity にネイティブ統合します：

- **左サイドバー全画面（MCP App）& 右ペイン（Sidecar UI）両対応**：単一のライブ UI を両方のエントリポイントで共有。
- **ノイズを抑えたファーストビュー**：画面上部にはアクティブセッションのコンテキスト使用量バー（早期警告ライン・圧縮しきい値目盛り付き）、自動圧縮トグル、「今すぐ圧縮」ボタンだけを配置。細かい設定は右側のスライドドロワーに集約しています。
- **モデル別の動的しきい値提案**：過去の `CHECKPOINT` 発生点とキャッシュ急落履歴からモデルごとに最適なしきい値を自動算出。手動調整はデフォルトで次回圧縮のみに適用され、完了後は自動で動的モードへ戻ります（固定ロックも可能）。
- **3層コンテキストライフサイクル設計**：
  1. **ソフト警告サブエージェント分流（≥70% しきい値）**：コンテキストが肥大化する前に `PreInvocation` フックが重いコード探索やテスト実行を `invoke_subagent` へ誘導し、メインスレッドのプレフィックスキャッシュヒット率（95%+）を維持します。
  2. **圧縮後メモリ台帳の自動注入（Post-CHECKPOINT 復元）**：`CHECKPOINT` 圧縮直後の最初のターンで、圧縮前に変更・参照した正確なファイルパス一覧、行範囲、タスク進捗を `<15ms` で抽出し自動注入。圧縮後のシンボル忘却やハルシネーションを防ぎます。
  3. **フォーカスを奪わないサイレント自動圧縮**：Antigravity が前面かつキーボード/マウスがアイドル時のみ `/compact` を送信（オートコンプリート貫通の2回 Enter・ターン別重複防止・Windows UIAutomation フォーカス復帰内蔵）。
- **直感的なクロスフィルタリング**：`24時間推移` と全幅レスポンシブ `53週間ヒートマップ` を切り替え可能。右側の「モデル別 / セッション別（全件検索対応）」や時間帯バーをクリックするだけでダッシュボード全体を連動フィルタリングでき、上部のチップからワンクリックで解除できます。
- **5言語自動判定**：システム言語（日本語 / English / 简体中文 / Français / Deutsch）を自動検出し、上部バーからいつでも切り替え可能です。

---

## クイックスタート

### 方法 A · AI エージェントにインストールを任せる（推奨）

Antigravity（または任意のコーディングエージェント）に以下を入力してください：

```text
https://raw.githubusercontent.com/FableFatale/antigravity-context-monitor/main/llms.txt を読み込み、Context & Cache Monitor プラグインをローカルの Antigravity プラグインディレクトリにインストールしてください。
```

### 方法 B · 手動インストール

**Node.js `>= 20`** および **Google Antigravity** が必要です。

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

その後 **Antigravity → Plugins / Customizations** で **Context & Cache Monitor** を有効化し、以下から開きます：
- **左サイドバー（推奨）**：**Context & Cache** をクリックして全画面 MCP App を表示。
- **右サイドペイン**：`+` メニューから **Context & Cache** を選択、またはチャットで `/context-monitor` と入力。

---

## 圧縮トリガーモード

ダッシュボード右上の「設定」ドロワーから、しきい値到達時の動作を選択できます：

| モード | 動作内容 | 対応 OS |
| :--- | :--- | :--- |
| **デスクトップトースト確認** (`toast_confirm`) | フォーカスを奪わずに画面右下へ軽量トーストを表示。「確定」で即 `/compact` を送信、または `+20K` で一時延長。 | Windows |
| **アイドル時自動圧縮** (`ui_send`) | セッションが指定秒数アイドルになると Antigravity ウィンドウへ `/compact` を自動送信し、クリップボードを復元。 | Windows |
| **Hook ソフトガード** (`hook_guard`) | `PreInvocation` フック経由で 0-token インライン通知を表示し、大規模探索を避けて作業をまとめるよう案内。 | Windows / macOS / Linux |
| **Hook ハードブロック** (`hook_block`) | しきい値超過時に次のモデル呼び出しを一時停止し、`/compact` 実行後に再開。 | Windows / macOS / Linux |
| **通知のみ** (`notify`) | ウィンドウ操作を行わず、`/compact` をクリップボードへコピーして通知。 | Windows / macOS / Linux |

---

## プライバシーとアーキテクチャ

- **完全ローカル & 読み取り専用**：外部通信やテレメトリは一切ありません。Antigravity のローカルログおよび SQLite メタデータを読み取り専用で解析し、設定のみ `plugin_data/context-monitor/auto-compact.json` に保存します。
- **単一コア設計**：依存関係ゼロの Node.js エンジン（`sidecars/context-monitor/server.mjs`）が Sidecar と MCP App（`mcp/server.mjs`）の双方を駆動し、軽量な `PreInvocation` フック（`hooks/context-guard.mjs`）と連携します。

詳細なファイル構成・API 仕様・開発規約については [`llms.txt`](../llms.txt) および [`AGENTS.md`](../AGENTS.md) をご覧ください。

---

## ライセンス

[MIT](../LICENSE) © 2026 FableFatale

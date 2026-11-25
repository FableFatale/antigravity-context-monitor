import { existsSync, mkdirSync, openSync, readFileSync, readSync, closeSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const APP_DATA = process.env.ANTIGRAVITY_APP_DATA_DIR || join(homedir(), '.gemini', 'antigravity');
const PLUGIN_DATA = process.env.PLUGIN_DATA || join(APP_DATA, 'plugin_data', 'context-monitor');
const CONFIG_PATH = join(PLUGIN_DATA, 'auto-compact.json');
const STATE_PATH = join(PLUGIN_DATA, 'hook-state.json');

function readStdin() {
  try {
    return readFileSync(0, 'utf-8');
  } catch {
    return '';
  }
}

function loadJson(path, fallback) {
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {}
  return fallback;
}

function saveJson(path, data) {
  try {
    mkdirSync(PLUGIN_DATA, { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
  } catch {}
}

function readTail(filePath, maxBytes = 256 * 1024) {
  const st = statSync(filePath);
  const size = st.size;
  const start = Math.max(0, size - maxBytes);
  const len = size - start;
  const buf = Buffer.alloc(len);
  const fd = openSync(filePath, 'r');
  try {
    readSync(fd, buf, 0, len, start);
  } finally {
    closeSync(fd);
  }
  return buf.toString('utf-8');
}

function unquoteArg(val) {
  if (val === undefined || val === null) return '';
  if (typeof val !== 'string') return String(val);
  const s = val.trim();
  if (s.startsWith('"') && s.endsWith('"')) {
    try {
      return JSON.parse(s);
    } catch {
      return s.slice(1, -1);
    }
  }
  return s;
}

function analyzeTranscript(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;
  const tail = readTail(transcriptPath, 512 * 1024);
  const lines = tail.split('\n');
  const objs = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || !line.startsWith('{')) continue;
    try {
      objs.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  if (objs.length === 0) return null;

  let latestSnap = null;
  let latestStep = 0;
  let lastCpIdx = -1;
  let lastCpStep = 0;
  let prevCpIdx = -1;

  for (let i = 0; i < objs.length; i++) {
    const o = objs[i];
    const step = Number(o.step_index) || i;
    if (step > latestStep) latestStep = step;
    if (o.type === 'CHECKPOINT') {
      prevCpIdx = lastCpIdx;
      lastCpIdx = i;
      lastCpStep = step;
    }
  }

  for (let i = objs.length - 1; i >= 0; i--) {
    const obj = objs[i];
    if (obj.type === 'CHECKPOINT') {
      if (!latestSnap) {
        latestSnap = { type: 'CHECKPOINT', step: Number(obj.step_index) || 0, contextTotal: 0, cacheRead: 0, input: 0, hitRate: 0 };
      }
      break;
    }
    const hasTokens = typeof obj.input_tokens === 'number' || typeof obj.cache_read_tokens === 'number';
    if (!hasTokens) continue;
    const input = obj.input_tokens ?? 0;
    const cacheRead = obj.cache_read_tokens ?? 0;
    const contextTotal = input + cacheRead;
    const hitRate = contextTotal > 0 ? Math.round((cacheRead / contextTotal) * 1000) / 10 : 0;
    latestSnap = {
      type: obj.type || 'PLANNER_RESPONSE',
      step: Number(obj.step_index) || 0,
      contextTotal,
      cacheRead,
      input,
      hitRate,
    };
    break;
  }

  function extractSegmentLedger(startIdx, endIdx, checkpointStep = 0) {
    const editedMap = new Map();
    const readMap = new Map();
    const commands = [];
    let lastSteps = null;
    let lastFocus = '';

    for (let i = Math.max(0, startIdx); i < Math.min(objs.length, endIdx); i++) {
      const o = objs[i];
      if (!Array.isArray(o.tool_calls)) continue;
      for (const tc of o.tool_calls) {
        const name = tc.name || '';
        const args = tc.args || {};
        if (name === 'write_file' || name === 'edit_file') {
          const p = unquoteArg(args.Path);
          if (p) {
            editedMap.delete(p);
            editedMap.set(p, name === 'write_file' ? 'write' : 'edit');
          }
        } else if (name === 'read_file') {
          const p = unquoteArg(args.Path);
          if (p) {
            const sLine = unquoteArg(args.StartLine);
            const eLine = unquoteArg(args.EndLine);
            const range = sLine || eLine ? `L${sLine || 1}-${eLine || 'end'}` : 'full';
            readMap.delete(p);
            readMap.set(p, range);
          }
        } else if (name === 'run_command') {
          const sum = unquoteArg(args.toolSummary) || unquoteArg(args.CommandLine).split(/\r?\n/)[0].slice(0, 72);
          if (sum) commands.push(sum);
        } else if (name === 'update_steps') {
          const rawSteps = unquoteArg(args.steps);
          try {
            const parsed = typeof rawSteps === 'string' ? JSON.parse(rawSteps) : rawSteps;
            if (Array.isArray(parsed) && parsed.length > 0) lastSteps = parsed;
          } catch {}
        } else if (name === 'update_focus') {
          const f = unquoteArg(args.focus);
          if (f) lastFocus = f;
        }
      }
    }

    const editedFiles = [...editedMap.entries()].reverse().slice(0, 10).map(([p, op]) => `${p} (${op})`);
    const readFiles = [...readMap.entries()]
      .reverse()
      .filter(([p]) => !editedMap.has(p))
      .slice(0, 8)
      .map(([p, range]) => `${p} [${range}]`);
    const recentCommands = [...new Set(commands.reverse())].slice(0, 5);

    if (editedFiles.length === 0 && readFiles.length === 0 && recentCommands.length === 0 && !lastSteps) {
      return null;
    }
    return {
      checkpointStep,
      editedFiles,
      readFiles,
      recentCommands,
      lastSteps,
      lastFocus,
    };
  }

  // Extract deterministic pre-checkpoint state ledger if a recent CHECKPOINT exists
  let ledger = null;
  if (lastCpIdx >= 0 && latestStep - lastCpStep <= 15) {
    const startIdx = Math.max(0, prevCpIdx + 1, lastCpIdx - 180);
    ledger = extractSegmentLedger(startIdx, lastCpIdx, lastCpStep);
  }

  // Also extract current active segment ledger for Auto-Branch Subagent Handoff when crossing threshold
  const activeStartIdx = Math.max(0, lastCpIdx + 1, objs.length - 180);
  const activeLedger = extractSegmentLedger(activeStartIdx, objs.length, latestStep);

  return {
    snap: latestSnap,
    latestStep,
    lastCpStep,
    ledger,
    activeLedger,
  };
}

function fmtK(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

function detectRtkInstalled(customPath = '') {
  try {
    const trimmed = String(customPath || '').trim();
    if (trimmed && existsSync(trimmed)) return true;
    if (existsSync(join(homedir(), '.gemini', 'config', 'plugins', 'rtk', 'plugin.json'))) return true;
    const isWin = process.platform === 'win32';
    const binName = isWin ? 'rtk.exe' : 'rtk';
    const dirs = String(process.env.PATH || '').split(isWin ? ';' : ':').filter(Boolean);
    for (const dir of dirs) {
      if (existsSync(join(dir, binName))) return true;
    }
  } catch {}
  return false;
}

function main() {
  const rawIn = readStdin();
  if (!rawIn) {
    process.stdout.write('{}');
    return;
  }

  let payload;
  try {
    payload = JSON.parse(rawIn);
  } catch {
    process.stdout.write('{}');
    return;
  }

  const convId = payload.conversationId || 'unknown';
  const now = Date.now();
  const state = loadJson(STATE_PATH, {});
  const convState = state[convId] || {};

  // Handle Stop lifecycle hook: record exact turn termination & fullyIdle flag so Auto-Compact never fires mid-turn
  if (payload.hookEventName === 'Stop') {
    convState.turnActive = false;
    convState.fullyIdle = payload.fullyIdle !== false;
    convState.stoppedAt = now;
    convState.terminationReason = payload.terminationReason || '';
    state[convId] = convState;
    saveJson(STATE_PATH, state);
    process.stdout.write('{}');
    return;
  }

  // Mark turn active on PreInvocation
  convState.turnActive = true;
  convState.fullyIdle = false;
  convState.startedAt = now;
  state[convId] = convState;
  saveJson(STATE_PATH, state);

  // Never interfere with an explicit /compact command
  const lastInput = String(payload.lastUserInput || '').trim();
  if (/^\/compact\b/i.test(lastInput)) {
    process.stdout.write('{}');
    return;
  }

  const cfg = loadJson(CONFIG_PATH, {
    enabled: false,
    thresholdMode: 'auto',
    thresholdK: 180,
    effectiveThresholdK: 180,
    mode: 'ui_send',
    subagentOffload: true,
    postCompactLedger: true,
  });
  if (!cfg.enabled) {
    process.stdout.write('{}');
    return;
  }

  const effectiveK = cfg.thresholdMode === 'auto'
    ? (Number(cfg.effectiveThresholdK) || Number(cfg.thresholdK) || 180)
    : (Number(cfg.thresholdK) || Number(cfg.effectiveThresholdK) || 180);
  const thresholdTokens = Math.max(50, effectiveK) * 1000;
  const softWarningTokens = Math.round(thresholdTokens * 0.7);

  let transcriptPath = payload.transcriptPath || '';
  if ((!transcriptPath || !existsSync(transcriptPath)) && payload.conversationId) {
    transcriptPath = join(APP_DATA, 'brain', payload.conversationId, '.system_generated', 'logs', 'transcript.jsonl');
  }

  const analysis = analyzeTranscript(transcriptPath);
  if (!analysis) {
    process.stdout.write('{}');
    return;
  }

  const { snap, lastCpStep, ledger, activeLedger } = analysis;

  const VALID_LANGS = new Set(['en', 'zh', 'ja', 'fr', 'de']);
  const detectOsLang = () => {
    const raw = (Intl.DateTimeFormat().resolvedOptions().locale || process.env.LANG || process.env.LC_ALL || 'en').toLowerCase();
    if (raw.startsWith('zh')) return 'zh';
    if (raw.startsWith('ja')) return 'ja';
    if (raw.startsWith('fr')) return 'fr';
    if (raw.startsWith('de')) return 'de';
    return 'en';
  };
  const lang = (cfg.lang && cfg.lang !== 'auto' && VALID_LANGS.has(cfg.lang))
    ? cfg.lang
    : (cfg.resolvedLang && VALID_LANGS.has(cfg.resolvedLang) ? cfg.resolvedLang : detectOsLang());

  // ============================================================================
  // Architecture 2: Post-CHECKPOINT Deterministic State Ledger Injection
  // Simulates PostCompact Hook (#1317) on the first turn after compaction
  // ============================================================================
  const enableLedger = cfg.postCompactLedger !== false;
  if (
    enableLedger &&
    ledger &&
    lastCpStep > 0 &&
    Number(convState.lastLedgerCheckpointStep || 0) !== lastCpStep
  ) {
    convState.lastLedgerCheckpointStep = lastCpStep;
    convState.lastLedgerAt = now;
    state[convId] = convState;
    saveJson(STATE_PATH, state);

    const eCount = ledger.editedFiles.length;
    const rCount = ledger.readFiles.length;
    const cCount = ledger.recentCommands.length;

    const LEDGER_BANNER = {
      en: `> 🧬 **Context & Cache · Post-Compaction Memory Ledger Injected**: Restored **${eCount} modified files**, **${rCount} inspected files**, and task state from pre-checkpoint Step #${lastCpStep} to prevent post-compaction amnesia.`,
      zh: `> 🧬 **Context & Cache · 压缩后防失忆账本已注入**：已从 Step #${lastCpStep} 压缩前的工具记录中无损恢复 **${eCount} 个修改文件**、**${rCount} 个读取文件** 与任务状态，防止压缩后丢失精确路径或幻觉。`,
      ja: `> 🧬 **Context & Cache · 圧縮後メモリ台帳を注入**：Step #${lastCpStep} 以前の履歴から **変更ファイル ${eCount} 件**・**参照ファイル ${rCount} 件** とタスク状態を復元し、圧縮後の記憶喪失を防止しました。`,
      fr: `> 🧬 **Context & Cache · Registre post-compaction injecté** : **${eCount} fichiers modifiés**, **${rCount} fichiers lus** et l'état des tâches restaurés depuis l'étape #${lastCpStep} pour éviter toute amnésie.`,
      de: `> 🧬 **Context & Cache · Post-Komprimierungs-Ledger injiziert**: **${eCount} geänderte Dateien**, **${rCount} gelesene Dateien** und Aufgabenstatus aus Schritt #${lastCpStep} wiederhergestellt, um Kontextverlust zu verhindern.`,
    };

    const sysLines = [
      `[Context & Cache Monitor · Post-Compaction Deterministic State Ledger (Checkpoint Step #${lastCpStep})]`,
      `IMPORTANT WORKING-MEMORY NOTICE: Context compaction just occurred. Raw file contents and tool outputs prior to Step #${lastCpStep} were evicted from active context. You MUST re-read files via \`read_file\` before quoting exact line numbers, symbols, or applying edits.`,
    ];
    if (ledger.lastFocus) {
      sysLines.push(`- Last Active Focus before compaction: ${ledger.lastFocus}`);
    }
    if (ledger.lastSteps && ledger.lastSteps.length > 0) {
      const stepsSummary = ledger.lastSteps
        .map((s) => `[${s.status === 'done' ? 'x' : s.status === 'in_progress' ? '/' : ' '}] ${s.title}`)
        .join(' | ');
      sysLines.push(`- Pre-Compaction Task Checklist: ${stepsSummary}`);
    }
    if (eCount > 0) {
      sysLines.push(`- Modified / Created Files prior to checkpoint (${eCount}):\n  ${ledger.editedFiles.join('\n  ')}`);
    }
    if (rCount > 0) {
      sysLines.push(`- Inspected Files prior to checkpoint (${rCount}):\n  ${ledger.readFiles.join('\n  ')}`);
    }
    if (cCount > 0) {
      sysLines.push(`- Recent Shell Commands prior to checkpoint: ${ledger.recentCommands.join(' ; ')}`);
    }

    const out = {
      injectSteps: [
        {
          systemMessage: {
            systemMessage: sysLines.join('\n'),
          },
        },
      ],
    };
    process.stdout.write(JSON.stringify(out));
    return;
  }

  if (!snap || snap.type === 'CHECKPOINT' || snap.contextTotal < softWarningTokens) {
    process.stdout.write('{}');
    return;
  }

  const mode = cfg.mode || 'ui_send';
  const pct = Math.round((snap.contextTotal / thresholdTokens) * 100);
  const curStr = fmtK(snap.contextTotal);
  const thStr = fmtK(thresholdTokens);
  const hitStr = `${snap.hitRate}%`;
  const rtkInstalled = detectRtkInstalled(cfg.rtkPath);

  // ============================================================================
  // Architecture 1: Tiered Subagent Offloading at Soft Warning (70% - 99%)
  // Proactively offloads heavy reads/searches to subagents to protect Prefix Cache
  // ============================================================================
  const enableOffload = cfg.subagentOffload !== false;
  if (snap.contextTotal < thresholdTokens) {
    if (!enableOffload) {
      process.stdout.write('{}');
      return;
    }
    const lastOffloadAt = Number(convState.lastOffloadAt || 0);
    const lastOffloadTokens = Number(convState.lastOffloadTokens || 0);
    // Fire at most once per 180s and only if context grew by >= 20K since last offload hint
    if (now - lastOffloadAt < 180 * 1000 && snap.contextTotal - lastOffloadTokens < 20000) {
      process.stdout.write('{}');
      return;
    }
    convState.lastOffloadAt = now;
    convState.lastOffloadTokens = snap.contextTotal;
    state[convId] = convState;
    saveJson(STATE_PATH, state);

    const OFFLOAD_BANNER = {
      en: `> 🧭 **Context & Cache · Soft-Warning Subagent Offloading (${pct}%)**: Context **${curStr}** / **${thStr}** (cache hit ${hitStr}). Guided agent to delegate multi-file searches & heavy reads to isolated subagents (\`invoke_subagent\`) to preserve main-thread prefix cache.`,
      zh: `> 🧭 **Context & Cache · 软预警子代理分流 (${pct}%)**：当前上下文 **${curStr}** / 阈值 **${thStr}**（缓存命中 ${hitStr}）。已自动引导 Agent 将多文件检索与长输出任务分流至独立子代理（\`invoke_subagent\`），延缓主会话膨胀并保住高缓存命中。`,
      ja: `> 🧭 **Context & Cache · ソフト警告サブエージェント分流 (${pct}%)**：コンテキスト **${curStr}** / **${thStr}**（キャッシュヒット ${hitStr}）。メインスレッドのキャッシュ維持のため、重い調査や検索を \`invoke_subagent\` に委譲するよう誘導しました。`,
      fr: `> 🧭 **Context & Cache · Délégation sous-agent en pré-alerte (${pct}%)** : Contexte **${curStr}** / **${thStr}** (cache ${hitStr}). L'agent est guidé pour déléguer les recherches lourdes à \`invoke_subagent\` afin de préserver le cache préfixe.`,
      de: `> 🧭 **Context & Cache · Vorwarnung Subagent-Auslagerung (${pct}%)**: Kontext **${curStr}** / **${thStr}** (Cache ${hitStr}). Agent angewiesen, umfangreiche Suchen an \`invoke_subagent\` auszulagern, um den Präfix-Cache zu schonen.`,
    };

    const outputBudgetNote = rtkInstalled
      ? ` (3) RTK output condenser is active on this machine — keep shell commands batched and avoid \`rtk bypass\` unless raw uncondensed output is strictly required.`
      : ` (3) Command output budget (fallback): keep shell output compact with flags like \`git status -sb\`, \`git diff --stat\`, \`-n 40\`, \`Select-Object -First 40\`, or targeted failing tests so raw logs do not bloat active context.`;

    const out = {
      injectSteps: [
        {
          systemMessage: {
            systemMessage:
              `[Context & Cache Monitor · Tiered Subagent Offloading (${curStr} / ${thStr}, ${pct}% of threshold, cache hit ${hitStr})] ` +
              `Active context has entered the Soft Warning zone (70%-99% of compaction threshold). To preserve the main thread's prefix cache and avoid premature compaction: ` +
              `(1) Delegate multi-file searches, broad codebase exploration, or verbose test/build runs to \`invoke_subagent\` (\`research\` for read-only surveys, \`self\` for isolated sub-tasks) so bulky tool outputs stay in the subagent's isolated window and only a concise summary returns here; once a one-shot \`research\`/\`self\` subagent finishes and returns its result, immediately dispose of it via \`manage_subagents({ Action: "kill", ConversationIds: ["<id>"] })\` (leave \`browser\` subagents idle if follow-ups are expected). ` +
              `(2) When reading files directly in the main thread, always pass narrow \`StartLine\`/\`EndLine\` ranges.` +
              outputBudgetNote,
          },
        },
      ],
    };
    process.stdout.write(JSON.stringify(out));
    return;
  }

  // ============================================================================
  // Threshold Reached (>= 100% of thresholdTokens)
  // ============================================================================
  const HOOK_TEXT = {
    en: {
      block: `[Context Guard] Context occupancy ${curStr} reached threshold ${thStr} (${pct}%, cache hit ${hitStr}).\nPlease run /compact before continuing, or adjust the threshold in [Context & Cache](sidecar://context-monitor/context-monitor/).`,
      head: `> **Context & Cache Monitor**: Context occupancy **${curStr}** / threshold **${thStr}** (${pct}% · cache hit ${hitStr}).`,
      ui_send: ` Internal Hook Guard is active; \`/compact\` will be sent silently when Antigravity is in the foreground and input is idle (post-compaction memory ledger ready).`,
      toast_confirm: ` A toast confirmation will appear when idle, or open [Context & Cache](sidecar://context-monitor/context-monitor/) to compact now.`,
      other: ` Consider running \`/compact\` after this turn, or open [Context & Cache](sidecar://context-monitor/context-monitor/).`,
    },
    zh: {
      block: `[Context Guard] 当前上下文占用 ${curStr} 已达到设定阈值 ${thStr} (${pct}%，缓存命中率 ${hitStr})。\n请发送 /compact 压缩上下文后再继续，或在侧栏 [Context & Cache](sidecar://context-monitor/context-monitor/) 调整阈值/模式。`,
      head: `> **Context & Cache Monitor**：当前上下文占用 **${curStr}** / 阈值 **${thStr}** (${pct}% · 缓存命中 ${hitStr})。`,
      ui_send: ` 已启用内部 Hook 护航（收尾控量 + 压缩后防失忆账本就绪），待本轮结束且 Antigravity 处于前台键鼠空闲时将静默发送 \`/compact\`。`,
      toast_confirm: ` 本轮空闲后将弹出 Toast 提醒供你点确定立马压缩；也可点击 [Context & Cache](sidecar://context-monitor/context-monitor/) 查看或立即压缩。`,
      other: ` 建议本轮结束后发送 \`/compact\`，或打开 [Context & Cache](sidecar://context-monitor/context-monitor/) 调整阈值。`,
    },
    ja: {
      block: `[Context Guard] コンテキスト使用量 ${curStr} がしきい値 ${thStr} に達しました (${pct}%・キャッシュヒット率 ${hitStr})。\n続行する前に /compact を実行するか、[Context & Cache](sidecar://context-monitor/context-monitor/) で設定を調整してください。`,
      head: `> **Context & Cache Monitor**：コンテキスト使用量 **${curStr}** / しきい値 **${thStr}** (${pct}% · キャッシュヒット ${hitStr})。`,
      ui_send: ` 内部 Hook ガードが有効です。このターン終了後、Antigravity が前面かつ入力アイドル時に \`/compact\` を自動送信します（圧縮後メモリ台帳待機中）。`,
      toast_confirm: ` アイドル時に確認トーストが表示されます。[Context & Cache](sidecar://context-monitor/context-monitor/) から即時圧縮も可能です。`,
      other: ` このターン終了後に \`/compact\` を実行するか、[Context & Cache](sidecar://context-monitor/context-monitor/) を確認してください。`,
    },
    fr: {
      block: `[Context Guard] L'occupation du contexte ${curStr} a atteint le seuil ${thStr} (${pct}%, cache ${hitStr}).\nExécutez /compact avant de continuer ou ajustez le seuil dans [Context & Cache](sidecar://context-monitor/context-monitor/).`,
      head: `> **Context & Cache Monitor** : Occupation du contexte **${curStr}** / seuil **${thStr}** (${pct}% · cache ${hitStr}).`,
      ui_send: ` Garde Hook interne active ; \`/compact\` sera envoyé silencieusement lorsque Antigravity sera au premier plan et inactif.`,
      toast_confirm: ` Une notification Toast s'affichera à l'inactivité, ou ouvrez [Context & Cache](sidecar://context-monitor/context-monitor/).`,
      other: ` Pensez à exécuter \`/compact\` après ce tour ou ouvrez [Context & Cache](sidecar://context-monitor/context-monitor/).`,
    },
    de: {
      block: `[Context Guard] Kontextauslastung ${curStr} hat den Schwellenwert ${thStr} erreicht (${pct}%, Cache-Trefferquote ${hitStr}).\nBitte führen Sie /compact aus oder passen Sie den Wert in [Context & Cache](sidecar://context-monitor/context-monitor/) an.`,
      head: `> **Context & Cache Monitor**: Kontextauslastung **${curStr}** / Schwelle **${thStr}** (${pct}% · Cache ${hitStr}).`,
      ui_send: ` Interner Hook-Schutz aktiv; \`/compact\` wird im Leerlauf gesendet, sobald Antigravity im Vordergrund ist.`,
      toast_confirm: ` Im Leerlauf erscheint eine Toast-Bestätigung, oder öffnen Sie [Context & Cache](sidecar://context-monitor/context-monitor/).`,
      other: ` Führen Sie nach dieser Runde \`/compact\` aus oder öffnen Sie [Context & Cache](sidecar://context-monitor/context-monitor/).`,
    },
  };
  const tx = HOOK_TEXT[lang] || HOOK_TEXT.en;

  // Mode 1: Hard gate before crossing threshold
  if (mode === 'hook_block') {
    const out = {
      injectSteps: [
        {
          errorMessage: {
            userMessage: tx.block,
          },
        },
      ],
      terminationBehavior: 'terminate',
    };
    process.stdout.write(JSON.stringify(out));
    return;
  }

  // Throttle non-blocking threshold banners per conversation (at most once every 60s)
  const lastWarn = Number(convState.lastWarnAt || 0);
  if (now - lastWarn < 60 * 1000) {
    process.stdout.write('{}');
    return;
  }
  convState.lastWarnAt = now;
  convState.lastContextTotal = snap.contextTotal;
  state[convId] = convState;
  saveJson(STATE_PATH, state);

  const bannerMd = tx.head + (mode === 'ui_send' ? tx.ui_send : mode === 'toast_confirm' ? tx.toast_confirm : tx.other);

  if (mode === 'hook_guard' || mode === 'ui_send') {
    const branchLines = [
      `[Context Guard · Threshold Reached (${fmtK(snap.contextTotal)} / ${fmtK(thresholdTokens)})]`,
      `Active context has reached the compaction threshold. Auto-Compact will execute automatically as soon as this turn terminates (` +
        `Stop hook with fullyIdle=true).`,
    ];
    if (enableOffload) {
      branchLines.push(
        `AUTO-BRANCH SESSION HANDOFF DIRECTIVE: If the user's request requires multi-step implementation, code edits, or test runs before this turn ends, you SHOULD immediately spawn a clean branched session via \`invoke_subagent({ TypeName: "self", Workspace: "inherit", Role: "Branched Session Executor", Prompt: "<Compact Task Brief + Active File Ledger>" })\`. ` +
          `The branched session starts with a fresh ~25K context window and full write/command capabilities, returning only the compact result here — immediately dispose of the finished one-shot subagent via \`manage_subagents({ Action: "kill", ConversationIds: ["<id>"] })\` so this parent session terminates quickly and compacts cleanly.`
      );
      if (activeLedger) {
        if (activeLedger.editedFiles.length > 0) {
          branchLines.push(`- Active Modified Files to include in subagent handoff: ${activeLedger.editedFiles.slice(0, 6).join(', ')}`);
        }
        if (activeLedger.readFiles.length > 0) {
          branchLines.push(`- Active Inspected Files: ${activeLedger.readFiles.slice(0, 5).join(', ')}`);
        }
      }
    } else {
      branchLines.push(
        `Finish the current atomic step cleanly, avoid starting large broad searches or reading huge files inline, and keep output concise so compaction can run smoothly.`
      );
    }
    branchLines.push(
      rtkInstalled
        ? `- RTK output condenser active: keep final verification commands compact and avoid \`rtk bypass\`.`
        : `- Output budget (pure fallback): keep any final shell command output compact (\`--stat\`, \`-n 30\`, targeted tests only) before compaction.`
    );
    const out = {
      injectSteps: [
        {
          systemMessage: {
            systemMessage: branchLines.join('\n'),
          },
        },
      ],
    };
    process.stdout.write(JSON.stringify(out));
    return;
  }

  // toast_confirm / notify: let sidecar handle desktop toast/copy without injecting extra model text
  process.stdout.write('{}');
}

try {
  main();
} catch {
  process.stdout.write('{}');
}

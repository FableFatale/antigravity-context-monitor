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

function readTail(filePath, maxBytes = 128 * 1024) {
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

function getLatestTokenSnapshot(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;
  const tail = readTail(transcriptPath);
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line || !line.startsWith('{')) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type === 'CHECKPOINT') {
      return { type: 'CHECKPOINT', contextTotal: 0, cacheRead: 0, input: 0, hitRate: 0 };
    }
    const hasTokens = typeof obj.input_tokens === 'number' || typeof obj.cache_read_tokens === 'number';
    if (!hasTokens) continue;
    const input = obj.input_tokens ?? 0;
    const cacheRead = obj.cache_read_tokens ?? 0;
    const contextTotal = input + cacheRead;
    const hitRate = contextTotal > 0 ? Math.round((cacheRead / contextTotal) * 1000) / 10 : 0;
    return { type: obj.type || 'PLANNER_RESPONSE', contextTotal, cacheRead, input, hitRate };
  }
  return null;
}

function fmtK(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
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
    mode: 'toast_confirm',
  });
  if (!cfg.enabled) {
    process.stdout.write('{}');
    return;
  }

  const effectiveK = cfg.thresholdMode === 'auto'
    ? (Number(cfg.effectiveThresholdK) || Number(cfg.thresholdK) || 180)
    : (Number(cfg.thresholdK) || Number(cfg.effectiveThresholdK) || 180);
  const thresholdTokens = Math.max(50, effectiveK) * 1000;
  let transcriptPath = payload.transcriptPath || '';
  if ((!transcriptPath || !existsSync(transcriptPath)) && payload.conversationId) {
    transcriptPath = join(APP_DATA, 'brain', payload.conversationId, '.system_generated', 'logs', 'transcript.jsonl');
  }

  const snap = getLatestTokenSnapshot(transcriptPath);
  if (!snap || snap.type === 'CHECKPOINT' || snap.contextTotal < thresholdTokens) {
    process.stdout.write('{}');
    return;
  }

  const mode = cfg.mode || 'ui_send';
  const pct = Math.round((snap.contextTotal / thresholdTokens) * 100);
  const convId = payload.conversationId || 'unknown';
  const now = Date.now();

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

  const curStr = fmtK(snap.contextTotal);
  const thStr = fmtK(thresholdTokens);
  const hitStr = `${snap.hitRate}%`;

  const HOOK_TEXT = {
    en: {
      block: `[Context Guard] Context occupancy ${curStr} reached threshold ${thStr} (${pct}%, cache hit ${hitStr}).\nPlease run /compact before continuing, or adjust the threshold in [Context & Cache](sidecar://context-monitor/context-monitor/).`,
      head: `> **Context & Cache Monitor**: Context occupancy **${curStr}** / threshold **${thStr}** (${pct}% · cache hit ${hitStr}).`,
      ui_send: ` Internal Hook Guard is active; \`/compact\` will be sent silently when Antigravity is in the foreground and input is idle.`,
      toast_confirm: ` A toast confirmation will appear when idle, or open [Context & Cache](sidecar://context-monitor/context-monitor/) to compact now.`,
      other: ` Consider running \`/compact\` after this turn, or open [Context & Cache](sidecar://context-monitor/context-monitor/).`,
    },
    zh: {
      block: `[Context Guard] 当前上下文占用 ${curStr} 已达到设定阈值 ${thStr} (${pct}%，缓存命中率 ${hitStr})。\n请发送 /compact 压缩上下文后再继续，或在侧栏 [Context & Cache](sidecar://context-monitor/context-monitor/) 调整阈值/模式。`,
      head: `> **Context & Cache Monitor**：当前上下文占用 **${curStr}** / 阈值 **${thStr}** (${pct}% · 缓存命中 ${hitStr})。`,
      ui_send: ` 已启用内部 Hook 护航（收尾控量），待本轮结束且 Antigravity 处于前台键鼠空闲时将静默发送 \`/compact\`（绝不抢占其他窗口焦点）。`,
      toast_confirm: ` 本轮空闲后将弹出 Toast 提醒供你点确定立马压缩；也可点击 [Context & Cache](sidecar://context-monitor/context-monitor/) 查看或立即压缩。`,
      other: ` 建议本轮结束后发送 \`/compact\`，或打开 [Context & Cache](sidecar://context-monitor/context-monitor/) 调整阈值。`,
    },
    ja: {
      block: `[Context Guard] コンテキスト使用量 ${curStr} がしきい値 ${thStr} に達しました (${pct}%・キャッシュヒット率 ${hitStr})。\n続行する前に /compact を実行するか、[Context & Cache](sidecar://context-monitor/context-monitor/) で設定を調整してください。`,
      head: `> **Context & Cache Monitor**：コンテキスト使用量 **${curStr}** / しきい値 **${thStr}** (${pct}% · キャッシュヒット ${hitStr})。`,
      ui_send: ` 内部 Hook ガードが有効です。このターン終了後、Antigravity が前面かつ入力アイドル時に \`/compact\` を自動送信します。`,
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

  // Throttle non-blocking banners per conversation (at most once every 60s)
  const state = loadJson(STATE_PATH, {});
  const lastWarn = Number(state[convId]?.lastWarnAt || 0);
  if (now - lastWarn < 60 * 1000) {
    process.stdout.write('{}');
    return;
  }
  state[convId] = { lastWarnAt: now, lastContextTotal: snap.contextTotal };
  saveJson(STATE_PATH, state);

  const bannerMd = tx.head + (mode === 'ui_send' ? tx.ui_send : mode === 'toast_confirm' ? tx.toast_confirm : tx.other);

  if (mode === 'hook_guard' || mode === 'ui_send') {
    const out = {
      injectSteps: [
        {
          systemMessage: {
            systemMessage:
              `[Context Guard] Active context is ${fmtK(snap.contextTotal)} tokens (threshold ${fmtK(thresholdTokens)}). ` +
              `Finish the current atomic step cleanly, avoid starting large broad searches or reading huge files, and keep output concise so compaction can run smoothly.`,
            metadata: {
              user_markdown: bannerMd,
            },
          },
        },
      ],
    };
    process.stdout.write(JSON.stringify(out));
    return;
  }

  // ui_send / notify: zero-token inline user banner (empty systemMessage -> model reads nothing)
  const out = {
    injectSteps: [
      {
        systemMessage: {
          systemMessage: '',
          metadata: {
            user_markdown: bannerMd,
          },
        },
      },
    ],
  };
  process.stdout.write(JSON.stringify(out));
}

try {
  main();
} catch {
  process.stdout.write('{}');
}

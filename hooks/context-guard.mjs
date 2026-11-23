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

  // Mode 1: Hard gate before crossing threshold
  if (mode === 'hook_block') {
    const out = {
      injectSteps: [
        {
          errorMessage: {
            userMessage:
              `[Context Guard] 当前上下文占用 ${fmtK(snap.contextTotal)} 已达到设定阈值 ${fmtK(thresholdTokens)} (${pct}%，缓存命中率 ${snap.hitRate}%)。\n` +
              `请发送 /compact 压缩上下文后再继续，或在侧栏 [Context & Cache](sidecar://context-monitor/context-monitor/) 调整阈值/模式。`,
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

  const bannerMd =
    `> **Context & Cache Monitor**：当前上下文占用 **${fmtK(snap.contextTotal)}** / 阈值 **${fmtK(thresholdTokens)}** (${pct}% · 缓存命中 ${snap.hitRate}%)。` +
    (mode === 'ui_send'
      ? ` 本轮空闲后侧栏插件将自动发送 \`/compact\`；点击 [Context & Cache](sidecar://context-monitor/context-monitor/) 可调下次阈值。`
      : mode === 'toast_confirm'
        ? ` 本轮空闲后将弹出 Toast 提醒供你点确定立马压缩；也可点击 [Context & Cache](sidecar://context-monitor/context-monitor/) 查看或立即压缩。`
        : ` 建议本轮结束后发送 \`/compact\`，或打开 [Context & Cache](sidecar://context-monitor/context-monitor/) 调整阈值。`);

  if (mode === 'hook_guard') {
    const out = {
      injectSteps: [
        {
          systemMessage: {
            systemMessage:
              `[Context Guard] Active context is ${fmtK(snap.contextTotal)} tokens (threshold ${fmtK(thresholdTokens)}). ` +
              `Finish the current atomic step cleanly, avoid starting large broad searches or reading huge files, and remind the user to run /compact at the end of this response.`,
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

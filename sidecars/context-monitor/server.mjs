import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) || 0;
const APP_DATA = process.env.ANTIGRAVITY_APP_DATA_DIR || join(homedir(), '.gemini', 'antigravity');
const BRAIN_DIR = join(APP_DATA, 'brain');
const CONV_DB_DIR = join(APP_DATA, 'conversations');
const ID_RE = /^[0-9a-f-]{8,}$/i;
const COMPACT_THRESHOLD = 256000;
const MODEL_RE = /\b((?:gemini-(?:\d|pro|flash|ultra|exp)|claude-|gpt-|o[134]-)[a-z0-9._-]+)\b/gi;

const parseCache = new Map();

function detectModelFromDb(id) {
  const dbPath = join(CONV_DB_DIR, `${id}.db`);
  if (!existsSync(dbPath)) return '';
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare('SELECT data FROM gen_metadata ORDER BY idx DESC LIMIT 1').get();
    if (!row?.data) return '';
    const txt = Buffer.from(row.data).toString('utf8').replace(/[^\x20-\x7e]/g, ' ');
    const matches = txt.match(MODEL_RE) || [];
    const filtered = matches.filter((m) => !/^gemini-api$/i.test(m));
    return filtered.length > 0 ? filtered[filtered.length - 1] : '';
  } catch {
    return '';
  } finally {
    try { db?.close(); } catch {}
  }
}

function getTranscriptPath(id) {
  if (!ID_RE.test(id)) return null;
  const p = join(BRAIN_DIR, id, '.system_generated', 'logs', 'transcript.jsonl');
  return existsSync(p) ? p : null;
}

function parseConversation(id) {
  const tPath = getTranscriptPath(id);
  if (!tPath) return null;
  const st = statSync(tPath);
  const cached = parseCache.get(id);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return cached.data;
  }

  const raw = readFileSync(tPath, 'utf-8');
  const lines = raw.split('\n');
  const events = [];
  let title = '';
  let errorCount = 0;
  let currentModel = '';
  let lastRawType = '';
  let lastRawStatus = 'DONE';
  let lastRawToolCalls = 0;
  const runningTaskIds = new Set();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }

    lastRawType = obj.type || '';
    lastRawStatus = obj.status || 'DONE';
    lastRawToolCalls = Array.isArray(obj.tool_calls) ? obj.tool_calls.length : 0;
    if (obj.type === 'USER_INPUT' || obj.type === 'CHECKPOINT') {
      runningTaskIds.clear();
    } else if (obj.status === 'RUNNING' && typeof obj.content === 'string') {
      const tm = obj.content.match(/task id:\s*([^\s\n"]+)/i);
      if (tm && tm[1]) runningTaskIds.add(tm[1]);
    } else if (obj.type === 'SYSTEM_MESSAGE' && typeof obj.content === 'string') {
      const fm = obj.content.match(/Task id "([^"]+)" finished/i) || obj.content.match(/sender=([^\s]+)/i);
      if (fm && fm[1]) runningTaskIds.delete(fm[1]);
    }

    if (typeof obj.content === 'string') {
      const mMatch = obj.content.match(/Model Selection.*?to\s+([^\n<]+?)(?:\.\s+(?:No need|If reporting)|\.?\s*(?:\n|<|$))/i);
      if (mMatch && mMatch[1]) {
        const cleaned = mMatch[1].replace(/\.+$/, '').trim();
        if (cleaned) currentModel = cleaned;
      }
    }
    if (!title && obj.type === 'USER_INPUT' && typeof obj.content === 'string') {
      const clean = obj.content.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (clean) title = clean.slice(0, 48);
    }
    const isError = obj.status === 'ERROR' || obj.type === 'ERROR_MESSAGE';
    if (isError) {
      errorCount++;
    }

    const hasTokens = typeof obj.input_tokens === 'number' || typeof obj.cache_read_tokens === 'number';
    if (!hasTokens && obj.type !== 'CHECKPOINT' && !isError) continue;

    const input = obj.input_tokens ?? 0;
    const cacheRead = obj.cache_read_tokens ?? 0;
    const output = obj.output_tokens ?? 0;
    const contextTotal = input + cacheRead;
    const hitRate = contextTotal > 0 ? (cacheRead / contextTotal) * 100 : 0;
    const ts = obj.created_at ? Date.parse(obj.created_at) : st.mtimeMs;

    let cacheDrop = false;
    let afterCompaction = false;
    if (events.length > 0 && hasTokens) {
      const prev = events[events.length - 1];
      afterCompaction = prev.type === 'CHECKPOINT';
      if (prev.cacheRead > 10000 && cacheRead < prev.cacheRead * 0.5) {
        cacheDrop = true;
      }
    }

    let detail = '';
    if (isError) {
      const errStr = typeof obj.error === 'string' ? obj.error : (obj.error ? JSON.stringify(obj.error) : '');
      detail = (errStr || (typeof obj.content === 'string' ? obj.content : '')).slice(0, 600);
    } else if (obj.type === 'CHECKPOINT' && typeof obj.content === 'string') {
      detail = obj.content.slice(0, 600);
    }

    const liveContextTokens = obj.type === 'CHECKPOINT'
      ? ((output > 0 ? output : 3000) + 26500)
      : contextTotal;

    events.push({
      convId: id,
      convTitle: title || id.slice(0, 8),
      model: currentModel || '',
      step: obj.step_index ?? 0,
      type: obj.type || 'PLANNER_RESPONSE',
      status: obj.status || 'DONE',
      isError,
      detail,
      ts: Number.isFinite(ts) ? ts : st.mtimeMs,
      createdAt: obj.created_at || '',
      input,
      cacheRead,
      output,
      contextTotal,
      liveContextTokens,
      hitRate: Number(hitRate.toFixed(1)),
      cacheDrop,
      afterCompaction,
    });
  }

  const dbModel = detectModelFromDb(id);
  const resolvedModel = dbModel || currentModel || 'unknown';
  const resolvedTitle = title || id.slice(0, 8);
  for (const e of events) {
    e.convTitle = resolvedTitle;
    if (!e.model) e.model = resolvedModel;
  }

  const turnCompleted =
    (lastRawType === 'CHECKPOINT' && lastRawStatus === 'DONE') ||
    (lastRawType === 'PLANNER_RESPONSE' && lastRawStatus === 'DONE' && lastRawToolCalls === 0);
  const transcriptBusy = !turnCompleted || runningTaskIds.size > 0;

  const data = {
    id,
    title: resolvedTitle,
    model: resolvedModel,
    mtimeMs: st.mtimeMs,
    size: st.size,
    errorCount,
    transcriptBusy,
    lastRawType,
    lastRawToolCalls,
    runningTasksCount: runningTaskIds.size,
    events,
  };
  parseCache.set(id, { mtimeMs: st.mtimeMs, size: st.size, data });
  return data;
}

function getAllConversations() {
  if (!existsSync(BRAIN_DIR)) return [];
  const entries = readdirSync(BRAIN_DIR, { withFileTypes: true });
  const list = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !ID_RE.test(entry.name)) continue;
    const parsed = parseConversation(entry.name);
    if (parsed) list.push(parsed);
  }
  list.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return list;
}

function buildOverview(targetId, dayFilter, modelFilter, hourFilter) {
  const allConvs = getAllConversations();
  const selectedConvs = targetId && targetId !== 'all'
    ? allConvs.filter((c) => c.id === targetId)
    : allConvs;
  const activeModel = modelFilter && modelFilter !== 'all' ? modelFilter : '';

  let totalInput = 0;
  let totalCacheRead = 0;
  let totalOutput = 0;
  let totalErrors = 0;
  let totalCompactions = 0;
  let nonCompactDrops = 0;

  const allEvents = [];
  const convSummaries = [];
  const dailyMap = new Map();
  const modelMap = new Map();

  for (const c of selectedConvs) {
    let cIn = 0;
    let cCache = 0;
    let cOut = 0;
    let cCp = 0;
    let cDrops = 0;
    let cCount = 0;
    let lastEv = null;

    for (const e of c.events) {
      const mKey = e.model || c.model || 'unknown';
      let mBucket = modelMap.get(mKey);
      if (!mBucket) {
        mBucket = { model: mKey, requests: 0, totalTokens: 0, input: 0, cacheRead: 0, output: 0 };
        modelMap.set(mKey, mBucket);
      }
      mBucket.requests += 1;
      mBucket.input += e.input;
      mBucket.cacheRead += e.cacheRead;
      mBucket.output += e.output;
      mBucket.totalTokens += e.input + e.cacheRead + e.output;

      if (activeModel && mKey !== activeModel) continue;

      cCount++;
      lastEv = e;
      cIn += e.input;
      cCache += e.cacheRead;
      cOut += e.output;
      if (e.type === 'CHECKPOINT') cCp++;
      if (e.cacheDrop && !e.afterCompaction) cDrops++;
      allEvents.push(e);

      const d = new Date(e.ts);
      const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      let dayBucket = dailyMap.get(dayKey);
      if (!dayBucket) {
        dayBucket = { date: dayKey, tokens: 0, requests: 0, compactions: 0 };
        dailyMap.set(dayKey, dayBucket);
      }
      dayBucket.tokens += e.input + e.cacheRead + e.output;
      dayBucket.requests += 1;
      if (e.type === 'CHECKPOINT') dayBucket.compactions += 1;
    }

    if (cCount > 0) {
      totalErrors += c.events.filter((ev) => ev.isError && (!activeModel || (ev.model || c.model || 'unknown') === activeModel)).length;
      totalInput += cIn;
      totalCacheRead += cCache;
      totalOutput += cOut;
      totalCompactions += cCp;
      nonCompactDrops += cDrops;

      const cTotal = cIn + cCache + cOut;
      const cDenom = cIn + cCache;
      convSummaries.push({
        id: c.id,
        title: c.title,
        model: activeModel || c.model,
        requests: cCount,
        totalTokens: cTotal,
        input: cIn,
        cacheRead: cCache,
        output: cOut,
        compactions: cCp,
        hitRate: cDenom > 0 ? Number(((cCache / cDenom) * 100).toFixed(1)) : 0,
        lastTs: lastEv.ts,
        mtimeMs: c.mtimeMs,
      });
    }
  }

  convSummaries.sort((a, b) => b.totalTokens - a.totalTokens);
  const modelsBreakdown = [...modelMap.values()]
    .map((m) => {
      const den = m.input + m.cacheRead;
      return { ...m, hitRate: den > 0 ? Number(((m.cacheRead / den) * 100).toFixed(1)) : 0 };
    })
    .sort((a, b) => b.totalTokens - a.totalTokens);

  // Hourly buckets for the target day (default: today local time)
  const refDate = dayFilter ? new Date(dayFilter + 'T00:00:00') : new Date();
  const targetDayKey = `${refDate.getFullYear()}-${String(refDate.getMonth() + 1).padStart(2, '0')}-${String(refDate.getDate()).padStart(2, '0')}`;

  const hourly = Array.from({ length: 24 }, (_, h) => ({
    hour: h,
    label: `${String(h).padStart(2, '0')}:00`,
    tokens: 0,
    input: 0,
    cacheRead: 0,
    output: 0,
    requests: 0,
    compactions: 0,
    byConv: {},
  }));

  for (const e of allEvents) {
    const d = new Date(e.ts);
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (k !== targetDayKey) continue;
    const h = d.getHours();
    const b = hourly[h];
    const t = e.input + e.cacheRead + e.output;
    b.tokens += t;
    b.input += e.input;
    b.cacheRead += e.cacheRead;
    b.output += e.output;
    b.requests += 1;
    if (e.type === 'CHECKPOINT') b.compactions += 1;
    b.byConv[e.convId] = (b.byConv[e.convId] || 0) + t;
  }

  allEvents.sort((a, b) => b.ts - a.ts || b.step - a.step);

  const advice = computeThresholdAdvice(allEvents);
  const latestEvent = allEvents[0] || null;
  const denom = totalInput + totalCacheRead;

  const hasHour = hourFilter !== '' && hourFilter !== null && hourFilter !== undefined && !Number.isNaN(Number(hourFilter));
  const targetHour = hasHour ? Number(hourFilter) : -1;
  const scopedEvents = hasHour
    ? allEvents.filter((e) => {
        const d = new Date(e.ts);
        const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        return k === targetDayKey && d.getHours() === targetHour;
      })
    : allEvents;

  return {
    scope: targetId || 'all',
    selectedModel: activeModel || 'all',
    selectedHour: hasHour ? targetHour : null,
    targetDay: targetDayKey,
    totalTokens: totalInput + totalCacheRead + totalOutput,
    totalInput,
    totalCacheRead,
    totalOutput,
    totalRequests: allEvents.length,
    totalErrors,
    totalCompactions,
    nonCompactDrops,
    overallHitRate: denom > 0 ? Number(((totalCacheRead / denom) * 100).toFixed(1)) : 0,
    latestWatermark: latestEvent ? {
      convId: latestEvent.convId,
      convTitle: latestEvent.convTitle,
      contextTokens: latestEvent.liveContextTokens ?? latestEvent.contextTotal,
      preCompactTokens: latestEvent.type === 'CHECKPOINT' ? latestEvent.contextTotal : 0,
      justCompacted: latestEvent.type === 'CHECKPOINT',
      threshold: advice.recommendedCompact,
      ceiling: advice.observedCeiling,
      pct: Math.min(100, Math.round(((latestEvent.liveContextTokens ?? latestEvent.contextTotal) / advice.recommendedCompact) * 100)),
    } : null,
    thresholdAdvice: advice,
    conversations: allConvs.map((c) => ({ id: c.id, title: c.title, model: c.model, mtimeMs: c.mtimeMs })),
    convBreakdown: convSummaries.slice(0, 6),
    modelsBreakdown,
    lastRequestTs: allEvents[0]?.ts || null,
    hourly,
    daily: Object.fromEntries(dailyMap),
    recentEvents: scopedEvents.slice(0, 120),
    checkpointEvents: scopedEvents.filter((e) => e.type === 'CHECKPOINT').slice(0, 100),
    dropEvents: scopedEvents.filter((e) => e.cacheDrop && !e.afterCompaction).slice(0, 100),
    errorEvents: scopedEvents.filter((e) => e.isError).slice(0, 100),
  };
}

function computeThresholdAdvice(events) {
  const cpWithCtx = events.filter((e) => e.type === 'CHECKPOINT' && e.contextTotal > 50000);
  const maxObserved = events.reduce((m, e) => Math.max(m, e.contextTotal || 0), 0);

  const observedCeiling = cpWithCtx.length > 0
    ? Math.round(cpWithCtx.reduce((s, e) => s + e.contextTotal, 0) / cpWithCtx.length)
    : Math.max(COMPACT_THRESHOLD, maxObserved);

  const nonCpDrops = events.filter((e) => e.cacheDrop && !e.afterCompaction);
  const avgDropRewarm = nonCpDrops.length > 0
    ? Math.round(nonCpDrops.reduce((s, e) => s + e.input, 0) / nonCpDrops.length)
    : 0;
  const highCtxDrops = nonCpDrops.filter((e) => (e.input + e.cacheRead) >= 120000 || e.input >= 80000);
  const highDropShare = nonCpDrops.length > 0
    ? Math.round((highCtxDrops.length / nonCpDrops.length) * 100)
    : 0;

  const normalSteps = events.filter((e) => !e.isError && !e.cacheDrop && e.input > 0 && e.input < 30000);
  const avgStepNewInput = normalSteps.length > 0
    ? Math.round(normalSteps.reduce((s, e) => s + e.input, 0) / normalSteps.length)
    : 3500;

  // Sweet spot: ~72%-78% of ceiling, tightened if drop rewarm cost is high
  let ratio = 0.76;
  if (avgDropRewarm >= 60000 || nonCpDrops.length >= 20) ratio = 0.72;
  if (avgDropRewarm >= 100000) ratio = 0.68;

  const rawRec = Math.max(120000, Math.min(observedCeiling - 30000, observedCeiling * ratio));
  const recommendedCompact = Math.round(rawRec / 10000) * 10000;
  const softWarn = Math.round((recommendedCompact * 0.8) / 10000) * 10000;

  return {
    softWarn,
    recommendedCompact,
    observedCeiling,
    maxObserved,
    cpSampleCount: cpWithCtx.length,
    nonCpDropCount: nonCpDrops.length,
    avgDropRewarm,
    highDropShare,
    avgStepNewInput,
  };
}

const PLUGIN_DATA_DIR = join(APP_DATA, 'plugin_data', 'context-monitor');
const AUTO_COMPACT_PATH = join(PLUGIN_DATA_DIR, 'auto-compact.json');

const DEFAULT_AUTO_COMPACT = {
  enabled: true,
  lang: 'auto', // 'auto' | 'en' | 'zh' | 'ja' | 'fr' | 'de'
  resolvedLang: '',
  thresholdMode: 'auto', // 'auto' | 'manual_next' | 'manual_fixed'
  thresholdK: 180,
  manualSetAt: 0,
  effectiveThresholdK: 180,
  effectiveThresholdReason: 'Auto-calculated by model & recent history',
  idleSeconds: 8,
  cooldownSeconds: 120,
  mode: 'ui_send', // 'ui_send' | 'toast_confirm' | 'hook_guard' | 'hook_block' | 'notify'
  subagentOffload: true,
  postCompactLedger: true,
  rtkPath: '',
  snoozedUntil: 0,
  lastTriggeredAt: 0,
  lastTriggeredConvId: '',
  lastTriggeredEventTs: 0,
  lastTriggeredStatus: '',
  history: [],
};

const VALID_LANGS = new Set(['auto', 'en', 'zh', 'ja', 'fr', 'de']);
function detectOsLang() {
  const raw = (Intl.DateTimeFormat().resolvedOptions().locale || process.env.LANG || process.env.LC_ALL || 'en').toLowerCase();
  if (raw.startsWith('zh')) return 'zh';
  if (raw.startsWith('ja')) return 'ja';
  if (raw.startsWith('fr')) return 'fr';
  if (raw.startsWith('de')) return 'de';
  return 'en';
}
function resolveLang(cfg) {
  if (cfg?.lang && cfg.lang !== 'auto' && VALID_LANGS.has(cfg.lang)) return cfg.lang;
  if (cfg?.resolvedLang && cfg.resolvedLang !== 'auto' && VALID_LANGS.has(cfg.resolvedLang)) return cfg.resolvedLang;
  return detectOsLang();
}

const BACKEND_I18N = {
  en: {
    toastTitle: 'Context & Cache · Threshold Reached',
    toastConfirm: 'Compact (/compact)',
    toastLater: 'Later',
    toastLine1: (cur, th, m) => `Occupancy ${cur} / Threshold ${th}K (${m})`,
    toastLine2: 'Click Compact to send /compact now',
  },
  zh: {
    toastTitle: 'Context & Cache · 到达压缩阈值',
    toastConfirm: '确定压缩 (/compact)',
    toastLater: '暂不',
    toastLine1: (cur, th, m) => `当前占用 ${cur} / 阈值 ${th}K (${m})`,
    toastLine2: '点击「确定压缩」将立即发送 /compact',
  },
  ja: {
    toastTitle: 'Context & Cache · 圧縮しきい値に到達',
    toastConfirm: '今すぐ圧縮 (/compact)',
    toastLater: '後で',
    toastLine1: (cur, th, m) => `使用量 ${cur} / しきい値 ${th}K (${m})`,
    toastLine2: 'クリックして /compact を実行',
  },
  fr: {
    toastTitle: 'Context & Cache · Seuil atteint',
    toastConfirm: 'Compresser (/compact)',
    toastLater: 'Plus tard',
    toastLine1: (cur, th, m) => `Occupation ${cur} / Seuil ${th}K (${m})`,
    toastLine2: 'Cliquez pour envoyer /compact',
  },
  de: {
    toastTitle: 'Context & Cache · Schwellenwert erreicht',
    toastConfirm: 'Komprimieren (/compact)',
    toastLater: 'Später',
    toastLine1: (cur, th, m) => `Auslastung ${cur} / Schwelle ${th}K (${m})`,
    toastLine2: 'Klicken, um /compact auszuführen',
  },
};

function loadAutoCompactConfig() {
  try {
    if (existsSync(AUTO_COMPACT_PATH)) {
      const parsed = JSON.parse(readFileSync(AUTO_COMPACT_PATH, 'utf-8'));
      return {
        ...DEFAULT_AUTO_COMPACT,
        ...parsed,
        history: Array.isArray(parsed.history) ? parsed.history.slice(0, 20) : [],
      };
    }
  } catch {}
  return { ...DEFAULT_AUTO_COMPACT };
}

function saveAutoCompactConfig(cfg) {
  try {
    mkdirSync(PLUGIN_DATA_DIR, { recursive: true });
    writeFileSync(AUTO_COMPACT_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
  } catch {}
}

const VALID_MODES = new Set(['toast_confirm', 'ui_send', 'hook_guard', 'hook_block', 'notify']);
const VALID_THRESHOLD_MODES = new Set(['auto', 'manual_next', 'manual_fixed']);
let autoCompactConfig = loadAutoCompactConfig();
let autoCompactConfigMtime = 0;
let autoCompactRunning = false;

function syncAutoCompactConfigFromDisk() {
  try {
    if (!existsSync(AUTO_COMPACT_PATH)) return;
    const st = statSync(AUTO_COMPACT_PATH);
    if (st.mtimeMs !== autoCompactConfigMtime) {
      autoCompactConfig = loadAutoCompactConfig();
      autoCompactConfigMtime = st.mtimeMs;
    }
  } catch {}
}

function extractTitleTokens(text) {
  const s = String(text || '').toLowerCase();
  const tokens = new Set();
  for (const m of s.matchAll(/[a-z0-9]{4,}/g)) {
    if (!['outside', 'project', 'antigravity', 'context', 'cache', 'model'].includes(m[0])) tokens.add(m[0]);
  }
  const cjk = s.match(/[\u4e00-\u9fff]{2,}/g) || [];
  for (const seg of cjk) {
    if (seg.length <= 6) {
      tokens.add(seg);
    } else {
      for (let i = 0; i <= seg.length - 3; i += 2) tokens.add(seg.slice(i, i + 3));
    }
  }
  return [...tokens].slice(0, 14);
}

function runPowerShellCompact(mode, toastMeta = null, options = {}) {
  const requireForeground = Boolean(options.requireForeground);
  const minInputIdleMs = Math.max(0, Number(options.minInputIdleMs) || 0);
  const keepClipboard = Boolean(options.keepClipboard);
  const targetTokens = Array.isArray(options.targetTokens) ? options.targetTokens : [];
  const otherTokens = Array.isArray(options.otherTokens) ? options.otherTokens : [];
  const anyOtherBusy = Boolean(options.anyOtherBusy);
  const psArr = (arr) => '@(' + arr.map((x) => `'${String(x).replace(/'/g, "''")}'`).join(',') + ')';
  return new Promise((resolve) => {
    const sendKeysLines = [
      '$procs = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and ($_.ProcessName -match "antigravity" -or $_.MainWindowTitle -match "Antigravity") })',
      'if ($procs.Count -eq 0) {',
      '  @{ ok = $false; reason = "NO_WINDOW_HANDLE"; message = "未检测到 Antigravity 桌面窗口句柄（请确认 Antigravity 窗口可见或改用 Hook 护航/硬拦截模式）" } | ConvertTo-Json -Compress',
      '  exit 0',
      '}',
      '$fg = [Win32]::GetForegroundWindow()',
      '$fgMatch = $procs | Where-Object { $_.MainWindowHandle -eq $fg } | Select-Object -First 1',
      '$chatMatch = $procs | Where-Object { $_.MainWindowTitle -notmatch "^Context & Cache" } | Select-Object -First 1',
      '$proc = if ($null -ne $fgMatch) { $fgMatch } elseif ($null -ne $chatMatch) { $chatMatch } else { $procs[0] }',
      ...(requireForeground
        ? [
            '$fgPid = [uint32]0',
            '[Win32]::GetWindowThreadProcessId($fg, [ref]$fgPid) | Out-Null',
            '$fgProc = if ($fgPid -gt 0) { Get-Process -Id $fgPid -ErrorAction SilentlyContinue } else { $null }',
            '$isAgyForeground = ($null -ne $fgMatch) -or ($null -ne $fgProc -and ($fgProc.ProcessName -match "antigravity" -or $fgProc.MainWindowTitle -match "Antigravity"))',
            'if (-not $isAgyForeground) {',
            '  @{ ok = $false; deferred = $true; reason = "DEFERRED_NOT_FOREGROUND"; message = "Antigravity 当前不在前台，已静默挂起（不抢占其他窗口焦点）" } | ConvertTo-Json -Compress',
            '  exit 0',
            '}',
            'if ($proc.MainWindowTitle -match "^Context & Cache") {',
            '  @{ ok = $false; deferred = $true; reason = "DEFERRED_DASHBOARD_TAB"; message = "当前停留在 Context & Cache 全屏面板页，待切回聊天会话页后自动发送" } | ConvertTo-Json -Compress',
            '  exit 0',
            '}',
            'if ($procs.Count -gt 1) {',
            '  $fgLower = ([string]$proc.MainWindowTitle).ToLower()',
            `  $tToks = ${psArr(targetTokens)}`,
            `  $oToks = ${psArr(otherTokens)}`,
            '  $tScore = 0; foreach ($k in $tToks) { if ($k -and $fgLower.Contains($k)) { $tScore++ } }',
            '  $oScore = 0; foreach ($k in $oToks) { if ($k -and $fgLower.Contains($k)) { $oScore++ } }',
            `  $otherBusy = ${anyOtherBusy ? '$true' : '$false'}`,
            '  if (($oScore -gt $tScore) -or ($otherBusy -and $tScore -eq 0)) {',
            '    @{ ok = $false; deferred = $true; reason = "DEFERRED_OTHER_WINDOW"; message = ("前台窗口 [" + $proc.MainWindowTitle + "] 属于其他会话，已静默挂起避免误发") } | ConvertTo-Json -Compress',
            '    exit 0',
            '  }',
            '}',
            `$inputIdleMs = [Win32]::GetInputIdleMs()`,
            `if ($inputIdleMs -lt ${minInputIdleMs}) {`,
            '  @{ ok = $false; deferred = $true; reason = "DEFERRED_USER_ACTIVE"; message = ("检测到键鼠正在输入 (" + [int]($inputIdleMs / 1000) + "s)，已静默顺延") } | ConvertTo-Json -Compress',
            '  exit 0',
            '}',
          ]
        : [
            '[Win32]::ShowWindow($proc.MainWindowHandle, 9) | Out-Null',
            '[Win32]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null',
            'Start-Sleep -Milliseconds 180',
            'try {',
            '  Add-Type -AssemblyName UIAutomationClient -ErrorAction SilentlyContinue',
            '  Add-Type -AssemblyName UIAutomationTypes -ErrorAction SilentlyContinue',
            '  $rootEl = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)',
            '  if ($null -ne $rootEl) {',
            '    $winRect = $rootEl.Current.BoundingRectangle',
            '    $editCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)',
            '    $edits = $rootEl.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editCond)',
            '    foreach ($ed in $edits) {',
            '      $er = $ed.Current.BoundingRectangle',
            '      $inChatZone = ($winRect.Width -le 0) -or (($er.Left -lt ($winRect.Left + $winRect.Width * 0.58)) -and ($er.Top -gt ($winRect.Top + $winRect.Height * 0.55)))',
            '      if ($ed.Current.IsKeyboardFocusable -and $inChatZone -and $ed.Current.Name -notmatch "Search|搜索|検索|Rechercher|Suchen") {',
            '        $ed.SetFocus()',
            '        Start-Sleep -Milliseconds 80',
            '        break',
            '      }',
            '    }',
            '  }',
            '} catch {}',
          ]),
      '$oldClip = $null',
      'try { if ([System.Windows.Forms.Clipboard]::ContainsText()) { $oldClip = [System.Windows.Forms.Clipboard]::GetText() } } catch {}',
      '[System.Windows.Forms.Clipboard]::SetText("/compact")',
      '[System.Windows.Forms.SendKeys]::SendWait("^v")',
      'Start-Sleep -Milliseconds 140',
      '[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")',
      'Start-Sleep -Milliseconds 140',
      '[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")',
      'Start-Sleep -Milliseconds 130',
      ...(keepClipboard ? [] : ['if ($null -ne $oldClip) { try { [System.Windows.Forms.Clipboard]::SetText($oldClip) } catch {} }']),
    ];

    let psScript;
    let timeoutMs = 10000;

    if (mode === 'toast_confirm') {
      timeoutMs = 35000;
      const tDict = BACKEND_I18N[resolveLang(autoCompactConfig)] || BACKEND_I18N.en;
      const safeTitle = String(toastMeta?.title || tDict.toastTitle).replace(/'/g, "''");
      const safeLine1 = String(toastMeta?.line1 || tDict.toastTitle).replace(/'/g, "''");
      const safeLine2 = String(toastMeta?.line2 || tDict.toastLine2).replace(/'/g, "''");
      const safeBtnOk = String(tDict.toastConfirm).replace(/'/g, "''");
      const safeBtnNo = String(tDict.toastLater).replace(/'/g, "''");
      psScript = [
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        'Add-Type -AssemblyName System.Windows.Forms',
        'Add-Type -AssemblyName System.Drawing',
        'Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing @"',
        'using System;',
        'using System.Runtime.InteropServices;',
        'using System.Windows.Forms;',
        'public class Win32 {',
        '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
        '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);',
        '}',
        'public class NoActivateToastForm : Form {',
        '  protected override bool ShowWithoutActivation { get { return true; } }',
        '  protected override CreateParams CreateParams {',
        '    get {',
        '      CreateParams cp = base.CreateParams;',
        '      cp.ExStyle |= 0x08000000 | 0x00000008 | 0x00000080;',
        '      return cp;',
        '    }',
        '  }',
        '}',
        '"@',
        '$script:confirmed = $false',
        '$script:dismissed = $false',
        '$form = New-Object NoActivateToastForm',
        '$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None',
        '$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual',
        '$form.Size = New-Object System.Drawing.Size(360, 128)',
        '$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea',
        '$form.Location = New-Object System.Drawing.Point(($wa.Right - 376), ($wa.Bottom - 144))',
        '$form.BackColor = [System.Drawing.Color]::White',
        '$form.TopMost = $true',
        '$form.Add_Paint({ param($s,$e) $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(226,232,240), 1); $e.Graphics.DrawRectangle($pen, 0, 0, $s.Width - 1, $s.Height - 1) })',
        '$bar = New-Object System.Windows.Forms.Panel',
        '$bar.Dock = [System.Windows.Forms.DockStyle]::Top',
        '$bar.Height = 4',
        '$bar.BackColor = [System.Drawing.Color]::FromArgb(37,99,235)',
        '$form.Controls.Add($bar)',
        '$lblTitle = New-Object System.Windows.Forms.Label',
        `$lblTitle.Text = '${safeTitle}'`,
        '$lblTitle.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 9.5, [System.Drawing.FontStyle]::Bold)',
        '$lblTitle.ForeColor = [System.Drawing.Color]::FromArgb(15,23,42)',
        '$lblTitle.Location = New-Object System.Drawing.Point(14, 14)',
        '$lblTitle.Size = New-Object System.Drawing.Size(332, 20)',
        '$form.Controls.Add($lblTitle)',
        '$lbl1 = New-Object System.Windows.Forms.Label',
        `$lbl1.Text = '${safeLine1}'`,
        '$lbl1.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 8.5)',
        '$lbl1.ForeColor = [System.Drawing.Color]::FromArgb(51,65,85)',
        '$lbl1.Location = New-Object System.Drawing.Point(14, 38)',
        '$lbl1.Size = New-Object System.Drawing.Size(332, 18)',
        '$form.Controls.Add($lbl1)',
        '$lbl2 = New-Object System.Windows.Forms.Label',
        `$lbl2.Text = '${safeLine2}'`,
        '$lbl2.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 8)',
        '$lbl2.ForeColor = [System.Drawing.Color]::FromArgb(100,116,139)',
        '$lbl2.Location = New-Object System.Drawing.Point(14, 58)',
        '$lbl2.Size = New-Object System.Drawing.Size(332, 18)',
        '$form.Controls.Add($lbl2)',
        '$btnOk = New-Object System.Windows.Forms.Button',
        `$btnOk.Text = '${safeBtnOk}'`,
        '$btnOk.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 8.5, [System.Drawing.FontStyle]::Bold)',
        '$btnOk.BackColor = [System.Drawing.Color]::FromArgb(37,99,235)',
        '$btnOk.ForeColor = [System.Drawing.Color]::White',
        '$btnOk.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat',
        '$btnOk.FlatAppearance.BorderSize = 0',
        '$btnOk.Location = New-Object System.Drawing.Point(14, 86)',
        '$btnOk.Size = New-Object System.Drawing.Size(166, 30)',
        '$btnOk.Add_Click({ $script:confirmed = $true; $form.Close() })',
        '$form.Controls.Add($btnOk)',
        '$btnNo = New-Object System.Windows.Forms.Button',
        `$btnNo.Text = '${safeBtnNo}'`,
        '$btnNo.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 8.5)',
        '$btnNo.BackColor = [System.Drawing.Color]::FromArgb(241,245,249)',
        '$btnNo.ForeColor = [System.Drawing.Color]::FromArgb(51,65,85)',
        '$btnNo.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat',
        '$btnNo.FlatAppearance.BorderSize = 0',
        '$btnNo.Location = New-Object System.Drawing.Point(188, 86)',
        '$btnNo.Size = New-Object System.Drawing.Size(80, 30)',
        '$btnNo.Add_Click({ $script:dismissed = $true; $form.Close() })',
        '$form.Controls.Add($btnNo)',
        '$timer = New-Object System.Windows.Forms.Timer',
        '$timer.Interval = 25000',
        '$timer.Add_Tick({ $timer.Stop(); $form.Close() })',
        '$timer.Start()',
        '[System.Windows.Forms.Application]::Run($form)',
        '$timer.Dispose()',
        'if (-not $script:confirmed) {',
        '  if ($script:dismissed) {',
        '    @{ ok = $false; reason = "TOAST_DISMISSED"; message = "用户点击暂不，本轮已延后" } | ConvertTo-Json -Compress',
        '  } else {',
        '    @{ ok = $false; reason = "TOAST_TIMEOUT"; message = "Toast 提醒超时未点击，已自动关闭" } | ConvertTo-Json -Compress',
        '  }',
        '  exit 0',
        '}',
        ...sendKeysLines,
        '@{ ok = $true; reason = "TOAST_CONFIRMED_SENT"; message = ("已点击 Toast 确认，向窗口 [" + $proc.MainWindowTitle + "] 发送 /compact") } | ConvertTo-Json -Compress',
      ].join('\r\n');
    } else if (mode === 'ui_send') {
      psScript = [
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        'Add-Type -AssemblyName System.Windows.Forms',
        'Add-Type @"',
        'using System;',
        'using System.Runtime.InteropServices;',
        'public class Win32 {',
        '  [StructLayout(LayoutKind.Sequential)]',
        '  public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }',
        '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
        '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);',
        '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
        '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);',
        '  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);',
        '  public static uint GetInputIdleMs() {',
        '    LASTINPUTINFO lii = new LASTINPUTINFO();',
        '    lii.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));',
        '    if (!GetLastInputInfo(ref lii)) return 999999;',
        '    return unchecked((uint)Environment.TickCount - lii.dwTime);',
        '  }',
        '}',
        '"@',
        ...sendKeysLines,
        '@{ ok = $true; reason = "SENT_KEYS"; message = ("已在前台空闲时静默向窗口 [" + $proc.MainWindowTitle + "] 发送 /compact") } | ConvertTo-Json -Compress',
      ].join('\r\n');
    } else {
      psScript = [
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        'Add-Type -AssemblyName System.Windows.Forms',
        '[System.Windows.Forms.Clipboard]::SetText("/compact")',
        '[console]::beep(880, 160)',
        '@{ ok = $true; reason = "COPIED_AND_BEEPED"; message = "已复制 /compact 到剪贴板并发出提示音" } | ConvertTo-Json -Compress',
      ].join('\r\n');
    }

    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-STA', '-EncodedCommand', encoded],
      { timeout: timeoutMs, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) {
          resolve({
            ok: false,
            reason: 'EXEC_ERROR',
            message: (stderr || err.message || 'PowerShell 执行失败').trim().slice(0, 200),
          });
          return;
        }
        const line = String(stdout || '').trim().split(/\r?\n/).pop() || '';
        try {
          resolve(JSON.parse(line));
        } catch {
          resolve({ ok: false, reason: 'PARSE_ERROR', message: line || '未知输出' });
        }
      }
    );
  });
}

function loadHookState() {
  try {
    const p = join(PLUGIN_DATA_DIR, 'hook-state.json');
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {}
  return {};
}

function getLatestActiveWatermark(maxIdleMs = 0) {
  const convs = getAllConversations();
  const now = Date.now();
  const hookState = loadHookState();
  for (const c of convs.slice(0, 5)) {
    if (maxIdleMs > 0 && now - c.mtimeMs > maxIdleMs) continue;
    if (!c.events || c.events.length === 0) continue;
    const lastEv = c.events[c.events.length - 1];
    const lastCp = [...c.events].reverse().find((e) => e.type === 'CHECKPOINT');
    const hs = hookState[c.id] || {};
    const hookBusy = Boolean(
      hs.turnActive &&
      !hs.fullyIdle &&
      (hs.startedAt || 0) > (hs.stoppedAt || 0) &&
      now - (hs.startedAt || 0) < 10 * 60 * 1000
    );
    const agentBusy = Boolean(c.transcriptBusy || hookBusy);
    const liveTokens = lastEv.liveContextTokens ?? lastEv.contextTotal;
    return {
      convId: c.id,
      convTitle: c.title,
      model: lastEv.model || c.model || 'unknown',
      contextTotal: liveTokens,
      preCompactTokens: lastEv.type === 'CHECKPOINT' ? lastEv.contextTotal : 0,
      justCompacted: lastEv.type === 'CHECKPOINT',
      agentBusy,
      hitRate: lastEv.hitRate,
      lastEventTs: lastEv.ts,
      lastEventType: lastEv.type,
      lastCheckpointTs: lastCp?.ts || 0,
      mtimeMs: c.mtimeMs,
    };
  }
  return null;
}

function computeAutoThresholdForTarget(target) {
  const allConvs = getAllConversations();
  const allEvs = [];
  for (const c of allConvs) {
    for (const e of c.events) allEvs.push(e);
  }
  const now = Date.now();
  const model = target?.model && target.model !== 'unknown' ? target.model : '';
  if (model) {
    const modelEvs = allEvs.filter((e) => (e.model || 'unknown') === model);
    if (modelEvs.length >= 10) {
      const adv = computeThresholdAdvice(modelEvs);
      const k = Math.max(80, Math.round(adv.recommendedCompact / 1000));
      return {
        autoK: k,
        basis: `自动按模型 ${model}（${modelEvs.length} 条记录）计算`,
        advice: adv,
      };
    }
  }
  const recentCutoff = now - 14 * 24 * 60 * 60 * 1000;
  const recentEvs = allEvs.filter((e) => e.ts >= recentCutoff);
  const sampleEvs = recentEvs.length >= 10 ? recentEvs : allEvs;
  const adv = computeThresholdAdvice(sampleEvs);
  const k = Math.max(80, Math.round(adv.recommendedCompact / 1000));
  return {
    autoK: k,
    basis: `自动按近期使用记录（${sampleEvs.length} 条）计算`,
    advice: adv,
  };
}

function resolveEffectiveThreshold(target) {
  const autoInfo = computeAutoThresholdForTarget(target);
  let dirty = false;

  // If user set a one-time manual threshold for the next compaction and a CHECKPOINT happened since then, revert to auto
  if (
    autoCompactConfig.thresholdMode === 'manual_next' &&
    target &&
    target.lastCheckpointTs > (autoCompactConfig.manualSetAt || 0)
  ) {
    autoCompactConfig.thresholdMode = 'auto';
    dirty = true;
  }

  const tMode = VALID_THRESHOLD_MODES.has(autoCompactConfig.thresholdMode)
    ? autoCompactConfig.thresholdMode
    : 'auto';

  let effectiveK = autoInfo.autoK;
  let reason = autoInfo.basis;
  if (tMode === 'manual_next') {
    effectiveK = Math.max(50, Number(autoCompactConfig.thresholdK) || autoInfo.autoK);
    reason = `下次压缩手动值 ${effectiveK}K（压缩后恢复自动 ${autoInfo.autoK}K）`;
  } else if (tMode === 'manual_fixed') {
    effectiveK = Math.max(50, Number(autoCompactConfig.thresholdK) || autoInfo.autoK);
    reason = `手动锁定 ${effectiveK}K（自动参考 ${autoInfo.autoK}K）`;
  }

  if (
    autoCompactConfig.effectiveThresholdK !== effectiveK ||
    autoCompactConfig.effectiveThresholdReason !== reason
  ) {
    autoCompactConfig.effectiveThresholdK = effectiveK;
    autoCompactConfig.effectiveThresholdReason = reason;
    dirty = true;
  }

  if (dirty) {
    saveAutoCompactConfig(autoCompactConfig);
    try { autoCompactConfigMtime = statSync(AUTO_COMPACT_PATH).mtimeMs; } catch {}
  }

  return {
    thresholdMode: tMode,
    autoThresholdK: autoInfo.autoK,
    autoBasis: autoInfo.basis,
    effectiveK,
    effectiveTokens: effectiveK * 1000,
    effectiveReason: reason,
  };
}

function fmtKShort(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

async function waitForTranscriptUpdate(tPath, beforeSize, beforeMtime, maxWaitMs = 1500) {
  if (!tPath || !existsSync(tPath)) return false;
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await new Promise((r) => setTimeout(r, 180));
    try {
      const st = statSync(tPath);
      if (st.size !== beforeSize || st.mtimeMs > beforeMtime) return true;
    } catch {}
  }
  return false;
}

async function triggerCompactNow(source = 'manual_toast') {
  syncAutoCompactConfigFromDisk();
  if (autoCompactRunning) return { skipped: true, reason: 'BUSY', message: '当前有触发任务正在执行中' };
  const target = getLatestActiveWatermark(0);
  const eff = resolveEffectiveThreshold(target);
  const now = Date.now();
  const tPath = target?.convId ? getTranscriptPath(target.convId) : null;
  let beforeSize = 0;
  let beforeMtime = 0;
  if (tPath && existsSync(tPath)) {
    try {
      const st = statSync(tPath);
      beforeSize = st.size;
      beforeMtime = st.mtimeMs;
    } catch {}
  }
  autoCompactRunning = true;
  try {
    const res = await runPowerShellCompact('ui_send', null, { keepClipboard: true });
    let verified = Boolean(res.ok);
    let copiedOnly = false;
    let finalMsg = res.message;
    let finalReason = res.reason;
    if (res.ok && tPath) {
      verified = await waitForTranscriptUpdate(tPath, beforeSize, beforeMtime, 1500);
      if (!verified) {
        copiedOnly = true;
        finalReason = 'COPIED_FOCUS_IN_PANEL';
        finalMsg = '已复制 /compact 到剪贴板（点击面板按钮时焦点在右侧面板内，请点一下左侧聊天框按 Ctrl+V 回车）';
      }
    }
    const entry = {
      ts: now,
      convId: target?.convId || 'manual-now',
      convTitle: target?.convTitle || '当前会话',
      contextTotal: target?.contextTotal || 0,
      thresholdTokens: eff.effectiveTokens,
      mode: source,
      ok: verified,
      copiedOnly,
      reason: finalReason,
      message: finalMsg,
      isTest: false,
    };
    autoCompactConfig.lastTriggeredAt = now;
    autoCompactConfig.lastTriggeredConvId = entry.convId;
    if (verified && target?.lastEventTs) autoCompactConfig.lastTriggeredEventTs = target.lastEventTs;
    autoCompactConfig.snoozedUntil = 0;
    if (verified && autoCompactConfig.thresholdMode === 'manual_next') {
      autoCompactConfig.thresholdMode = 'auto';
    }
    autoCompactConfig.lastTriggeredStatus = `${verified ? '成功' : '已复制待粘贴'}: ${finalMsg}`;
    autoCompactConfig.history = [entry, ...(autoCompactConfig.history || [])].slice(0, 20);
    saveAutoCompactConfig(autoCompactConfig);
    try { autoCompactConfigMtime = statSync(AUTO_COMPACT_PATH).mtimeMs; } catch {}
    return entry;
  } finally {
    autoCompactRunning = false;
  }
}

async function evaluateAutoCompact(forceTest = false) {
  syncAutoCompactConfigFromDisk();
  if (autoCompactRunning) return { skipped: true, reason: 'BUSY' };
  const target = getLatestActiveWatermark(forceTest ? 0 : 30 * 60 * 1000);
  const eff = resolveEffectiveThreshold(target);
  const now = Date.now();
  const thresholdTokens = eff.effectiveTokens;
  const idleMs = Math.max(2, Number(autoCompactConfig.idleSeconds) || 8) * 1000;
  const cooldownMs = Math.max(15, Number(autoCompactConfig.cooldownSeconds) || 120) * 1000;
  const mode = VALID_MODES.has(autoCompactConfig.mode) ? autoCompactConfig.mode : 'toast_confirm';

  if (!forceTest) {
    if (!autoCompactConfig.enabled) return { skipped: true, reason: 'DISABLED' };
    if (mode === 'hook_guard' || mode === 'hook_block') return { skipped: true, reason: 'HANDLED_BY_HOOK' };
    if (!target) return { skipped: true, reason: 'NO_ACTIVE_SESSION' };
    if (target.lastEventType === 'CHECKPOINT') return { skipped: true, reason: 'ALREADY_COMPACTED' };
    if (
      autoCompactConfig.lastTriggeredConvId === target.convId &&
      autoCompactConfig.lastTriggeredEventTs &&
      autoCompactConfig.lastTriggeredEventTs === target.lastEventTs
    ) {
      return { skipped: true, reason: 'ALREADY_TRIGGERED_FOR_TURN' };
    }
    if (target.contextTotal < thresholdTokens) return { skipped: true, reason: 'BELOW_THRESHOLD' };
    if (now < (autoCompactConfig.snoozedUntil || 0)) return { skipped: true, reason: 'SNOOZED' };
    if (target.agentBusy) return { skipped: true, reason: 'AGENT_WORKING' };
    if (now - target.lastEventTs < idleMs) return { skipped: true, reason: 'SESSION_BUSY' };
    if (now - (autoCompactConfig.lastTriggeredAt || 0) < cooldownMs) return { skipped: true, reason: 'COOLDOWN' };
  }

  autoCompactRunning = true;
  try {
    const tDict = BACKEND_I18N[resolveLang(autoCompactConfig)] || BACKEND_I18N.en;
    const toastMeta = {
      title: tDict.toastTitle,
      line1: tDict.toastLine1(fmtKShort(target?.contextTotal || thresholdTokens), eff.effectiveK, target?.model || 'Active Model'),
      line2: (target?.convTitle || tDict.toastLine2).slice(0, 32),
    };
    const recentOthers = !forceTest && target
      ? getAllConversations()
          .slice(0, 6)
          .filter((c) => c.id !== target.convId && now - c.mtimeMs < 15 * 60 * 1000)
      : [];
    const hookStateNow = loadHookState();
    const anyOtherBusy = recentOthers.some((c) => {
      const hs = hookStateNow[c.id] || {};
      const hBusy = Boolean(hs.turnActive && !hs.fullyIdle && (hs.startedAt || 0) > (hs.stoppedAt || 0) && now - (hs.startedAt || 0) < 10 * 60 * 1000);
      return Boolean(c.transcriptBusy || hBusy);
    });
    const targetTokens = target ? extractTitleTokens(target.convTitle) : [];
    const otherTokens = [...new Set(recentOthers.flatMap((c) => extractTitleTokens(c.title)))].filter((t) => !targetTokens.includes(t));

    const res = (mode === 'hook_guard' || mode === 'hook_block')
      ? {
          ok: true,
          reason: 'HOOK_ACTIVE',
          message: mode === 'hook_block'
            ? `Hook 硬拦截已就绪：下次对话前若上下文占用 >= ${eff.effectiveK}K 将自动暂停等待 /compact`
            : `Hook 护航已就绪：下次对话前若上下文占用 >= ${eff.effectiveK}K 将注入收尾提醒与内联横幅`,
        }
      : await runPowerShellCompact(mode, toastMeta, {
          requireForeground: !forceTest && mode === 'ui_send',
          minInputIdleMs: !forceTest && mode === 'ui_send' ? Math.min(6000, Math.max(3000, Math.floor(idleMs * 0.6))) : 0,
          targetTokens,
          otherTokens,
          anyOtherBusy,
        });
    if (!forceTest && res.deferred) {
      autoCompactConfig.lastTriggeredStatus = `静默挂起: ${res.message}`;
      saveAutoCompactConfig(autoCompactConfig);
      try { autoCompactConfigMtime = statSync(AUTO_COMPACT_PATH).mtimeMs; } catch {}
      return { skipped: true, deferred: true, reason: res.reason, message: res.message };
    }
    const entry = {
      ts: now,
      convId: target?.convId || 'manual-test',
      convTitle: target?.convTitle || '手动测试',
      contextTotal: target?.contextTotal || 0,
      thresholdTokens,
      mode,
      ok: Boolean(res.ok),
      reason: res.reason,
      message: res.message,
      isTest: forceTest,
    };
    if (!forceTest) {
      autoCompactConfig.lastTriggeredAt = now;
      autoCompactConfig.lastTriggeredConvId = entry.convId;
      if (res.ok && target?.lastEventTs) {
        autoCompactConfig.lastTriggeredEventTs = target.lastEventTs;
      }
      if (res.reason === 'TOAST_DISMISSED' || res.reason === 'TOAST_TIMEOUT') {
        autoCompactConfig.snoozedUntil = now + cooldownMs;
      }
      if (res.ok && autoCompactConfig.thresholdMode === 'manual_next') {
        autoCompactConfig.thresholdMode = 'auto';
      }
    }
    autoCompactConfig.lastTriggeredStatus = `${res.ok ? '成功' : '未触发'}: ${res.message}`;
    autoCompactConfig.history = [entry, ...(autoCompactConfig.history || [])].slice(0, 20);
    saveAutoCompactConfig(autoCompactConfig);
    try { autoCompactConfigMtime = statSync(AUTO_COMPACT_PATH).mtimeMs; } catch {}
    return entry;
  } finally {
    autoCompactRunning = false;
  }
}

function getAutoCompactStatus() {
  syncAutoCompactConfigFromDisk();
  const target = getLatestActiveWatermark();
  const eff = resolveEffectiveThreshold(target);
  const thresholdTokens = eff.effectiveTokens;
  const now = Date.now();
  const cooldownMs = Math.max(15, Number(autoCompactConfig.cooldownSeconds) || 120) * 1000;
  const cooldownLeftSec = Math.max(0, Math.ceil(((autoCompactConfig.lastTriggeredAt || 0) + cooldownMs - now) / 1000));
  const snoozeLeftSec = Math.max(0, Math.ceil(((autoCompactConfig.snoozedUntil || 0) - now) / 1000));
  const overThreshold = Boolean(
    autoCompactConfig.enabled &&
    target &&
    target.lastEventType !== 'CHECKPOINT' &&
    target.contextTotal >= thresholdTokens
  );
  return {
    config: autoCompactConfig,
    thresholdTokens,
    effectiveThresholdK: eff.effectiveK,
    effectiveReason: eff.effectiveReason,
    autoThresholdK: eff.autoThresholdK,
    autoBasis: eff.autoBasis,
    thresholdMode: eff.thresholdMode,
    cooldownLeftSec,
    snoozeLeftSec,
    activeTarget: target,
    needsManualAlert: overThreshold,
    showToastPrompt: Boolean(overThreshold && !target?.agentBusy && snoozeLeftSec === 0 && (autoCompactConfig.mode === 'toast_confirm' || autoCompactConfig.mode === 'notify')),
  };
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 64 * 1024) body = body.slice(0, 64 * 1024);
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const INDEX_HTML_PATH = join(__dirname, 'index.html');
let cachedHtml = '';
let cachedHtmlMtime = 0;
function getIndexHtml() {
  try {
    const st = statSync(INDEX_HTML_PATH);
    if (st.mtimeMs !== cachedHtmlMtime) {
      cachedHtml = readFileSync(INDEX_HTML_PATH, 'utf-8');
      cachedHtmlMtime = st.mtimeMs;
    }
  } catch {}
  return cachedHtml;
}

const RTK_PLUGIN_PATH = join(homedir(), '.gemini', 'config', 'plugins', 'rtk', 'plugin.json');
const RTK_CACHE_TTL_MS = 30 * 1000;
const RTK_MISS_TTL_MS = 60 * 1000;
const rtkCache = {
  checkedAt: 0,
  inFlight: false,
  installed: false,
  pluginInstalled: false,
  summary: null,
  daily: {},
  lastUpdatedAt: 0,
};

function refreshRtkStatsAsync(force = false) {
  const now = Date.now();
  const ttl = rtkCache.installed ? RTK_CACHE_TTL_MS : RTK_MISS_TTL_MS;
  if (rtkCache.inFlight || (!force && rtkCache.checkedAt > 0 && now - rtkCache.checkedAt < ttl)) return;
  rtkCache.inFlight = true;
  rtkCache.pluginInstalled = existsSync(RTK_PLUGIN_PATH);
  const customBin = String(autoCompactConfig.rtkPath || '').trim();
  const rtkBin = customBin || 'rtk';
  execFile(
    rtkBin,
    ['gain', '--daily', '--format', 'json'],
    { timeout: 2500, encoding: 'utf8', windowsHide: true },
    (err, stdout) => {
      rtkCache.inFlight = false;
      rtkCache.checkedAt = Date.now();
      if (err || !stdout) {
        rtkCache.installed = false;
        rtkCache.summary = null;
        rtkCache.daily = {};
        return;
      }
      try {
        const parsed = JSON.parse(String(stdout).trim());
        const s = parsed?.summary;
        if (!s || typeof s !== 'object') {
          rtkCache.installed = false;
          rtkCache.summary = null;
          rtkCache.daily = {};
          return;
        }
        const dailyMap = {};
        if (Array.isArray(parsed.daily)) {
          for (const d of parsed.daily) {
            if (!d?.date) continue;
            dailyMap[d.date] = {
              date: d.date,
              commands: Number(d.commands) || 0,
              inputTokens: Number(d.input_tokens) || 0,
              outputTokens: Number(d.output_tokens) || 0,
              savedTokens: Number(d.saved_tokens) || 0,
              savingsPct: Number((Number(d.savings_pct) || 0).toFixed(1)),
            };
          }
        }
        rtkCache.installed = true;
        rtkCache.summary = {
          totalCommands: Number(s.total_commands) || 0,
          totalInput: Number(s.total_input) || 0,
          totalOutput: Number(s.total_output) || 0,
          totalSaved: Number(s.total_saved) || 0,
          avgSavingsPct: Number((Number(s.avg_savings_pct) || 0).toFixed(1)),
        };
        rtkCache.daily = dailyMap;
        rtkCache.lastUpdatedAt = Date.now();
      } catch {
        rtkCache.installed = false;
        rtkCache.summary = null;
        rtkCache.daily = {};
      }
    }
  );
}

function getRtkStatsSnapshot(targetDay = '') {
  refreshRtkStatsAsync();
  const dayEntry = targetDay && rtkCache.daily[targetDay] ? rtkCache.daily[targetDay] : null;
  const recentDays = Object.values(rtkCache.daily).slice(-7);
  return {
    installed: rtkCache.installed,
    pluginInstalled: rtkCache.pluginInstalled,
    checked: rtkCache.checkedAt > 0,
    customPath: String(autoCompactConfig.rtkPath || '').trim(),
    summary: rtkCache.summary,
    day: dayEntry,
    recentDays,
    lastUpdatedAt: rtkCache.lastUpdatedAt,
  };
}

// Kick off initial non-blocking RTK probe on startup
refreshRtkStatsAsync();

export function getFullOverview({ id = 'all', day = '', model = 'all', hour = '' } = {}) {
  const data = buildOverview(id, day, model, hour);
  const acStatus = getAutoCompactStatus();
  data.autoCompact = acStatus;
  data.rtkStats = getRtkStatsSnapshot(data.targetDay);
  if (data.latestWatermark && acStatus.thresholdTokens) {
    data.latestWatermark.threshold = acStatus.thresholdTokens;
    data.latestWatermark.pct = Math.min(100, Math.round((data.latestWatermark.contextTokens / acStatus.thresholdTokens) * 100));
  }
  return data;
}

export function updateAutoCompactConfig(body = {}) {
  syncAutoCompactConfigFromDisk();
  if (typeof body.enabled === 'boolean') autoCompactConfig.enabled = body.enabled;
  if (body.lang && VALID_LANGS.has(body.lang)) autoCompactConfig.lang = body.lang;
  if (body.resolvedLang && VALID_LANGS.has(body.resolvedLang)) autoCompactConfig.resolvedLang = body.resolvedLang;
  if (VALID_THRESHOLD_MODES.has(body.thresholdMode)) {
    autoCompactConfig.thresholdMode = body.thresholdMode;
    if (body.thresholdMode === 'manual_next') autoCompactConfig.manualSetAt = Date.now();
  }
  if (body.thresholdK !== undefined) {
    autoCompactConfig.thresholdK = Math.max(50, Math.min(500, Number(body.thresholdK) || 180));
    if (autoCompactConfig.thresholdMode === 'manual_next') autoCompactConfig.manualSetAt = Date.now();
  }
  if (body.idleSeconds !== undefined) autoCompactConfig.idleSeconds = Math.max(2, Math.min(120, Number(body.idleSeconds) || 8));
  if (body.cooldownSeconds !== undefined) autoCompactConfig.cooldownSeconds = Math.max(15, Math.min(3600, Number(body.cooldownSeconds) || 120));
  if (VALID_MODES.has(body.mode)) autoCompactConfig.mode = body.mode;
  if (typeof body.subagentOffload === 'boolean') autoCompactConfig.subagentOffload = body.subagentOffload;
  if (typeof body.postCompactLedger === 'boolean') autoCompactConfig.postCompactLedger = body.postCompactLedger;
  if (typeof body.rtkPath === 'string') {
    const nextPath = body.rtkPath.trim().replace(/^["']|["']$/g, '').slice(0, 260);
    if (nextPath !== autoCompactConfig.rtkPath) {
      autoCompactConfig.rtkPath = nextPath;
      rtkCache.checkedAt = 0;
      refreshRtkStatsAsync(true);
    }
  }
  autoCompactConfig.snoozedUntil = 0;
  saveAutoCompactConfig(autoCompactConfig);
  try { autoCompactConfigMtime = statSync(AUTO_COMPACT_PATH).mtimeMs; } catch {}
  return getAutoCompactStatus();
}

export function snoozeAutoCompact(body = {}) {
  syncAutoCompactConfigFromDisk();
  const sec = Math.max(30, Math.min(3600, Number(body.seconds) || Number(autoCompactConfig.cooldownSeconds) || 120));
  autoCompactConfig.snoozedUntil = Date.now() + sec * 1000;
  if (body.bumpK) {
    const target = getLatestActiveWatermark();
    const curK = Math.ceil((target?.contextTotal || autoCompactConfig.effectiveThresholdK * 1000) / 1000);
    autoCompactConfig.thresholdMode = 'manual_next';
    autoCompactConfig.thresholdK = Math.min(500, Math.max(curK + Number(body.bumpK), (autoCompactConfig.effectiveThresholdK || 180) + Number(body.bumpK)));
    autoCompactConfig.manualSetAt = Date.now();
    autoCompactConfig.snoozedUntil = 0;
  }
  saveAutoCompactConfig(autoCompactConfig);
  try { autoCompactConfigMtime = statSync(AUTO_COMPACT_PATH).mtimeMs; } catch {}
  return getAutoCompactStatus();
}

export { getAutoCompactStatus, triggerCompactNow, evaluateAutoCompact, getIndexHtml };

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');

  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(getIndexHtml());
    return;
  }

  if (url.pathname === '/api/overview') {
    const data = getFullOverview({
      id: url.searchParams.get('id') || 'all',
      day: url.searchParams.get('day') || '',
      model: url.searchParams.get('model') || 'all',
      hour: url.searchParams.get('hour') ?? '',
    });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
    return;
  }

  if (url.pathname === '/api/auto-compact' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(getAutoCompactStatus()));
    return;
  }

  if (url.pathname === '/api/auto-compact' && req.method === 'POST') {
    const body = await readJsonBody(req);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(updateAutoCompactConfig(body)));
    return;
  }

  if (url.pathname === '/api/auto-compact/trigger-now' && req.method === 'POST') {
    const result = await triggerCompactNow('web_toast_confirm');
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ result, status: getAutoCompactStatus() }));
    return;
  }

  if (url.pathname === '/api/auto-compact/snooze' && req.method === 'POST') {
    const body = await readJsonBody(req);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(snoozeAutoCompact(body)));
    return;
  }

  if (url.pathname === '/api/auto-compact/test' && req.method === 'POST') {
    const result = await evaluateAutoCompact(true);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ result, status: getAutoCompactStatus() }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === resolve(process.argv[1]).toLowerCase();
if (isDirectRun) {
  setInterval(() => {
    evaluateAutoCompact(false).catch(() => {});
  }, 3000);

  server.listen(PORT, '127.0.0.1', () => {
    const addr = server.address();
    console.log(`Context & Cache Monitor listening on http://127.0.0.1:${addr.port}`);
  });
}

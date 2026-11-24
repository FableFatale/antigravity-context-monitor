import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  getFullOverview,
  getAutoCompactStatus,
  updateAutoCompactConfig,
  triggerCompactNow,
  snoozeAutoCompact,
  evaluateAutoCompact,
  getIndexHtml,
} from '../sidecars/context-monitor/server.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_URI = 'ui://context-monitor/app.html';
const EXT_APPS_BUNDLE_PATH = join(
  __dirname,
  'node_modules',
  '@modelcontextprotocol',
  'ext-apps',
  'dist',
  'src',
  'app-with-deps.js'
);

let cachedSdkSnippet = null;

function getInlineExtAppsSnippet() {
  if (cachedSdkSnippet) return cachedSdkSnippet;
  const raw = readFileSync(EXT_APPS_BUNDLE_PATH, 'utf-8');
  const exportIdx = raw.lastIndexOf('export{');
  if (exportIdx === -1) {
    throw new Error('Unexpected @modelcontextprotocol/ext-apps bundle format');
  }
  const body = raw.slice(0, exportIdx).replace(/<\/script/gi, '<\\/script');
  const exportClause = raw.slice(exportIdx);

  const pick = (name) => {
    const m = exportClause.match(new RegExp(`([A-Za-z0-9_$]+)\\s+as\\s+${name}\\b`));
    return m ? m[1] : null;
  };
  const AppId = pick('App');
  const applyThemeId = pick('applyDocumentTheme');
  const applyVarsId = pick('applyHostStyleVariables');
  if (!AppId) throw new Error('Could not resolve App export in ext-apps bundle');

  cachedSdkSnippet = { body, AppId, applyThemeId, applyVarsId };
  return cachedSdkSnippet;
}

function buildMcpAppHtml() {
  const baseHtml = getIndexHtml();
  const { body, AppId, applyThemeId, applyVarsId } = getInlineExtAppsSnippet();

  const shimScripts = `
<script>
(function () {
  var resolveBridge;
  window.__mcpBridgeReady = new Promise(function (resolve) { resolveBridge = resolve; });
  window.__resolveMcpBridge = resolveBridge;
  window.fetch = async function (input, init) {
    var handler = await window.__mcpBridgeReady;
    return handler(String(input || ''), init || {});
  };
})();
</script>
<script type="module">
${body}
const __App = ${AppId};
const __applyTheme = ${applyThemeId || '(() => {})'};
const __applyVars = ${applyVarsId || '(() => {})'};

const app = new __App({ name: 'Context & Cache Monitor', version: '1.3.0' }, {});

const applyCtx = (ctx) => {
  if (!ctx) return;
  try {
    if (ctx.theme) __applyTheme(ctx.theme);
    if (ctx.styles && ctx.styles.variables) __applyVars(ctx.styles.variables);
  } catch {}
};

app.onhostcontextchanged = (ctx) => applyCtx(ctx);
app.ontoolresult = () => {};

let connected = false;
async function ensureConnected() {
  if (connected) return;
  await app.connect();
  applyCtx(app.getHostContext());
  connected = true;
}

function makeJsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    async json() { return payload; },
    async text() { return JSON.stringify(payload); },
  };
}

async function callAppTool(name, args) {
  await ensureConnected();
  const res = await app.callServerTool({ name, arguments: args || {} });
  if (res && res.structuredContent !== undefined) return res.structuredContent;
  const txt = res && Array.isArray(res.content) && res.content[0] && res.content[0].text;
  try { return txt ? JSON.parse(txt) : {}; } catch { return {}; }
}

async function mcpFetch(urlStr, opts) {
  const method = String((opts && opts.method) || 'GET').toUpperCase();
  const url = new URL(urlStr, 'http://localhost/');
  let body = {};
  if (opts && opts.body) {
    try { body = JSON.parse(opts.body); } catch {}
  }

  if (url.pathname.endsWith('/api/overview')) {
    const data = await callAppTool('get_overview', {
      id: url.searchParams.get('id') || 'all',
      day: url.searchParams.get('day') || '',
      model: url.searchParams.get('model') || 'all',
      hour: url.searchParams.get('hour') ?? '',
    });
    return makeJsonResponse(data);
  }
  if (url.pathname.endsWith('/api/auto-compact') && method === 'GET') {
    return makeJsonResponse(await callAppTool('get_auto_compact', {}));
  }
  if (url.pathname.endsWith('/api/auto-compact') && method === 'POST') {
    return makeJsonResponse(await callAppTool('save_auto_compact', body));
  }
  if (url.pathname.endsWith('/api/auto-compact/trigger-now') && method === 'POST') {
    return makeJsonResponse(await callAppTool('trigger_compact_now', {}));
  }
  if (url.pathname.endsWith('/api/auto-compact/snooze') && method === 'POST') {
    return makeJsonResponse(await callAppTool('snooze_auto_compact', body));
  }
  if (url.pathname.endsWith('/api/auto-compact/test') && method === 'POST') {
    return makeJsonResponse(await callAppTool('test_auto_compact', {}));
  }
  return { ok: false, status: 404, async json() { return {}; }, async text() { return 'Not found'; } };
}

ensureConnected()
  .catch((err) => console.error('MCP App connect failed:', err))
  .finally(() => {
    if (typeof window.__resolveMcpBridge === 'function') {
      window.__resolveMcpBridge(mcpFetch);
    }
  });
</script>
`;

  return baseHtml.replace('</head>', () => `${shimScripts}\n</head>`);
}

const server = new Server(
  { name: 'context-monitor', version: '1.3.0' },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: APP_URI,
      name: 'Context & Cache Monitor Dashboard',
      description: 'Live Gemini context compaction, prefix cache hit rate, and Auto-Compact dashboard.',
      mimeType: 'text/html;profile=mcp-app',
      _meta: {
        ui: {
          prefersBorder: false,
        },
      },
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  if (req.params.uri !== APP_URI) {
    throw new Error(`Unknown resource: ${req.params.uri}`);
  }
  const html = buildMcpAppHtml();
  return {
    contents: [
      {
        uri: APP_URI,
        mimeType: 'text/html;profile=mcp-app',
        text: html,
        _meta: {
          ui: {
            prefersBorder: false,
          },
        },
      },
    ],
  };
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'open_context_monitor',
      title: 'Context & Cache',
      description:
        'Open the interactive Context & Cache Monitor dashboard (available full-page from the left sidebar and in the right side pane "+" menu).',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      _meta: {
        ui: {
          resourceUri: APP_URI,
        },
        'com.google.antigravity/ui': {
          entrypoints: [
            { type: 'aux_pane', title: 'Context & Cache' },
            { type: 'global', title: 'Context & Cache' },
          ],
        },
      },
    },
    {
      name: 'get_overview',
      title: 'Get Overview Data',
      description: 'App-only tool to fetch live overview metrics and event logs.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          day: { type: 'string' },
          model: { type: 'string' },
          hour: { type: 'string' },
        },
      },
      _meta: {
        ui: {
          visibility: ['app'],
        },
      },
    },
    {
      name: 'get_auto_compact',
      title: 'Get Auto-Compact Status',
      description: 'App-only tool to inspect Auto-Compact configuration and active watermark.',
      inputSchema: { type: 'object', properties: {} },
      _meta: { ui: { visibility: ['app'] } },
    },
    {
      name: 'save_auto_compact',
      title: 'Save Auto-Compact Config',
      description: 'App-only tool to update Auto-Compact threshold and mode.',
      inputSchema: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean' },
          thresholdMode: { type: 'string' },
          thresholdK: { type: 'number' },
          mode: { type: 'string' },
          idleSeconds: { type: 'number' },
          cooldownSeconds: { type: 'number' },
        },
      },
      _meta: { ui: { visibility: ['app'] } },
    },
    {
      name: 'trigger_compact_now',
      title: 'Trigger Compact Now',
      description: 'App-only tool to immediately send /compact to the active Antigravity window.',
      inputSchema: { type: 'object', properties: {} },
      _meta: { ui: { visibility: ['app'] } },
    },
    {
      name: 'snooze_auto_compact',
      title: 'Snooze Auto-Compact Toast',
      description: 'App-only tool to snooze or temporarily bump threshold.',
      inputSchema: {
        type: 'object',
        properties: {
          seconds: { type: 'number' },
          bumpK: { type: 'number' },
        },
      },
      _meta: { ui: { visibility: ['app'] } },
    },
    {
      name: 'test_auto_compact',
      title: 'Test Auto-Compact',
      description: 'App-only tool to test the selected Auto-Compact trigger mode.',
      inputSchema: { type: 'object', properties: {} },
      _meta: { ui: { visibility: ['app'] } },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  if (name === 'open_context_monitor') {
    const st = getAutoCompactStatus();
    const t = st.activeTarget;
    const summary = t
      ? `Context & Cache Monitor ready. Active session "${t.convTitle}" (${t.model}): ${Math.round(t.contextTotal / 100) / 10}K / ${st.effectiveThresholdK}K.`
      : `Context & Cache Monitor ready. Effective threshold: ${st.effectiveThresholdK}K (${st.effectiveReason}).`;
    return {
      content: [{ type: 'text', text: summary }],
      structuredContent: { ok: true, effectiveThresholdK: st.effectiveThresholdK },
    };
  }

  if (name === 'get_overview') {
    const data = getFullOverview({
      id: args.id || 'all',
      day: args.day || '',
      model: args.model || 'all',
      hour: args.hour ?? '',
    });
    return {
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: data,
    };
  }

  if (name === 'get_auto_compact') {
    const data = getAutoCompactStatus();
    return { content: [{ type: 'text', text: 'ok' }], structuredContent: data };
  }

  if (name === 'save_auto_compact') {
    const data = updateAutoCompactConfig(args);
    return { content: [{ type: 'text', text: 'ok' }], structuredContent: data };
  }

  if (name === 'trigger_compact_now') {
    const result = await triggerCompactNow('mcp_app_confirm');
    return {
      content: [{ type: 'text', text: result.message || 'ok' }],
      structuredContent: { result, status: getAutoCompactStatus() },
    };
  }

  if (name === 'snooze_auto_compact') {
    const data = snoozeAutoCompact(args);
    return { content: [{ type: 'text', text: 'ok' }], structuredContent: data };
  }

  if (name === 'test_auto_compact') {
    const result = await evaluateAutoCompact(true);
    return {
      content: [{ type: 'text', text: result.message || 'ok' }],
      structuredContent: { result, status: getAutoCompactStatus() },
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);

setInterval(() => {
  evaluateAutoCompact(false).catch(() => {});
}, 3000);

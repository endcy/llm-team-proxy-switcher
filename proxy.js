#!/usr/bin/env node

/**
 * llm-team-proxy-switcher
 * Team-shared LLM API proxy with automatic provider + model switching on rate limiting (429).
 *
 * Zero dependencies — uses only Node.js built-in modules.
 * Supports both Anthropic (/v1/messages) and OpenAI (/v1/chat/completions) API formats.
 *
 * @author endcy
 * @url https://github.com/endcy/llm-team-proxy-switcher
 */

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// ─── Console colors ──────────────────────────────────────────────
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

// ─── Paths ───────────────────────────────────────────────────────
const PROXY_DIR = __dirname;
const CONFIG_PATH = path.join(PROXY_DIR, 'config.json');
const PUBLIC_DIR = path.join(PROXY_DIR, 'public');
const LOG_DIR = path.join(PROXY_DIR, 'log');
const LOG_FILE = path.join(LOG_DIR, 'llm-proxy.log');
const LOG_MAX_SIZE = 200 * 1024 * 1024; // 200MB
const SWITCH_STATUS_CODES = new Set([429, 524, 529]);

// ─── Display URL helper ──────────────────────────────────────────
function getLocalIP() {
  const os = require('os');
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

function getDisplayUrl(config) {
  const host = config.bind === '0.0.0.0' ? getLocalIP() : config.bind;
  return `http://${host}:${config.port}`;
}

// ─── MIME types ──────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ─── Default config ──────────────────────────────────────────────
const DEFAULTS = {
  port: 9982,
  bind: '0.0.0.0',
  maxRetries: 20,
  requestTimeoutMs: 300000,
  'limiter-recovery-seconds': 300,
  'p0-reset-interval-seconds': 600,
  logDebug: false,
  textOnlyModels: ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v3.2'],
  providers: [],
};

// ═══════════════════════════════════════════════════════════════════
//  CONFIG LOADING
// ═══════════════════════════════════════════════════════════════════

function loadConfig() {
  let fileCfg = {};
  try {
    fileCfg = JSON.parse(stripJsonComments(fs.readFileSync(CONFIG_PATH, 'utf-8')));
  } catch (err) {
    if (err.code === 'ENOENT') {
      log('warn', 'config.json not found, using defaults. Run with --help for setup guide.');
    } else {
      log('warn', `Failed to parse config.json: ${err.message}`);
    }
  }
  return { ...DEFAULTS, ...fileCfg };
}

/** Remove // comments from JSON */
function stripJsonComments(text) {
  return text.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

// ═══════════════════════════════════════════════════════════════════
//  PROVIDER / TARGET MANAGEMENT
// ═══════════════════════════════════════════════════════════════════

/**
 * Build flat target list from providers config.
 * Each target is { providerIndex, model, baseUrl, apiKey, key }.
 *
 * Example with 2 providers × 2 models:
 *   [0] P0-M0  [1] P0-M1  [2] P1-M0  [3] P1-M1
 */
/**
 * Build target list from config.
 * @param {string} format - 'anthropic' or 'openai'
 * If provider has 'openai-models', use it for openai format; otherwise use 'models' for both.
 */
function buildTargets(config, format) {
  format = format || 'anthropic';
  const targets = [];
  for (let pi = 0; pi < config.providers.length; pi++) {
    const p = config.providers[pi];
    // Choose model list based on format
    let models;
    if (format === 'openai') {
      // If openai-models is explicitly defined (even empty), use it
      if ('openai-models' in p) {
        models = p['openai-models'] || [];
      } else {
        // No openai-models field → models supports both formats
        models = p.models || [];
      }
    } else {
      models = p.models || [];
    }
    for (const model of models) {
      targets.push({
        providerIndex: pi,
        model,
        baseUrl: p['base-url'],
        openaiBaseUrl: p['openai-base-url'] || '',
        apiKey: p['api-key'],
        key: `${pi}::${model}`,
      });
    }
  }
  return targets;
}

// ─── Rotation state ──────────────────────────────────────────────
const state = {
  /** Per-format dynamic queues: { anthropic: [keys], openai: [keys] } */
  targetQueues: { anthropic: [], openai: [] },
  /** Map<targetKey, cooldownExpiry timestamp> — brief cooldown after error */
  cooldowns: new Map(),
  /** Timer for periodic P0 reset */
  p0ResetTimer: null,
  /** Last config providers hash — for detecting config changes */
  lastConfigHash: '',
};

/** Compute a simple hash of provider config to detect changes */
function configHash(config) {
  return JSON.stringify(config.providers.map(p => ({
    url: p['base-url'],
    openaiUrl: p['openai-base-url'] || '',
    models: p.models,
    openaiModels: 'openai-models' in p ? p['openai-models'] : null,
  })));
}

/** Initialize or rebuild the per-format target queues from config */
function ensureTargetQueue(config) {
  const hash = configHash(config);
  if (state.lastConfigHash === hash &&
      (state.targetQueues.anthropic.length > 0 || state.targetQueues.openai.length > 0)) {
    return;
  }
  state.targetQueues.anthropic = buildTargets(config, 'anthropic').map(t => t.key);
  state.targetQueues.openai = buildTargets(config, 'openai').map(t => t.key);
  state.lastConfigHash = hash;
}

/** Move a target to the end of all queues (after error) */
function moveTargetToEnd(targetKey) {
  for (const fmt of ['anthropic', 'openai']) {
    const q = state.targetQueues[fmt];
    const idx = q.indexOf(targetKey);
    if (idx >= 0) {
      q.splice(idx, 1);
      q.push(targetKey);
    }
  }
}

/** Move all P0 targets to the front of all queues */
function resetP0ToFront(config) {
  for (const fmt of ['anthropic', 'openai']) {
    const targets = buildTargets(config, fmt);
    const p0Keys = targets.filter(t => t.providerIndex === 0).map(t => t.key);
    const q = state.targetQueues[fmt];
    for (const key of p0Keys) {
      const idx = q.indexOf(key);
      if (idx >= 0) q.splice(idx, 1);
    }
    q.unshift(...p0Keys);
  }
  log('recovery', 'P0 targets reset to front of queue');
}

/** Start periodic P0 reset timer (every `p0-reset-interval-seconds` or default 600s) */
function startP0ResetTimer(config) {
  if (state.p0ResetTimer) clearInterval(state.p0ResetTimer);
  const intervalSec = config['p0-reset-interval-seconds'] || 600;
  state.p0ResetTimer = setInterval(() => {
    const cfg = loadConfig();
    resetP0ToFront(cfg);
  }, intervalSec * 1000);
}

function targetLabel(target, config) {
  const pName = `P${target.providerIndex}`;
  return `${pName}/${target.model}`;
}

/**
 * Resolve the best target to use right now.
 * Uses dynamic queue: picks first non-cooled target from queue.
 * After error, target moves to queue tail.
 * P0 targets are periodically reset to queue front.
 */
function resolveTarget(config, format) {
  format = format || 'anthropic';
  ensureTargetQueue(config);
  const targets = buildTargets(config, format);
  if (targets.length === 0) return null;

  const queue = state.targetQueues[format] || [];
  const now = Date.now();

  // Expire old cooldowns
  for (const [key, expiry] of state.cooldowns) {
    if (expiry <= now) state.cooldowns.delete(key);
  }

  // Find first non-cooled target in queue order
  for (const key of queue) {
    if ((state.cooldowns.get(key) || 0) <= now) {
      const target = targets.find(t => t.key === key);
      if (target) return target;
    }
  }

  // All targets cooled — find earliest recovery
  let earliest = Infinity;
  for (const [key, expiry] of state.cooldowns) {
    if (expiry > now && expiry < earliest) earliest = expiry;
  }
  if (earliest !== Infinity) {
    const waitSec = Math.ceil((earliest - now) / 1000);
    log('warn', `All ${format} targets in cooldown. Earliest recovery in ${waitSec}s`);
  }

  // Fallback: return first target, let it fail naturally
  return targets[0] || null;
}

/** Detect request format from URL path */
function detectFormat(reqUrl) {
  if (reqUrl.includes('/chat/completions')) return 'openai';
  return 'anthropic';
}

/**
 * Called when a target gets 429/524/529:
 * 1. Set brief cooldown so it's not retried immediately
 * 2. Move to end of queue so other targets get tried first
 */
function markTargetCooled(targetKey, config) {
  const recoverySec = config['limiter-recovery-seconds'] || 300;
  state.cooldowns.set(targetKey, Date.now() + recoverySec * 1000);
  moveTargetToEnd(targetKey);
}

function getCoolingTargets(config) {
  const now = Date.now();
  const targets = buildTargets(config);
  const cooling = [];
  for (const t of targets) {
    const expiry = state.cooldowns.get(t.key) || 0;
    if (expiry > now) {
      cooling.push({
        label: targetLabel(t, config),
        remainingSec: Math.ceil((expiry - now) / 1000),
      });
    }
  }
  return cooling;
}

// ═══════════════════════════════════════════════════════════════════
//  LOGGING
// ═══════════════════════════════════════════════════════════════════

function log(type, msg) {
  const ts = new Date().toLocaleTimeString();
  const prefix = {
    'info':         `${C.blue}ℹ${C.reset}`,
    'ok':           `${C.green}✓${C.reset}`,
    'warn':         `${C.yellow}⚠${C.reset}`,
    'error':        `${C.red}✗${C.reset}`,
    'switch':       `${C.cyan}⇄${C.reset}`,
    'recovery':     `${C.green}↻${C.reset}`,
    'rate-limited': `${C.red}⬤${C.reset}`,
    'request':      `${C.gray}→${C.reset}`,
    'response':     `${C.gray}←${C.reset}`,
  }[type] || '?';
  console.log(`  ${C.gray}${ts}${C.reset} ${prefix} ${msg}`);
  logToFile(type, msg);
}

/** Strip ANSI color codes for plain text log */
function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Write log to file with rotation (max 200MB, archive with timestamp) */
function logToFile(type, msg) {
  try {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }

    // Check if current log exceeds max size
    if (fs.existsSync(LOG_FILE)) {
      const stat = fs.statSync(LOG_FILE);
      if (stat.size >= LOG_MAX_SIZE) {
        const now = new Date();
        const ts = now.getFullYear()
          + String(now.getMonth() + 1).padStart(2, '0')
          + String(now.getDate()).padStart(2, '0') + '-'
          + String(now.getHours()).padStart(2, '0')
          + String(now.getMinutes()).padStart(2, '0')
          + String(now.getSeconds()).padStart(2, '0');
        const archiveName = `llm-proxy-${ts}.log`;
        const archivePath = path.join(LOG_DIR, archiveName);
        fs.renameSync(LOG_FILE, archivePath);
      }
    }

    const now = new Date();
    const ts = now.getFullYear()
      + '-' + String(now.getMonth() + 1).padStart(2, '0')
      + '-' + String(now.getDate()).padStart(2, '0') + ' '
      + String(now.getHours()).padStart(2, '0') + ':'
      + String(now.getMinutes()).padStart(2, '0') + ':'
      + String(now.getSeconds()).padStart(2, '0');
    const plain = stripAnsi(msg);
    const line = `[${ts}] [${type}] ${plain}\n`;
    fs.appendFileSync(LOG_FILE, line, 'utf-8');
  } catch {
    // Never let logging errors crash the proxy
  }
}

// ═══════════════════════════════════════════════════════════════════
//  AUTH HEADER INJECTION
// ═══════════════════════════════════════════════════════════════════

/**
 * Replace the API key in request headers.
 * Remove ALL existing auth headers and set the provider's key.
 */
function injectApiKey(headers, apiKey) {
  if (!apiKey) return headers;
  const result = { ...headers };

  // Remove all existing auth headers (NOT anthropic-version — that's a required API header)
  const authHeaders = ['authorization', 'x-api-key', 'x-auth-token'];
  for (const key of Object.keys(result)) {
    if (authHeaders.includes(key.toLowerCase())) {
      delete result[key];
    }
  }

  // Set the provider's API key in both common formats
  result['x-api-key'] = apiKey;
  result['authorization'] = `Bearer ${apiKey}`;

  return result;
}

// ═══════════════════════════════════════════════════════════════════
//  STATIC FILE SERVING
// ═══════════════════════════════════════════════════════════════════

function serveStaticFile(res, filePath) {
  const ext = path.extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
}

function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data, null, 2));
}

// ═══════════════════════════════════════════════════════════════════
//  MULTI-CLI HELPERS
// ═══════════════════════════════════════════════════════════════════

function getAllModels(config) {
  const allModels = new Set();
  for (const p of config.providers) {
    for (const m of (p.models || [])) allModels.add(m);
  }
  return [...allModels];
}

/** Mask API key: show first 6 and last 4 chars, mask middle */
function maskKey(key) {
  if (!key || key.length <= 10) return '***';
  return key.slice(0, 6) + '***' + key.slice(-4);
}

/** Format target details for logging */
function targetDetails(target) {
  return `model=${target.model} key=${maskKey(target.apiKey)} url=${target.baseUrl}`;
}

function getFirstModel(config) {
  if (config.providers.length === 0) return 'unknown';
  const p = config.providers[0];
  return (p.models && p.models[0]) || 'unknown';
}

function getCliSetupData(proxyUrl, defaultModel) {
  return {
    'claude-code': {
      name: 'Claude Code',
      status: 'supported',
      icon: '🟢',
      env: {
        ANTHROPIC_BASE_URL: proxyUrl,
        ANTHROPIC_API_KEY: 'dummy',
        ANTHROPIC_MODEL: defaultModel,
      },
      configFile: '~/.claude/settings.json',
      notes: 'API_KEY must be non-empty (proxy replaces it). Set in env{} in settings.json.',
    },
    'codex': {
      name: 'Codex (OpenAI)',
      status: 'supported',
      icon: '🟢',
      env: {
        OPENAI_BASE_URL: proxyUrl + '/v1',
        OPENAI_API_KEY: 'dummy',
        OPENAI_MODEL: defaultModel,
      },
      configFile: '~/.codex/config.toml or env vars',
      notes: 'Uses OpenAI-compatible format. API_KEY must be non-empty.',
    },
    'cursor': {
      name: 'Cursor',
      status: 'planned',
      icon: '🔜',
      env: {
        'Settings → Models → Override OpenAI Base URL': proxyUrl + '/v1',
        'OpenAI API Key': 'dummy',
      },
      configFile: 'Cursor Settings UI',
      notes: 'Configure via Cursor Settings → Models → Override OpenAI Base URL.',
    },
    'openclaw': {
      name: 'OpenClaw',
      status: 'supported',
      icon: '',
      env: {
        'models.providers.<name>.baseUrl': proxyUrl + '/v1',
        'models.providers.<name>.api': 'anthropic-messages',
        'models.providers.<name>.apiKey': 'dummy',
      },
      configFile: '~/.openclaw/openclaw.json',
      notes: 'Coding Plan keys require "api": "anthropic-messages". Proxy strips provider prefixes (bailian/qwen3.7-plus → qwen3.7-plus), replaces API keys, and routes OpenAI format (/v1/chat/completions) to openai-base-url.',
    },
    'workbuddy': {
      name: 'WorkBuddy',
      status: 'supported',
      icon: '',
      env: {
        'API Base URL': proxyUrl,
        'API Key': 'dummy (any non-empty value)',
      },
      configFile: 'WorkBuddy Settings',
      notes: 'Sends OpenAI format (/v1/chat/completions). Proxy auto-routes to openai-base-url. Just set the base URL to the proxy address.',
    },
    'generic': {
      name: 'Any OpenAI / Anthropic CLI',
      status: 'supported',
      icon: '🟢',
      env: {
        'OpenAI format': proxyUrl + '/v1  (e.g. /v1/chat/completions)',
        'Anthropic format': proxyUrl + '  (e.g. /v1/messages)',
        'API Key': 'dummy (any non-empty value)',
      },
      configFile: 'Tool-specific',
      notes: 'Proxy auto-detects format from request path. OpenAI requests route to openai-base-url if configured. No client-side changes needed beyond base URL.',
    },
  };
}

// ═══════════════════════════════════════════════════════════════════
//  HTTP SERVER
//  Author: endcy | https://github.com/endcy/llm-team-proxy-switcher
// ═══════════════════════════════════════════════════════════════════

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // ── Web UI: static files ──
  if (req.method === 'GET') {
    // Home page
    if (pathname === '/' || pathname === '/index.html') {
      return serveStaticFile(res, path.join(PUBLIC_DIR, 'index.html'));
    }
    // Config page
    if (pathname === '/config.html') {
      return serveStaticFile(res, path.join(PUBLIC_DIR, 'config.html'));
    }
    // Status API (health check)
    if (pathname === '/api/status') {
      const config = loadConfig();
      const targets = buildTargets(config);
      const cooling = getCoolingTargets(config);
      return sendJSON(res, 200, {
        status: 'ok',
        providers: config.providers.map((p, i) => ({
          index: i,
          baseUrl: p['base-url'],
          apiKeyPreview: (p['api-key'] || '').slice(0, 10) + '...',
          models: p.models || [],
        })),
        totalTargets: targets.length,
        activeIndex: state.activeIndex,
        coolingTargets: cooling,
        recoverySeconds: config['limiter-recovery-seconds'] || 300,
      });
    }
    // Read config API
    if (pathname === '/api/config') {
      try {
        const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
        const data = JSON.parse(raw);
        return sendJSON(res, 200, data);
      } catch (err) {
        return sendJSON(res, 500, { error: 'Failed to read config: ' + err.message });
      }
    }

    // ── API GET passthrough: model listing & auth validation ──
    // Claude Code sends GET requests to validate models and check auth.
    // We respond with a synthetic model list from our configured providers.
    if (pathname === '/v1/models' || pathname === '/v1/models/') {
      const config = loadConfig();
      const allModels = new Set();
      for (const p of config.providers) {
        for (const m of (p.models || [])) allModels.add(m);
      }
      // Return OpenAI-compatible model list
      return sendJSON(res, 200, {
        object: 'list',
        data: [...allModels].map(id => ({
          id,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: 'proxy',
        })),
      });
    }

    // Anthropic model listing
    if (pathname === '/v1/messages/models' || pathname === '/v1/messages/models/') {
      const config = loadConfig();
      const allModels = new Set();
      for (const p of config.providers) {
        for (const m of (p.models || [])) allModels.add(m);
      }
      return sendJSON(res, 200, {
        models: [...allModels].map(id => ({
          id,
          display_name: id,
          created_at: new Date().toISOString(),
        })),
      });
    }

    // Catch-all for other API GET requests — return OK to pass validation
    if (pathname.startsWith('/v1/')) {
      return sendJSON(res, 200, { status: 'ok' });
    }

    // Additional model listing endpoints for broader CLI compatibility
    // (Codex, OpenClaw, Cursor, etc. may probe different paths)
    if (pathname === '/models' || pathname === '/models/' ||
        pathname === '/api/models' || pathname === '/api/models/') {
      const config = loadConfig();
      const allModels = getAllModels(config);
      return sendJSON(res, 200, {
        object: 'list',
        data: allModels.map(id => ({
          id,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: 'proxy',
        })),
      });
    }

    // ── CLI Setup Guide API ──
    if (pathname === '/api/cli-setup') {
      const displayUrl = getDisplayUrl(loadConfig());
      const firstModel = getFirstModel(loadConfig());
      return sendJSON(res, 200, getCliSetupData(displayUrl, firstModel));
    }

    // Other static files from public/
    const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
    const filePath = path.join(PUBLIC_DIR, safePath);
    if (filePath.startsWith(PUBLIC_DIR)) {
      return serveStaticFile(res, filePath);
    }
  }

  // ── Write config API ──
  if (req.method === 'PUT' && pathname === '/api/config') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf-8');
        const parsed = JSON.parse(body);

        // Validate minimum structure
        if (!parsed.providers || !Array.isArray(parsed.providers)) {
          return sendJSON(res, 400, { error: '"providers" must be an array' });
        }
        for (let i = 0; i < parsed.providers.length; i++) {
          const p = parsed.providers[i];
          if (!p['base-url']) return sendJSON(res, 400, { error: `Provider P${i}: missing "base-url"` });
          if (!p['api-key']) return sendJSON(res, 400, { error: `Provider P${i}: missing "api-key"` });
        }

        // Write config
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
      log('ok', 'Config updated via Web UI (llm-team-proxy-switcher)');
        return sendJSON(res, 200, { status: 'ok', message: 'Config saved' });
      } catch (err) {
        if (err instanceof SyntaxError) {
          return sendJSON(res, 400, { error: 'Invalid JSON: ' + err.message });
        }
        return sendJSON(res, 500, { error: 'Failed to save config: ' + err.message });
      }
    });
    return;
  }

  // ── Proxy: only POST requests ──
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method Not Allowed');
    return;
  }

  // Collect request body for proxying
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    handleProxyRequest(req, res, body, 0);
  });
  req.on('error', (err) => {
    log('error', `Client request error: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502);
      res.end();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
//  PROXY LOGIC
// ═══════════════════════════════════════════════════════════════════

function handleProxyRequest(clientReq, clientRes, body, attempt) {
  const config = loadConfig();

  // Parse body
  let parsed;
  try {
    parsed = JSON.parse(body.toString('utf-8'));
  } catch (e) {
    log('warn', `Skip non-JSON body (${body.length}B) from ${clientReq.url}`);
    clientRes.writeHead(400, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Invalid request body' } }));
    return;
  }

  // Detect request format and resolve target accordingly
  const format = detectFormat(clientReq.url);
  const target = resolveTarget(config, format);
  if (!target) {
    log('error', `No providers configured for ${format} format in config.json`);
    clientRes.writeHead(500, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({ error: { type: 'config_error', message: 'No providers configured' } }));
    return;
  }

  // Swap model
  // Strip provider prefix if present (e.g. "bailian/qwen3.7-plus" → "qwen3.7-plus")
  const rawModel = parsed.model || 'unknown';
  const originalModel = rawModel.includes('/') ? rawModel.split('/').pop() : rawModel;
  if (target.model !== originalModel) {
    parsed.model = target.model;
    log('request', `${rawModel} → ${target.model} [P${target.providerIndex}] key=${maskKey(target.apiKey)}`);
  } else {
    log('request', `[${attempt + 1}] ${clientReq.method} ${clientReq.url} model=${target.model} [P${target.providerIndex}] key=${maskKey(target.apiKey)}`);
  }

  // Strip Claude Code-specific fields that non-Anthropic upstreams (e.g. LiteLLM) don't understand
  delete parsed['output_config'];
  delete parsed['context_management'];

  // Text-only models cannot handle image/document/base64 content; sanitize before forwarding.
  if (isTextOnlyModel(target.model)) {
    sanitizeTextOnlyRequest(parsed, config);
  }

  const newBody = Buffer.from(JSON.stringify(parsed), 'utf-8');
  proxyToUpstream(clientReq, clientRes, newBody, originalModel, target, config, attempt);
}

function proxyToUpstream(clientReq, clientRes, body, originalModel, target, config, attempt) {
  // Properly join base-url path with request path
  // baseUrl may have a path (e.g. https://opencode.ai/zen/go)
  // clientReq.url starts with / (e.g. /v1/messages?beta=true)
  const base = target.baseUrl.replace(/\/+$/, '');          // strip trailing slash
  let reqPath = clientReq.url;                             // e.g. /v1/messages?beta=true
  // Normalize: if path doesn't start with /v1/, prepend /v1
  if (!reqPath.startsWith('/v1/') && !reqPath.startsWith('/v1?')) {
    reqPath = '/v1' + reqPath;
  }

  // Choose base URL based on request format
  // /v1/chat/completions → OpenAI format → use openai-base-url if configured
  // /v1/messages → Anthropic format → use base-url
  let effectiveBase = base;
  let pathForUpstream = reqPath;
  if (reqPath.startsWith('/v1/chat/completions') && target.openaiBaseUrl) {
    effectiveBase = target.openaiBaseUrl.replace(/\/+$/, '');
    log('info', `  OpenAI format → using openai-base-url: ${effectiveBase}`);
    // openai-base-url already contains a version path (/v1, /v2, /v3, etc.), strip /v1 from request path
    if (/\/v\d+$/.test(effectiveBase)) {
      pathForUpstream = reqPath.replace(/^\/v1/, '');
    }
  }

  const fullUrl = effectiveBase + pathForUpstream;
  const upstreamUrl = new URL(fullUrl);
  const isHttps = upstreamUrl.protocol === 'https:';
  const transport = isHttps ? https : http;

  // Build headers — forward all except host, inject provider's API key
  let headers = { ...clientReq.headers };
  delete headers.host;
  // Strip Anthropic-specific headers that may cause compatibility issues
  // with non-Anthropic upstreams (e.g. LiteLLM)
  delete headers['anthropic-beta'];
  delete headers['anthropic-version'];
  headers['content-length'] = String(body.length);
  headers = injectApiKey(headers, target.apiKey);

  const options = {
    hostname: upstreamUrl.hostname,
    port: upstreamUrl.port || (isHttps ? 443 : 80),
    path: upstreamUrl.pathname + upstreamUrl.search,
    method: 'POST',
    headers,
    timeout: config.requestTimeoutMs,
  };

  const upstreamReq = transport.request(options, (upstreamRes) => {
    const statusCode = upstreamRes.statusCode;
    const contentType = upstreamRes.headers['content-type'] || '';
    const isStream = contentType.includes('text/event-stream');

    // ── Non-streaming: buffer response, check for 429 ──
    if (!isStream) {
      const resChunks = [];
      upstreamRes.on('data', (c) => resChunks.push(c));
      upstreamRes.on('end', () => {
        const resBody = Buffer.concat(resChunks);

        if (SWITCH_STATUS_CODES.has(statusCode) && attempt < config.maxRetries) {
          markTargetCooled(target.key, config);
          log('rate-limited', `${targetLabel(target, config)} → status ${statusCode}, cooldown ${config['limiter-recovery-seconds'] || 300}s`);
          log('info', `  Was: ${targetDetails(target)}`);
          const next = resolveTarget(config, detectFormat(clientReq.url));
          if (next && next.key !== target.key) {
            log('retry', `Retrying with ${targetLabel(next, config)}...`);
            log('info', `  Now: ${targetDetails(next)}`);
            retryWithTarget(clientReq, clientRes, body, originalModel, next, config, attempt);
            return;
          }
        }

        // Handle 400 error due to unsupported content format
        if (isImageUnsupportedError(statusCode, resBody) && attempt < config.maxRetries) {
          const strippedBody = stripImageContent(body, config);
          if (strippedBody) {
            log('retry', `Retrying with fixed content format...`);
            proxyToUpstream(clientReq, clientRes, strippedBody, originalModel, target, config, attempt + 1);
            return;
          }
        }

        // Forward response to client
        clientRes.writeHead(statusCode, upstreamRes.headers);
        clientRes.end(resBody);
        log('response', `${statusCode} ${targetLabel(target, config)} (${resBody.length}B)`);
      });
      return;
    }

    // ── Streaming: SSE handling ──
    handleSSEResponse(upstreamRes, clientReq, clientRes, body, originalModel, target, config, attempt);
  });

  // Connection error
  upstreamReq.on('error', (err) => {
    log('error', `Upstream connection error: ${err.message}`);
    if (!clientRes.headersSent && attempt < config.maxRetries) {
      markTargetCooled(target.key, config);
      const next = resolveTarget(config, detectFormat(clientReq.url));
      if (next && next.key !== target.key) {
        log('retry', `Connection failed, retrying with ${targetLabel(next, config)}...`);
        retryWithTarget(clientReq, clientRes, body, originalModel, next, config, attempt);
        return;
      }
    }
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({ error: { type: 'proxy_error', message: err.message } }));
    } else {
      clientRes.end();
    }
  });

  upstreamReq.on('timeout', () => {
    log('warn', 'Upstream request timeout');
    upstreamReq.destroy();
    if (!clientRes.headersSent) {
      clientRes.writeHead(504, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({ error: { type: 'timeout_error', message: 'Upstream timeout' } }));
    } else {
      clientRes.end();
    }
  });

  upstreamReq.write(body);
  upstreamReq.end();
}

/**
 * Handle SSE streaming response.
 * If 429 is received before streaming starts, retry with next target.
 * If 400 with image_url error, strip images and retry.
 */
function handleSSEResponse(upstreamRes, clientReq, clientRes, body, originalModel, target, config, attempt) {
  // 429 before stream starts — retry
  if (SWITCH_STATUS_CODES.has(upstreamRes.statusCode) && attempt < config.maxRetries) {
    const chunks = [];
    upstreamRes.on('data', (c) => chunks.push(c));
    upstreamRes.on('end', () => {
      markTargetCooled(target.key, config);
      log('rate-limited', `${targetLabel(target, config)} → status ${upstreamRes.statusCode}, cooldown (stream)`);
      log('info', `  Was: ${targetDetails(target)}`);
      const next = resolveTarget(config, detectFormat(clientReq.url));
      if (next && next.key !== target.key) {
        log('retry', `Stream got 429, retrying with ${targetLabel(next, config)}...`);
        log('info', `  Now: ${targetDetails(next)}`);
        retryWithTarget(clientReq, clientRes, body, originalModel, next, config, attempt);
        return;
      }
      clientRes.writeHead(429, upstreamRes.headers);
      clientRes.end(Buffer.concat(chunks));
    });
    return;
  }

  // 400 with content format error before stream starts — fix and retry
  if (upstreamRes.statusCode === 400 && attempt < config.maxRetries) {
    const chunks = [];
    upstreamRes.on('data', (c) => chunks.push(c));
    upstreamRes.on('end', () => {
      const resBody = Buffer.concat(chunks);
      if (isImageUnsupportedError(400, resBody)) {
        const strippedBody = stripImageContent(body);
        if (strippedBody) {
          log('retry', `Stream got content error, retrying with fixed format...`);
          proxyToUpstream(clientReq, clientRes, strippedBody, originalModel, target, config, attempt + 1);
          return;
        }
      }
      clientRes.writeHead(400, upstreamRes.headers);
      clientRes.end(resBody);
    });
    return;
  }

  // Forward streaming headers to client
  // Explicitly set chunked encoding and close connection so client knows stream is done
  const streamHeaders = {
    'Content-Type': upstreamRes.headers['content-type'] || 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'close',
    'Transfer-Encoding': 'chunked',
  };
  clientRes.writeHead(upstreamRes.statusCode, streamHeaders);

  // Stream data through
  upstreamRes.on('data', (chunk) => {
    clientRes.write(chunk);
  });

  upstreamRes.on('end', () => {
    clientRes.end();
    log('response', `stream done ${targetLabel(target, config)}`);
  });

  upstreamRes.on('error', (err) => {
    log('error', `Stream error: ${err.message}`);
    try { clientRes.end(); } catch { /* already ended */ }
  });

  clientReq.on('close', () => {
    upstreamRes.destroy();
  });
}

/** Check if model is text-only and should not receive images/documents */
function isTextOnlyModel(model) {
  const cfg = loadConfig();
  const textOnly = cfg.textOnlyModels || [];
  return textOnly.includes(model);
}

/** Recursively sanitize unsupported multimodal blocks for text-only models */
function sanitizeValueForTextOnly(value, state) {
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) {
      if (item && typeof item === 'object') {
        const t = item.type;
        if (t === 'image' || t === 'image_url' || t === 'document') {
          state.changed = true;
          continue;
        }
        if (t === 'tool_result' && typeof item.content === 'string') {
          out.push({ ...item, content: [{ type: 'text', text: item.content }] });
          state.changed = true;
          continue;
        }
      }
      out.push(sanitizeValueForTextOnly(item, state));
    }
    return out.length > 0 ? out : [{ type: 'text', text: '' }];
  }
  if (value && typeof value === 'object') {
    if (value.type === 'image' || value.type === 'image_url' || value.type === 'document') {
      state.changed = true;
      return { type: 'text', text: '' };
    }
    if (value.source && value.source.type === 'base64') {
      state.changed = true;
      return { type: 'text', text: '' };
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'image_url' || k === 'source') {
        state.changed = true;
        continue;
      }
      out[k] = sanitizeValueForTextOnly(v, state);
    }
    return out;
  }
  return value;
}

function sanitizeTextOnlyRequest(parsed, config) {
  const state = { changed: false };
  if (parsed.messages) parsed.messages = sanitizeValueForTextOnly(parsed.messages, state);
  if (parsed.system) parsed.system = sanitizeValueForTextOnly(parsed.system, state);
  if (state.changed) log('warn', 'Sanitized multimodal content for text-only model');
}

/** Check if 400 error is due to unsupported image content */
function isImageUnsupportedError(statusCode, body) {
  if (statusCode !== 400) return false;
  const text = body.toString('utf-8');
  return text.includes('image_url') && (text.includes('unknown variant') || text.includes('not supported'));
}

/** Strip all image_url content from request body, return new body Buffer or null if no images found */
function stripImageContent(body, config) {
  let parsed;
  try {
    parsed = JSON.parse(body.toString('utf-8'));
  } catch {
    return null;
  }

  let stripped = false;

  // Fix content format issues in all messages
  if (parsed.messages && Array.isArray(parsed.messages)) {
    for (const msg of parsed.messages) {
      // Case 1: msg itself is a tool_result (top-level)
      if (msg.type === 'tool_result' && msg.content && typeof msg.content === 'string') {
        msg.content = [{ type: 'text', text: msg.content }];
        stripped = true;
      }

      // Case 2: msg.content is an array containing tool_result or image_url
      if (msg.content && Array.isArray(msg.content)) {
        const originalLen = msg.content.length;

        // Fix tool_result with string content inside content array
        for (const item of msg.content) {
          if (item.type === 'tool_result' && item.content && typeof item.content === 'string') {
            item.content = [{ type: 'text', text: item.content }];
            stripped = true;
          }
        }

        // Strip image_url
        msg.content = msg.content.filter(c => c.type !== 'image_url');
        if (msg.content.length < originalLen) stripped = true;
        if (msg.content.length === 0) {
          msg.content = [{ type: 'text', text: '' }];
        }
      }
    }
  }

  if (!stripped) return null;

  // Debug logging (only when logDebug is true in config)
  const fixedBody = JSON.stringify(parsed);
  if (config.logDebug && fixedBody.includes('image_url')) {
    const idx = fixedBody.indexOf('image_url');
    log('info', `  DEBUG image_url still found at position ${idx}: ${fixedBody.slice(idx - 50, idx + 100)}`);
  }

  return Buffer.from(fixedBody, 'utf-8');
}

/** Retry the request with a different target (provider + model) */
function retryWithTarget(clientReq, clientRes, body, originalModel, newTarget, config, attempt) {
  let parsed;
  try {
    parsed = JSON.parse(body.toString('utf-8'));
  } catch {
    clientRes.writeHead(400);
    clientRes.end();
    return;
  }
  parsed.model = newTarget.model;
  const newBody = Buffer.from(JSON.stringify(parsed), 'utf-8');

  proxyToUpstream(clientReq, clientRes, newBody, originalModel, newTarget, config, attempt + 1);
}

// ═══════════════════════════════════════════════════════════════════
//  CONFIG FILE WATCHER
// ═══════════════════════════════════════════════════════════════════

function watchConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return;

  let debounce = null;
  try {
    fs.watchFile(CONFIG_PATH, { interval: 2000 }, () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        const config = loadConfig();
        const targets = buildTargets(config);
        log('info', `Config reloaded — ${config.providers.length} provider(s), ${targets.length} target(s)`);
        for (let i = 0; i < config.providers.length; i++) {
          const p = config.providers[i];
          log('info', `  P${i}: ${(p['api-key'] || '').slice(0, 10)}... → [${(p.models || []).join(', ')}]`);
        }
      }, 500);
    });
  } catch {
    // File watching not available on all platforms
  }
}

// ═══════════════════════════════════════════════════════════════════
//  STARTUP
// ═══════════════════════════════════════════════════════════════════

function showHelp() {
  console.log(`
${C.bold}${C.cyan}llm-team-proxy-switcher${C.reset} — Team LLM proxy with auto provider/model switching on 429

${C.bold}Quick Start:${C.reset}
  1. Edit ${C.cyan}config.json${C.reset} — configure providers and models
  2. Set Claude Code env: ${C.green}ANTHROPIC_BASE_URL${C.reset}=http://<server-ip>:9982
  3. Start: ${C.green}node proxy.js${C.reset}

${C.bold}Config (config.json):${C.reset}
  providers                    Array of provider configs (required)
    [].base-url                Provider's API base URL
    [].api-key                 Provider's API key
    [].models                  Available models for this provider
  limiter-recovery-seconds     Cooldown before restoring primary (default: 300)
  port                         Local listen port (default: 9982)
  bind                         Listen address (default: 127.0.0.1)
  maxRetries                   Max rotation attempts per request (default: 20)
  requestTimeoutMs             Upstream timeout in ms (default: 300000)

${C.bold}Rotation order:${C.reset}
  P0/model0 → P0/model1 → P1/model0 → P1/model1 → P2/model0 → ...
  After recovery → back to P0/model0

${C.bold}Health check:${C.reset}
  GET http://127.0.0.1:9982/ — returns current status as JSON
`);
}

function showBanner(config) {
  const sep = '═'.repeat(56);
  const targets = buildTargets(config);
  const recoverySec = config['limiter-recovery-seconds'] || 300;

  const displayUrl = getDisplayUrl(config);

  let providerLines = '';
  for (let i = 0; i < config.providers.length; i++) {
    const p = config.providers[i];
    const keyPreview = (p['api-key'] || '').slice(0, 10) + '...';
    const models = (p.models || []).join(', ') || '(none)';
    const baseUrl = p['base-url'] || '(not set)';
    providerLines += `  ${C.bold}P${i}:${C.reset} ${keyPreview}  ${C.gray}${baseUrl}${C.reset}\n`;
    providerLines += `      ${C.dim}models: ${models}${C.reset}\n`;
  }

  console.log(`
${C.cyan}${C.bold}╔${sep}╗
║   llm-team-proxy-switcher v1.0.0                     ║
║   Team LLM proxy with auto provider/model switching   ║
╚${sep}╝${C.reset}

  ${C.bold}Proxy:${C.reset}      ${displayUrl}
  ${C.bold}Providers:${C.reset}  ${config.providers.length}
  ${C.bold}Targets:${C.reset}    ${targets.length}
  ${C.bold}Recovery:${C.reset}   ${recoverySec}s
  ${C.bold}Timeout:${C.reset}    ${config.requestTimeoutMs}ms

${providerLines}
  ${C.gray}─────────────────────────────────────────────────${C.reset}
  ${C.gray}Web UI:${C.reset}       ${displayUrl}/
  ${C.gray}Config UI:${C.reset}    ${displayUrl}/config.html
  ${C.gray}Waiting for requests... (Ctrl+C to stop)${C.reset}
`);
}

// ─── Main ────────────────────────────────────────────────────────
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  showHelp();
  process.exit(0);
}

const config = loadConfig();
showBanner(config);

if (config.providers.length === 0) {
  log('error', 'No providers configured in config.json.');
  log('info', 'Add at least one provider with "base-url", "api-key", and "models".');
  log('info', 'Example:');
  console.log(`    ${C.green}"providers"${C.reset}: [{`);
  console.log(`      "base-url": "https://api.example.com",`);
  console.log(`      "api-key": "sk-xxx",`);
  console.log(`      "models": ["model-a", "model-b"]`);
  console.log(`    }]`);
  process.exit(1);
}

// Start watching config for changes
watchConfig();

// Start server
server.listen(config.port, config.bind, () => {
  const displayUrl = getDisplayUrl(config);
  log('ok', `Proxy listening on ${displayUrl}`);
  if (config.bind === '0.0.0.0') {
    log('info', `Bound to all interfaces — team members use http://<your-ip>:${config.port}`);
  }
  log('ok', `Web UI: ${displayUrl}/`);
  log('ok', `${config.providers.length} provider(s), ${buildTargets(config).length} target(s)`);
  log('ok', `P0 reset interval: ${config['p0-reset-interval-seconds'] || 600}s`);
  startP0ResetTimer(config);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log(`\n${C.yellow}Shutting down...${C.reset}`);
  if (state.p0ResetTimer) clearInterval(state.p0ResetTimer);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});

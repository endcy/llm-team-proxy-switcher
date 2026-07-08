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

// ─── Console colors (disabled when stdout is not a terminal) ─────
const isTTY = process.stdout.isTTY === true;
const C = {
  reset: isTTY ? '\x1b[0m' : '',
  bold:  isTTY ? '\x1b[1m' : '',
  dim:   isTTY ? '\x1b[2m' : '',
  red:   isTTY ? '\x1b[31m' : '',
  green: isTTY ? '\x1b[32m' : '',
  yellow:isTTY ? '\x1b[33m' : '',
  blue:  isTTY ? '\x1b[34m' : '',
  cyan:  isTTY ? '\x1b[36m' : '',
  gray:  isTTY ? '\x1b[90m' : '',
};

// ─── Paths ───────────────────────────────────────────────────────
const PROXY_DIR = __dirname;
const CONFIG_PATH = path.join(PROXY_DIR, 'config.json');
const PUBLIC_DIR = path.join(PROXY_DIR, 'public');
const LOG_DIR = path.join(PROXY_DIR, 'log');
const LOG_FILE = path.join(LOG_DIR, 'llm-proxy.log');
const LOG_MAX_SIZE = 200 * 1024 * 1024; // 200MB
const SWITCH_STATUS_CODES = new Set([429, 524, 529]);
const MAX_401_RETRIES = 5; // Switch to next key after 5 consecutive 401 errors

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
  // Trim all provider string fields to prevent \r or whitespace leaking into log / headers
  if (fileCfg.providers && Array.isArray(fileCfg.providers)) {
    for (const p of fileCfg.providers) {
      if (typeof p['api-key'] === 'string') p['api-key'] = p['api-key'].trim();
      if (typeof p['base-url'] === 'string') p['base-url'] = p['base-url'].trim();
      if (typeof p['openai-base-url'] === 'string') p['openai-base-url'] = p['openai-base-url'].trim();
      if (Array.isArray(p.models)) p.models = p.models.map(m => typeof m === 'string' ? m.trim() : m);
      if (Array.isArray(p['openai-models'])) p['openai-models'] = p['openai-models'].map(m => typeof m === 'string' ? m.trim() : m);
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
  /** Per-format dynamic queues: { anthropic: [keys], openai: [keys], responses: [keys] } */
  targetQueues: { anthropic: [], openai: [], responses: [] },
  /** Map<targetKey, cooldownExpiry timestamp> — brief cooldown after error */
  cooldowns: new Map(),
  /** Map<targetKey, 401 error count> — track consecutive 401 errors per target */
  auth401Counts: new Map(),
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
      (state.targetQueues.anthropic.length > 0 || state.targetQueues.openai.length > 0 || state.targetQueues.responses.length > 0)) {
    return;
  }
  state.targetQueues.anthropic = buildTargets(config, 'anthropic').map(t => t.key);
  state.targetQueues.openai = buildTargets(config, 'openai').map(t => t.key);
  // Responses API uses the same targets as openai (same models, different endpoint)
  state.targetQueues.responses = buildTargets(config, 'openai').map(t => t.key);
  state.lastConfigHash = hash;
}

/** Move a target to the end of all queues (after error) */
function moveTargetToEnd(targetKey) {
  for (const fmt of ['anthropic', 'openai', 'responses']) {
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
  for (const fmt of ['anthropic', 'openai', 'responses']) {
    const targets = buildTargets(config, fmt === 'responses' ? 'openai' : fmt);
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
  // Responses API uses the same targets as openai
  const targetFormat = format === 'responses' ? 'openai' : format;
  ensureTargetQueue(config);
  const targets = buildTargets(config, targetFormat);
  if (targets.length === 0) return null;

  const queue = state.targetQueues[format] || state.targetQueues[targetFormat] || [];
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
  // OpenAI Responses API (used by Codex with wire_api = "responses")
  if (reqUrl.includes('/responses')) return 'responses';
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

/**
 * Handle 401 Unauthorized error for a target.
 * Increment the 401 counter. Only switch to next target after MAX_401_RETRIES consecutive 401s.
 * Returns true if should switch to next target, false if should retry same target.
 */
function handle401Error(targetKey, config) {
  const count = (state.auth401Counts.get(targetKey) || 0) + 1;
  state.auth401Counts.set(targetKey, count);

  if (count >= MAX_401_RETRIES) {
    // Reached max retries, reset counter and switch
    state.auth401Counts.set(targetKey, 0);
    moveTargetToEnd(targetKey);
    return true; // Should switch
  }
  return false; // Should retry same target
}

/**
 * Reset 401 error count for a target (called on successful request)
 */
function reset401Count(targetKey) {
  state.auth401Counts.delete(targetKey);
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
  // Strip \r and control chars to prevent log line corruption in terminal and file
  const cleanMsg = String(msg).replace(/\r/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
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
  console.log(`  ${C.gray}${ts}${C.reset} ${prefix} ${cleanMsg}`);
  logToFile(type, cleanMsg);
}

/** Strip ANSI color codes and control characters (e.g. \r) for plain text log */
function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, '').replace(/\r/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
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
    // Final safety: ensure the written line has no \r, \n, or control chars
    const safePlain = plain.replace(/[\r\n]/g, ' ').replace(/[\x00-\x1f]/g, '');
    const line = `[${ts}] [${type}] ${safePlain}\n`;
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
      env: {},
      configFile: '~/.codex/config.toml',
      config: `# ~/.codex/config.toml
model_provider = "Proxy"
model = "${defaultModel}"

[model_providers.Proxy]
name = "Proxy"
base_url = "${proxyUrl}"
env_key = "TMP"
wire_api = "responses"

# env_key 指定环境变量名（任意已存在的环境变量均可）
# wire_api 必须为 "responses"（Codex 0.130+ 默认）
# base_url 指向代理地址（不要加 /v1）`,
      notes: 'Codex 0.130+ 使用 Responses API。代理自动转换为 Chat Completions 格式，兼容所有 upstream。env_key 需指定一个已存在的环境变量名（值随意）。',
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

    // OpenAI Responses API model listing (for Codex with wire_api = "responses")
    if (pathname === '/responses/models' || pathname === '/responses/models/' ||
        pathname === '/v1/responses/models' || pathname === '/v1/responses/models/') {
      const config = loadConfig();
      const allModels = new Set();
      for (const p of config.providers) {
        for (const m of (p.models || [])) allModels.add(m);
      }
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

    // Catch-all for other API GET requests — return OK to pass validation
    if (pathname.startsWith('/v1/') || pathname.startsWith('/responses')) {
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

        // Merge: if an api-key looks masked (contains ***), preserve the original
        // from the current config so reordering / editing doesn't destroy keys.
        // Match by base-url (not index) so reordering providers is safe.
        try {
          const currentCfg = JSON.parse(stripJsonComments(fs.readFileSync(CONFIG_PATH, 'utf-8')));
          const currentProviders = currentCfg.providers || [];
          for (const p of parsed.providers) {
            if (typeof p['api-key'] === 'string' && p['api-key'].includes('***')) {
              const matched = currentProviders.find(
                cp => cp['base-url'] === p['base-url']
              );
              if (matched) {
                p['api-key'] = matched['api-key'];
              }
            }
          }
        } catch {
          // If current config can't be read, just save as-is
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

    // ── Handle count_tokens locally (most upstreams don't support this endpoint) ──
    if (pathname === '/v1/messages/count_tokens') {
      return handleCountTokens(req, res, body);
    }

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
//  COUNT TOKENS (local handler — most upstreams don't support this)
// ═══════════════════════════════════════════════════════════════════

/**
 * Handle POST /v1/messages/count_tokens locally.
 * Returns an approximate token count based on the request body,
 * since most upstream providers don't support this endpoint.
 */
function handleCountTokens(req, res, body) {
  let parsed;
  try {
    parsed = JSON.parse(body.toString('utf-8'));
  } catch {
    return sendJSON(res, 400, { type: 'invalid_request_error', message: 'Invalid JSON body' });
  }

  const config = loadConfig();
  const format = detectFormat(req.url);
  const target = resolveTarget(config, format);

  // Estimate token count: ~4 chars per token (rough approximation)
  let charCount = 0;
  if (parsed.messages && Array.isArray(parsed.messages)) {
    for (const msg of parsed.messages) {
      if (typeof msg.content === 'string') {
        charCount += msg.content.length;
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text' && block.text) charCount += block.text.length;
        }
      }
      if (msg.role) charCount += 4; // role overhead
    }
  }
  if (typeof parsed.system === 'string') {
    charCount += parsed.system.length;
  } else if (Array.isArray(parsed.system)) {
    for (const block of parsed.system) {
      if (typeof block === 'string') charCount += block.length;
      else if (block.text) charCount += block.text.length;
    }
  }

  const inputTokens = Math.max(1, Math.ceil(charCount / 4));

  log('request', `count_tokens → ${inputTokens} tokens (estimated)`);
  sendJSON(res, 200, {
    input_tokens: inputTokens,
  });
}

// ═══════════════════════════════════════════════════════════════════
//  RESPONSES API ↔ CHAT COMPLETIONS CONVERSION
//  For Codex CLI compatibility with providers that only support Chat API
// ═══════════════════════════════════════════════════════════════════

/**
 * Convert OpenAI Responses API request to Chat Completions request
 */
function responsesToChatRequest(body) {
  const result = {};
  result.model = body.model;

  const messages = [];

  // instructions → system message
  if (body.instructions != null && body.instructions !== '') {
    messages.push({ role: 'system', content: body.instructions });
  }

  // input → messages
  if (body.input != null) {
    if (typeof body.input === 'string') {
      messages.push({ role: 'user', content: body.input });
    } else if (Array.isArray(body.input)) {
      for (const item of body.input) {
        // Normalize: if no type field, treat as message
        const type = item.type || 'message';

        if (type === 'message') {
          const content = extractResponsesMessageContent(item);
          // Map developer role to system for better compatibility
          const role = (item.role === 'developer') ? 'system' : (item.role || 'user');
          messages.push({ role, content });
        } else if (type === 'input_text') {
          messages.push({ role: 'user', content: item.text || '' });
        } else if (type === 'function_call') {
          // Collect function calls - will be converted to assistant message with tool_calls
          const existing = messages.find(m => m.role === 'assistant' && m.tool_calls);
          const toolCall = {
            id: item.call_id || item.id || '',
            type: 'function',
            function: {
              name: item.name || '',
              arguments: item.arguments || '{}'
            }
          };
          if (existing) {
            existing.tool_calls.push(toolCall);
          } else {
            messages.push({ role: 'assistant', content: null, tool_calls: [toolCall] });
          }
        } else if (type === 'function_call_output') {
          messages.push({
            role: 'tool',
            tool_call_id: item.call_id || '',
            content: item.output || ''
          });
        }
        // reasoning, input_image, etc. → skip
      }
    }
  }

  result.messages = messages;

  // max_output_tokens → max_completion_tokens
  if (body.max_output_tokens != null) {
    result.max_completion_tokens = body.max_output_tokens;
  }

  // Pass-through fields
  if (body.temperature != null) result.temperature = body.temperature;
  if (body.top_p != null) result.top_p = body.top_p;
  if (body.stream != null) result.stream = body.stream;

  // tools conversion
  if (body.tools) {
    const chatTools = [];
    for (const t of body.tools) {
      if (t.type === 'function') {
        const fn = { name: t.name };
        if (t.description != null) fn.description = t.description;
        if (t.parameters != null) fn.parameters = t.parameters;
        chatTools.push({ type: 'function', function: fn });
      }
    }
    if (chatTools.length > 0) {
      result.tools = chatTools;
    }
  }

  if (body.tool_choice != null) result.tool_choice = body.tool_choice;
  if (body.parallel_tool_calls != null) result.parallel_tool_calls = body.parallel_tool_calls;

  // text.format → response_format
  if (body.text?.format != null) {
    const format = body.text.format;
    if (format.type === 'json_schema') {
      result.response_format = {
        type: 'json_schema',
        json_schema: {
          name: format.name || 'response_schema',
          schema: format.schema || {},
          strict: format.strict || false
        }
      };
    } else {
      result.response_format = format;
    }
  }

  return result;
}

/**
 * Extract text content from a Responses API message
 */
function extractResponsesMessageContent(item) {
  const content = item.content;
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(p => p.type === 'input_text' && p.text != null)
      .map(p => p.text)
      .join('');
  }
  return '';
}

/**
 * Convert Chat Completions response to Responses API response
 */
function chatResponseToResponses(chatResponse, requestBody) {
  const result = {
    id: 'resp_' + (chatResponse.id || 'unknown'),
    object: 'response',
    created_at: chatResponse.created || Math.floor(Date.now() / 1000),
    model: chatResponse.model || requestBody.model,
    output: [],
    status: 'completed'
  };

  // Convert usage
  if (chatResponse.usage) {
    result.usage = {
      input_tokens: chatResponse.usage.prompt_tokens || 0,
      output_tokens: chatResponse.usage.completion_tokens || 0,
      total_tokens: chatResponse.usage.total_tokens || 0
    };
  }

  // Convert choices to output items
  if (chatResponse.choices && chatResponse.choices.length > 0) {
    const choice = chatResponse.choices[0];
    const message = choice.message || {};

    // Text content → output_text
    if (message.content != null && message.content !== '') {
      result.output.push({
        type: 'message',
        id: 'msg_' + (chatResponse.id || 'unknown'),
        role: 'assistant',
        status: 'completed',
        content: [
          {
            type: 'output_text',
            text: message.content,
            annotations: []
          }
        ]
      });
    }

    // tool_calls → function_call
    if (message.tool_calls) {
      for (const tc of message.tool_calls) {
        result.output.push({
          type: 'function_call',
          id: tc.id || '',
          call_id: tc.id || '',
          name: tc.function?.name || '',
          arguments: tc.function?.arguments || '{}'
        });
      }
    }
  }

  return result;
}

/**
 * Convert Chat Completions streaming chunk to Responses API streaming events
 */
function chatStreamChunkToResponses(chunk, requestId) {
  const events = [];
  const ts = Math.floor(Date.now() / 1000);

  if (!chunk.choices || chunk.choices.length === 0) {
    // Usage-only chunk or done
    if (chunk.usage) {
      events.push({ type: 'response.completed', response: { id: requestId, usage: chunk.usage } });
    }
    return events;
  }

  const choice = chunk.choices[0];
  const delta = choice.delta || {};

  // Response created event (first chunk)
  if (chunk.choices[0].index === 0 && !chunk._sentCreated) {
    events.push({
      type: 'response.created',
      response: { id: requestId, object: 'response', created_at: ts, model: chunk.model, output: [], status: 'in_progress' }
    });
    events.push({
      type: 'response.in_progress',
      response: { id: requestId, object: 'response', created_at: ts, model: chunk.model, output: [], status: 'in_progress' }
    });
    chunk._sentCreated = true;
  }

  // Content delta
  if (delta.content != null && delta.content !== '') {
    events.push({
      type: 'response.output_text.delta',
      delta: delta.content,
      item_id: 'msg_' + requestId,
      output_index: 0,
      content_index: 0
    });
  }

  // Tool call arguments delta
  if (delta.tool_calls && delta.tool_calls.length > 0) {
    for (const tc of delta.tool_calls) {
      if (tc.function?.arguments) {
        events.push({
          type: 'response.function_call_arguments.delta',
          delta: tc.function.arguments,
          item_id: tc.id || '',
          output_index: 0
        });
      }
    }
  }

  // Finish reason
  if (choice.finish_reason != null) {
    events.push({
      type: 'response.output_text.done',
      item_id: 'msg_' + requestId,
      output_index: 0,
      content_index: 0
    });
    events.push({
      type: 'response.completed',
      response: { id: requestId, object: 'response', created_at: ts, model: chunk.model, output: [], status: 'completed' }
    });
  }

  return events;
}

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
  const isResponsesApi = format === 'responses';
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

  // Responses API → Chat Completions conversion
  // Convert request body and modify URL to /v1/chat/completions
  let convertedBody = null;
  let modifiedUrl = clientReq.url;
  if (isResponsesApi) {
    convertedBody = responsesToChatRequest(parsed);
    // Change URL from /responses or /v1/responses to /v1/chat/completions
    modifiedUrl = '/v1/chat/completions';
    log('info', `  Responses API → Chat Completions conversion enabled`);
  }

  // Text-only models cannot handle image/document/base64 content; sanitize before forwarding.
  if (isTextOnlyModel(target.model)) {
    const bodyToSanitize = convertedBody || parsed;
    sanitizeTextOnlyRequest(bodyToSanitize, config);
    if (convertedBody) convertedBody = bodyToSanitize;
  }

  const newBody = Buffer.from(JSON.stringify(convertedBody || parsed), 'utf-8');
  proxyToUpstream(clientReq, clientRes, newBody, originalModel, target, config, attempt, isResponsesApi, modifiedUrl);
}

function proxyToUpstream(clientReq, clientRes, body, originalModel, target, config, attempt, isResponsesApi, modifiedUrl) {
  // Properly join base-url path with request path
  // baseUrl may have a path (e.g. https://opencode.ai/zen/go)
  // For Responses API, modifiedUrl is /v1/chat/completions (already converted)
  const base = target.baseUrl.replace(/\/+$/, '');          // strip trailing slash
  let reqPath = modifiedUrl || clientReq.url;               // use modified URL for Responses API

  // Normalize path based on endpoint type (skip for already-converted Responses API)
  if (!isResponsesApi) {
    if (!reqPath.startsWith('/v1/') && !reqPath.startsWith('/v1?')) {
      reqPath = '/v1' + reqPath;
    }
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

  // Generate a response ID for Responses API conversion
  const responseId = 'resp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

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
            retryWithTarget(clientReq, clientRes, body, originalModel, next, config, attempt, isResponsesApi, modifiedUrl);
            return;
          }
        }

        // Handle 401 Unauthorized — retry same target up to MAX_401_RETRIES times, then switch
        if (statusCode === 401 && attempt < config.maxRetries) {
          const shouldSwitch = handle401Error(target.key, config);
          const count401 = state.auth401Counts.get(target.key) || 0;
          if (shouldSwitch) {
            log('warn', `${targetLabel(target, config)} → 401 Unauthorized (${MAX_401_RETRIES} retries), switching to next key`);
            log('info', `  Was: ${targetDetails(target)}`);
            const next = resolveTarget(config, detectFormat(clientReq.url));
            if (next && next.key !== target.key) {
              log('retry', `Retrying with ${targetLabel(next, config)}...`);
              log('info', `  Now: ${targetDetails(next)}`);
              retryWithTarget(clientReq, clientRes, body, originalModel, next, config, attempt, isResponsesApi, modifiedUrl);
              return;
            }
          } else {
            log('warn', `${targetLabel(target, config)} → 401 Unauthorized (retry ${count401}/${MAX_401_RETRIES})`);
            // Retry with same target
            retryWithTarget(clientReq, clientRes, body, originalModel, target, config, attempt, isResponsesApi, modifiedUrl);
            return;
          }
        }

        // Handle 400 error due to unsupported content format
        if (isImageUnsupportedError(statusCode, resBody) && attempt < config.maxRetries) {
          const strippedBody = stripImageContent(body, config);
          if (strippedBody) {
            log('retry', `Retrying with fixed content format...`);
            proxyToUpstream(clientReq, clientRes, strippedBody, originalModel, target, config, attempt + 1, isResponsesApi, modifiedUrl);
            return;
          }
        }

        // Convert response back to Responses API format if needed
        let finalBody = resBody;
        let finalStatusCode = statusCode;
        if (isResponsesApi && statusCode >= 200 && statusCode < 300) {
          try {
            const chatResponse = JSON.parse(resBody.toString('utf-8'));
            const responsesResponse = chatResponseToResponses(chatResponse, JSON.parse(body.toString('utf-8')));
            finalBody = Buffer.from(JSON.stringify(responsesResponse), 'utf-8');
            log('info', `  Converted Chat Completions response → Responses API format`);
          } catch (e) {
            log('warn', `  Failed to convert response: ${e.message}`);
          }
        }

        // Forward response to client
        // Reset 401 counter on success
        if (finalStatusCode >= 200 && finalStatusCode < 300) {
          reset401Count(target.key);
        }
        const responseHeaders = { ...upstreamRes.headers };
        responseHeaders['content-length'] = String(finalBody.length);
        clientRes.writeHead(finalStatusCode, responseHeaders);
        clientRes.end(finalBody);
        log('response', `${finalStatusCode} ${targetLabel(target, config)} (${finalBody.length}B)`);
      });
      return;
    }

    // ── Streaming: SSE handling ──
    handleSSEResponse(upstreamRes, clientReq, clientRes, body, originalModel, target, config, attempt, isResponsesApi, modifiedUrl, responseId);
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
function handleSSEResponse(upstreamRes, clientReq, clientRes, body, originalModel, target, config, attempt, isResponsesApi, modifiedUrl, responseId) {
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
        retryWithTarget(clientReq, clientRes, body, originalModel, next, config, attempt, isResponsesApi, modifiedUrl);
        return;
      }
      clientRes.writeHead(429, upstreamRes.headers);
      clientRes.end(Buffer.concat(chunks));
    });
    return;
  }

  // 401 Unauthorized before stream starts — retry same target up to MAX_401_RETRIES, then switch
  if (upstreamRes.statusCode === 401 && attempt < config.maxRetries) {
    const chunks = [];
    upstreamRes.on('data', (c) => chunks.push(c));
    upstreamRes.on('end', () => {
      const shouldSwitch = handle401Error(target.key, config);
      const count401 = state.auth401Counts.get(target.key) || 0;
      if (shouldSwitch) {
        log('warn', `${targetLabel(target, config)} → 401 Unauthorized (${MAX_401_RETRIES} retries), switching to next key (stream)`);
        log('info', `  Was: ${targetDetails(target)}`);
        const next = resolveTarget(config, detectFormat(clientReq.url));
        if (next && next.key !== target.key) {
          log('retry', `Stream got 401, retrying with ${targetLabel(next, config)}...`);
          log('info', `  Now: ${targetDetails(next)}`);
          retryWithTarget(clientReq, clientRes, body, originalModel, next, config, attempt, isResponsesApi, modifiedUrl);
          return;
        }
      } else {
        log('warn', `${targetLabel(target, config)} → 401 Unauthorized (retry ${count401}/${MAX_401_RETRIES}, stream)`);
        // Retry with same target
        retryWithTarget(clientReq, clientRes, body, originalModel, target, config, attempt, isResponsesApi, modifiedUrl);
        return;
      }
      clientRes.writeHead(401, upstreamRes.headers);
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
          proxyToUpstream(clientReq, clientRes, strippedBody, originalModel, target, config, attempt + 1, isResponsesApi, modifiedUrl);
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

  // For Responses API streaming conversion
  let sseBuffer = '';
  const reqId = responseId || generateId('resp_', 12);
  const streamState = {
    sentCreated: false,
    itemId: generateId('msg_', 12),
    model: null,
    createdAt: Math.floor(Date.now() / 1000),
    sequenceNumber: 0,
    inputTokens: 0,
    outputTokens: 0,
    textBuffer: '',
    collectedOutput: [],
    hasMessageItemStarted: false,
    hasContentPartStarted: false,
    outputIndex: 0,
    contentIndex: 0,
    pendingCompletion: false
  };

  function nextSeq() {
    return streamState.sequenceNumber++;
  }

  // Stream data through
  upstreamRes.on('data', (chunk) => {
    if (!isResponsesApi) {
      // Pass through as-is for non-Responses API
      clientRes.write(chunk);
      return;
    }

    // Convert Chat Completions SSE to Responses API SSE
    const chunkStr = chunk.toString('utf-8');
    sseBuffer += chunkStr;

    // Process complete SSE lines
    const lines = sseBuffer.split('\n');
    sseBuffer = lines.pop() || ''; // Keep incomplete line in buffer

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(':')) continue; // Skip empty lines and comments

      if (trimmed.startsWith('data: ')) {
        const data = trimmed.slice(6);
        if (data === '[DONE]') {
          // Handle [DONE] - emit completion if pending
          if (streamState.pendingCompletion) {
            emitCompleted(clientRes, reqId, streamState);
          }
          clientRes.write('data: [DONE]\n\n');
          continue;
        }

        try {
          const chatChunk = JSON.parse(data);

          // Extract usage when present
          if (chatChunk.usage) {
            streamState.inputTokens = chatChunk.usage.prompt_tokens || streamState.inputTokens;
            streamState.outputTokens = chatChunk.usage.completion_tokens || streamState.outputTokens;

            // Usage-only chunk (no choices) - may trigger completion
            if (!chatChunk.choices || chatChunk.choices.length === 0) {
              if (streamState.pendingCompletion) {
                emitCompleted(clientRes, reqId, streamState);
              }
              continue;
            }
          }

          const choice = chatChunk.choices?.[0];
          if (!choice) continue;

          const delta = choice.delta || {};

          // First chunk with role → emit response.created + response.in_progress
          if (delta.role === 'assistant' && !streamState.sentCreated) {
            streamState.model = chatChunk.model || streamState.model;
            ensureResponseCreated(clientRes, reqId, streamState, nextSeq);
          }

          // Handle text content
          if (delta.content != null && delta.content !== '') {
            if (!streamState.sentCreated) {
              streamState.model = chatChunk.model || streamState.model;
              ensureResponseCreated(clientRes, reqId, streamState, nextSeq);
            }

            // Start message item if not started
            if (!streamState.hasMessageItemStarted) {
              streamState.hasMessageItemStarted = true;
              streamState.textBuffer = '';
              streamState.contentIndex = 0;
              sendResponsesEvent(clientRes, 'response.output_item.added', {
                type: 'response.output_item.added',
                output_index: streamState.outputIndex,
                item: {
                  type: 'message',
                  id: streamState.itemId,
                  role: 'assistant',
                  content: [],
                  status: 'in_progress'
                },
                sequence_number: nextSeq()
              });
            }

            // Start content part if not started
            if (!streamState.hasContentPartStarted) {
              streamState.hasContentPartStarted = true;
              sendResponsesEvent(clientRes, 'response.content_part.added', {
                type: 'response.content_part.added',
                output_index: streamState.outputIndex,
                content_index: streamState.contentIndex,
                item_id: streamState.itemId,
                part: { type: 'output_text', text: '', annotations: [] },
                sequence_number: nextSeq()
              });
            }

            // Emit delta
            sendResponsesEvent(clientRes, 'response.output_text.delta', {
              type: 'response.output_text.delta',
              output_index: streamState.outputIndex,
              content_index: streamState.contentIndex,
              item_id: streamState.itemId,
              delta: delta.content,
              sequence_number: nextSeq()
            });
            streamState.textBuffer += delta.content;
          }

          // Handle finish_reason
          if (choice.finish_reason) {
            // Close current message item
            if (streamState.hasContentPartStarted) {
              sendResponsesEvent(clientRes, 'response.output_text.done', {
                type: 'response.output_text.done',
                output_index: streamState.outputIndex,
                content_index: streamState.contentIndex,
                item_id: streamState.itemId,
                text: streamState.textBuffer,
                sequence_number: nextSeq()
              });
              sendResponsesEvent(clientRes, 'response.content_part.done', {
                type: 'response.content_part.done',
                output_index: streamState.outputIndex,
                content_index: streamState.contentIndex,
                item_id: streamState.itemId,
                part: { type: 'output_text', text: streamState.textBuffer, annotations: [] },
                sequence_number: nextSeq()
              });
              streamState.hasContentPartStarted = false;
            }
            if (streamState.hasMessageItemStarted) {
              sendResponsesEvent(clientRes, 'response.output_item.done', {
                type: 'response.output_item.done',
                output_index: streamState.outputIndex,
                item: {
                  type: 'message',
                  id: streamState.itemId,
                  role: 'assistant',
                  content: [{ type: 'output_text', text: streamState.textBuffer, annotations: [] }],
                  status: 'completed'
                },
                sequence_number: nextSeq()
              });
              streamState.collectedOutput.push({
                type: 'message',
                id: streamState.itemId,
                role: 'assistant',
                content: [{ type: 'output_text', text: streamState.textBuffer, annotations: [] }]
              });
              streamState.hasMessageItemStarted = false;
              streamState.outputIndex++;
            }

            streamState.pendingCompletion = true;
            // If there's usage in this chunk, emit completed now
            if (chatChunk.usage) {
              emitCompleted(clientRes, reqId, streamState);
            }
          }
        } catch (e) {
          // If parsing fails, pass through original
          clientRes.write(line + '\n');
        }
      }
    }
  });

  upstreamRes.on('end', () => {
    // Process any remaining buffer
    if (isResponsesApi && sseBuffer.trim()) {
      const trimmed = sseBuffer.trim();
      if (trimmed.startsWith('data: ') && trimmed.slice(6) !== '[DONE]') {
        try {
          const chatChunk = JSON.parse(trimmed.slice(6));
          if (chatChunk.choices?.[0]?.delta?.content) {
            if (!streamState.sentCreated) {
              streamState.model = chatChunk.model || streamState.model;
              ensureResponseCreated(clientRes, reqId, streamState, nextSeq);
            }
            sendResponsesEvent(clientRes, 'response.output_text.delta', {
              type: 'response.output_text.delta',
              output_index: streamState.outputIndex,
              content_index: streamState.contentIndex,
              item_id: streamState.itemId,
              delta: chatChunk.choices[0].delta.content,
              sequence_number: nextSeq()
            });
            streamState.textBuffer += chatChunk.choices[0].delta.content;
          }
        } catch (e) {
          clientRes.write(trimmed + '\n');
        }
      }
    }
    // Ensure completion is emitted
    if (isResponsesApi && streamState.pendingCompletion) {
      emitCompleted(clientRes, reqId, streamState);
    }
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

/**
 * Send a Responses API SSE event with proper format
 */
function sendResponsesEvent(clientRes, eventType, eventData) {
  clientRes.write(`event: ${eventType}\n`);
  clientRes.write(`data: ${JSON.stringify(eventData)}\n\n`);
}

/**
 * Generate a random hex ID
 */
function generateId(prefix, bytes = 12) {
  const chars = '0123456789abcdef';
  let result = prefix || '';
  for (let i = 0; i < bytes * 2; i++) {
    result += chars[Math.floor(Math.random() * 16)];
  }
  return result;
}

/**
 * Ensure response.created and response.in_progress events have been sent
 */
function ensureResponseCreated(clientRes, requestId, streamState, nextSeq) {
  if (streamState.sentCreated) return;
  streamState.sentCreated = true;

  const base = {
    id: requestId,
    object: 'response',
    model: streamState.model || 'unknown',
    status: 'in_progress',
    output: [],
    created_at: streamState.createdAt
  };

  sendResponsesEvent(clientRes, 'response.created', {
    type: 'response.created',
    response: { ...base, status: 'queued' },
    sequence_number: nextSeq()
  });
  sendResponsesEvent(clientRes, 'response.in_progress', {
    type: 'response.in_progress',
    response: base,
    sequence_number: nextSeq()
  });
}

/**
 * Emit response.completed event
 */
function emitCompleted(clientRes, requestId, streamState) {
  if (!streamState.pendingCompletion) return;
  streamState.pendingCompletion = false;

  const completedAt = Math.floor(Date.now() / 1000);
  const response = {
    id: requestId,
    object: 'response',
    model: streamState.model || 'unknown',
    status: 'completed',
    output: streamState.collectedOutput,
    usage: {
      input_tokens: streamState.inputTokens || 0,
      output_tokens: streamState.outputTokens || 0,
      total_tokens: (streamState.inputTokens || 0) + (streamState.outputTokens || 0)
    },
    created_at: streamState.createdAt,
    completed_at: completedAt
  };

  sendResponsesEvent(clientRes, 'response.completed', {
    type: 'response.completed',
    response,
    sequence_number: streamState.sequenceNumber++
  });
}

/**
 * Build a response object for Responses API events
 */
function buildResponseObject(requestId, streamState, status) {
  const completedAt = Math.floor(Date.now() / 1000);
  const output = streamState.collectedOutput || [];

  return {
    id: requestId,
    object: 'response',
    model: streamState.model || 'unknown',
    status,
    output,
    usage: {
      input_tokens: streamState.inputTokens || 0,
      output_tokens: streamState.outputTokens || 0,
      total_tokens: (streamState.inputTokens || 0) + (streamState.outputTokens || 0)
    },
    created_at: streamState.createdAt || completedAt,
    completed_at: completedAt
  };
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
function retryWithTarget(clientReq, clientRes, body, originalModel, newTarget, config, attempt, isResponsesApi, modifiedUrl) {
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

  proxyToUpstream(clientReq, clientRes, newBody, originalModel, newTarget, config, attempt + 1, isResponsesApi, modifiedUrl);
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

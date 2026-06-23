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
function buildTargets(config) {
  const targets = [];
  for (let pi = 0; pi < config.providers.length; pi++) {
    const p = config.providers[pi];
    const models = p.models || [];
    for (const model of models) {
      targets.push({
        providerIndex: pi,
        model,
        baseUrl: p['base-url'],
        apiKey: p['api-key'],
        key: `${pi}::${model}`,
      });
    }
  }
  return targets;
}

// ─── Rotation state ──────────────────────────────────────────────
const state = {
  /** Map<targetKey, cooldownExpiry timestamp> */
  cooldowns: new Map(),
  /** Current active target index (null = use primary) */
  activeIndex: null,
};

function targetLabel(target, config) {
  const pName = `P${target.providerIndex}`;
  return `${pName}/${target.model}`;
}

/**
 * Resolve the best target to use right now.
 * Priority: primary (index 0) → same provider next model → next provider → ...
 * After recovery, reset to primary.
 */
function resolveTarget(config) {
  const targets = buildTargets(config);
  if (targets.length === 0) return null;

  const now = Date.now();
  const recoveryMs = (config['limiter-recovery-seconds'] || 300) * 1000;

  // Expire old cooldowns
  for (const [key, expiry] of state.cooldowns) {
    if (expiry <= now) state.cooldowns.delete(key);
  }

  // Check if primary target (index 0) is available
  const primary = targets[0];
  const primaryCooled = (state.cooldowns.get(primary.key) || 0) > now;

  if (!primaryCooled) {
    if (state.activeIndex !== null && state.activeIndex !== 0) {
      log('recovery', `Primary recovered → ${targetLabel(primary, config)}`);
      log('info', `  Target: ${targetDetails(primary)}`);
    }
    state.activeIndex = null;
    return primary;
  }

  // Primary is cooled — find next available target in order
  for (let i = 1; i < targets.length; i++) {
    const t = targets[i];
    if ((state.cooldowns.get(t.key) || 0) <= now) {
      if (state.activeIndex !== i) {
        state.activeIndex = i;
        log('switch', `${targetLabel(primary, config)} → ${targetLabel(t, config)}`);
        log('info', `  New target: ${targetDetails(t)}`);
      }
      return t;
    }
  }

  // All targets cooled — find earliest recovery
  let earliest = Infinity;
  for (const t of targets) {
    const expiry = state.cooldowns.get(t.key) || 0;
    if (expiry > now && expiry < earliest) earliest = expiry;
  }
  const waitSec = Math.ceil((earliest - now) / 1000);
  log('warn', `All targets in cooldown. Earliest recovery in ${waitSec}s`);
  return primary; // fallback, let it fail naturally
}

function markTargetCooled(targetKey, config) {
  const recoverySec = config['limiter-recovery-seconds'] || 300;
  state.cooldowns.set(targetKey, Date.now() + recoverySec * 1000);
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
    const ts = now.toISOString().replace('T', ' ').substring(0, 19);
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
      notes: 'Must use "api": "anthropic-messages" for Coding Plan keys. Proxy handles model prefix stripping (e.g. bailian/qwen3.7-plus → qwen3.7-plus) and API key replacement.',
    },
    'generic': {
      name: 'Any OpenAI-compatible CLI',
      status: 'supported',
      icon: '🟢',
      env: {
        OPENAI_BASE_URL: proxyUrl + '/v1',
        OPENAI_API_KEY: 'dummy',
      },
      configFile: 'Tool-specific',
      notes: 'Any tool supporting custom OpenAI Base URL works. Set API key to any non-empty value.',
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
  } catch {
    log('error', 'Invalid JSON in request body');
    clientRes.writeHead(400, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Invalid JSON' } }));
    return;
  }

  // Resolve target (provider + model)
  const target = resolveTarget(config);
  if (!target) {
    log('error', 'No providers configured in config.json');
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

  const newBody = Buffer.from(JSON.stringify(parsed), 'utf-8');
  proxyToUpstream(clientReq, clientRes, newBody, originalModel, target, config, attempt);
}

function proxyToUpstream(clientReq, clientRes, body, originalModel, target, config, attempt) {
  // Properly join base-url path with request path
  // baseUrl may have a path (e.g. https://opencode.ai/zen/go)
  // clientReq.url starts with / (e.g. /v1/messages?beta=true)
  const base = target.baseUrl.replace(/\/+$/, '');          // strip trailing slash
  const reqPath = clientReq.url;                             // e.g. /v1/messages?beta=true
  const fullUrl = base + reqPath;
  const upstreamUrl = new URL(fullUrl);
  const isHttps = upstreamUrl.protocol === 'https:';
  const transport = isHttps ? https : http;

  // Build headers — forward all except host, inject provider's API key
  let headers = { ...clientReq.headers };
  delete headers.host;
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
          const next = resolveTarget(config);
          if (next && next.key !== target.key) {
            log('retry', `Retrying with ${targetLabel(next, config)}...`);
            log('info', `  Now: ${targetDetails(next)}`);
            retryWithTarget(clientReq, clientRes, body, originalModel, next, config, attempt);
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
      const next = resolveTarget(config);
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
      const next = resolveTarget(config);
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

  // Forward streaming headers to client
  clientRes.writeHead(upstreamRes.statusCode, upstreamRes.headers);

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
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log(`\n${C.yellow}Shutting down...${C.reset}`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});

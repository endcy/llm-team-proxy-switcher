# llm-team-proxy-switcher

[中文](README.md) | **English**

## 📌 Overview

**llm-team-proxy-switcher** is a lightweight LLM API proxy deployed on your team's internal network. It solves the frequent rate-limiting errors that AI coding tools (Claude Code, Codex, etc.) encounter when using third-party APIs.

Simply run this proxy on a team server, point all members' CLI tools to it, and you automatically get **multi-key rotation + multi-model switching + auto rate-limit recovery**.

> Just kill **"API Error: Request rejected (429) · usage allocated quota exceeded. please try again later."**

## 🔥 What Problems Does It Solve?

| Pain Point | Solution |
|-----------|----------|
| ❌ Single API Key hits 429 rate limit / 524 timeout / 529 overloaded frequently | ✅ Auto-rotate across multiple Keys, pool team quotas |
| ❌ Rate limit error interrupts workflow | ✅ Seamlessly switch to backup Key / Model |
| ❌ Each team member deploys their own proxy | ✅ One server deployment, shared by the whole team |
| ❌ Different members use different Providers / Models | ✅ Each Provider has independent base-url, key, and model list |
| ❌ Manual switching needed after rate limit recovery | ✅ Auto-recover to primary config after cooldown |
| ❌ Requires extra dependencies or complex setup | ✅ Zero dependencies — just `node proxy.js` |
| ❌ Service restart needed after config changes | ✅ config.json hot-reload — save and it takes effect |

 Don't want to use CC Switch, now you have better choice!
<div align="center">

### 🌟 If this project helps you, please Star ⭐ to support it! Your support is my motivation to keep updating! thx!

</div>

## ✨ Key Features

- **2D Rotation Matrix** — Provider × Model combinations auto-rotate; when one dimension exhausts, switch to the other
- **Team Quota Pooling** — N members' API Keys = N× available quota, maximizing Coding Plan value
- **Independent Cooldown Tracking** — Each (Provider, Model) pair tracked independently, no interference
- **Auto Recovery** — Automatically switches back to primary Provider + Model after cooldown expires
- **Transparent Proxy** — No client config changes needed, just one env var `*_BASE_URL`
- **Multi-CLI Compatible** — Supports Claude Code, Codex, Cursor, and any OpenAI / Anthropic-compatible client
- **Responses API Conversion** — Automatically converts Codex's Responses API to Chat Completions, compatible with all upstream providers
- **401 Smart Retry** — Auto-retries 5 times on API key failure (401), then switches to next key
- **Web UI Management** — Built-in dashboard (live status) + config editor (JSON edit + validate + save) + CLI setup guide
- **Auth Format Compatible** — Supports both `Authorization: Bearer` and `x-api-key`, auto-detected and replaced
- **Streaming Support** — Full SSE streaming support, no impact on typing experience
- **Zero Dependencies** — Pure Node.js built-in modules, no `npm install` needed

## 🎯 Why This Tool?

Most LLM proxy tools on the market are built for **token-based billing** scenarios. They're feature-rich but complex — requiring databases, Docker, admin dashboards, and significant setup effort.

**This tool is built specifically for Coding Plan subscribers.** If you and your team each have a Claude Code / Codex Coding Plan subscription with independent API keys and quotas, you don't need a bloated LLM gateway. You need a **simple, lightweight, quota-pooling proxy that switches on rate limits**.

That's exactly what this project does: **one JSON config + one JS file + one command** — and your whole team shares all members' Coding Plan quotas, with seamless auto-switching on 429 rate limit / 524 timeout / 529 overload / 401 auth failure.

> 💡 **One-line advantage:** Zero dependencies, single file, deploy in seconds. No token billing, no user management — just Plan quota pooling and rate-limit switching. Solving the most painful problem with the least code.

How it compares to similar tools:

| Aspect | General LLM Proxies | This Project |
|--------|-------------------|--------------|
| Focus | Token billing / general LLM gateway | **Coding Plan rate-limit switching** |
| Dependencies | Database + framework + Docker | **Zero deps — just `node proxy.js`** |
| Deploy time | Minutes, needs DB / admin setup | **Seconds — one JSON config** |
| Team mgmt | Users / roles / tokens / billing | **Not needed — team just uses it** |
| Learning curve | High (many concepts, thick docs) | **Minimal — 5 min to get started** |


## 🛠️ Supported Tools

| Tool | Status | Notes |
|------|--------|-------|
| **Claude Code** | ✅ Supported | Fully tested and verified |
| **Codex (OpenAI)** | ✅ Supported | Responses API auto-converted to Chat Completions, compatible with all providers |
| **Cursor** | 🔜 Planned | Same principle, pending verification |
| **OpenClaw** | ✅ Supported | Auto-strips provider prefix (e.g. bailian/qwen3.7-plus) |
| **WorkBuddy** | ✅ Supported | OpenAI format, auto-routes to openai-base-url |
| Other OpenAI / Anthropic-compatible CLI | ✅ Supported | Any client with custom API Base URL support |

---

## How It Works

### Architecture

![Architecture](.assets/workflow.png)

### What Does the Proxy Replace?

Claude Code sends requests to the proxy with dummy credentials. The proxy replaces three key fields before forwarding:

| Field | Claude Code Sends | Proxy Replaces With |
|-------|-------------------|---------------------|
| Request URL | `proxy:9982` | Provider's real `base-url` + path |
| Auth headers (`x-api-key`, `Authorization`) | dummy value | Provider's real API key |
| `body.model` | any model name | Provider's configured model |

The proxy also handles `GET /v1/models` requests that Claude Code sends during startup to validate model availability — it returns the list of all configured models.

### 2D Rotation Matrix

The rotation space is a 2D matrix: **Provider × Model**.

```
Config:
  P0: key-A, models: [qwen3.7-plus, qwen-turbo]
  P1: key-B, models: [qwen3.6-plus, glm5.2]
  P2: key-C, models: [qwen3.5-plus, deepseek-v4-pro]

Flattened target list (tried in order):
  [0] P0/qwen3.7-plus    ← default primary
  [1] P0/qwen-turbo
  [2] P1/qwen3.6-plus
  [3] P1/glm5.2
  [4] P2/qwen3.5-plus
  [5] P2/deepseek-v4-pro
```

**Rotation rules (dynamic queue algorithm):**
1. Initial queue follows config order: P0/m0 → P0/m1 → P1/m0 → P1/m1 → ...
2. Each request picks the first non-cooled target from the queue
3. On error (429/524/529) → target enters cooldown → **moved to queue tail**
4. Every `p0-reset-interval-seconds` (default 600s), all P0 targets are **reset to queue front**
5. Cooled targets remain eligible after cooldown; P0 stays highest priority via periodic reset

### Request Lifecycle

![Request Lifecycle](.assets/cycle.png)

---

## Full Flow with Claude Code

### Step 1: Start the Proxy

```bash
cd llm-team-proxy-switcher

# Foreground (recommended for debugging)
start.bat                    # Windows
./start.sh                   # Linux / macOS

# Background (Linux / macOS, recommended for servers)
nohup ./start.sh -d &        # Start in background, log to ./log/llm-proxy.log
./start.sh --stop            # Stop background proxy
./start.sh --restart         # Restart background proxy

# Or run directly
node proxy.js
```

> **Auto log rotation:** Log files are automatically archived with a timestamp when exceeding 200MB (e.g. `llm-proxy-20260618-193000.log`), and a fresh log file is started.

The proxy loads all Provider configs, builds the rotation matrix, and starts the Web UI.

### Step 2: Configure Claude Code

In Claude Code's `settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://192.168.23.145:9982",
    "ANTHROPIC_API_KEY": "dummy",
    "ANTHROPIC_MODEL": "qwen3.7-plus"
  }
}
```

- `ANTHROPIC_BASE_URL` → points to the proxy
- `ANTHROPIC_API_KEY` → must be non-empty (any value works, proxy replaces it)
- `ANTHROPIC_MODEL` → any model name (proxy replaces it)

### Step 3: Claude Code Validates

On startup, Claude Code sends `GET /v1/models` to validate the model. The proxy returns all configured models — validation passes.

### Step 4: User Sends a Message

Claude Code sends `POST /v1/messages` to the proxy. The proxy:
1. Selects the current target from the rotation matrix
2. Replaces model, API key, and base-url
3. Forwards to the real API
4. Returns the response (or retries on 429 / 524 / 529)

### Step 5: Cooldown Recovery

After `limiter-recovery-seconds`, cooled-down targets automatically recover. The primary target is restored.

---

## CLI Setup Guide

All CLI tools work the same way — point the API Base URL to the proxy, and it handles model switching and key rotation transparently.

### Claude Code (✅ Verified)

```jsonc
// ~/.claude/settings.json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://192.168.23.145:9982",
    "ANTHROPIC_API_KEY": "dummy",
    "ANTHROPIC_MODEL": "qwen3.7-plus"
  }
}
```

- `ANTHROPIC_API_KEY` must be non-empty (proxy replaces it)
- `ANTHROPIC_MODEL` should match a model in config.json

### Codex / OpenAI CLI (✅ Supported)

Codex CLI 0.130+ uses OpenAI Responses API (`/responses` endpoint). The proxy **automatically converts Responses API to Chat Completions API**, compatible with all upstream providers that only support Chat Completions.

**Configuration:**

```toml
# ~/.codex/config.toml
model_provider = "Proxy"
model = "qwen3.7-plus"

[model_providers.Proxy]
name = "Proxy"
base_url = "http://<your-proxy-ip>:9982"
env_key = "TMP"
wire_api = "responses"
```

**Configuration Notes:**
- `model_provider` / `name` — Custom name, keep them consistent
- `model` — Use any model name configured in config.json
- `base_url` — Proxy address (**do not add `/v1`**, replace with actual proxy IP and port)
- `env_key` — Environment variable name (any existing environment variable works, value doesn't matter)
- `wire_api` — Must be `"responses"` (default for Codex 0.130+)

**Proxy Auto-Handles:**
- ✅ Receives Codex's Responses API requests (`POST /responses`)
- ✅ Converts to Chat Completions format (`POST /v1/chat/completions`)
- ✅ Maps `developer` role to `system` (compatible with domestic providers)
- ✅ Converts responses back to Responses API format for Codex
- ✅ Full streaming SSE format conversion (includes `sequence_number`, complete event sequence)

### Cursor (🔜 Pending Verification)

1. Open Cursor Settings → Models
2. Find **Override OpenAI Base URL**
3. Set to: `http://192.168.23.145:9982/v1`
4. Set OpenAI API Key to any non-empty value

### OpenClaw (✅ Verified)

When using Coding Plan keys with OpenClaw, **Anthropic format is required**:

```json
{
  "models": {
    "providers": {
      "bailian": {
        "baseUrl": "http://<proxy-ip>:9982/v1",
        "apiKey": "dummy",
        "api": "anthropic-messages",
        "models": [
          { "id": "qwen3.7-plus", "name": "qwen3.7-plus" },
          { "id": "qwen3.6-plus", "name": "qwen3.6-plus" }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "model": { "primary": "qwen3.7-plus" },
      "models": {
        "qwen3.7-plus": {},
        "qwen3.6-plus": {}
      }
    }
  }
}
```

> **Note:** Coding Plan keys (`sk-sp-` prefix) only work with Anthropic format (`api: "anthropic-messages"`), not OpenAI format. The proxy automatically strips provider prefixes (e.g. `bailian/qwen3.7-plus` → `qwen3.7-plus`) and replaces the API key.

### Generic (Any OpenAI / Anthropic-Compatible Client)

**OpenAI-format clients:**
```
Base URL:  http://<proxy-ip>:9982/v1
API Key:   dummy (any non-empty value)
```

**Anthropic-format clients:**
```
Base URL:  http://<proxy-ip>:9982
API Key:   dummy (any non-empty value)
```

**Key points:**
- All clients share one proxy deployment — no need to install anywhere else
- Proxy auto-handles auth header format (`Authorization: Bearer` and `x-api-key` both supported)
- Proxy auto-handles model validation (`GET /v1/models` returns configured model list)
- Proxy auto-handles 429 rate limit / 524 timeout / 529 overloaded switching — fully transparent to clients

---

## Quick Start

### 1. Edit config.json

```json
{
  "limiter-recovery-seconds": 300,

  "providers": [
    {
      "base-url": "https://opencode.ai/zen/go",
      "api-key": "sk-member-A-key",
      "models": ["qwen3.7-plus", "qwen-turbo"]
    },
    {
      "base-url": "https://opencode.ai/zen/go",
      "api-key": "sk-member-B-key",
      "models": ["qwen3.6-plus", "glm5.2"]
    },
    {
      "base-url": "https://dashscope.aliyuncs.com/compatible-mode",
      "api-key": "sk-member-C-key",
      "models": ["qwen3.5-plus", "deepseek-v4-pro"]
    }
  ]
}
```

Each provider can have a **different base-url, api-key, and model list**.

Full config options:

| Field | Default | Description |
|-------|---------|-------------|
| `providers` | _(required)_ | Provider config array |
| `[].base-url` | — | Provider's API base URL |
| `[].api-key` | — | Provider's API key |
| `[].models` | — | Available models (priority order) |
| `[].openai-models` | _(optional)_ | OpenAI-format model list. If set, used for OpenAI requests; if missing, `models` is used for both formats; empty list `[]` means no OpenAI support for this provider |
| `limiter-recovery-seconds` | `300` | Cooldown recovery time (seconds) |
| `p0-reset-interval-seconds` | `600` | Interval to reset P0 targets to queue front (seconds) |
| `textOnlyModels` | `["deepseek-v4-pro","deepseek-v4-flash","deepseek-v3.2"]` | Text-only models. Proxy auto-strips multimodal content (images, documents, base64) before forwarding to these models |
| `port` | `9982` | Proxy listen port |
| `bind` | `0.0.0.0` | Listen address (all interfaces) |
| `maxRetries` | `20` | Max rotation attempts per request |
| `requestTimeoutMs` | `300000` | Upstream timeout (ms) |

### Dual-Format Routing

The proxy supports both **Anthropic** (`/v1/messages`) and **OpenAI** (`/v1/chat/completions`) API formats, with independent rotation queues for each:

| Client Request Path | Base URL Used | Model List Used |
|--------------------|---------------|----------------|
| `/v1/messages` (Anthropic) | `base-url` | `models` |
| `/v1/chat/completions` (OpenAI) | `openai-base-url` (if set) | `openai-models` (if set) |

- No `openai-base-url` → OpenAI requests also use `base-url`
- No `openai-models` → `models` is used for both formats
- `openai-models: []` → this provider does not support OpenAI format, skipped automatically

Path normalization: `/v1` prefix is auto-added if missing; if `openai-base-url` already ends with `/v1`, it's not duplicated.

### 2. Set Environment Variable

Each team member sets `ANTHROPIC_BASE_URL` in their Claude Code:

```bash
# Windows (PowerShell)
$env:ANTHROPIC_BASE_URL = "http://192.168.23.145:9982"

# Linux / macOS
export ANTHROPIC_BASE_URL=http://192.168.23.145:9982
```

Or permanently in Claude Code's `settings.json`:

```jsonc
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://192.168.23.145:9982",
    "ANTHROPIC_API_KEY": "dummy"
  }
}
```

### 3. Start the Proxy

**Option 1: One-click script (Recommended)**

```bash
# Windows
start.bat

# Linux / macOS
./start.sh
```

The script auto-checks Node.js, validates config, and starts the proxy.

**Option 2: Direct run**

```bash
node proxy.js
```

Output:

```
╔════════════════════════════════════════════════════════╗
║   llm-team-proxy-switcher v1.0.0                       ║
║   Team LLM proxy with auto provider/model switching     ║
╚════════════════════════════════════════════════════════╝

  Proxy:      http://192.168.23.145:9982
  Providers:  3
  Targets:    6
  Recovery:   300s

  P0: sk-member-A...  https://opencode.ai/zen/go
      models: qwen3.7-plus, qwen-turbo
  P1: sk-member-B...  https://opencode.ai/zen/go
      models: qwen3.6-plus, glm5.2
  P2: sk-member-C...  https://dashscope.aliyuncs.com/compatible-mode
      models: qwen3.5-plus, deepseek-v4-pro

  Web UI:       http://192.168.23.145:9982/
  Config UI:    http://192.168.23.145:9982/config.html
```

### 4. Verify

```bash
curl http://127.0.0.1:9982/
```

---

## Team Deployment

Deploy the proxy on a single internal server for the whole team:

```
Internal Server (192.168.23.145)
├── proxy.js      ← bind: 0.0.0.0 (accessible from LAN)
├── config.json   ← shared Provider configs (all members' keys)
└── public/       ← Web UI

Member A: Claude Code → ANTHROPIC_BASE_URL=http://192.168.23.145:9982
Member B: Claude Code → ANTHROPIC_BASE_URL=http://192.168.23.145:9982
Member C: Claude Code → ANTHROPIC_BASE_URL=http://192.168.23.145:9982
```

**Quota Pooling:**
```
Member A: sk-aaa → RPM:600, TPM:5M  (independent quota)
Member B: sk-bbb → RPM:600, TPM:5M  (independent quota)
Member C: sk-ccc → RPM:600, TPM:5M  (independent quota)

Team total = 3× single-key quota
```

---

## Runtime Behavior

### Normal Request
```
14:41:47 → POST /v1/messages model=qwen3.7-plus [P0]
14:41:48 ← 200 P0/qwen3.7-plus (2048B)
```

### Rate Limit Triggers Switch
```
14:42:00 → POST /v1/messages model=qwen3.7-plus [P0]
14:42:01 ⬤ P0/qwen3.7-plus → cooldown 300s
14:42:01 ⇄ Switched to P0/qwen-turbo
14:42:02 ⬤ P0/qwen-turbo → cooldown 300s
14:42:02 ⇄ Switched to P1/qwen3.6-plus
14:42:03 ← 200 P1/qwen3.6-plus (1024B)
```

### Auto Recovery
```
14:47:01 ↻ Primary recovered → P0/qwen3.7-plus
```

---

## Security

- Proxy defaults to `0.0.0.0` (LAN accessible). Change to `127.0.0.1` for local-only use
- No request logging, no request body storage
- API keys are injected at forwarding time only, never persisted
- Startup banner and Web UI show only first 10 chars of keys
- Web UI config page can view full keys — **use on internal network only, never expose to public internet**

---

## Troubleshooting

### Proxy Won't Start
```
✗ No providers configured in config.json
```
Add at least one provider to `config.json`.

### Connection Refused
Make sure the proxy is running (`node proxy.js`) and `ANTHROPIC_BASE_URL` is set correctly.

### "Not logged in" Error in Claude Code
Set `ANTHROPIC_API_KEY` to any non-empty value (e.g., `"dummy"`). The proxy replaces it with the real key.

### "Model not found" Error in Claude Code
The proxy handles `GET /v1/models` to pass model validation. Make sure the proxy is running before starting Claude Code.

### Hot Reload
Changes to `config.json` take effect immediately — no restart needed.

---


## Changelog

### 2026-07-08

- **Added Codex CLI Support**:
  - Supports Codex 0.130+ Responses API (`/responses` endpoint)
  - Automatically converts Responses API requests to Chat Completions format, compatible with all upstream providers
  - Automatically maps `developer` role to `system` (compatible with domestic providers)
  - Full streaming SSE format conversion (includes `sequence_number`, complete event sequence)
  - Supports non-streaming and streaming responses, tool call (function_call) conversion
- **Added 401 Unauthorized Smart Retry**:
  - Automatically retries current key up to 5 times on API key failure (401)
  - After 5 failures, automatically switches to next key
  - Resets 401 count on successful request
  - Unlike 429/524/529 which switch immediately, 401 has a retry buffer to avoid false switches due to temporary failures

### 2026-06-23

- **New dynamic queue rotation algorithm**:
  - Failed targets move to queue tail, all targets get rotated
  - P0 targets reset to queue front every `p0-reset-interval-seconds` (default 600s), maintaining highest priority
  - Brief cooldown preserved after errors to avoid immediate retries
- Added automatic switching for HTTP 524 and 529:
  - `429`: quota / request rate exceeded
  - `524`: upstream response timeout
  - `529`: upstream overloaded or busy
- These status codes put the current target into cooldown and automatically switch to the next Provider / Model.

## License

[Apache License 2.0](LICENSE)

---

<div align="center">

**Author:** [endcy](https://github.com/endcy)  
**GitHub:** [https://github.com/endcy/llm-team-proxy-switcher](https://github.com/endcy/llm-team-proxy-switcher)

If this project helps you, feel free to Star ⭐!

</div>

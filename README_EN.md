# llm-team-proxy-switcher

[中文](README.md) | **English**

## 📌 What Is This?

**llm-team-proxy-switcher** is a lightweight LLM API proxy deployed on your team's internal network. It solves the frequent rate-limiting errors that AI coding tools (Claude Code, Codex, etc.) encounter when using third-party APIs.

Simply run this proxy on a team server, point all members' CLI tools to it, and you automatically get **multi-key rotation + multi-model switching + auto rate-limit recovery**.

> Just kill **"API Error: Request rejected (429) · usage allocated quota exceeded. please try again later."**

## 🔥 What Problems Does It Solve?

| Pain Point | Solution |
|-----------|----------|
| ❌ Single API Key hits 429 rate limit frequently | ✅ Auto-rotate across multiple Keys, pool team quotas |
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
- **Web UI Management** — Built-in dashboard (live status) + config editor (JSON edit + validate + save) + CLI setup guide
- **Auth Format Compatible** — Supports both `Authorization: Bearer` and `x-api-key`, auto-detected and replaced
- **Streaming Support** — Full SSE streaming support, no impact on typing experience
- **Zero Dependencies** — Pure Node.js built-in modules, no `npm install` needed

## 🎯 Why This Tool?

Most LLM proxy tools on the market are built for **token-based billing** scenarios. They're feature-rich but complex — requiring databases, Docker, admin dashboards, and significant setup effort.

**This tool is built specifically for Coding Plan subscribers.** If you and your team each have a Claude Code / Codex Coding Plan subscription with independent API keys and quotas, you don't need a bloated LLM gateway. You need a **simple, lightweight, quota-pooling proxy that switches on rate limits**.

That's exactly what this project does: **one JSON config + one JS file + one command** — and your whole team shares all members' Coding Plan quotas, with seamless auto-switching on 429 rate limits.

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
| **Codex (OpenAI)** | ✅ Supported | OpenAI-compatible format |
| **Cursor** | 🔜 Planned | Same principle, pending verification |
| **OpenClaw** | 🔜 Planned | Same principle, pending verification |
| Other OpenAI / Anthropic-compatible CLI | ✅ Supported | Any client with custom API Base URL support |

---

## How It Works

### Architecture

```
Claude Code (currently supported)
       │
       │  Only knows: ANTHROPIC_BASE_URL=http://proxy:9982
       │  Sends: model=anything, api-key=anything
       │
       ▼
┌──────────────────────────────────┐
│  llm-team-proxy-switcher (:9982) │
│                                  │
│  1. Receive request (ignore      │
│     client's model/key)          │
│  2. Pick current target from     │
│     config.json                  │
│  3. Replace model in body        │
│  4. Replace API key in headers   │
│  5. Forward to target Provider   │
│  6. Got 429 → switch to next     │
│  7. Success → return to client   │
│                                  │
│  Auto-recover after cooldown     │
└──────────┬───────────────────────┘
           │
           ▼
    Real Provider APIs (each can have different base-url)
```

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

**Rules:**
1. Requests start with target [0] (P0's first model)
2. 429 → target [0] enters cooldown, switch to [1]
3. [1] also 429 → switch to [2] (new Provider + Key)
4. Continue until a working combination is found
5. After cooldown → target [0] recovers → auto-switch back

### Request Lifecycle

```
Client request arrives
    │
    ▼
Parse request body JSON
    │
    ▼
resolveTarget() → which target is available?
    │   ├─ Primary not cooled → use primary
    │   └─ Primary cooled → find next in order
    ▼
Replace model + api-key + base-url
    │
    ▼
Forward to upstream API
    │
    ├─ 200 success → return to client ✓
    │
    ├─ 429 rate limit → mark target cooled
    │                   resolveTarget() for next
    │                   retry (up to maxRetries)
    │
    ├─ Connection error → mark cooled, retry next
    │
    └─ Timeout → return 504 to client
```

---

## Full Flow with Claude Code

### Step 1: Start the Proxy

```bash
cd llm-team-proxy-switcher

# One-click start (recommended)
start.bat        # Windows
./start.sh       # Linux / macOS

# Or run directly
node proxy.js
```

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
4. Returns the response (or retries on 429)

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

Codex uses the OpenAI-compatible format:

```bash
# Environment variables
export OPENAI_BASE_URL=http://192.168.23.145:9982/v1
export OPENAI_API_KEY=dummy
```

Or in config file:

```toml
# ~/.codex/config.toml
[api]
base_url = "http://192.168.23.145:9982/v1"
api_key = "dummy"
```

- Note: URL must end with `/v1` (OpenAI format standard)
- `OPENAI_API_KEY` must be non-empty (proxy replaces it)

### Cursor (🔜 Pending Verification)

1. Open Cursor Settings → Models
2. Find **Override OpenAI Base URL**
3. Set to: `http://192.168.23.145:9982/v1`
4. Set OpenAI API Key to any non-empty value

### OpenClaw (🔜 Pending Verification)

```bash
export OPENAI_BASE_URL=http://192.168.23.145:9982/v1
export OPENAI_API_KEY=dummy
```

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
- Proxy auto-handles 429 rate limit switching — fully transparent to clients

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
| `limiter-recovery-seconds` | `300` | Cooldown recovery time (seconds) |
| `port` | `9982` | Proxy listen port |
| `bind` | `0.0.0.0` | Listen address (all interfaces) |
| `maxRetries` | `20` | Max rotation attempts per request |
| `requestTimeoutMs` | `300000` | Upstream timeout (ms) |

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

## License

[Apache License 2.0](LICENSE)

---

<div align="center">

**Author:** [endcy](https://github.com/endcy)  
**GitHub:** [https://github.com/endcy/llm-team-proxy-switcher](https://github.com/endcy/llm-team-proxy-switcher)

If this project helps you, feel free to Star ⭐!

</div>

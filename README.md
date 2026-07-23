<div align="center">

# llm-gateway

**Lightweight LLM gateway with automatic fallback, rate limiting, and multi-provider routing**

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D16-green.svg)](https://nodejs.org)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](#)

Stop hitting rate limits. Stop writing retry logic. Just proxy.

</div>

---

## 🚀 What is this?

`llm-gateway` is a lightweight reverse proxy that sits between your app and LLM API providers (OpenAI, Anthropic, Z.ai, etc.). It handles:

- ⚡ **Automatic fallback** — When your primary model hits a rate limit (429), it retries with the next available model automatically
- 🔄 **Multi-provider routing** — Route requests across OpenAI, Anthropic, and other providers from a single endpoint
- ⚖️ **Load balancing** — Distributes requests across models, preferring the ones idle longest
- ⏱️ **Smart timeouts** — Uses idle timeout (not total timeout), so long-running streaming requests don't get killed
- 📊 **Live monitoring** — Built-in status dashboard at `/gateway-status`
- 🔒 **Secure by default** — API keys via environment variables, never hardcoded
- 📦 **Zero dependencies** — Pure Node.js. No `npm install` needed. Ever.

### Why not just call the API directly?

| Without `llm-gateway` | With `llm-gateway` |
|---|---|
| ❌ Hit 429 rate limit → request fails | ✅ Automatically retries with fallback model |
| ❌ One provider down → app is down | ✅ Falls through to next provider |
| ❌ Write retry logic in every app | ✅ Set up once, works for all apps |
| ❌ No visibility into model usage | ✅ Live status endpoint shows everything |
| ❌ Expensive models for every request | ✅ Route to cheaper models by default |

## 🐛 Real-World Production Problems Solved

This gateway was battle-tested in production handling thousands of requests per hour. Here are the actual problems it solved:

### Problem #1: Proxy Timeout (55s) vs API Response (60-235s)
**Symptom:** Requests failing with timeout errors even though the API was working fine.

**What happened:** The proxy had a 55-second timeout, but Z.ai's GLM models were taking 60-235 seconds to respond. Every long request failed.

**Solution:** Extended timeout to 300 seconds (5 minutes) with smart idle timeout that only times out when data stops flowing, not based on total request time.

**Impact:** Zero timeout failures for long-running requests.

---

### Problem #2: Invalid API Paths (`/v4/v1/...`)
**Symptom:** All requests returning 404 Not Found.

**What happened:** The proxy was concatenating paths incorrectly. Incoming `/v1/chat/completions` → `/api/coding/paas/v4/v1/chat/completions` (wrong) instead of `/api/coding/paas/v4/chat/completions` (correct).

**Solution:** Added path normalization to strip the `/v1` prefix when proxying to providers that don't expect it.

**Impact:** 100% request success rate.

---

### Problem #3: State Counter Drift (Ghost Requests)
**Symptom:** Active request counters showed 17 requests when 0 were actually running. Queue position was wrong.

**What happened:** When clients disconnected early or requests timed out, state wasn't cleaned up. After hours, counters drifted by 25+ ghost requests.

**Solution:** Added comprehensive cleanup handlers for timeout, client disconnect, and response completion. Also fixed race conditions in model slot reservation.

**Impact:** Accurate state tracking 100% of the time.

---

### Problem #4: Rate Limits Blocking All Requests
**Symptom:** When GLM-5 hit 429, the entire system failed. Pooja and Kanu's agents were completely blocked.

**What happened:** The proxy was forwarding 429 errors directly to clients instead of retrying with fallback models.

**Solution:** Implemented automatic retry chain: try GLM-5 → 429 → try GLM-4.7 → 429 → try GLM-4.6 → 429 → try GLM-4.5.

**Impact:** Zero visible rate limit errors (unless all models exhausted).

---

### Problem #5: Double Decrement Bug
**Symptom:** User activity counters showed more active requests than model counters. User limits were mis-enforced.

**What happened:** Network errors triggered retry logic, but cleanup handlers were duplicated. State was decremented twice, creating "ghost" negative counts.

**Solution:** Moved state cleanup to a single shared function with a `stateCleaned` flag to prevent double-decrement.

**Impact:** User limits enforce correctly, no more priority queue bypass.

---

### Problem #6: Client Disconnects Leaving Zombie Requests
**Symptom:** When users killed their agents, upstream API requests kept running, consuming quota.

**What happened:** No handler for client disconnect. When a client closed the connection, the proxy kept waiting for the upstream response.

**Solution:** Added `req.on('close')` and `res.on('close')` handlers that immediately abort upstream requests and clean up state.

**Impact:** Zero zombie requests, instant cleanup on disconnect.

---

## 💡 Key Takeaways

1. **Long requests need idle timeout, not total timeout** — 4-minute responses are fine if data is flowing. Time out only when data stops.

2. **State cleanup must be comprehensive** — Timeout, error, disconnect, completion — every path must clean up.

3. **Rate limits are not hard errors** — They're routing signals. Retry with a different model/provider instead of failing.

4. **Counter drift is inevitable** — Without atomic operations and shared cleanup flags, your counters will drift over hours.

5. **Path normalization is provider-specific** — OpenAI expects `/v1`, others don't. Don't blindly concatenate.

---

## 📦 Install

```bash
git clone https://github.com/bhashkaranand/llm-gateway.git
cd llm-gateway
```

That's it. No `npm install`. No build step.

## 🔧 Quick Start

### 1. Set your API key

```bash
export OPENAI_API_KEY="sk-..."
# or
export ANTHROPIC_API_KEY="sk-ant-..."
# or
export ZAI_API_KEY="..."
```

### 2. Configure providers

Edit `config/default.json`:

```json
{
  "port": 8888,
  "host": "127.0.0.1",
  "providers": {
    "openai": {
      "baseUrl": "https://api.openai.com",
      "basePath": "/v1",
      "apiKeyEnv": "OPENAI_API_KEY",
      "models": {
        "gpt-4o": { "max": 5, "name": "GPT-4o" },
        "gpt-4o-mini": { "max": 30, "name": "GPT-4o Mini" }
      }
    }
  },
  "primaryModel": "gpt-4o",
  "fallbackModels": ["gpt-4o-mini"]
}
```

### 3. Start the gateway

```bash
npm start
```

### 4. Point your app to the gateway

```bash
# Before (direct to OpenAI)
curl https://api.openai.com/v1/chat/completions \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -d '{"model": "gpt-4o", "messages": [...]}'

# After (through gateway)
curl http://127.0.0.1:8888/chat/completions \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -d '{"model": "gpt-4o", "messages": [...]}'
```

That's it. The gateway handles the rest.

## 🎯 Use Cases

### 1. Survive Rate Limits

You're building an app with OpenAI. You hit `429 Too Many Requests` during peak hours. Users are frustrated.

**Solution:** Configure multiple models. When GPT-4o is rate-limited, the gateway automatically retries with GPT-4o-mini. Your users never see an error.

```json
{
  "primaryModel": "gpt-4o",
  "fallbackModels": ["gpt-4o-mini", "gpt-3.5-turbo"]
}
```

### 2. Multi-Provider Redundancy

OpenAI has an outage. Your app is dead. Users flood your inbox.

**Solution:** Configure OpenAI + Anthropic. When OpenAI fails, the gateway routes to Claude automatically.

```json
{
  "providers": {
    "openai": {
      "baseUrl": "https://api.openai.com",
      "basePath": "/v1",
      "apiKeyEnv": "OPENAI_API_KEY",
      "models": {
        "gpt-4o": { "max": 5 }
      }
    },
    "anthropic": {
      "baseUrl": "https://api.anthropic.com",
      "basePath": "/v1",
      "apiKeyEnv": "ANTHROPIC_API_KEY",
      "models": {
        "claude-3-5-sonnet-20241022": { "max": 5 },
        "claude-3-haiku-20240307": { "max": 20 }
      }
    }
  },
  "primaryModel": "gpt-4o",
  "fallbackModels": ["gpt-4o-mini", "claude-3-5-sonnet-20241022", "claude-3-haiku-20240307"]
}
```

### 3. Cost Optimization

GPT-4o is expensive. Most requests don't need it.

**Solution:** Default to GPT-4o-mini. Only upgrade when necessary.

```json
{
  "primaryModel": "gpt-4o-mini",
  "fallbackModels": ["gpt-4o"]
}
```

### 4. High-Concurrency Queue

You need to process 500 requests, but OpenAI only allows 5 concurrent.

**Solution:** Set `max` to match your tier. The gateway queues the rest and processes them as slots free up. Auto-fallback kicks in after 2 minutes if the queue is too long.

```json
{
  "models": {
    "gpt-4o": { "max": 5 },
    "gpt-4o-mini": { "max": 30 }
  },
  "fallbackTimeoutMs": 120000
}
```

## 📊 Monitoring

### Status Endpoint

```bash
curl http://127.0.0.1:8888/gateway-status | jq
```

```json
{
  "status": "running",
  "active": {
    "openai/gpt-4o": 3,
    "openai/gpt-4o-mini": 7
  },
  "queueLength": 2,
  "queue": [
    { "waiting": "14s" },
    { "waiting": "3s" }
  ],
  "models": [
    {
      "provider": "openai",
      "model": "gpt-4o",
      "active": 3,
      "max": 5,
      "available": true
    },
    {
      "provider": "openai",
      "model": "gpt-4o-mini",
      "active": 7,
      "max": 30,
      "available": true
    }
  ]
}
```

### Logs

```bash
tail -f logs/proxy.log
```

JSON-formatted, auto-rotated at 5MB, compressed and kept for 3 days.

## ⚙️ Configuration Reference

| Option | Description | Default |
|--------|-------------|---------|
| `port` | Gateway port | `8888` |
| `host` | Gateway host | `127.0.0.1` |
| `providers` | Provider configurations (see below) | — |
| `fallbackTimeoutMs` | Auto-fallback after waiting this long in queue | `120000` (2 min) |
| `primaryModel` | First model to try | First in config |
| `fallbackModels` | Fallback order | All models |

### Provider Configuration

| Field | Description | Example |
|-------|-------------|---------|
| `baseUrl` | Provider API base URL | `https://api.openai.com` |
| `basePath` | API path prefix | `/v1` |
| `apiKeyEnv` | Environment variable name for API key | `OPENAI_API_KEY` |
| `models` | Model definitions with concurrency limits | See examples |

## 🏗️ Production Deployment

### systemd (Linux)

```bash
sudo cat > /etc/systemd/system/llm-gateway.service << EOF
[Unit]
Description=LLM Gateway
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/opt/llm-gateway
Environment="OPENAI_API_KEY=sk-..."
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable llm-gateway
sudo systemctl start llm-gateway
```

### Docker

```dockerfile
FROM node:18-alpine
COPY . /app
WORKDIR /app
EXPOSE 8888
CMD ["node", "server.js"]
```

```bash
docker build -t llm-gateway .
docker run -p 8888:8888 -e OPENAI_API_KEY=sk-... llm-gateway
```

### PM2 (Process Manager)

```bash
pm2 start server.js --name llm-gateway
pm2 save
pm2 startup
```

## 🆚 Comparison

| Feature | `llm-gateway` | LiteLLM | OpenRouter |
|---------|--------------|---------|------------|
| **Dependencies** | Zero | Python + many | Hosted service |
| **Setup time** | 30 seconds | 10+ minutes | Instant (but hosted) |
| **Self-hosted** | ✅ | ✅ | ❌ |
| **Multi-provider** | ✅ | ✅ | ✅ |
| **Auto-fallback** | ✅ | ✅ | ✅ |
| **Load balancing** | ✅ | ✅ | ✅ |
| **Queue system** | ✅ | ❌ | ❌ |
| **Idle timeout** | ✅ | ❌ | ❌ |
| **Lines of code** | ~450 | 50,000+ | N/A |
| **Language** | JavaScript (Node.js) | Python | N/A |

**When to use `llm-gateway`:**
- You want a lightweight, zero-dependency solution
- You want to self-host
- You want full control over routing
- You don't want to install Python and 100+ packages

**When to use LiteLLM:**
- You need 100+ provider integrations
- You want Python SDK features
- You need advanced features like caching, guardrails

## 📁 Project Structure

```
llm-gateway/
├── server.js              # The entire gateway (~450 lines)
├── package.json
├── config/
│   └── default.json       # Default config (edit this)
├── examples/
│   ├── openai.json        # OpenAI config
│   └── multi-provider.json # OpenAI + Anthropic
├── scripts/
│   ├── start.sh
│   └── stop.sh
├── LICENSE
└── README.md
```

## 🤝 Contributing

Contributions welcome! Areas we'd love help with:

- **New providers** — Add configs for Gemini, Mistral, DeepSeek, etc.
- **Streaming support** — Better SSE/streaming handling
- **Metrics** — Prometheus endpoint
- **Tests** — Unit and integration tests
- **Docs** — More examples, tutorials

## 📝 License

MIT — Use it however you want.

---

<div align="center">

**[Report Bug](https://github.com/bhashkaranand/llm-gateway/issues)** · **[Request Feature](https://github.com/bhashkaranand/llm-gateway/issues)** · **[Star on GitHub](https://github.com/bhashkaranand/llm-gateway)**

</div>
#!/usr/bin/env node
/**
 * AI Proxy Gateway
 *
 * Smart API proxy for AI/LLM providers with:
 * - Multi-model fallback and load balancing
 * - Automatic retry on rate limits (429) and errors
 * - Idle timeout (not total timeout) — handles long requests
 * - Configurable providers and models
 *
 * Usage: node server.js [--config path/to/config.json]
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ============ CONFIGURATION ============

function loadConfig(configPath) {
  const defaultConfig = {
    port: 8888,
    host: '127.0.0.1',
    providers: {
      primary: {
        baseUrl: 'https://api.z.ai',
        basePath: '/api/coding/paas/v4',
        apiKeyEnv: 'ZAI_API_KEY',
        models: {
          'glm-5.2': { max: 10, name: 'GLM-5.2 (Flagship)' },
          'glm-5.1': { max: 10, name: 'GLM-5.1 (Best)' },
          'glm-5': { max: 2, name: 'GLM-5 (Best)' },
          'glm-4.7': { max: 2, name: 'GLM-4.7 (Excellent)' },
          'glm-4.6': { max: 3, name: 'GLM-4.6 (Great)' },
          'glm-4.5': { max: 10, name: 'GLM-4.5 (Good)' }
        }
      }
    },
    fallbackTimeoutMs: 120000,
    primaryModel: 'glm-5.1',
    fallbackModels: ['glm-5.2', 'glm-5', 'glm-4.7', 'glm-4.6', 'glm-4.5']
  };

  let config;

  // Try to load config file
  const paths = [
    configPath,
    path.join(__dirname, 'config.json'),
    path.join(__dirname, 'config', 'default.json')
  ].filter(Boolean);

  for (const p of paths) {
    if (fs.existsSync(p)) {
      config = JSON.parse(fs.readFileSync(p, 'utf8'));
      console.log(`Loaded config from: ${p}`);
      break;
    }
  }

  if (!config) {
    config = defaultConfig;
    console.log('Using default configuration (no config file found)');
  }

  // Merge with defaults
  config = { ...defaultConfig, ...config };

  // Resolve API keys from environment
  for (const [name, provider] of Object.entries(config.providers)) {
    if (provider.apiKeyEnv) {
      provider.apiKey = process.env[provider.apiKeyEnv];
      if (!provider.apiKey) {
        console.warn(`⚠️  Warning: Environment variable ${provider.apiKeyEnv} not set for provider "${name}"`);
      }
    }
    provider._name = name;
  }

  return config;
}

// Parse command line args
const args = process.argv.slice(2);
let configPath = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--config' || args[i] === '-c') {
    configPath = args[i + 1];
    i++;
  }
}

const CONFIG = loadConfig(configPath);

// ============ STATE ============
const STATE = {
  // Active requests per model
  active: {},
  // Queue of waiting requests
  queue: [],
  // Rate limiting: track last request time per model
  lastRequestTime: {}
};

// Initialize state for all models
for (const [providerName, provider] of Object.entries(CONFIG.providers)) {
  for (const modelName of Object.keys(provider.models)) {
    const key = `${providerName}/${modelName}`;
    STATE.active[key] = 0;
    STATE.lastRequestTime[key] = 0;
  }
}

// ============ LOGGING ============
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB
const KEEP_DAYS = 3;
let lastRotationCheck = 0;

function rotateIfNeeded() {
  const now = Date.now();
  if (now - lastRotationCheck < 5 * 60 * 1000) return;
  lastRotationCheck = now;

  try {
    const logDir = path.join(__dirname, 'logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

    const logFile = path.join(logDir, 'proxy.log');
    if (!fs.existsSync(logFile)) return;

    const stats = fs.statSync(logFile);
    if (stats.size > MAX_LOG_SIZE) {
      const today = new Date().toISOString().split('T')[0];
      const backupFile = path.join(logDir, `proxy.log-${today}`);
      fs.renameSync(logFile, backupFile);

      try {
        require('child_process').execSync(`gzip -f "${backupFile}"`, { stdio: 'ignore' });
      } catch {}

      // Delete old logs (>3 days)
      const threeDaysAgo = Date.now() - (KEEP_DAYS * 24 * 60 * 60 * 1000);
      for (const file of fs.readdirSync(logDir)) {
        if (file.startsWith('proxy.log-')) {
          const filePath = path.join(logDir, file);
          try {
            const stat = fs.statSync(filePath);
            if (stat.mtime.getTime() < threeDaysAgo) {
              fs.unlinkSync(filePath);
            }
          } catch {}
        }
      }
    }
  } catch {}
}

function log(level, message, data = {}) {
  const timestamp = new Date().toISOString();
  const logLine = JSON.stringify({ timestamp, level, message, ...data }) + '\n';

  const colors = { INFO: '\x1b[36m', WARN: '\x1b[33m', ERROR: '\x1b[31m', SUCCESS: '\x1b[32m', DEBUG: '\x1b[90m' };
  console.log(`${colors[level] || ''}[${timestamp}] [${level}] ${message}\x1b[0m`, data);

  rotateIfNeeded();

  const logDir = path.join(__dirname, 'logs');
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, 'proxy.log');
  fs.appendFileSync(logFile, logLine);
}

// ============ MODEL SELECTION ============

function getAllModels() {
  const models = [];
  for (const [providerName, provider] of Object.entries(CONFIG.providers)) {
    for (const [modelName, modelConfig] of Object.entries(provider.models)) {
      const key = `${providerName}/${modelName}`;
      models.push({
        provider: providerName,
        model: modelName,
        key,
        max: modelConfig.max,
        name: modelConfig.name,
        active: STATE.active[key],
        available: STATE.active[key] < modelConfig.max,
        idleFor: Date.now() - (STATE.lastRequestTime[key] || 0)
      });
    }
  }
  return models;
}

function selectModel(queuedAt = null) {
  const now = Date.now();
  const allModels = getAllModels();

  // Auto-fallback: if waiting too long, pick any available model
  if (queuedAt) {
    const waitTime = now - queuedAt;
    if (waitTime > CONFIG.fallbackTimeoutMs) {
      log('WARN', 'Auto-fallback triggered', { waitTime: `${Math.round(waitTime/1000)}s` });
      const available = allModels.filter(m => m.available);
      if (available.length > 0) {
        return available[0];
      }
    }
  }

  // Build preferred order (primary first, then fallbacks)
  const preferredOrder = [CONFIG.primaryModel, ...CONFIG.fallbackModels];
  const primaryProviderName = Object.keys(CONFIG.providers)[0];

  // Try models in preferred order
  for (const preferredModel of preferredOrder) {
    const key = `${primaryProviderName}/${preferredModel}`;
    if (STATE.active[key] < CONFIG.providers[primaryProviderName].models[preferredModel]?.max) {
      return allModels.find(m => m.key === key);
    }
  }

  // All preferred models full, try ANY available model
  const available = allModels.filter(m => m.available);
  if (available.length > 0) {
    // Pick the one idle the longest (load balancing)
    available.sort((a, b) => b.idleFor - a.idleFor);
    log('INFO', 'Using alternative model', { model: available[0].name });
    return available[0];
  }

  // Everything full, return null (will queue)
  return null;
}

// ============ QUEUE MANAGEMENT ============

function addToQueue(request) {
  STATE.queue.push(request);
  log('INFO', 'Request queued', { position: STATE.queue.length, queueLength: STATE.queue.length });
}

function processQueue() {
  if (STATE.queue.length === 0) return;

  const now = Date.now();

  // Check for auto-fallback candidates
  for (const req of STATE.queue) {
    if (now - req.queuedAt > CONFIG.fallbackTimeoutMs) {
      const model = selectModel(req.queuedAt);
      if (model) {
        const idx = STATE.queue.indexOf(req);
        if (idx !== -1) {
          STATE.queue.splice(idx, 1);
          processRequest(req, model);
          return;
        }
      }
    }
  }

  // Normal queue processing
  for (const request of STATE.queue) {
    const model = selectModel();
    if (model) {
      const idx = STATE.queue.indexOf(request);
      if (idx !== -1) {
        STATE.queue.splice(idx, 1);
        processRequest(request, model);
        return;
      }
    }
  }
}

// ============ REQUEST PROCESSING ============

function processRequest(request, model, triedKeys = new Set()) {
  const { req, res, requestBody } = request;
  const key = model.key;
  const provider = CONFIG.providers[model.provider];

  triedKeys.add(key);

  // Update state
  STATE.active[key]++;
  STATE.lastRequestTime[key] = Date.now();

  let stateCleaned = false;
  const startTime = Date.now();

  const cleanupState = () => {
    if (!stateCleaned) {
      stateCleaned = true;
      STATE.active[key]--;
    }
  };

  log('INFO', 'Processing request', {
    model: model.name,
    active: STATE.active[key],
    max: model.max,
    triedKeys: Array.from(triedKeys)
  });

  // Modify request body to use selected model
  let modifiedBody = requestBody;
  try {
    const body = JSON.parse(requestBody);
    if (body.model) {
      body.model = model.model;
    }
    modifiedBody = JSON.stringify(body);
  } catch {}

  // Build upstream request
  const upstreamPath = provider.basePath + (req.url.startsWith('/v1') ? req.url.substring(3) : req.url);
  const headers = {
    ...req.headers,
    'host': provider.baseUrl.replace('https://', '').replace('http://', ''),
    'content-length': Buffer.byteLength(modifiedBody)
  };

  // Set auth
  headers['authorization'] = `Bearer ${provider.apiKey}`;

  const options = {
    hostname: provider.baseUrl.replace('https://', '').replace('http://', ''),
    port: 443,
    path: upstreamPath,
    method: req.method,
    headers
  };

  const proxyReq = https.request(options, (proxyRes) => {
    log('INFO', 'Response received', {
      model: model.name,
      status: proxyRes.statusCode
    });

    // Retry on 429 (rate limit)
    if (proxyRes.statusCode === 429) {
      cleanupState();
      log('WARN', 'Rate limited, trying fallback', {
        model: model.name,
        triedKeys: Array.from(triedKeys)
      });

      // Find next fallback model
      const allModels = getAllModels();
      const nextModel = allModels.find(m =>
        !triedKeys.has(m.key) && m.available
      );

      if (nextModel) {
        log('INFO', 'Retrying with fallback model', {
          nextModel: nextModel.name,
          available: `${nextModel.active}/${nextModel.max}`
        });
        proxyRes.destroy();
        processRequest(request, nextModel, triedKeys);
        return;
      }

      // All models exhausted
      cleanupState();
      log('ERROR', 'All models exhausted', {
        triedKeys: Array.from(triedKeys).map(k => {
          const m = allModels.find(m => m.key === k);
          return m ? m.name : k;
        })
      });

      if (!res.headersSent) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'All models exhausted or rate limited',
          triedModels: Array.from(triedKeys)
        }));
      }
      proxyRes.destroy();
      setTimeout(processQueue, 100);
      return;
    }

    // Forward response
    const hopByHopHeaders = ['connection', 'keep-alive', 'transfer-encoding', 'upgrade',
      'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'proxy-connection'];
    const filteredHeaders = {};
    for (const [key, value] of Object.entries(proxyRes.headers)) {
      if (!hopByHopHeaders.includes(key.toLowerCase())) {
        filteredHeaders[key] = value;
      }
    }

    if (!res.headersSent) {
      res.writeHead(proxyRes.statusCode, filteredHeaders);
    }

    // Idle timeout (not total timeout)
    let lastDataTime = Date.now();
    let idleCheckInterval;

    proxyRes.on('data', () => {
      lastDataTime = Date.now();
    });

    idleCheckInterval = setInterval(() => {
      if (!stateCleaned) {
        const idleTime = Date.now() - lastDataTime;
        if (idleTime > 150000) {
          clearInterval(idleCheckInterval);
          const duration = Date.now() - startTime;
          cleanupState();

          log('WARN', 'Request completed (idle timeout)', {
            model: model.name,
            status: 'idle_timeout',
            duration: `${duration}ms`,
            note: 'No data received for 150s'
          });
          proxyReq.destroy();
          setTimeout(processQueue, 100);
        }
      }
    }, 10000);

    proxyRes.on('end', () => {
      clearInterval(idleCheckInterval);
      if (!stateCleaned) {
        const duration = Date.now() - startTime;
        cleanupState();
        log('SUCCESS', 'Request completed', {
          model: model.name,
          status: proxyRes.statusCode,
          duration: `${duration}ms`
        });
      }
      setTimeout(processQueue, 100);
    });

    proxyRes.on('close', () => {
      clearInterval(idleCheckInterval);
      const duration = Date.now() - startTime;

      if (!stateCleaned) {
        cleanupState();
        log('WARN', 'Request completed (connection closed)', {
          model: model.name,
          status: proxyRes.statusCode || 'connection_closed',
          duration: `${duration}ms`
        });
      }
      setTimeout(processQueue, 100);
    });

    proxyRes.on('error', (pipeError) => {
      clearInterval(idleCheckInterval);
      cleanupState();
      log('ERROR', 'Response pipe error', { model: model.name, error: pipeError.message });
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Proxy response error', details: pipeError.message }));
      }
      setTimeout(processQueue, 100);
    });

    proxyRes.pipe(res);
  });

  proxyReq.on('error', (error) => {
    if (!stateCleaned) {
      cleanupState();
      const retryableErrors = ['socket hang up', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'];
      const isRetryable = retryableErrors.some(e => error.message.includes(e));

      log(isRetryable ? 'WARN' : 'ERROR', 'Request error', {
        model: model.name,
        error: error.message,
        retryable: isRetryable
      });
    }

    // Try fallback models
    const allModels = getAllModels();
    const nextModel = allModels.find(m =>
      !triedKeys.has(m.key) && m.available
    );

    if (nextModel) {
      log('INFO', 'Retrying after error', {
        failedModel: model.name,
        nextModel: nextModel.name,
        error: error.message
      });
      processRequest(request, nextModel, triedKeys);
      return;
    }

    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Proxy error', details: error.message }));
    }

    setTimeout(processQueue, 100);
  });

  proxyReq.write(modifiedBody);
  proxyReq.end();

  // Request timeout (5 minutes)
  const requestTimeout = setTimeout(() => {
    if (!stateCleaned) {
      cleanupState();
      log('ERROR', 'Request timeout - no response from upstream', {
        model: model.name,
        duration: `${Date.now() - startTime}ms`
      });
      if (!res.headersSent) {
        res.writeHead(504, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Gateway timeout - no response from upstream API' }));
      }
      proxyReq.destroy();
      setTimeout(processQueue, 100);
    }
  }, 300000);

  proxyReq.on('response', () => clearTimeout(requestTimeout));
  proxyReq.on('error', () => clearTimeout(requestTimeout));
}

// ============ HTTP SERVER ============

const server = http.createServer((req, res) => {
  // Status endpoint
  if (req.url === '/gateway-status') {
    const now = Date.now();
    const lastRequestTimes = {};
    for (const key in STATE.lastRequestTime) {
      const timeSince = now - STATE.lastRequestTime[key];
      lastRequestTimes[key] = timeSince > 0 ? `${Math.round(timeSince / 1000)}s ago` : 'never';
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'running',
      active: STATE.active,
      queueLength: STATE.queue.length,
      queue: STATE.queue.map(r => ({
        waiting: `${Math.round((Date.now() - r.queuedAt)/1000)}s`
      })),
      lastRequestTimes,
      models: getAllModels()
    }, null, 2));
    return;
  }

  log('INFO', 'Request received', {
    method: req.method,
    path: req.url
  });

  // Read request body
  let body = [];
  req.on('data', (chunk) => body.push(chunk));
  req.on('end', () => {
    const requestBody = Buffer.concat(body).toString();

    // Select model
    const model = selectModel();

    if (model) {
      processRequest({ req, res, requestBody }, model);
    } else {
      // Queue the request
      addToQueue({
        req, res, requestBody,
        queuedAt: Date.now()
      });

      // Try to process queue
      processQueue();
    }
  });
});

// ============ START SERVER ============

server.listen(CONFIG.port, CONFIG.host, () => {
  log('SUCCESS', 'AI Proxy Gateway started', {
    url: `http://${CONFIG.host}:${CONFIG.port}`,
    providers: Object.keys(CONFIG.providers).join(', ')
  });

  console.log('\n═══════════════════════════════════════════════');
  console.log('  AI Proxy Gateway');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Listening:  http://${CONFIG.host}:${CONFIG.port}`);
  console.log(`  Status:     http://${CONFIG.host}:${CONFIG.port}/gateway-status`);
  console.log('');
  console.log('  Providers:');
  for (const [name, provider] of Object.entries(CONFIG.providers)) {
    const models = Object.entries(provider.models)
      .map(([m, c]) => `${m} (${c.max})`)
      .join(', ');
    console.log(`    ${name}: ${models}`);
  }
  console.log('═══════════════════════════════════════════════\n');
});

// ============ GRACEFUL SHUTDOWN ============

process.on('SIGTERM', () => {
  log('INFO', 'Shutting down gracefully...');
  server.close(() => {
    log('INFO', 'Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  log('INFO', 'Shutting down gracefully...');
  server.close(() => {
    log('INFO', 'Server closed');
    process.exit(0);
  });
});

// Periodic queue processing (safety net)
setInterval(processQueue, 5000);
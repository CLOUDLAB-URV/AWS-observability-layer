/* eslint-disable @typescript-eslint/no-require-imports */

const http = require('http');
const { spawn } = require('child_process');
const { appendFileSync, mkdirSync, writeFileSync } = require('fs');
const path = require('path');
const readline = require('readline');
const { randomUUID } = require('crypto');

const PORT = Number(process.env.AWS_MCP_PROXY_PORT || 8787);
const HOST = process.env.AWS_MCP_PROXY_HOST || '127.0.0.1';
const CHILD_COMMAND = process.env.AWS_MCP_COMMAND || 'uvx';
const CHILD_ARGS = process.env.AWS_MCP_ARGS
  ? process.env.AWS_MCP_ARGS.split(' ').filter(Boolean)
  : ['awslabs.aws-api-mcp-server@latest'];
const DATA_DIR = path.join(__dirname, 'data');
const LOG_FILE = path.join(DATA_DIR, 'aws-mcp-proxy.log');
const REQUESTS_LOG = path.join(DATA_DIR, 'mcp_requests.json');
const RESPONSES_LOG = path.join(DATA_DIR, 'mcp_responses.json');
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};

mkdirSync(DATA_DIR, { recursive: true });
writeFileSync(LOG_FILE, '');
writeFileSync(REQUESTS_LOG, '');
writeFileSync(RESPONSES_LOG, '');

function now() {
  return new Date().toISOString();
}

function writeLog(message) {
  const line = `${now()} [proxy] ${message}`;
  try {
    appendFileSync(LOG_FILE, `${line}\n`);
  } catch {
    // Ignore log write failures.
  }
  process.stderr.write(`${line}\n`);
  broadcast('log', { ts: now(), type: 'log', level: 'info', message });
}

function writeRequestLog(request) {
  try {
    const entry = { ts: now(), request };
    appendFileSync(REQUESTS_LOG, `${JSON.stringify(entry)}\n`);
  } catch {
    // Ignore log write failures.
  }
}

function writeResponseLog(response) {
  try {
    const entry = { ts: now(), response };
    appendFileSync(RESPONSES_LOG, `${JSON.stringify(entry)}\n`);
  } catch {
    // Ignore log write failures.
  }
}

function writeRawResponseLog(raw) {
  try {
    const entry = { ts: now(), raw };
    appendFileSync(RESPONSES_LOG, `${JSON.stringify(entry)}\n`);
  } catch {
    // Ignore log write failures.
  }
}

function writeEvent(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json', ...CORS_HEADERS });
  res.end(JSON.stringify(payload));
}

const sseClients = new Set();
const pendingRequests = new Map();
let toolCache = null;
let childSpawned = false;
let childInitialized = false;
let childExited = false;
let initializePromise = null;

function broadcast(event, payload) {
  for (const client of sseClients) {
    try {
      writeEvent(client, event, payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

function extractTelemetryLines(parsed) {
  const telemetry = [];

  const structuredContent = parsed && parsed.result && parsed.result.structuredContent;
  if (structuredContent && Array.isArray(structuredContent.result)) {
    for (const item of structuredContent.result) {
      if (!item) {
        continue;
      }

      const command = item.cli_command || item.command || item.name;
      if (!command) {
        continue;
      }

      telemetry.push({
        ts: now(),
        type: 'aws-cli-output',
        level: item.error ? 'error' : 'info',
        message: item.error || `Executed ${command}`,
        payload: item,
      });
    }
  }

  const textContent = parsed && parsed.result && parsed.result.content;
  if (Array.isArray(textContent)) {
    for (const item of textContent) {
      if (item && item.type === 'text' && item.text) {
        telemetry.push({
          ts: now(),
          type: 'aws-cli-output',
          level: 'info',
          message: item.text,
          payload: item,
        });
      }
    }
  }

  return telemetry;
}

function createRpcRequest(method, params) {
  return {
    jsonrpc: '2.0',
    id: randomUUID(),
    method,
    params,
  };
}

function sendChildNotification(method, params) {
  if (!childProcess || childProcess.killed) {
    return Promise.reject(new Error('AWS MCP child process is not available.'));
  }

  try {
    const payload = {
      jsonrpc: '2.0',
      method,
      params,
    };
    writeRequestLog(payload);
    childProcess.stdin.write(`${JSON.stringify(payload)}\n`);
    return Promise.resolve();
  } catch (error) {
    return Promise.reject(error);
  }
}

async function ensureChildInitialized() {
  if (childInitialized) {
    return;
  }

  if (!initializePromise) {
    initializePromise = (async () => {
      const result = await sendChildRequest('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: {
          name: 'aws-architect-chat-local-proxy',
          version: '0.1.0',
        },
      });

      await sendChildNotification('notifications/initialized', {});
      childInitialized = true;
      broadcast('status', {
        ts: now(),
        type: 'initialized',
        message: 'AWS MCP child initialized',
        payload: result,
      });
    })().catch((error) => {
      initializePromise = null;
      throw error;
    });
  }

  return initializePromise;
}

function sendChildRequest(method, params, timeoutMs = 60000) {
  if (!childProcess || childProcess.killed) {
    return Promise.reject(new Error('AWS MCP child process is not available.'));
  }

  const request = createRpcRequest(method, params);

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      pendingRequests.delete(request.id);
      reject(new Error(`Timed out waiting for ${method}`));
    }, timeoutMs);

    pendingRequests.set(request.id, {
      resolve: (value) => {
        clearTimeout(timeoutId);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timeoutId);
        reject(error);
      },
    });

    try {
      writeRequestLog(request);
      childProcess.stdin.write(`${JSON.stringify(request)}\n`);
      broadcast('status', {
        ts: now(),
        type: 'rpc-request',
        method,
        requestId: request.id,
      });
    } catch (error) {
      clearTimeout(timeoutId);
      pendingRequests.delete(request.id);
      reject(error);
    }
  });
}

function normalizeTools(payload) {
  const tools = [];
  const rawTools = payload && payload.result && (payload.result.tools || payload.result.content || payload.tools);

  const candidates = Array.isArray(rawTools) ? rawTools : Array.isArray(payload) ? payload : [];
  for (const tool of candidates) {
    if (!tool || !tool.name) {
      continue;
    }

    tools.push({
      name: tool.name,
      description: tool.description || `AWS MCP tool ${tool.name}`,
      inputSchema: tool.inputSchema || tool.input_schema || { type: 'object', properties: {} },
    });
  }

  return tools;
}

async function getToolDefinitions() {
  await ensureChildInitialized();

  if (Array.isArray(toolCache) && toolCache.length > 0) {
    return toolCache;
  }

  const response = await sendChildRequest('tools/list', {});
  toolCache = normalizeTools(response);
  broadcast('status', {
    ts: now(),
    type: 'tools-ready',
    count: toolCache.length,
  });
  return toolCache;
}

function handleChildLine(line) {
  if (!line || !line.trim()) {
    return;
  }

  let parsed = null;

  try {
    parsed = JSON.parse(line);
    writeResponseLog(parsed);
  } catch {
    writeRawResponseLog(line);
    broadcast('log', {
      ts: now(),
      type: 'raw-log',
      level: 'info',
      message: line,
    });
    return;
  }

  if (parsed && parsed.id && pendingRequests.has(parsed.id)) {
    const pending = pendingRequests.get(parsed.id);
    pendingRequests.delete(parsed.id);

    if (parsed.error) {
      pending.reject(new Error(parsed.error.message || 'AWS MCP returned an error'));
      broadcast('status', {
        ts: now(),
        type: 'rpc-error',
        requestId: parsed.id,
        error: parsed.error,
      });
      return;
    }

    pending.resolve(parsed.result ?? parsed);
  }

  const telemetry = extractTelemetryLines(parsed);
  for (const entry of telemetry) {
    broadcast('log', entry);
  }

  if (parsed && parsed.result && parsed.result.tools) {
    toolCache = normalizeTools(parsed);
  }

  broadcast('mcp', {
    ts: now(),
    type: 'mcp-response',
    payload: parsed,
  });
}

function handleChildError(error) {
  const message = error instanceof Error ? error.message : String(error);
  broadcast('status', {
    ts: now(),
    type: 'child-error',
    message,
  });
  writeLog(`child error: ${message}`);
}

const childProcess = spawn(CHILD_COMMAND, CHILD_ARGS, {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: process.env,
});

childProcess.on('spawn', () => {
  childSpawned = true;
  writeLog(`child spawned: ${CHILD_COMMAND} ${CHILD_ARGS.join(' ')}`);
  broadcast('status', {
    ts: now(),
    type: 'ready',
    message: 'AWS MCP child process spawned',
  });
});

childProcess.on('error', handleChildError);
childProcess.on('close', (code, signal) => {
  childSpawned = false;
  childInitialized = false;
  childExited = true;
  initializePromise = null;
  broadcast('status', {
    ts: now(),
    type: 'child-closed',
    code,
    signal,
  });
  writeLog(`child closed: code=${code} signal=${signal || 'none'}`);
});

const childStdout = readline.createInterface({ input: childProcess.stdout, crlfDelay: Infinity });
childStdout.on('line', handleChildLine);

childProcess.stderr.on('data', (chunk) => {
  const text = chunk.toString('utf8').trimEnd();
  if (!text) {
    return;
  }

  broadcast('log', {
    ts: now(),
    type: 'stderr',
    level: 'warning',
    message: text,
  });
  writeLog(`child stderr: ${text}`);
});

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    sendJson(res, 200, {
      ok: childSpawned && !childExited,
      port: PORT,
      toolsCached: Array.isArray(toolCache) && toolCache.length > 0,
      initialized: childInitialized,
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/tools') {
    try {
      await ensureChildInitialized();
      const tools = await getToolDefinitions();
      sendJson(res, 200, { tools });
    } catch (error) {
      sendJson(res, 503, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (req.method === 'GET' && req.url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...CORS_HEADERS,
    });

    const keepAlive = setInterval(() => {
      try {
        res.write(': heartbeat\n\n');
      } catch {
        clearInterval(keepAlive);
      }
    }, 15000);

    const client = res;
    sseClients.add(client);
    writeEvent(client, 'status', {
      ts: now(),
      type: 'connected',
      ok: childReady,
      toolsCached: Array.isArray(toolCache) && toolCache.length > 0,
    });

    req.on('close', () => {
      clearInterval(keepAlive);
      sseClients.delete(client);
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/invoke') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });

    req.on('end', async () => {
      try {
        await ensureChildInitialized();
        const parsed = body ? JSON.parse(body) : {};
        const toolName = parsed.toolName || parsed.name;
        const toolArguments = parsed.arguments || parsed.args || {};

        if (!toolName) {
          sendJson(res, 400, { error: 'toolName is required.' });
          return;
        }

        broadcast('status', {
          ts: now(),
          type: 'tool-call-start',
          toolName,
          arguments: toolArguments,
        });

        const result = await sendChildRequest('tools/call', {
          name: toolName,
          arguments: toolArguments,
        });

        broadcast('status', {
          ts: now(),
          type: 'tool-call-finish',
          toolName,
        });

        sendJson(res, 200, { result });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        broadcast('status', {
          ts: now(),
          type: 'tool-call-error',
          message,
        });
        sendJson(res, 500, { error: message });
      }
    });
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, HOST, () => {
  writeLog(`proxy listening on http://${HOST}:${PORT}`);
});

server.on('error', (error) => {
  if (error && error.code === 'EADDRINUSE') {
    const message = `Port ${PORT} is already in use. Stop the existing proxy or set AWS_MCP_PROXY_PORT to another port.`;
    process.stderr.write(`${now()} [proxy] ${message}\n`);
    process.exit(1);
  }

  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${now()} [proxy] server error: ${message}\n`);
  process.exit(1);
});

function shutdown(signal) {
  writeLog(`received ${signal}, shutting down`);
  for (const client of sseClients) {
    try {
      client.end();
    } catch {
      // Ignore close errors.
    }
  }
  try {
    childProcess.kill('SIGTERM');
  } catch {
    // Ignore kill errors.
  }
  server.close(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
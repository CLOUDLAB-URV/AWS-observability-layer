const { appendFileSync, mkdirSync, writeFileSync } = require('fs');
const { join } = require('path');
const { spawn } = require('child_process');
const readline = require('readline');

const DEBUG_PREFIX = '[proxy]';
const childCommand = 'uvx';
const childArgs = ['awslabs.aws-api-mcp-server@latest'];
const llmCallsDir = join(__dirname, '..', 'data');
const logFilePath = join(llmCallsDir, 'proxy.log');
const llmCallsPath = join(llmCallsDir, 'mcp_requests.json');
const responsesPath = join(llmCallsDir, 'mcp_responses.json');

const WS_URL = process.env.PROXY_WS_URL || 'ws://127.0.0.1:8080';

function now() { return new Date().toISOString(); }

function log(message) {
  const line = `${now()} ${DEBUG_PREFIX} ${message}`;
  try { appendFileSync(logFilePath, `${line}\n`); } catch (e) { /* ignore */ }
  process.stderr.write(`${line}\n`);
}

function ensureDataDir() {
  try { mkdirSync(llmCallsDir, { recursive: true }); } catch (e) { /* ignore */ }
}

function resetLogs() {
  try { writeFileSync(logFilePath, ''); } catch (e) { /* ignore */ }
  try { writeFileSync(llmCallsPath, ''); } catch (e) { /* ignore */ }
  try { writeFileSync(responsesPath, ''); } catch (e) { /* ignore */ }
}

// Ensure data directory exists and clean old logs before writing new ones
ensureDataDir();
resetLogs();

log(`starting proxy process in cwd=${process.cwd()}`);
log(`launching child command: ${childCommand} ${childArgs.join(' ')}`);

// Spawn child MCP server (the real backend)
const child = spawn(childCommand, childArgs, {
  stdio: ['pipe', 'pipe', 'pipe'],
});

child.on('spawn', () => log(`child spawned pid=${child.pid}`));
child.on('error', (err) => { log(`failed to start child MCP process: ${err && (err.stack || err.message || String(err))}`); process.exitCode = 1; });
child.on('exit', (code, signal) => { log(`child exit code=${code} signal=${signal || 'none'}`); if (signal) { process.exitCode = 1; return; } process.exitCode = code ?? 0; });
child.on('close', (code, signal) => log(`child close code=${code} signal=${signal || 'none'}`));

// Setup WebSocket forwarding (non-fatal if not available)
let WebSocket;
try { WebSocket = require('ws'); } catch (e) { try { WebSocket = require('../.opencode/node_modules/ws'); } catch (err) { WebSocket = null; log('ws module not available; websocket forwarding disabled'); } }

let extensionWs = null;
let wsConnected = false;
const messageQueue = [];
let reconnectDelay = 1000;
const RECONNECT_MAX = 30000;
let reconnectTimer = null;

function logWsError(err) {
  const text = err && (err.stack || err.message || String(err));
  log(`WebSocket error: ${text || '<no error message>'}`);
}

function scheduleReconnect() {
  if (!WebSocket) return;
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(RECONNECT_MAX, reconnectDelay * 2);
    connectToExtension();
  }, reconnectDelay);
}

function connectToExtension() {
  if (!WebSocket) return;
  if (extensionWs && extensionWs.readyState === WebSocket.OPEN) return;
  log(`attempting WebSocket connect to ${WS_URL} (delay ${reconnectDelay}ms)`);
  try {
    extensionWs = new WebSocket(WS_URL);
  } catch (err) {
    logWsError(err);
    scheduleReconnect();
    return;
  }

  extensionWs.on('open', () => {
    wsConnected = true;
    reconnectDelay = 1000;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    log(`connected to extension websocket ${WS_URL}`);
    while (messageQueue.length > 0) {
      const msg = messageQueue.shift();
      try { extensionWs.send(JSON.stringify(msg)); log('queued message sent to extension'); }
      catch (e) { logWsError(e); messageQueue.unshift(msg); break; }
    }
  });

  extensionWs.on('error', (err) => { logWsError(err); wsConnected = false; });

  extensionWs.on('close', (code, reason) => {
    wsConnected = false;
    const r = reason ? reason.toString() : '';
    log(`websocket disconnected (code=${code} reason=${r})`);
    scheduleReconnect();
  });
}

function forwardToExtension(request) {
  if (!WebSocket) {
    log('WebSocket not available; skipping forward to extension');
    return;
  }
  if (wsConnected && extensionWs && extensionWs.readyState === WebSocket.OPEN) {
    try { extensionWs.send(JSON.stringify(request)); log('message sent to extension'); }
    catch (err) { log(`failed sending to extension: ${err && (err.message || err)}`); messageQueue.push(request); }
  } else {
    messageQueue.push(request);
    log('message queued for extension (waiting WebSocket)');
  }
}

// Read stdin lines (incoming MCP requests from client) and forward
const rlIn = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rlIn.on('line', (line) => {
  if (!line || !line.trim()) return;
  log(`received stdin line preview=${line.length > 200 ? line.slice(0,200)+'…' : line}`);
  try {
    const parsed = JSON.parse(line);
    const record = { ts: now(), request: parsed };
    try { appendFileSync(llmCallsPath, JSON.stringify(record) + '\n'); log(`appended LLM call to ${llmCallsPath}`); } catch (e) { log(`failed to write LLM call: ${e && e.message}`); }
  } catch (e) {
    log(`stdin line is not JSON: ${e && e.message}`);
  }

  // Forward raw line to child (preserve newline)
  try {
    if (!child.killed) {
      child.stdin.write(line + '\n');
      log(`forwarded line to child stdin (${line.length} bytes)`);
    } else {
      log('child process is not available; cannot forward request');
    }
  } catch (e) { log(`failed forwarding to child stdin: ${e && e.message}`); }
});

rlIn.on('close', () => { log('stdin closed; ending child.stdin'); try { child.stdin.end(); } catch (e) {} });
rlIn.on('error', (err) => log(`stdin readline error: ${err && err.message}`));

// Forward child stdout to our stdout and persist responses
const rlOut = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
rlOut.on('line', (line) => {
  try { process.stdout.write(line + '\n'); } catch (e) { log(`failed to write to stdout: ${e && e.message}`); }

  if (!line || !line.trim()) return;
  try {
    const parsed = JSON.parse(line);
    const record = { ts: now(), response: parsed };
    try { appendFileSync(responsesPath, JSON.stringify(record) + '\n'); log(`appended MCP response to ${responsesPath}`); } catch (e) { log(`failed to write MCP response: ${e && e.message}`); }
    
    // Si la respuesta tiene structuredContent, enviamos solo eso por el websocket
    if (parsed.result && parsed.result.structuredContent) {
        try { forwardToExtension(parsed.result.structuredContent); } catch (e) { log(`forwardToExtension error: ${e && e.message}`); }
    }
  } catch (e) {
    const rawRecord = { ts: now(), raw: line };
    try { appendFileSync(responsesPath, JSON.stringify(rawRecord) + '\n'); log(`appended raw MCP line to ${responsesPath}`); } catch (err) { log(`failed to write raw MCP line: ${err && err.message}`); }
  }

  log(`child stdout line forwarded preview=${line.length > 200 ? line.slice(0,200)+'…' : line}`);
});

child.stderr.on('data', (chunk) => {
  const text = chunk.toString('utf8');
  try { appendFileSync(logFilePath, `${now()} ${DEBUG_PREFIX} child stderr: ${text}`); } catch (e) {}
  process.stderr.write(`${now()} ${DEBUG_PREFIX} child stderr: ${text}`);
  if (!text.endsWith('\n')) process.stderr.write('\n');
});

function shutdown(signal) {
  log(`received ${signal}; forwarding shutdown to child`);
  if (!child.killed) {
    try { child.kill(signal); } catch (err) { log(`shutdown error: ${err && (err.stack || err.message || String(err))}`); }
  }
  try { if (extensionWs) extensionWs.close(); } catch (e) {}
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('exit', (code) => { log(`process exit code=${code}`); });

// Start websocket connect attempts (if ws available)
connectToExtension();

// Export nothing; run as script

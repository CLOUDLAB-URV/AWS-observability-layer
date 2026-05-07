// proxy.js - MCP Server que actúa como proxy e interceptor
// proxy.js - MCP Server que actúa como proxy e interceptor
const { spawn } = require('child_process');
let WebSocket;
try {
    WebSocket = require('ws');
} catch (e) {
    WebSocket = require('../extension/node_modules/ws');
}
const readline = require('readline');

// Estado del WebSocket
let wsConnected = false;
const messageQueue = [];

// WebSocket client instance + reconnect/backoff state
let extensionWs = null;
let reconnectDelay = 1000; // start 1s
const RECONNECT_MAX = 30000; // 30s
let reconnectTimer = null;

// AWS MCP server handling: start after WS connected (with fallback)
let awsMcpServer = null;
const pendingLines = [];
let awsStartTimer = null;
const AWS_START_FALLBACK = 5000; // ms

function logWsError(err) {
    const text = err && (err.stack || err.message || String(err));
    console.error('⚠️  [MCP Server] Error WebSocket:', text || '<no error message>');
}

function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        reconnectDelay = Math.min(RECONNECT_MAX, reconnectDelay * 2);
        connectToExtension();
    }, reconnectDelay);
}

function connectToExtension() {
    if (extensionWs && extensionWs.readyState === WebSocket.OPEN) return;
    console.error(`[MCP Server] Intentando conectar a ws://localhost:8765 (delay ${reconnectDelay}ms)`);
    try {
        extensionWs = new WebSocket('ws://localhost:8765');
    } catch (err) {
        logWsError(err);
        scheduleReconnect();
        return;
    }

    extensionWs.on('open', () => {
        wsConnected = true;
        reconnectDelay = 1000;
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        console.error('✅ [MCP Server] Conectado a la extensión de logging en puerto 8765');

        // send queued messages
        while (messageQueue.length > 0) {
            const msg = messageQueue.shift();
            try { extensionWs.send(JSON.stringify(msg)); console.error('✅ [MCP Server] Mensaje de cola enviado a extensión'); }
            catch (e) { logWsError(e); messageQueue.unshift(msg); break; }
        }

        // start aws server now that extension is available
        if (!awsMcpServer) startAwsMcpServer();
        if (awsStartTimer) { clearTimeout(awsStartTimer); awsStartTimer = null; }
    });

    extensionWs.on('error', (err) => { logWsError(err); wsConnected = false; });

    extensionWs.on('close', (code, reason) => {
        wsConnected = false;
        const r = reason ? reason.toString() : '';
        console.error(`🔌 [MCP Server] WebSocket desconectado (code=${code} reason=${r})`);
        scheduleReconnect();
    });
}

function startAwsMcpServer() {
    if (awsMcpServer) return;
    console.error('🚀 [MCP Server] Iniciando AWS MCP Server...');
    try {
        awsMcpServer = spawn('uvx', ['awslabs.aws-api-mcp-server@latest']);
    } catch (err) {
        console.error('❌ [MCP Server] Error al iniciar AWS server:', err && (err.message || err));
        process.exit(1);
    }

    // Flush pending lines
    while (pendingLines.length > 0) {
        const l = pendingLines.shift();
        try { awsMcpServer.stdin.write(l + '\n'); } catch (e) { console.error('❌ [MCP Server] Error al escribir a stdin de AWS server:', e && e.message); }
    }

    awsMcpServer.stdout.on('data', (data) => { process.stdout.write(data); });
    awsMcpServer.stderr.on('data', (data) => { console.error(`[AWS Server] ${data}`); });
    awsMcpServer.on('error', (err) => { console.error('❌ [MCP Server] Error en AWS server:', err && (err.message || err)); });
    awsMcpServer.on('exit', (code, signal) => { console.error(`[MCP Server] AWS server exited (code=${code} signal=${signal})`); });
}

// Crear interface para leer stdin
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

// Procesar entrada línea por línea
rl.on('line', (line) => {
    try {
        if (!line.trim()) return;
        const request = JSON.parse(line);
        console.error(`📝 [MCP Server] Mensaje interceptado (id: ${request.id || 'N/A'}, método: ${request.method || 'N/A'})`);
        const msg = { type: 'mcp_intercept', data: request };

        if (wsConnected && extensionWs && extensionWs.readyState === WebSocket.OPEN) {
            try { extensionWs.send(JSON.stringify(msg)); console.error('✅ [MCP Server] Mensaje enviado a extensión'); }
            catch (err) { console.error('⚠️  [MCP Server] Falló envío a extensión:', err && (err.message || err)); messageQueue.push(msg); }
        } else { messageQueue.push(msg); console.error('⏳ [MCP Server] Mensaje encolado (esperando conexión WebSocket)'); }

        if (awsMcpServer && awsMcpServer.stdin && !awsMcpServer.killed) { awsMcpServer.stdin.write(line + '\n'); }
        else { pendingLines.push(line); console.error('⏳ [MCP Server] Línea almacenada hasta que AWS server inicie'); }

    } catch (e) {
        console.error(`❌ [MCP Server] Error al parsear JSON:`, e && (e.message || e));
        if (awsMcpServer && awsMcpServer.stdin && !awsMcpServer.killed) awsMcpServer.stdin.write(line + '\n');
        else pendingLines.push(line);
    }
});

// If WS doesn't connect, start AWS after a short fallback delay
function ensureAwsStartedSoon() {
    if (awsMcpServer) return;
    if (awsStartTimer) return;
    awsStartTimer = setTimeout(() => { awsStartTimer = null; if (!awsMcpServer) startAwsMcpServer(); }, AWS_START_FALLBACK);
}

// Start connect attempts and fallback
connectToExtension();
ensureAwsStartedSoon();

// Apagado graceful
process.on('SIGINT', () => {
    console.error('\n[MCP Server] Señal SIGINT recibida, cerrando...');
    try { if (extensionWs) extensionWs.close(); } catch (e) {}
    try { if (awsMcpServer) awsMcpServer.kill(); } catch (e) {}
    try { rl.close(); } catch (e) {}
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.error('[MCP Server] Señal SIGTERM recibida, cerrando');
    try { if (extensionWs) extensionWs.close(); } catch (e) {}
    try { if (awsMcpServer) awsMcpServer.kill(); } catch (e) {}
    try { rl.close(); } catch (e) {}
    process.exit(0);
});

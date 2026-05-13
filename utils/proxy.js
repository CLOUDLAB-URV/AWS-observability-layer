// proxy.js - MCP forwarder que intercepta por WebSocket y habla MCP por stdio
let WebSocket;
try {
    WebSocket = require('ws');
} catch (e) {
    WebSocket = require('../extension/node_modules/ws');
}
const readline = require('readline');

const WS_URL = process.env.PROXY_WS_URL || 'ws://127.0.0.1:8765';

// Estado del WebSocket de la extensión
let wsConnected = false;
const messageQueue = [];

// WebSocket client instance + reconnect/backoff state
let extensionWs = null;
let reconnectDelay = 1000; // start 1s
const RECONNECT_MAX = 30000; // 30s
let reconnectTimer = null;

function logWsError(err) {
    const text = err && (err.stack || err.message || String(err));
    console.error('⚠️  [MCP Server] Error WebSocket:', text || '<no error message>');
}

function writeJsonRpc(message) {
    process.stdout.write(JSON.stringify(message) + '\n');
}

function sendJsonRpcResult(id, result) {
    writeJsonRpc({ jsonrpc: '2.0', id, result });
}

function sendJsonRpcError(id, code, message, data) {
    const error = { code, message };
    if (data !== undefined) error.data = data;
    writeJsonRpc({ jsonrpc: '2.0', id, error });
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
    console.error(`[MCP Server] Intentando conectar a ${WS_URL} (delay ${reconnectDelay}ms)`);
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
        console.error(`✅ [MCP Server] Conectado a la extensión de logging en ${WS_URL}`);

        // send queued messages
        while (messageQueue.length > 0) {
            const msg = messageQueue.shift();
            try { extensionWs.send(JSON.stringify(msg)); console.error('✅ [MCP Server] Mensaje de cola enviado a extensión'); }
            catch (e) { logWsError(e); messageQueue.unshift(msg); break; }
        }
    });

    extensionWs.on('error', (err) => { logWsError(err); wsConnected = false; });

    extensionWs.on('close', (code, reason) => {
        wsConnected = false;
        const r = reason ? reason.toString() : '';
        console.error(`🔌 [MCP Server] WebSocket desconectado (code=${code} reason=${r})`);
        scheduleReconnect();
    });
}

function forwardToExtension(request) {
    const msg = { type: 'mcp_intercept', data: request };

    if (wsConnected && extensionWs && extensionWs.readyState === WebSocket.OPEN) {
        try {
            extensionWs.send(JSON.stringify(msg));
            console.error('✅ [MCP Server] Mensaje enviado a extensión');
        } catch (err) {
            console.error('⚠️  [MCP Server] Falló envío a extensión:', err && (err.message || err));
            messageQueue.push(msg);
        }
    } else {
        messageQueue.push(msg);
        console.error('⏳ [MCP Server] Mensaje encolado (esperando WebSocket)');
    }
}

// Crear interface para leer stdin
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

// Procesar entrada línea por línea
rl.on('line', (line) => {
    try {
        if (!line.trim()) return;
        const request = JSON.parse(line);
        console.error(`📝 [MCP Server] Mensaje interceptado (id: ${request.id || 'N/A'}, método: ${request.method || 'N/A'})`);
        forwardToExtension(request);

        if (!request || typeof request !== 'object') {
            if (request && request.id !== undefined) sendJsonRpcError(request.id, -32600, 'Invalid Request');
            return;
        }

        const isNotification = request.id === undefined || request.id === null;
        if (isNotification) return;

        switch (request.method) {
            case 'initialize':
                sendJsonRpcResult(request.id, {
                    protocolVersion: (request.params && request.params.protocolVersion) || '2024-11-05',
                    serverInfo: {
                        name: 'mcp-forwarder-proxy',
                        version: '1.0.0'
                    },
                    capabilities: {
                        tools: { listChanged: false },
                        resources: { listChanged: false },
                        prompts: { listChanged: false }
                    }
                });
                break;
            case 'tools/list':
                sendJsonRpcResult(request.id, { tools: [] });
                break;
            case 'resources/list':
                sendJsonRpcResult(request.id, { resources: [] });
                break;
            case 'prompts/list':
                sendJsonRpcResult(request.id, { prompts: [] });
                break;
            case 'ping':
                sendJsonRpcResult(request.id, {});
                break;
            default:
                sendJsonRpcError(request.id, -32601, `Method not implemented: ${request.method || '<unknown>'}`);
                break;
        }

    } catch (e) {
        console.error(`❌ [MCP Server] Error al parsear JSON:`, e && (e.message || e));
    }
});

// Start connect attempts
connectToExtension();

// Apagado graceful
process.on('SIGINT', () => {
    console.error('\n[MCP Server] Señal SIGINT recibida, cerrando...');
    try { if (extensionWs) extensionWs.close(); } catch (e) {}
    try { rl.close(); } catch (e) {}
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.error('[MCP Server] Señal SIGTERM recibida, cerrando');
    try { if (extensionWs) extensionWs.close(); } catch (e) {}
    try { rl.close(); } catch (e) {}
    process.exit(0);
});

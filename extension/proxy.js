// proxy.js
const { spawn } = require('child_process');
const WebSocket = require('ws');

// Connect to the VS Code Extension's local WebSocket server
const ws = new WebSocket('ws://localhost:8765');

// Spawn the actual AWS MCP server
const awsMcpServer = spawn('uvx', ['awslabs.aws-api-mcp-server@latest']);

// 1. Intercept Client -> Server (stdin)
process.stdin.on('data', (data) => {
    try {
        const payload = data.toString();
        const request = JSON.parse(payload);
        
        // Intercept tool execution calls
        if (request.method === 'tools/call') {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'mcp_intercept', data: request }));
            }
        }
    } catch (e) {
        // Ignore parse errors for partial chunks
    }
    
    // Forward to the real MCP server
    awsMcpServer.stdin.write(data);
});

// 2. Intercept Server -> Client (stdout)
awsMcpServer.stdout.on('data', (data) => {
    // Forward the response back to the client
    process.stdout.write(data);
});

// Handle graceful shutdown
process.on('SIGINT', () => awsMcpServer.kill('SIGINT'));
const vscode = require('vscode');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');

/** @type {import('ws').WebSocketServer | undefined} */
let wss;

/**
 * @param {import('vscode').ExtensionContext} context
 */
function activate(context) {
    const logFilePath = path.join(context.extensionPath, '..', 'test.json');

    // Ensure the file exists
    if (!fs.existsSync(logFilePath)) {
        fs.writeFileSync(logFilePath, JSON.stringify([], null, 2));
    }

    // Initialize the server
    wss = new WebSocketServer({ port: 8765 });

    wss.on('connection', (ws) => {
        vscode.window.setStatusBarMessage('✅ MCP Proxy Connected', 3000);

        ws.on('message', (message) => {
            try {
                const msg = JSON.parse(message.toString());
                if (msg.type === 'mcp_intercept') {
                    updateJsonLog(logFilePath, msg.data.params.name, msg.data.params.arguments);
                }
            } catch (error) {
                console.error('Error parsing MCP message:', error);
            }
        });

        // Interruption logic
        ws.on('close', () => {
            vscode.window.showWarningMessage('MCP Proxy interrupted. Stopping session...');
            markInterruptionInLog(logFilePath);
        });

        ws.on('error', (err) => {
            console.error('WebSocket Error:', err);
        });
    });

    console.log('MCP Logger Extension (JS) active on port 8765');
}

/**
 * Appends a new tool call to the JSON log
 */
function updateJsonLog(filePath, tool, args) {
    try {
        const fileContent = fs.readFileSync(filePath, 'utf8');
        const logs = JSON.parse(fileContent);

        logs.push({
            timestamp: new Date().toISOString(),
            tool: tool,
            parameters: args,
            status: "active"
        });

        fs.writeFileSync(filePath, JSON.stringify(logs, null, 2), 'utf8');
    } catch (err) {
        console.error('Failed to update log:', err);
    }
}

/**
 * Adds a marker to the JSON file indicating the proxy disconnected
 */
function markInterruptionInLog(filePath) {
    try {
        const fileContent = fs.readFileSync(filePath, 'utf8');
        const logs = JSON.parse(fileContent);
        
        logs.push({
            timestamp: new Date().toISOString(),
            event: "PROXY_INTERRUPTED",
            details: "The connection was closed by the proxy script."
        });

        fs.writeFileSync(filePath, JSON.stringify(logs, null, 2), 'utf8');
    } catch (err) {
        console.error('Failed to mark interruption:', err);
    }
}

/**
 * Cleanup logic
 */
function deactivate() {
    if (wss) {
        wss.close();
    }
}

module.exports = {
    activate,
    deactivate
};
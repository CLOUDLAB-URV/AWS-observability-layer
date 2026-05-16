const vscode = require('vscode');
const { WebSocketServer } = require('ws');

/** @type {vscode.StatusBarItem} */
let myStatusBarItem;
/** @type {import('ws').WebSocketServer | null} */
let server = null;
/** @type {vscode.WebviewPanel | undefined} */
let currentPanel = undefined;

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    console.log('AI-to-cloud-visualizer is now active.');

    // 1. Create and show the Status Bar Item immediately on startup
    // Priority 100 ensures it stays on the right near other system icons
    myStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    myStatusBarItem.command = 'ai-to-cloud.toggleServer';
    updateStatusBar(false); // Initialize in "Stopped" state
    myStatusBarItem.show();
    context.subscriptions.push(myStatusBarItem);

    // 2. Register the toggle command (Matches your package.json)
    const toggleCommand = vscode.commands.registerCommand('ai-to-cloud.toggleServer', function () {
        if (server) {
            stopServer();
        } else {
            startServer(context);
        }
    });

    context.subscriptions.push(toggleCommand);
}

/**
 * Starts the WebSocket server and opens the React Flow Webview
 * @param {vscode.ExtensionContext} context
 */
function startServer(context) {
    const port = 8080;

    try {
        server = new WebSocketServer({ port: port });
        
        server.on('connection', (socket) => {
            socket.on('message', (data) => {
                const payload = data.toString();
                if (currentPanel) {
                    currentPanel.webview.postMessage(JSON.parse(payload));
                }
            });
        });

        // Open the Webview Tab
        currentPanel = vscode.window.createWebviewPanel(
            'awsVisualizer', 
            'AWS Real-Time Canvas', 
            vscode.ViewColumn.One, 
            { enableScripts: true }
        );

        // Handle panel closure
        currentPanel.onDidDispose(() => {
            currentPanel = undefined;
        }, null, context.subscriptions);

        // Inject the placeholder HTML for your React App
        currentPanel.webview.html = getWebviewContent();

        updateStatusBar(true);
        vscode.window.showInformationMessage(`AWS Visualizer Server started on port ${port}`);

    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Failed to start server: ${message}`);
    }
}

/**
 * Shuts down the server and cleans up UI elements
 */
function stopServer() {
    if (server) {
        server.close();
        server = null;
    }
    if (currentPanel) {
        currentPanel.dispose();
    }
    updateStatusBar(false);
    vscode.window.showInformationMessage('AWS Visualizer Server stopped.');
}

/**
 * @param {boolean} running 
 */
function updateStatusBar(running) {
    if (running) {
        myStatusBarItem.text = `$(zap) AWS: Running`;
        myStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        myStatusBarItem.tooltip = 'Click to stop the server';
    } else {
        myStatusBarItem.text = `$(primitive-square) AWS: Stopped`;
        myStatusBarItem.backgroundColor = undefined;
        myStatusBarItem.tooltip = 'Click to start the server';
    }
}

/**
 * Returns the HTML for the webview
 */
function getWebviewContent() {
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <title>AWS Canvas</title>
        <style>
            body {
                font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
                margin: 0;
                padding: 16px;
                background: #0f172a;
                color: #e2e8f0;
            }
            h1 {
                font-size: 18px;
                margin: 0 0 12px 0;
                color: #cbd5e1;
            }
            #commands {
                white-space: pre-wrap;
                word-break: break-word;
                line-height: 1.6;
                padding: 12px;
                border-radius: 8px;
                background: #111827;
                border: 1px solid #334155;
                min-height: 240px;
            }
            .hint {
                color: #94a3b8;
                margin-bottom: 10px;
                font-size: 13px;
            }
        </style>
    </head>
    <body>
        <h1>CLI Commands</h1>
        <div class="hint">Showing only call_aws commands received from the proxy.</div>
        <pre id="commands"></pre>
        <script>
            const commandsEl = document.getElementById('commands');
            commandsEl.textContent = "Listening for AWS commands...\\n";

            window.addEventListener('message', event => {
                try {
                    const message = event.data;
                    const request = message && message.data ? message.data : message;

                    if (request && request.method === 'tools/call' && request.params && request.params.name === 'call_aws') {
                        const args = request.params.arguments || {};
                        const cliCommand = args.cli_command;
                        
                        let cmds = [];
                        if (Array.isArray(cliCommand)) {
                            cmds = cliCommand.filter(Boolean).map(c => String(c));
                        } else if (typeof cliCommand === 'string' && cliCommand.trim()) {
                            cmds = [cliCommand.trim()];
                        }
                        
                        cmds.forEach(cmd => {
                            commandsEl.textContent += '\\n> ' + cmd;
                        });
                    }
                } catch (err) {
                    commandsEl.textContent += '\\n[Error: ' + err.message + ']';
                }
            });
        </script>
    </body>
    </html>`;
}

function deactivate() {
    stopServer();
}

module.exports = {
    activate,
    deactivate
}
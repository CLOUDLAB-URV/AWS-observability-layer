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
            commandsEl.textContent = "Listening for AWS structured content...\\n";

            window.addEventListener('message', event => {
                try {
                    const structuredContent = event.data;

                    // Ignorar suggestions (suggest_aws_commands) si vienen como tales
                    if (structuredContent && structuredContent.suggestions) {
                        return;
                    }

                    // Iterar el array 'result' (sabiendo que nos llega estructurado directo del proxy)
                    if (structuredContent && Array.isArray(structuredContent.result)) {
                        const resultsArray = structuredContent.result;
                        
                        resultsArray.forEach(res => {
                            // Ignoramos si no es una respuesta válida que tenga el comando a enseñar
                            if (res.cli_command) {
                                let resourceState = {};
                                
                                // Intentar extraer un payload as_json si lo tiene
                                if (res.response) {
                                    if (typeof res.response.as_json !== 'undefined') {
                                        try {
                                            const parsedJson = typeof res.response.as_json === 'string' ? 
                                                JSON.parse(res.response.as_json) : res.response.as_json;
                                                
                                            if (parsedJson.ResponseMetadata) {
                                                delete parsedJson.ResponseMetadata;
                                            }
                                            resourceState = parsedJson;
                                        } catch (e) {
                                            resourceState = res.response; // fallback al original
                                        }
                                    } else {
                                        resourceState = res.response; // fallback donde la respuesta no es json estricto (ej bucket creation)
                                    }
                                }

                                const outputMessage = {
                                    action: res.cli_command,
                                    resource_state: resourceState
                                };
                                
                                if (res.error) {
                                    outputMessage.error = res.error;
                                }

                                commandsEl.textContent += '\\n\\n' + JSON.stringify(outputMessage, null, 2);
                            }
                        });
                    }
                } catch (err) {
                    commandsEl.textContent += '\\n\\n[Error de parseo: ' + err.message + ']';
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
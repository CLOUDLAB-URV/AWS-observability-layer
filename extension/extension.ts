import * as vscode from 'vscode';
import { WebSocketServer } from 'ws';

export function activate(context: vscode.ExtensionContext) {
    let panel: vscode.WebviewPanel | undefined;
    let diagramState: string[] = ["graph TD"]; // Initial Mermaid syntax

    // Start local WebSocket Server
    const wss = new WebSocketServer({ port: 8765 });

    wss.on('connection', (ws) => {
        ws.on('message', (message) => {
            const msg = JSON.parse(message.toString());
            
            if (msg.type === 'mcp_intercept') {
                const toolName = msg.data.params.name;
                const toolArgs = msg.data.params.arguments;
                
                // Parse AWS API calls to build the diagram
                updateDiagramState(toolName, toolArgs, diagramState);
                
                // Send updated diagram to Webview
                if (panel) {
                    panel.webview.postMessage({ command: 'updateDiagram', text: diagramState.join('\n') });
                }
            }
        });
    });

    // Command to open the diagram view
    let disposable = vscode.commands.registerCommand('aws-mcp-diagram.show', () => {
        panel = vscode.window.createWebviewPanel(
            'awsDiagram',
            'Real-Time AWS Architecture',
            vscode.ViewColumn.Two,
            { enableScripts: true }
        );

        panel.webview.html = getWebviewContent(diagramState.join('\n'));
        
        panel.onDidDispose(() => { panel = undefined; }, null, context.subscriptions);
    });

    context.subscriptions.push(disposable);
}

function updateDiagramState(toolName: string, args: any, state: string[]) {
    // Example parsing logic based on AWS MCP tool names
    if (toolName.includes('ec2_run_instances')) {
        state.push(`    Internet --> EC2[EC2 Instance: ${args.InstanceType || 'Default'}]`);
    } else if (toolName.includes('s3_create_bucket')) {
        state.push(`    EC2 --> S3[(S3 Bucket: ${args.Bucket})]`);
    }
    // Add logic for RDS, DynamoDB, VPC, etc.
}

function getWebviewContent(initialDiagram: string) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <script type="module">
        import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs';
        mermaid.initialize({ startOnLoad: true, theme: 'dark' });

        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'updateDiagram') {
                const container = document.getElementById('diagram');
                container.innerHTML = message.text;
                container.removeAttribute('data-processed');
                mermaid.run({ nodes: [container] });
            }
        });
    </script>
</head>
<body>
    <h2>AWS Architecture</h2>
    <div class="mermaid" id="diagram">
        ${initialDiagram}
    </div>
</body>
</html>`;
}
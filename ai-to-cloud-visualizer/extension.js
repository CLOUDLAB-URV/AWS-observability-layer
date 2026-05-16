const vscode = require('vscode');
const { WebSocketServer } = require('ws');
const path = require('path');

/** @type {vscode.StatusBarItem} */
let myStatusBarItem;
/** @type {import('ws').WebSocketServer | null} */
let server = null;
/** @type {vscode.Uri | null} */
let currentOutputFileUri = null;
/** @type {Promise<void>} */
let writeQueue = Promise.resolve();

/**
 * @typedef {Object} ExistingJsonFilePick
 * @property {string} label
 * @property {string} description
 * @property {'existing'} mode
 * @property {vscode.Uri} uri
 */

/**
 * @typedef {Object} CreateJsonFilePick
 * @property {string} label
 * @property {string} description
 * @property {'create'} mode
 */

/** @typedef {ExistingJsonFilePick | CreateJsonFilePick} OutputFilePickItem */

/**
 * @typedef {Object} OutputMessage
 * @property {string} [action]
 * @property {unknown} [resource_state]
 * @property {string} [error]
 */

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
    const toggleCommand = vscode.commands.registerCommand('ai-to-cloud.toggleServer', async function () {
        if (server) {
            stopServer();
        } else {
            await startServer(context);
        }
    });

    context.subscriptions.push(toggleCommand);
}

/**
 * Starts the WebSocket server and configures persistent JSON output file
 * @param {vscode.ExtensionContext} context
 */
async function startServer(context) {
    const port = 8080;

    try {
        const selectedFileUri = await pickOrCreateJsonFile(context);
        if (!selectedFileUri) {
            return;
        }

        currentOutputFileUri = selectedFileUri;

        const document = await vscode.workspace.openTextDocument(selectedFileUri);
        await vscode.window.showTextDocument(document, { preview: false });

        server = new WebSocketServer({ port: port });
        
        server.on('connection', (socket) => {
            socket.on('message', (data) => {
                const payload = data.toString();

                // Serialize writes so rapid messages do not clobber each other.
                writeQueue = writeQueue
                    .then(() => appendPayloadToSelectedFile(payload))
                    .catch((error) => {
                        const message = error instanceof Error ? error.message : String(error);
                        vscode.window.showErrorMessage(`Failed to persist WebSocket payload: ${message}`);
                    });
            });
        });

        updateStatusBar(true);
        vscode.window.showInformationMessage(`AWS Visualizer Server started on port ${port}. Writing to ${path.basename(selectedFileUri.fsPath)}`);

    } catch (error) {
        server = null;
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
    currentOutputFileUri = null;
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
 * Shows a QuickPick to choose/create a persistent JSON output file.
 * @param {vscode.ExtensionContext} context
 * @returns {Promise<vscode.Uri | null>}
 */
async function pickOrCreateJsonFile(context) {
    await vscode.workspace.fs.createDirectory(context.globalStorageUri);

    const entries = await vscode.workspace.fs.readDirectory(context.globalStorageUri);
    /** @type {ExistingJsonFilePick[]} */
    const existingJsonFiles = entries
        .filter(([name, type]) => type === vscode.FileType.File && name.toLowerCase().endsWith('.json'))
        .map(([name]) => ({
            label: name,
            description: 'Existing JSON file',
            uri: vscode.Uri.joinPath(context.globalStorageUri, name),
            mode: 'existing'
        }));

    /** @type {CreateJsonFilePick} */
    const createItem = {
        label: '$(add) Create new JSON file',
        description: 'Create a new persistent JSON file in global storage',
        mode: 'create'
    };

    /** @type {OutputFilePickItem[]} */
    const quickPickItems = [...existingJsonFiles, createItem];

    /** @type {OutputFilePickItem | undefined} */
    const pick = await vscode.window.showQuickPick(quickPickItems, {
        placeHolder: 'Select a persistent JSON file for live WebSocket output',
        ignoreFocusOut: true
    });

    if (!pick) {
        return null;
    }

    if (pick.mode === 'existing') {
        return pick.uri;
    }

    const inputName = await vscode.window.showInputBox({
        prompt: 'Enter a name for the new JSON file',
        placeHolder: 'session-log.json',
        ignoreFocusOut: true,
        validateInput: (value) => {
            const trimmed = value.trim();
            if (!trimmed) {
                return 'File name is required.';
            }
            if (trimmed.includes('/') || trimmed.includes('\\')) {
                return 'Use a file name only, without path separators.';
            }
            return null;
        }
    });

    if (!inputName) {
        return null;
    }

    const normalizedName = inputName.trim().toLowerCase().endsWith('.json')
        ? inputName.trim()
        : `${inputName.trim()}.json`;
    const fileUri = vscode.Uri.joinPath(context.globalStorageUri, normalizedName);

    try {
        await vscode.workspace.fs.stat(fileUri);
    } catch {
        await vscode.workspace.fs.writeFile(fileUri, Buffer.from('[]', 'utf8'));
    }

    return fileUri;
}

/**
 * @param {string} payload
 * @returns {Promise<void>}
 */
async function appendPayloadToSelectedFile(payload) {
    if (!currentOutputFileUri) {
        return;
    }

    const outputMessages = extractOutputMessages(payload);
    if (outputMessages.length === 0) {
        return;
    }

    const existingContent = await readJsonFile(currentOutputFileUri);
    existingContent.push(...outputMessages);
    const updatedContent = `${JSON.stringify(existingContent, null, 2)}\n`;
    await vscode.workspace.fs.writeFile(currentOutputFileUri, Buffer.from(updatedContent, 'utf8'));
}

/**
 * @param {vscode.Uri} fileUri
 * @returns {Promise<OutputMessage[]>}
 */
async function readJsonFile(fileUri) {
    try {
        const bytes = await vscode.workspace.fs.readFile(fileUri);
        const text = Buffer.from(bytes).toString('utf8').trim();

        if (!text) {
            return [];
        }

        const parsed = JSON.parse(text);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

/**
 * @param {string} payload
 * @returns {OutputMessage[]}
 */
function extractOutputMessages(payload) {
    /** @type {OutputMessage[]} */
    const outputMessages = [];

    try {
        const structuredContent = JSON.parse(payload);

        // Ignorar suggestions (suggest_aws_commands) si vienen como tales
        if (structuredContent && structuredContent.suggestions) {
            return outputMessages;
        }

        // Iterar el array 'result' (sabiendo que nos llega estructurado directo del proxy)
        if (structuredContent && Array.isArray(structuredContent.result)) {
            const resultsArray = structuredContent.result;

            resultsArray.forEach(/** @param {any} res */ (res) => {
                // Ignoramos si no es una respuesta válida que tenga el comando a enseñar
                if (res.cli_command) {
                    let resourceState = {};

                    // Intentar extraer un payload as_json si lo tiene
                    if (res.response) {
                        if (typeof res.response.as_json !== 'undefined') {
                            try {
                                const parsedJson = typeof res.response.as_json === 'string'
                                    ? JSON.parse(res.response.as_json)
                                    : res.response.as_json;

                                if (parsedJson.ResponseMetadata) {
                                    delete parsedJson.ResponseMetadata;
                                }
                                resourceState = parsedJson;
                            } catch {
                                resourceState = res.response; // fallback al original
                            }
                        } else {
                            resourceState = res.response; // fallback donde la respuesta no es json estricto (ej bucket creation)
                        }
                    }

                    /** @type {OutputMessage} */
                    const outputMessage = {
                        action: res.cli_command,
                        resource_state: resourceState
                    };

                    if (res.error) {
                        outputMessage.error = res.error;
                    }

                    outputMessages.push(outputMessage);
                }
            });
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        outputMessages.push({
            error: `[Error de parseo: ${message}]`
        });
    }

    return outputMessages;
}

function deactivate() {
    stopServer();
}

module.exports = {
    activate,
    deactivate
}
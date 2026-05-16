const vscode = require('vscode');
const { WebSocketServer } = require('ws');
const path = require('path');

const PROJECT_FOLDERS = {
    fullWorkflow: 'full-workflow',
    queue: 'queue',
    diagrams: 'diagrams'
};

/** @type {vscode.StatusBarItem} */
let myStatusBarItem;
/** @type {import('ws').WebSocketServer | null} */
let server = null;
/** @type {ProjectFiles | null} */
let currentProjectFiles = null;
/** @type {Promise<void>} */
let writeQueue = Promise.resolve();

/**
 * @typedef {Object} ProjectFiles
 * @property {string} name
 * @property {vscode.Uri} fullWorkflowUri
 * @property {vscode.Uri} queueUri
 * @property {vscode.Uri} diagramUri
 */

/**
 * @typedef {Object} ExistingProjectPick
 * @property {string} label
 * @property {string} description
 * @property {'existing'} mode
 * @property {ProjectFiles} project
 */

/**
 * @typedef {Object} CreateProjectPick
 * @property {string} label
 * @property {string} description
 * @property {'create'} mode
 */

/** @typedef {ExistingProjectPick | CreateProjectPick} ProjectPickItem */

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
 * Starts the WebSocket server and configures persistent project output files
 * @param {vscode.ExtensionContext} context
 */
async function startServer(context) {
    const port = 8080;

    try {
        const selectedProject = await pickOrCreateProject(context);
        if (!selectedProject) {
            return;
        }

        currentProjectFiles = selectedProject;

        const document = await vscode.workspace.openTextDocument(selectedProject.fullWorkflowUri);
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
        vscode.window.showInformationMessage(
            `AWS Visualizer Server started on port ${port}. Project: ${selectedProject.name} (${path.basename(selectedProject.fullWorkflowUri.fsPath)})`
        );

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
    currentProjectFiles = null;
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
 * Shows a QuickPick to choose/create a persistent project.
 * @param {vscode.ExtensionContext} context
 * @returns {Promise<ProjectFiles | null>}
 */
async function pickOrCreateProject(context) {
    const folders = await ensureProjectFolders(context);

    const entries = await vscode.workspace.fs.readDirectory(folders.fullWorkflowDir);
    /** @type {ExistingProjectPick[]} */
    const existingProjects = entries
        .filter(([name, type]) => type === vscode.FileType.File && name.toLowerCase().endsWith('.json'))
        .map(([name]) => name.slice(0, -5))
        .map((projectName) => ({
            label: projectName,
            description: 'Existing project',
            mode: 'existing',
            project: {
                name: projectName,
                fullWorkflowUri: getProjectFileUri(folders.fullWorkflowDir, projectName, '.json'),
                queueUri: getProjectFileUri(folders.queueDir, projectName, '.json'),
                diagramUri: getProjectFileUri(folders.diagramsDir, projectName, '.d2')
            }
        }));

    /** @type {CreateProjectPick} */
    const createItem = {
        label: '$(add) Create new project',
        description: 'Create full-workflow, queue, and diagrams files',
        mode: 'create'
    };

    /** @type {ProjectPickItem[]} */
    const quickPickItems = [...existingProjects, createItem];

    /** @type {ProjectPickItem | undefined} */
    const pick = await vscode.window.showQuickPick(quickPickItems, {
        placeHolder: 'Select an existing project or create a new project',
        ignoreFocusOut: true
    });

    if (!pick) {
        return null;
    }

    if (pick.mode === 'existing') {
        return pick.project;
    }

    const projectName = await promptForProjectName();
    if (!projectName) {
        return null;
    }

    const project = {
        name: projectName,
        fullWorkflowUri: getProjectFileUri(folders.fullWorkflowDir, projectName, '.json'),
        queueUri: getProjectFileUri(folders.queueDir, projectName, '.json'),
        diagramUri: getProjectFileUri(folders.diagramsDir, projectName, '.d2')
    };

    const projectExists = await fileExists(project.fullWorkflowUri);
    if (projectExists) {
        vscode.window.showErrorMessage(`Project "${projectName}" already exists. Please choose it from the list.`);
        return null;
    }

    await Promise.all([
        vscode.workspace.fs.writeFile(project.fullWorkflowUri, Buffer.from('[]', 'utf8')),
        vscode.workspace.fs.writeFile(project.queueUri, Buffer.from('[]', 'utf8')),
        vscode.workspace.fs.writeFile(project.diagramUri, Buffer.from('', 'utf8'))
    ]);

    return project;
}

/**
 * @param {vscode.ExtensionContext} context
 * @returns {Promise<{fullWorkflowDir: vscode.Uri, queueDir: vscode.Uri, diagramsDir: vscode.Uri}>}
 */
async function ensureProjectFolders(context) {
    await vscode.workspace.fs.createDirectory(context.globalStorageUri);

    const fullWorkflowDir = vscode.Uri.joinPath(context.globalStorageUri, PROJECT_FOLDERS.fullWorkflow);
    const queueDir = vscode.Uri.joinPath(context.globalStorageUri, PROJECT_FOLDERS.queue);
    const diagramsDir = vscode.Uri.joinPath(context.globalStorageUri, PROJECT_FOLDERS.diagrams);

    await Promise.all([
        vscode.workspace.fs.createDirectory(fullWorkflowDir),
        vscode.workspace.fs.createDirectory(queueDir),
        vscode.workspace.fs.createDirectory(diagramsDir)
    ]);

    return { fullWorkflowDir, queueDir, diagramsDir };
}

/**
 * @returns {Promise<string | null>}
 */
async function promptForProjectName() {
    while (true) {
        const input = await vscode.window.showInputBox({
            prompt: 'Enter Project Name (base name only, no extension)',
            placeHolder: 'myProject',
            ignoreFocusOut: true,
            validateInput: (value) => {
                const trimmed = value.trim();
                if (!trimmed) {
                    return 'Project name is required.';
                }
                if (trimmed.includes('/') || trimmed.includes('\\')) {
                    return 'Use a project name only, without path separators.';
                }
                return null;
            }
        });

        if (!input) {
            return null;
        }

        const projectName = input.trim();
        if (projectName.includes('.')) {
            vscode.window.showErrorMessage('Project name must not include extensions. Do not use dots (.).');
            continue;
        }

        return projectName;
    }
}

/**
 * @param {vscode.Uri} directoryUri
 * @param {string} projectName
 * @param {string} extension
 * @returns {vscode.Uri}
 */
function getProjectFileUri(directoryUri, projectName, extension) {
    return vscode.Uri.joinPath(directoryUri, `${projectName}${extension}`);
}

/**
 * @param {vscode.Uri} fileUri
 * @returns {Promise<boolean>}
 */
async function fileExists(fileUri) {
    try {
        await vscode.workspace.fs.stat(fileUri);
        return true;
    } catch {
        return false;
    }
}

/**
 * @param {string} payload
 * @returns {Promise<void>}
 */
async function appendPayloadToSelectedFile(payload) {
    if (!currentProjectFiles) {
        return;
    }

    const outputMessages = extractOutputMessages(payload);
    if (outputMessages.length === 0) {
        return;
    }

    const [fullWorkflowContent, queueContent] = await Promise.all([
        readJsonFile(currentProjectFiles.fullWorkflowUri),
        readJsonFile(currentProjectFiles.queueUri)
    ]);

    fullWorkflowContent.push(...outputMessages);
    queueContent.push(...outputMessages);

    const fullWorkflowUpdatedContent = `${JSON.stringify(fullWorkflowContent, null, 2)}\n`;
    const queueUpdatedContent = `${JSON.stringify(queueContent, null, 2)}\n`;

    await Promise.all([
        vscode.workspace.fs.writeFile(currentProjectFiles.fullWorkflowUri, Buffer.from(fullWorkflowUpdatedContent, 'utf8')),
        vscode.workspace.fs.writeFile(currentProjectFiles.queueUri, Buffer.from(queueUpdatedContent, 'utf8'))
    ]);
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
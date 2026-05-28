const vscode = require('vscode');
const { WebSocketServer } = require('ws');
const path = require('path');

/** @type {vscode.StatusBarItem} */
let myStatusBarItem;
/** @type {import('ws').WebSocketServer | null} */
let server = null;
/** @type {ProjectFiles | null} */
let currentProjectFiles = null;
/** @type {vscode.WebviewPanel | null} */
let currentDiagramPanel = null;
/** @type {boolean} */
let diagramWebviewReady = false;
/** @type {Promise<any> | null} */
let d2RendererPromise = null;
/** @type {Promise<void>} */
let writeQueue = Promise.resolve();
/** @type {string} */
let currentPromptTemplate = 'default.md';

/**
 * @typedef {Object} ProjectFiles
 * @property {string} name
 * @property {vscode.Uri} dirUri
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

    context.subscriptions.push(vscode.commands.registerCommand('ai-to-cloud.startServer', async () => {
        if (!server) {
            await startServer(context);
        } else {
            vscode.window.showInformationMessage('AWS Visualizer Server is already running.');
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('ai-to-cloud.stopServer', () => {
        if (server) {
            stopServer();
        } else {
            vscode.window.showInformationMessage('AWS Visualizer Server is not running.');
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('ai-to-cloud.createProject', async () => {
        const projectName = await promptForProjectName();
        if (!projectName) return;
        
        const dirUri = vscode.Uri.joinPath(context.globalStorageUri, projectName);
        const projectExists = await fileExists(dirUri);
        
        if (projectExists) {
            vscode.window.showErrorMessage(`Project "${projectName}" already exists.`);
            return;
        }

        const project = {
            name: projectName,
            dirUri: dirUri,
            fullWorkflowUri: vscode.Uri.joinPath(dirUri, `${projectName}_workflow.json`),
            queueUri: vscode.Uri.joinPath(dirUri, `${projectName}_queue.json`),
            diagramUri: vscode.Uri.joinPath(dirUri, `${projectName}_diagram.d2`)
        };

        await vscode.workspace.fs.createDirectory(dirUri);
        await Promise.all([
            vscode.workspace.fs.writeFile(project.fullWorkflowUri, Buffer.from('[]', 'utf8')),
            vscode.workspace.fs.writeFile(project.queueUri, Buffer.from('[]', 'utf8')),
            vscode.workspace.fs.writeFile(project.diagramUri, Buffer.from('', 'utf8'))
        ]);
        
        vscode.window.showInformationMessage(`Project "${projectName}" created successfully!`);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('ai-to-cloud.changeActiveProject', async () => {
        const project = await pickExistingProject(context);
        if (!project) return;
        
        currentProjectFiles = project;
        vscode.window.showInformationMessage(`Active project changed to: ${project.name}`);
        
        // If webview is open, re-render it for the new project
        try {
            await openDiagramWorkspace(context, project);
        } catch (err) {
            console.error('Error switching webview for new project:', err);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('ai-to-cloud.deleteProject', async () => {
        const project = await pickExistingProject(context);
        if (!project) return;

        const confirmation = await vscode.window.showWarningMessage(
            `Are you sure you want to delete the project "${project.name}"? This action cannot be undone.`,
            { modal: true },
            'Delete',
            'Cancel'
        );

        if (confirmation !== 'Delete') {
            return;
        }

        try {
            await vscode.workspace.fs.delete(project.dirUri, { recursive: true });
            
            // If the deleted project was the active one, clear it
            if (currentProjectFiles && currentProjectFiles.name === project.name) {
                currentProjectFiles = null;
                disposeDiagramWorkspace();
            }
            
            vscode.window.showInformationMessage(`Project "${project.name}" has been deleted successfully.`);
        } catch (err) {
            vscode.window.showErrorMessage(`Failed to delete project: ${err instanceof Error ? err.message : String(err)}`);
        }
    }));

    // 3. Register the Project opening commands
    context.subscriptions.push(vscode.commands.registerCommand('ai-to-cloud.openProjectAll', async () => {
        const project = await pickExistingProject(context);
        if (!project) return;
        
        try {
            // Cierra todos los editores previamente abiertos
            await vscode.commands.executeCommand('workbench.action.closeAllEditors');

            const workflowExists = await fileExists(project.fullWorkflowUri);
            if (workflowExists) {
                const doc3 = await vscode.workspace.openTextDocument(project.fullWorkflowUri);
                // preview en false para que no sea sobreescrito por el siguiente doc
                await vscode.window.showTextDocument(doc3, { viewColumn: vscode.ViewColumn.One, preserveFocus: true, preview: false });
            } else {
                vscode.window.showWarningMessage(`Workflow file not found for ${project.name}`);
            }

            const queueExists = await fileExists(project.queueUri);
            if (queueExists) {
                const doc2 = await vscode.workspace.openTextDocument(project.queueUri);
                await vscode.window.showTextDocument(doc2, { viewColumn: vscode.ViewColumn.One, preserveFocus: true, preview: false });
            } else {
                vscode.window.showWarningMessage(`Queue file not found for ${project.name}`);
            }

            const diagramExists = await fileExists(project.diagramUri);
            if (!diagramExists) {
                vscode.window.showWarningMessage(`Diagram file not found for ${project.name}`);
            }

            await openDiagramWorkspace(context, project);
        } catch (err) {
            vscode.window.showErrorMessage(`Error opening files: ${err instanceof Error ? err.message : String(err)}`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('ai-to-cloud.openProjectQueue', async () => {
        const project = await pickExistingProject(context);
        if (!project) return;
        if (await fileExists(project.queueUri)) {
            const doc = await vscode.workspace.openTextDocument(project.queueUri);
            await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preserveFocus: false, preview: false });
        } else {
            vscode.window.showWarningMessage(`Queue file not found for ${project.name}`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('ai-to-cloud.openProjectDiagram', async () => {
        const project = await pickExistingProject(context);
        if (!project) return;
        if (await fileExists(project.diagramUri)) {
            const doc = await vscode.workspace.openTextDocument(project.diagramUri);
            await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Two, preserveFocus: false, preview: false });
        } else {
            vscode.window.showWarningMessage(`Diagram file not found for ${project.name}`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('ai-to-cloud.openProjectWorkflow', async () => {
        const project = await pickExistingProject(context);
        if (!project) return;
        if (await fileExists(project.fullWorkflowUri)) {
            const doc = await vscode.workspace.openTextDocument(project.fullWorkflowUri);
            await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preserveFocus: false, preview: false });
        } else {
            vscode.window.showWarningMessage(`Workflow file not found for ${project.name}`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('ai-to-cloud.openProjectWebview', async () => {
        const project = await pickExistingProject(context);
        if (!project) return;
        try {
            await openDiagramWorkspace(context, project);
        } catch (err) {
            vscode.window.showErrorMessage(`Error opening webview: ${err instanceof Error ? err.message : String(err)}`);
        }
    }));
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

        await openDiagramWorkspace(context, selectedProject);

        // Abre el resto de archivos en el editor de forma simultánea
        try {
            const workflowDoc = await vscode.workspace.openTextDocument(selectedProject.fullWorkflowUri);
            await vscode.window.showTextDocument(workflowDoc, { preview: false, viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });
            
            const queueDoc = await vscode.workspace.openTextDocument(selectedProject.queueUri);
            await vscode.window.showTextDocument(queueDoc, { preview: false, viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });
        } catch (err) {
            console.error('Error opening project files:', err);
        }

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
    // disposeDiagramWorkspace(); // Removed to keep diagram and webview open
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
 * Shows a QuickPick to choose an existing persistent project.
 * @param {vscode.ExtensionContext} context
 * @returns {Promise<ProjectFiles | null>}
 */
async function pickExistingProject(context) {
    try {
        await vscode.workspace.fs.createDirectory(context.globalStorageUri);
    } catch {}

    const entries = await vscode.workspace.fs.readDirectory(context.globalStorageUri);
    
    /** @type {any[]} */
    const existingProjects = entries
        .filter(([name, type]) => type === vscode.FileType.Directory && !name.startsWith('.'))
        .map(([projectName]) => {
            const dirUri = vscode.Uri.joinPath(context.globalStorageUri, projectName);
            const isActive = currentProjectFiles && currentProjectFiles.name === projectName;
            return {
                label: isActive ? `$(radio-tower) ${projectName}` : projectName,
                description: isActive ? '(Active / Listening)' : 'Existing project folder',
                isActive: isActive,
                project: {
                    name: projectName,
                    dirUri: dirUri,
                    fullWorkflowUri: vscode.Uri.joinPath(dirUri, `${projectName}_workflow.json`),
                    queueUri: vscode.Uri.joinPath(dirUri, `${projectName}_queue.json`),
                    diagramUri: vscode.Uri.joinPath(dirUri, `${projectName}_diagram.d2`)
                }
            };
        });

    if (existingProjects.length === 0) {
        vscode.window.showWarningMessage('No existing projects found.');
        return null;
    }

    // Sort active project to the top
    existingProjects.sort((a, b) => {
        if (a.isActive && !b.isActive) return -1;
        if (!a.isActive && b.isActive) return 1;
        return a.label.localeCompare(b.label);
    });

    const pick = await vscode.window.showQuickPick(existingProjects, {
        placeHolder: 'Select an existing project',
        ignoreFocusOut: true
    });

    return pick ? pick.project : null;
}

/**
 * Shows a QuickPick to choose/create a persistent project.
 * @param {vscode.ExtensionContext} context
 * @returns {Promise<ProjectFiles | null>}
 */
async function pickOrCreateProject(context) {
    await vscode.workspace.fs.createDirectory(context.globalStorageUri);

    const entries = await vscode.workspace.fs.readDirectory(context.globalStorageUri);
    /** @type {ExistingProjectPick[]} */
    const existingProjects = entries
        .filter(([name, type]) => type === vscode.FileType.Directory && !name.startsWith('.'))
        .map(([projectName]) => {
            const dirUri = vscode.Uri.joinPath(context.globalStorageUri, projectName);
            return {
                label: projectName,
                description: 'Existing project folder',
                mode: 'existing',
                project: {
                    name: projectName,
                    dirUri: dirUri,
                    fullWorkflowUri: vscode.Uri.joinPath(dirUri, `${projectName}_workflow.json`),
                    queueUri: vscode.Uri.joinPath(dirUri, `${projectName}_queue.json`),
                    diagramUri: vscode.Uri.joinPath(dirUri, `${projectName}_diagram.d2`)
                }
            };
        });

    /** @type {CreateProjectPick} */
    const createItem = {
        label: '$(add) Create new project',
        description: 'Create an isolated project folder with workflow, queue, and diagram files',
        mode: 'create'
    };

    /** @type {ProjectPickItem[]} */
    const quickPickItems = [...existingProjects, createItem];

    /** @type {ProjectPickItem | undefined} */
    const pick = await vscode.window.showQuickPick(quickPickItems, {
        placeHolder: 'Select an existing project folder or create a new project',
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

    const dirUri = vscode.Uri.joinPath(context.globalStorageUri, projectName);

    const project = {
        name: projectName,
        dirUri: dirUri,
        fullWorkflowUri: vscode.Uri.joinPath(dirUri, `${projectName}_workflow.json`),
        queueUri: vscode.Uri.joinPath(dirUri, `${projectName}_queue.json`),
        diagramUri: vscode.Uri.joinPath(dirUri, `${projectName}_diagram.d2`)
    };

    const projectExists = await fileExists(dirUri);
    if (projectExists) {
        vscode.window.showErrorMessage(`Project "${projectName}" already exists. Please choose it from the list.`);
        return null;
    }

    await vscode.workspace.fs.createDirectory(dirUri);
    await Promise.all([
        vscode.workspace.fs.writeFile(project.fullWorkflowUri, Buffer.from('[]', 'utf8')),
        vscode.workspace.fs.writeFile(project.queueUri, Buffer.from('[]', 'utf8')),
        vscode.workspace.fs.writeFile(project.diagramUri, Buffer.from('', 'utf8'))
    ]);

    return project;
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
 * @param {vscode.ExtensionContext} context
 * @param {ProjectFiles} project
 * @returns {Promise<void>}
 */
async function openDiagramWorkspace(context, project) {
    if (currentDiagramPanel) {
        // Reuse existing panel
        currentDiagramPanel.title = `D2 Visualizer: ${project.name}`;
        diagramWebviewReady = false;
        const initialResult = await loadDiagramRenderResult(project.diagramUri);
        currentDiagramPanel.webview.html = getDiagramWebviewContent(currentDiagramPanel.webview, initialResult.svg, initialResult.error);
        currentDiagramPanel.reveal(vscode.ViewColumn.Two, true);
    } else {
        diagramWebviewReady = false;
        const initialResult = await loadDiagramRenderResult(project.diagramUri);

        currentDiagramPanel = vscode.window.createWebviewPanel(
            'd2Visualizer',
            `D2 Visualizer: ${project.name}`,
            { viewColumn: vscode.ViewColumn.Two, preserveFocus: true },
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        currentDiagramPanel.onDidDispose(() => {
            if (currentDiagramPanel === null) {
                return;
            }

            currentDiagramPanel = null;
            diagramWebviewReady = false;
        }, null, context.subscriptions);

        currentDiagramPanel.webview.onDidReceiveMessage((message) => {
            if (message && message.type === 'ready') {
                diagramWebviewReady = true;
                if (initialResult.error) {
                    flushDiagramError(initialResult.error);
                    return;
                }
                flushDiagramUpdate(initialResult.svg);
            }

            if (message && message.type === 'reload-diagram') {
                refreshDiagramFromFile(project).catch((error) => {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    flushDiagramError(errorMessage);
                });
            }

            if (message && message.type === 'update-rendering') {
                handleUpdateRendering(context, project).catch((error) => {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    vscode.window.showErrorMessage(`Update Rendering failed: ${errorMessage}`);
                    flushDiagramError(`Update Rendering failed: ${errorMessage}`);
                });
            }

            if (message && message.type === 'update-rendering-vscode') {
                handleUpdateRenderingVSCode(context, project).catch((error) => {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    vscode.window.showErrorMessage(`Copilot Update failed: ${errorMessage}`);
                    flushDiagramError(`Copilot Update failed: ${errorMessage}`);
                });
            }

            if (message && message.type === 'select-prompt') {
                selectPromptTemplate(context).catch((error) => {
                    console.error('Failed to select prompt template:', error);
                });
            }
        }, null, context.subscriptions);

        currentDiagramPanel.webview.html = getDiagramWebviewContent(currentDiagramPanel.webview, initialResult.svg, initialResult.error);
    }

    const document = await vscode.workspace.openTextDocument(project.diagramUri);
    await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.Two, preserveFocus: false });
}

/**
 * @param {string} svgContent
 */
function flushDiagramUpdate(svgContent) {
    if (!currentDiagramPanel || !diagramWebviewReady) {
        return;
    }

    currentDiagramPanel.webview.postMessage({
        type: 'render-svg',
        content: svgContent
    });
}

/**
 * @param {string} errorMessage
 */
function flushDiagramError(errorMessage) {
    if (!currentDiagramPanel || !diagramWebviewReady) {
        return;
    }

    currentDiagramPanel.webview.postMessage({
        type: 'render-error',
        content: errorMessage
    });
}

/**
 * @param {ProjectFiles} project
 * @returns {Promise<void>}
 */
async function refreshDiagramFromFile(project) {
    const result = await loadDiagramRenderResult(project.diagramUri);
    if (result.error) {
        flushDiagramError(result.error);
        return;
    }

    flushDiagramUpdate(result.svg);
}

function disposeDiagramWorkspace() {
    if (currentDiagramPanel) {
        currentDiagramPanel.dispose();
        currentDiagramPanel = null;
    }

    diagramWebviewReady = false;
}

async function getD2Renderer() {
    if (!d2RendererPromise) {
        d2RendererPromise = import('@terrastruct/d2').then(({ D2 }) => new D2());
    }

    return d2RendererPromise;
}

/**
 * @param {string} diagramText
 * @returns {Promise<string>}
 */
async function renderDiagramSvg(diagramText) {
    const text = (diagramText ?? '').trim();
    if (!text) {
        return '';
    }

    const d2 = await getD2Renderer();
    const compiled = await d2.compile(text);
    const svg = await d2.render(compiled.diagram, compiled.renderOptions);
    return typeof svg === 'string' ? svg : String(svg);
}

/**
 * @param {vscode.Uri} fileUri
 * @returns {Promise<{svg: string, error: string | null}>}
 */
async function loadDiagramRenderResult(fileUri) {
    const diagramText = await readDiagramText(fileUri);

    try {
        const svg = await renderDiagramSvg(diagramText);
        return { svg, error: null };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { svg: '', error: message };
    }
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
 * @param {vscode.Uri} fileUri
 * @returns {Promise<string>}
 */
async function readDiagramText(fileUri) {
    try {
        const bytes = await vscode.workspace.fs.readFile(fileUri);
        return Buffer.from(bytes).toString('utf8');
    } catch {
        return '';
    }
}

/**
 * @param {vscode.ExtensionContext} context
 * @returns {Promise<void>}
 */
async function selectPromptTemplate(context) {
    const promptsDir = vscode.Uri.joinPath(context.extensionUri, 'prompts');
    let entries = [];
    try {
        entries = await vscode.workspace.fs.readDirectory(promptsDir);
    } catch (err) {
        vscode.window.showErrorMessage('Could not read prompts directory.');
        return;
    }

    const mdFiles = entries
        .filter(([name, type]) => type === vscode.FileType.File && name.endsWith('.md'))
        .map(([name]) => name.replace('.md', ''));

    if (mdFiles.length === 0) {
        vscode.window.showWarningMessage('No prompts found.');
        return;
    }

    const selected = await vscode.window.showQuickPick(mdFiles, {
        placeHolder: 'Select a prompt template'
    });

    if (selected) {
        currentPromptTemplate = selected + '.md';
        if (currentDiagramPanel && diagramWebviewReady) {
            currentDiagramPanel.webview.postMessage({
                type: 'active-prompt-changed',
                content: selected
            });
        }
    }
}

/**
 * @param {vscode.Webview} webview
 * @param {string} initialSvg
 * @param {string | null} initialError
 * @returns {string}
 */
function getDiagramWebviewContent(webview, initialSvg, initialError) {
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <title>D2 Visualizer</title>
    <style>
        :root {
            color-scheme: light dark;
            --bg: #0b1020;
            --panel: #11172d;
            --border: rgba(148, 163, 184, 0.22);
            --text: #dbe4ff;
            --muted: #8da2c0;
            --accent: #7dd3fc;
            --error: #fca5a5;
        }
        body {
            margin: 0;
            width: 100vw;
            height: 100vh;
            overflow: hidden;
            background: radial-gradient(circle at top left, rgba(125, 211, 252, 0.16), transparent 34%), var(--bg);
            color: var(--text);
            font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
        }
        .shell {
            display: grid;
            grid-template-rows: auto 1fr;
            height: 100vh;
        }
        .header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            padding: 14px 18px;
            border-bottom: 1px solid var(--border);
            background: rgba(17, 23, 45, 0.9);
            backdrop-filter: blur(12px);
        }
        .title {
            font-size: 13px;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            color: var(--accent);
        }
        .status {
            color: var(--muted);
            font-size: 12px;
        }
        .toolbar {
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .reload-btn {
            border: 1px solid rgba(125, 211, 252, 0.45);
            background: linear-gradient(180deg, rgba(125, 211, 252, 0.22), rgba(56, 189, 248, 0.12));
            color: var(--text);
            padding: 7px 12px;
            border-radius: 10px;
            font-size: 12px;
            font-weight: 600;
            letter-spacing: 0.02em;
            cursor: pointer;
            transition: transform 120ms ease, border-color 120ms ease, background 120ms ease;
        }
        .reload-btn:hover {
            transform: translateY(-1px);
            border-color: rgba(125, 211, 252, 0.8);
            background: linear-gradient(180deg, rgba(125, 211, 252, 0.3), rgba(56, 189, 248, 0.2));
        }
        .reload-btn:active {
            transform: translateY(0);
        }
        .stage {
            position: relative;
            overflow: hidden;
            background:
                linear-gradient(rgba(125, 211, 252, 0.05) 1px, transparent 1px),
                linear-gradient(90deg, rgba(125, 211, 252, 0.05) 1px, transparent 1px);
            background-size: 32px 32px;
            cursor: grab;
        }
        .stage:active {
            cursor: grabbing;
        }
        .diagram {
            width: 100%;
            height: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
            box-sizing: border-box;
            transform-origin: 0 0;
            will-change: transform;
        }
        .empty,
        .error {
            max-width: 680px;
            padding: 18px 20px;
            border-radius: 14px;
            border: 1px solid var(--border);
            background: rgba(17, 23, 45, 0.82);
            box-shadow: 0 18px 48px rgba(0, 0, 0, 0.28);
        }
        .empty {
            color: var(--muted);
        }
        .error {
            color: var(--error);
            white-space: pre-wrap;
        }
        .svg-wrap svg {
            max-width: none;
        }
    </style>
</head>
<body>
    <div class="shell">
        <div class="header">
            <div>
                <div class="title">D2 Visualizer</div>
                <div class="status" id="status">Press Reload / Compile after editing the .d2 file.</div>
            </div>
            <div class="toolbar">
                <button class="reload-btn" id="updateBtn" type="button">Update (MCP)</button>
                <button class="reload-btn" id="updateVscodeBtn" type="button">Update (Copilot)</button>
                <button class="reload-btn" id="reloadBtn" type="button">Reload / Compile</button>
                <div class="status" id="activePromptDisplay">${currentPromptTemplate.replace('.md', '')}</div>
                <button class="reload-btn" id="selectPromptBtn" type="button" title="Select Prompt Template" style="padding: 6px 8px; display: flex; align-items: center; justify-content: center;">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="12" cy="12" r="3"></circle>
                        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 1.65 1.65 0 0 0-1.51 1z"></path>
                    </svg>
                </button>
            </div>
        </div>
        <div class="stage">
            <div class="diagram svg-wrap" id="diagram"></div>
        </div>
    </div>
    <script type="module" nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const diagramEl = document.getElementById('diagram');
        const statusEl = document.getElementById('status');
        const reloadBtn = document.getElementById('reloadBtn');
        const updateBtn = document.getElementById('updateBtn');
        const updateVscodeBtn = document.getElementById('updateVscodeBtn');
        const selectPromptBtn = document.getElementById('selectPromptBtn');
        const activePromptDisplay = document.getElementById('activePromptDisplay');

        function escapeHtml(value) {
            return value
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        }

        function setEmptyState(message) {
            diagramEl.innerHTML = '<div class="empty">' + escapeHtml(message) + '</div>';
            statusEl.textContent = message;
        }

        function setErrorState(message) {
            diagramEl.innerHTML = '<div class="error">' + escapeHtml(message) + '</div>';
            statusEl.textContent = 'Render failed';
        }

        function requestReload() {
            statusEl.textContent = 'Compiling latest diagram...';
            vscode.postMessage({ type: 'reload-diagram' });
        }

        function requestUpdate() {
            statusEl.textContent = 'Gathering queued commands (MCP)...';
            vscode.postMessage({ type: 'update-rendering' });
        }

        function requestUpdateVSCode() {
            statusEl.textContent = 'Generating with Copilot...';
            vscode.postMessage({ type: 'update-rendering-vscode' });
        }

        reloadBtn.addEventListener('click', requestReload);
        updateBtn.addEventListener('click', requestUpdate);
        updateVscodeBtn.addEventListener('click', requestUpdateVSCode);
        selectPromptBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'select-prompt' });
        });

        window.addEventListener('message', (event) => {
            const message = event.data;
            if (message && message.type === 'active-prompt-changed') {
                activePromptDisplay.textContent = message.content;
            }

            if (message && message.type === 'render-svg') {
                if (!message.content) {
                    setEmptyState('The selected .d2 file is empty. Add D2 text to render the diagram.');
                    return;
                }

                diagramEl.innerHTML = message.content;
                statusEl.textContent = 'Compiled from latest file content';
            }

            if (message && message.type === 'render-error') {
                setErrorState(message.content || 'Unknown compilation error');
            }
        });

        vscode.postMessage({ type: 'ready' });
        ${initialError ? `setErrorState(${JSON.stringify(initialError)});` : (initialSvg ? `diagramEl.innerHTML = ${JSON.stringify(initialSvg)}; statusEl.textContent = 'Compiled from latest file content';` : `setEmptyState('The selected .d2 file is empty. Add D2 text to render the diagram.');`)}

        // Zoom and Pan logic for the diagram stage
        const stage = document.querySelector('.stage');
        let scale = 1;
        let pointX = 0;
        let pointY = 0;
        let panning = false;
        let start = { x: 0, y: 0 };

        function updateTransform() {
            diagramEl.style.transform = \`translate(\${pointX}px, \${pointY}px) scale(\${scale})\`;
        }

        stage.addEventListener('mousedown', (e) => {
            e.preventDefault();
            start = { x: e.clientX - pointX, y: e.clientY - pointY };
            panning = true;
        });

        window.addEventListener('mouseup', () => {
            panning = false;
        });

        window.addEventListener('mousemove', (e) => {
            if (!panning) return;
            e.preventDefault();
            pointX = e.clientX - start.x;
            pointY = e.clientY - start.y;
            updateTransform();
        });

        stage.addEventListener('wheel', (e) => {
            e.preventDefault();
            const rect = stage.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;

            const zoomIntensity = 0.1;
            const wheel = e.deltaY < 0 ? 1 : -1;
            const zoomFactor = Math.exp(wheel * zoomIntensity);
            
            const newScale = scale * zoomFactor;

            // Adjust translation to effectively zoom into the mouse cursor
            pointX = mouseX - (mouseX - pointX) * zoomFactor;
            pointY = mouseY - (mouseY - pointY) * zoomFactor;
            scale = newScale;

            updateTransform();
        }, { passive: false });
    </script>
</body>
</html>`;
}

/**
 * @returns {string}
 */
function getNonce() {
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let value = '';
    for (let index = 0; index < 32; index += 1) {
        value += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return value;
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

/**
 * Handles the logic for the "Update Rendering" button.
 * @param {vscode.ExtensionContext} context
 * @param {ProjectFiles} project
 * @returns {Promise<void>}
 */
async function handleUpdateRendering(context, project) {
    // 1. Read the selected prompt template
    const templateUri = vscode.Uri.joinPath(context.extensionUri, 'prompts', currentPromptTemplate);
    let templateContent = '';
    try {
        const templateBytes = await vscode.workspace.fs.readFile(templateUri);
        templateContent = Buffer.from(templateBytes).toString('utf8');
    } catch (err) {
        throw new Error(`Could not read ${currentPromptTemplate} template: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 2. Read current D2 diagram string
    const d2Content = await readDiagramText(project.diagramUri);

    // 3. Read queued commands
    const queueContent = await readJsonFile(project.queueUri);
    const queueString = JSON.stringify(queueContent, null, 2);

    // 4. Interpolate
    const promptStr = templateContent
        .replace('[D2_CURRENT_STATE]', d2Content)
        .replace('[AWS_COMMAND_QUEUE]', queueString);

    // 6. Save the generated prompt for history
    const promptsDir = vscode.Uri.joinPath(project.dirUri, 'prompts');
    try {
        await vscode.workspace.fs.createDirectory(promptsDir);
    } catch {
        // Ignored if it already exists
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const promptFileName = `${timestamp}_${project.name}.md`;
    const promptUri = vscode.Uri.joinPath(promptsDir, promptFileName);

    await vscode.workspace.fs.writeFile(promptUri, Buffer.from(promptStr, 'utf8'));

    vscode.window.showInformationMessage(`Prompt saved to ${promptFileName}, requesting new diagram from LLM...`);

    // 7. Request LLM Inference via proxy server
    try {
        const response = await fetch('http://127.0.0.1:8081/api/generate-d2', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: promptStr })
        });

        if (!response.ok) {
            throw new Error(`Proxy responded with status ${response.status}: ${await response.text()}`);
        }

        const data = await response.json();
        
        if (!response.ok || !data.success) {
            throw new Error(`Proxy/LLM Error: ${data.error || response.statusText}`);
        }

        if (!data.d2Code) {
            throw new Error("Proxy succeeded but returned empty D2 code");
        }

        // 8. Overwrite existing .d2 file
        await vscode.workspace.fs.writeFile(project.diagramUri, Buffer.from(data.d2Code, 'utf8'));

        // 9. Now safely clear the queue
        await vscode.workspace.fs.writeFile(project.queueUri, Buffer.from('[]', 'utf8'));

        // 10. Re-render UI
        vscode.window.showInformationMessage('D2 Diagram updated successfully.');
        await refreshDiagramFromFile(project);

    } catch (err) {
        throw new Error(`LLM Update failed: ${err instanceof Error ? err.message : String(err)}`);
    }
}

/**
 * Handles the logic for the "Update (Copilot)" button using Native VS Code Copilot API.
 * @param {vscode.ExtensionContext} context
 * @param {ProjectFiles} project
 * @returns {Promise<void>}
 */
async function handleUpdateRenderingVSCode(context, project) {
    // 1. Read the selected prompt template
    const templateUri = vscode.Uri.joinPath(context.extensionUri, 'prompts', currentPromptTemplate);
    let templateContent = '';
    try {
        const templateBytes = await vscode.workspace.fs.readFile(templateUri);
        templateContent = Buffer.from(templateBytes).toString('utf8');
    } catch (err) {
        throw new Error(`Could not read ${currentPromptTemplate} template: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 2. Read current D2 diagram string
    const d2Content = await readDiagramText(project.diagramUri);

    // 3. Read queued commands
    const queueContent = await readJsonFile(project.queueUri);
    const queueString = JSON.stringify(queueContent, null, 2);

    // 4. Interpolate
    const promptStr = templateContent
        .replace('[D2_CURRENT_STATE]', d2Content)
        .replace('[AWS_COMMAND_QUEUE]', queueString);

    // 5. Save the generated prompt for history
    const promptsDir = vscode.Uri.joinPath(project.dirUri, 'prompts');
    try {
        await vscode.workspace.fs.createDirectory(promptsDir);
    } catch {
        // Ignored if it already exists
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const promptFileName = `${timestamp}_${project.name}_vscode.md`;
    const promptUri = vscode.Uri.joinPath(promptsDir, promptFileName);

    await vscode.workspace.fs.writeFile(promptUri, Buffer.from(promptStr, 'utf8'));

    vscode.window.showInformationMessage(`Prompt saved to ${promptFileName}, requesting new diagram from VS Code Copilot...`);

    // 6. Request VS Code Language Models
    try {
        const allModels = await vscode.lm.selectChatModels({});
        if (allModels.length === 0) {
             throw new Error("No VS Code Language Models available. Is GitHub Copilot extension active?");
        }

        const modelItems = allModels.map(m => ({
            label: m.name,
            description: `Family: ${m.family} | Vendor: ${m.vendor}`,
            model: m
        }));

        const selectedPick = await vscode.window.showQuickPick(modelItems, {
            placeHolder: 'Select a Language Model for Copilot Inference',
            ignoreFocusOut: true
        });

        if (!selectedPick) {
            vscode.window.showInformationMessage('Model selection cancelled.');
            return;
        }

        const model = selectedPick.model;

        const messages = [
            vscode.LanguageModelChatMessage.User(promptStr)
        ];

        const chatResponse = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);
        
        let d2Code = '';
        for await (const fragment of chatResponse.text) {
            d2Code += fragment;
        }

        // Cleanup potential markdown wrappers
        d2Code = d2Code.replace(/^```d2\n/im, '').replace(/\n```$/im, '').trim();
        if (d2Code.startsWith('```')) {
             d2Code = d2Code.split('\n').slice(1, -1).join('\n');
        }

        if (!d2Code) {
            throw new Error("Copilot succeeded but returned an empty response.");
        }

        // 7. Overwrite existing .d2 file
        await vscode.workspace.fs.writeFile(project.diagramUri, Buffer.from(d2Code, 'utf8'));

        // 8. Safely clear the queue
        await vscode.workspace.fs.writeFile(project.queueUri, Buffer.from('[]', 'utf8'));

        // 9. Re-render UI
        vscode.window.showInformationMessage('D2 Diagram updated successfully via Copilot.');
        await refreshDiagramFromFile(project);

    } catch (err) {
        throw new Error(`Copilot Inference failed: ${err instanceof Error ? err.message : String(err)}`);
    }
}

function deactivate() {
    stopServer();
}

module.exports = {
    activate,
    deactivate
}
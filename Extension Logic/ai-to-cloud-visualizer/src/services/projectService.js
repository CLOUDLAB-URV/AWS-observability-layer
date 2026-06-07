// @ts-nocheck

'use strict';

const vscode = require('vscode');
const { ensureDirectory, fileExists } = require('../utils/fileSystem');

/**
 * @param {vscode.Uri} directoryUri
 * @param {string} projectName
 */
function buildProjectFiles(directoryUri, projectName) {
    return {
        name: projectName,
        dirUri: directoryUri,
        fullWorkflowUri: vscode.Uri.joinPath(directoryUri, `${projectName}_workflow.json`),
        queueUri: vscode.Uri.joinPath(directoryUri, `${projectName}_queue.json`),
        diagramUri: vscode.Uri.joinPath(directoryUri, `${projectName}_diagram.d2`)
    };
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {string} projectName
 */
async function createProjectInStorage(context, projectName) {
    await ensureDirectory(context.globalStorageUri);

    const dirUri = vscode.Uri.joinPath(context.globalStorageUri, projectName);
    if (await fileExists(dirUri)) {
        throw new Error(`Project "${projectName}" already exists.`);
    }

    const project = buildProjectFiles(dirUri, projectName);
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
 * @param {vscode.ExtensionContext} context
 * @param {import('../state/appState').createAppState} state
 */
async function pickExistingProject(context, state) {
    await ensureDirectory(context.globalStorageUri);
    const entries = await vscode.workspace.fs.readDirectory(context.globalStorageUri);

    const existingProjects = entries
        .filter(([name, type]) => type === vscode.FileType.Directory && !name.startsWith('.'))
        .map(([projectName]) => {
            const dirUri = vscode.Uri.joinPath(context.globalStorageUri, projectName);
            const isActive = Boolean(state.currentProjectFiles && state.currentProjectFiles.name === projectName);
            return {
                label: isActive ? `$(radio-tower) ${projectName}` : projectName,
                description: isActive ? '(Active / Listening)' : 'Existing project folder',
                isActive,
                sortKey: projectName.toLowerCase(),
                project: buildProjectFiles(dirUri, projectName)
            };
        });

    if (existingProjects.length === 0) {
        vscode.window.showWarningMessage('No existing projects found.');
        return null;
    }

    existingProjects.sort((a, b) => {
        if (a.isActive && !b.isActive) {
            return -1;
        }

        if (!a.isActive && b.isActive) {
            return 1;
        }

        return a.sortKey.localeCompare(b.sortKey);
    });

    const pick = await vscode.window.showQuickPick(existingProjects, {
        placeHolder: 'Select an existing project',
        ignoreFocusOut: true
    });

    return pick ? pick.project : null;
}

/**
 * @param {vscode.ExtensionContext} context
 * @returns {Promise<import('./projectService').ProjectFiles | null>}
 */
async function pickOrCreateProject(context) {
    await ensureDirectory(context.globalStorageUri);
    const entries = await vscode.workspace.fs.readDirectory(context.globalStorageUri);

    const existingProjects = entries
        .filter(([name, type]) => type === vscode.FileType.Directory && !name.startsWith('.'))
        .map(([projectName]) => ({
            label: projectName,
            description: 'Existing project folder',
            mode: 'existing',
            project: buildProjectFiles(vscode.Uri.joinPath(context.globalStorageUri, projectName), projectName)
        }));

    const createItem = {
        label: '$(add) Create new project',
        description: 'Create an isolated project folder with workflow, queue, and diagram files',
        mode: 'create'
    };

    const quickPickItems = [...existingProjects, createItem];
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

    return createProjectInStorage(context, projectName);
}

/**
 * @param {vscode.Uri} projectDirUri
 */
async function deleteProjectDirectory(projectDirUri) {
    await vscode.workspace.fs.delete(projectDirUri, { recursive: true });
}

module.exports = {
    buildProjectFiles,
    createProjectInStorage,
    deleteProjectDirectory,
    pickExistingProject,
    pickOrCreateProject,
    promptForProjectName
};

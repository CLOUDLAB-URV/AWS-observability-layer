// @ts-nocheck

'use strict';

const vscode = require('vscode');
const path = require('path');
const { fileExists } = require('../utils/fileSystem');
const { appendPayloadToSelectedFile, startWebSocketServer, stopServer } = require('../services/serverService');
const { createProjectInStorage, deleteProjectDirectory, pickExistingProject, pickOrCreateProject, promptForProjectName } = require('../services/projectService');
const { disposeDiagramWorkspace, openDiagramWorkspace } = require('../services/diagramService');
const { selectPromptTemplate } = require('../services/promptService');

/**
 * @param {object} state
 * @param {boolean} running
 */
function updateStatusBar(state, running) {
    if (!state.statusBarItem) {
        return;
    }

    if (running) {
        state.statusBarItem.text = '$(zap) AWS: Running';
        state.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        state.statusBarItem.tooltip = 'Click to stop the server';
        return;
    }

    state.statusBarItem.text = '$(primitive-square) AWS: Stopped';
    state.statusBarItem.backgroundColor = undefined;
    state.statusBarItem.tooltip = 'Click to start the server';
}

/**
 * @param {import('vscode').ExtensionContext} context
 * @param {object} state
 */
async function startServer(context, state) {
    const port = 8080;

    try {
        const selectedProject = await pickOrCreateProject(context);
        if (!selectedProject) {
            return;
        }

        state.currentProjectFiles = selectedProject;
        await openDiagramWorkspace(context, state, selectedProject);

        try {
            const workflowDoc = await vscode.workspace.openTextDocument(selectedProject.fullWorkflowUri);
            await vscode.window.showTextDocument(workflowDoc, { preview: false, viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });

            const queueDoc = await vscode.workspace.openTextDocument(selectedProject.queueUri);
            await vscode.window.showTextDocument(queueDoc, { preview: false, viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });
        } catch (error) {
            console.error('Error opening project files:', error);
        }

        startWebSocketServer(state, port, (payload) => appendPayloadToSelectedFile(state, payload));
        updateStatusBar(state, true);
        vscode.window.showInformationMessage(
            `AWS Visualizer Server started on port ${port}. Project: ${selectedProject.name} (${path.basename(selectedProject.fullWorkflowUri.fsPath)})`
        );
    } catch (error) {
        state.server = null;
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Failed to start server: ${message}`);
    }
}

/**
 * @param {import('vscode').ExtensionContext} context
 * @param {object} state
 */
function registerCommands(context, state) {
    state.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    state.statusBarItem.command = 'ai-to-cloud.toggleServer';
    updateStatusBar(state, false);
    state.statusBarItem.show();
    context.subscriptions.push(state.statusBarItem);

    context.subscriptions.push(vscode.commands.registerCommand('ai-to-cloud.toggleServer', async () => {
        if (state.server) {
            stopServer(state);
            updateStatusBar(state, false);
            vscode.window.showInformationMessage('AWS Visualizer Server stopped.');
            return;
        }

        await startServer(context, state);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('ai-to-cloud.startServer', async () => {
        if (!state.server) {
            await startServer(context, state);
            return;
        }

        vscode.window.showInformationMessage('AWS Visualizer Server is already running.');
    }));

    context.subscriptions.push(vscode.commands.registerCommand('ai-to-cloud.stopServer', () => {
        if (!state.server) {
            vscode.window.showInformationMessage('AWS Visualizer Server is not running.');
            return;
        }

        stopServer(state);
        updateStatusBar(state, false);
        vscode.window.showInformationMessage('AWS Visualizer Server stopped.');
    }));

    context.subscriptions.push(vscode.commands.registerCommand('ai-to-cloud.createProject', async () => {
        const projectName = await promptForProjectName();
        if (!projectName) {
            return;
        }

        try {
            await createProjectInStorage(context, projectName);
            vscode.window.showInformationMessage(`Project "${projectName}" created successfully!`);
        } catch (error) {
            vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('ai-to-cloud.changeActiveProject', async () => {
        const project = await pickExistingProject(context, state);
        if (!project) {
            return;
        }

        state.currentProjectFiles = project;
        vscode.window.showInformationMessage(`Active project changed to: ${project.name}`);

        try {
            await openDiagramWorkspace(context, state, project);
        } catch (error) {
            console.error('Error switching webview for new project:', error);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('ai-to-cloud.deleteProject', async () => {
        const project = await pickExistingProject(context, state);
        if (!project) {
            return;
        }

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
            await deleteProjectDirectory(project.dirUri);

            if (state.currentProjectFiles && state.currentProjectFiles.name === project.name) {
                state.currentProjectFiles = null;
                disposeDiagramWorkspace(state);
            }

            vscode.window.showInformationMessage(`Project "${project.name}" has been deleted successfully.`);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to delete project: ${error instanceof Error ? error.message : String(error)}`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('ai-to-cloud.openProjectAll', async () => {
        const project = await pickExistingProject(context, state);
        if (!project) {
            return;
        }

        try {
            await vscode.commands.executeCommand('workbench.action.closeAllEditors');

            const workflowExists = await fileExists(project.fullWorkflowUri);
            if (workflowExists) {
                const workflowDoc = await vscode.workspace.openTextDocument(project.fullWorkflowUri);
                await vscode.window.showTextDocument(workflowDoc, { viewColumn: vscode.ViewColumn.One, preserveFocus: true, preview: false });
            } else {
                vscode.window.showWarningMessage(`Workflow file not found for ${project.name}`);
            }

            const queueExists = await fileExists(project.queueUri);
            if (queueExists) {
                const queueDoc = await vscode.workspace.openTextDocument(project.queueUri);
                await vscode.window.showTextDocument(queueDoc, { viewColumn: vscode.ViewColumn.One, preserveFocus: true, preview: false });
            } else {
                vscode.window.showWarningMessage(`Queue file not found for ${project.name}`);
            }

            const diagramExists = await fileExists(project.diagramUri);
            if (!diagramExists) {
                vscode.window.showWarningMessage(`Diagram file not found for ${project.name}`);
            }

            await openDiagramWorkspace(context, state, project);
        } catch (error) {
            vscode.window.showErrorMessage(`Error opening files: ${error instanceof Error ? error.message : String(error)}`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('ai-to-cloud.openProjectQueue', async () => {
        const project = await pickExistingProject(context, state);
        if (!project) {
            return;
        }

        const queueExists = await fileExists(project.queueUri);
        if (queueExists) {
            const doc = await vscode.workspace.openTextDocument(project.queueUri);
            await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preserveFocus: false, preview: false });
            return;
        }

        vscode.window.showWarningMessage(`Queue file not found for ${project.name}`);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('ai-to-cloud.openProjectDiagram', async () => {
        const project = await pickExistingProject(context, state);
        if (!project) {
            return;
        }

        const diagramExists = await fileExists(project.diagramUri);
        if (diagramExists) {
            const doc = await vscode.workspace.openTextDocument(project.diagramUri);
            await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Two, preserveFocus: false, preview: false });
            return;
        }

        vscode.window.showWarningMessage(`Diagram file not found for ${project.name}`);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('ai-to-cloud.openProjectWorkflow', async () => {
        const project = await pickExistingProject(context, state);
        if (!project) {
            return;
        }

        const workflowExists = await fileExists(project.fullWorkflowUri);
        if (workflowExists) {
            const doc = await vscode.workspace.openTextDocument(project.fullWorkflowUri);
            await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preserveFocus: false, preview: false });
            return;
        }

        vscode.window.showWarningMessage(`Workflow file not found for ${project.name}`);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('ai-to-cloud.openProjectWebview', async () => {
        const project = await pickExistingProject(context, state);
        if (!project) {
            return;
        }

        try {
            await openDiagramWorkspace(context, state, project);
        } catch (error) {
            vscode.window.showErrorMessage(`Error opening webview: ${error instanceof Error ? error.message : String(error)}`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('ai-to-cloud.selectPromptTemplate', async () => {
        await selectPromptTemplate(context, state);
    }));
}

module.exports = {
    registerCommands,
    startServer,
    updateStatusBar
};

// @ts-nocheck

'use strict';

const vscode = require('vscode');
const { readTextFile } = require('../utils/fileSystem');

/**
 * @param {vscode.ExtensionContext} context
 * @param {object} state
 * @returns {Promise<string>}
 */
async function loadPromptTemplateContent(context, state) {
    const templateUri = vscode.Uri.joinPath(context.extensionUri, 'prompts', state.currentPromptTemplate);
    const templateContent = await readTextFile(templateUri);
    if (!templateContent) {
        throw new Error(`Could not read ${state.currentPromptTemplate} template.`);
    }

    return templateContent;
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {object} state
 * @returns {Promise<void>}
 */
async function selectPromptTemplate(context, state) {
    const promptsDir = vscode.Uri.joinPath(context.extensionUri, 'prompts');
    let entries = [];

    try {
        entries = await vscode.workspace.fs.readDirectory(promptsDir);
    } catch {
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

    if (!selected) {
        return;
    }

    state.currentPromptTemplate = `${selected}.md`;
    if (state.currentDiagramPanel && state.diagramWebviewReady) {
        state.currentDiagramPanel.webview.postMessage({
            type: 'active-prompt-changed',
            content: selected
        });
    }
}

module.exports = {
    loadPromptTemplateContent,
    selectPromptTemplate
};

// @ts-nocheck

'use strict';

const vscode = require('vscode');
const { loadPromptTemplateContent } = require('./promptService');
const { readJsonArray, readTextFile, writeTextFile } = require('../utils/fileSystem');

/**
 * @param {vscode.ExtensionContext} context
 * @param {object} state
 * @param {import('./projectService').buildProjectFiles} project
 */
async function buildInterpolatedPrompt(context, state, project) {
    const templateContent = await loadPromptTemplateContent(context, state);
    const d2Content = await readTextFile(project.diagramUri);
    const queueContent = await readJsonArray(project.queueUri);
    const queueString = JSON.stringify(queueContent, null, 2);

    return templateContent
        .replace('[D2_CURRENT_STATE]', d2Content)
        .replace('[AWS_COMMAND_QUEUE]', queueString);
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {object} state
 * @param {object} project
 * @param {(state: object) => Promise<void>} refreshDiagramFromFile
 * @returns {Promise<void>}
 */
async function handleUpdateRendering(context, state, project, refreshDiagramFromFile) {
    const promptStr = await buildInterpolatedPrompt(context, state, project);

    const promptsDir = vscode.Uri.joinPath(project.dirUri, 'prompts');
    try {
        await vscode.workspace.fs.createDirectory(promptsDir);
    } catch {
        // Ignored if it already exists.
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const promptFileName = `${timestamp}_${project.name}.md`;
    const promptUri = vscode.Uri.joinPath(promptsDir, promptFileName);
    await writeTextFile(promptUri, promptStr);

    vscode.window.showInformationMessage(`Prompt saved to ${promptFileName}, requesting new diagram from LLM...`);

    try {
        const response = await fetch('http://127.0.0.1:8081/api/generate-d2', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ prompt: promptStr })
        });

        if (!response.ok) {
            throw new Error(`Proxy responded with status ${response.status}: ${await response.text()}`);
        }

        const data = await response.json();
        if (!data.success) {
            throw new Error(`Proxy/LLM Error: ${data.error || response.statusText}`);
        }

        if (!data.d2Code) {
            throw new Error('Proxy succeeded but returned empty D2 code');
        }

        await writeTextFile(project.diagramUri, data.d2Code);
        await writeTextFile(project.queueUri, '[]');

        vscode.window.showInformationMessage('D2 Diagram updated successfully.');
        await refreshDiagramFromFile(state);
    } catch (error) {
        throw new Error(`LLM Update failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {object} state
 * @param {object} project
 * @param {(state: object) => Promise<void>} refreshDiagramFromFile
 * @returns {Promise<void>}
 */
async function handleUpdateRenderingVSCode(context, state, project, refreshDiagramFromFile) {
    const promptStr = await buildInterpolatedPrompt(context, state, project);

    const promptsDir = vscode.Uri.joinPath(project.dirUri, 'prompts');
    try {
        await vscode.workspace.fs.createDirectory(promptsDir);
    } catch {
        // Ignored if it already exists.
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const promptFileName = `${timestamp}_${project.name}_vscode.md`;
    const promptUri = vscode.Uri.joinPath(promptsDir, promptFileName);
    await writeTextFile(promptUri, promptStr);

    vscode.window.showInformationMessage(`Prompt saved to ${promptFileName}, requesting new diagram from VS Code Copilot...`);

    try {
        if (!vscode.lm || typeof vscode.lm.selectChatModels !== 'function') {
            throw new Error('VS Code language model API is not available.');
        }

        const allModels = await vscode.lm.selectChatModels({});
        if (allModels.length === 0) {
            throw new Error('No VS Code Language Models available. Is GitHub Copilot extension active?');
        }

        const modelItems = allModels.map((model) => ({
            label: model.name,
            description: `Family: ${model.family} | Vendor: ${model.vendor}`,
            model
        }));

        const selectedPick = await vscode.window.showQuickPick(modelItems, {
            placeHolder: 'Select a Language Model for Copilot Inference',
            ignoreFocusOut: true
        });

        if (!selectedPick) {
            vscode.window.showInformationMessage('Model selection cancelled.');
            return;
        }

        const cancellation = new vscode.CancellationTokenSource();
        try {
            const messages = [
                vscode.LanguageModelChatMessage.User(promptStr)
            ];

            const chatResponse = await selectedPick.model.sendRequest(messages, {}, cancellation.token);
            let d2Code = '';
            for await (const fragment of chatResponse.text) {
                d2Code += fragment;
            }

            d2Code = d2Code.replace(/^```d2\n/im, '').replace(/\n```$/im, '').trim();
            if (d2Code.startsWith('```')) {
                d2Code = d2Code.split('\n').slice(1, -1).join('\n');
            }

            if (!d2Code) {
                throw new Error('Copilot succeeded but returned an empty response.');
            }

            await writeTextFile(project.diagramUri, d2Code);
            await writeTextFile(project.queueUri, '[]');

            vscode.window.showInformationMessage('D2 Diagram updated successfully via Copilot.');
            await refreshDiagramFromFile(state);
        } finally {
            cancellation.dispose();
        }
    } catch (error) {
        throw new Error(`Copilot Inference failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}

module.exports = {
    handleUpdateRendering,
    handleUpdateRenderingVSCode
};

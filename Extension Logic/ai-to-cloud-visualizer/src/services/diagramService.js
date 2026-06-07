// @ts-nocheck

'use strict';

const vscode = require('vscode');
const { buildDiagramWebviewHtml } = require('../webview/diagramWebviewBuilder');
const { handleUpdateRendering, handleUpdateRenderingVSCode } = require('./updateService');
const { selectPromptTemplate } = require('./promptService');
const { readTextFile } = require('../utils/fileSystem');

/**
 * @param {object} state
 * @returns {Promise<Promise<any> | null>}
 */
async function getD2Renderer(state) {
    if (!state.d2RendererPromise) {
        state.d2RendererPromise = import('@terrastruct/d2').then(({ D2 }) => new D2());
    }

    return state.d2RendererPromise;
}

/**
 * @param {object} state
 * @param {string} diagramText
 * @returns {Promise<string>}
 */
async function renderDiagramSvg(state, diagramText) {
    const text = (diagramText ?? '').trim();
    if (!text) {
        return '';
    }

    const d2 = await getD2Renderer(state);
    const compiled = await d2.compile(text);
    const svg = await d2.render(compiled.diagram, compiled.renderOptions);
    return typeof svg === 'string' ? svg : String(svg);
}

/**
 * @param {object} state
 * @param {vscode.Uri} fileUri
 * @returns {Promise<{svg: string, error: string | null}>}
 */
async function loadDiagramRenderResult(state, fileUri) {
    const diagramText = await readTextFile(fileUri);

    try {
        const svg = await renderDiagramSvg(state, diagramText);
        return { svg, error: null };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { svg: '', error: message };
    }
}

/**
 * @param {object} state
 * @param {string} svgContent
 */
function flushDiagramUpdate(state, svgContent) {
    if (!state.currentDiagramPanel || !state.diagramWebviewReady) {
        return;
    }

    state.currentDiagramPanel.webview.postMessage({
        type: 'render-svg',
        content: svgContent
    });
}

/**
 * @param {object} state
 * @param {string} errorMessage
 */
function flushDiagramError(state, errorMessage) {
    if (!state.currentDiagramPanel || !state.diagramWebviewReady) {
        return;
    }

    state.currentDiagramPanel.webview.postMessage({
        type: 'render-error',
        content: errorMessage
    });
}

/**
 * @param {object} state
 * @returns {Promise<void>}
 */
async function refreshDiagramFromFile(state) {
    if (!state.currentProjectFiles) {
        return;
    }

    const result = await loadDiagramRenderResult(state, state.currentProjectFiles.diagramUri);
    if (result.error) {
        flushDiagramError(state, result.error);
        return;
    }

    flushDiagramUpdate(state, result.svg);
}

/**
 * @param {object} state
 */
function disposeDiagramWorkspace(state) {
    if (state.currentDiagramPanel) {
        state.currentDiagramPanel.dispose();
        state.currentDiagramPanel = null;
    }

    state.diagramWebviewReady = false;
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {object} state
 * @param {object} project
 * @returns {Promise<void>}
 */
async function openDiagramWorkspace(context, state, project) {
    state.currentProjectFiles = project;
    state.diagramWebviewReady = false;

    const initialResult = await loadDiagramRenderResult(state, project.diagramUri);
    state.diagramInitialResult = initialResult;

    if (state.currentDiagramPanel) {
        state.currentDiagramPanel.title = `D2 Visualizer: ${project.name}`;
        state.currentDiagramPanel.webview.html = await buildDiagramWebviewHtml(context, state.currentDiagramPanel.webview, {
            initialSvg: initialResult.svg,
            initialError: initialResult.error,
            currentPromptLabel: state.currentPromptTemplate.replace(/\.md$/i, '')
        });
        state.currentDiagramPanel.reveal(vscode.ViewColumn.Two, true);
    } else {
        state.currentDiagramPanel = vscode.window.createWebviewPanel(
            'd2Visualizer',
            `D2 Visualizer: ${project.name}`,
            { viewColumn: vscode.ViewColumn.Two, preserveFocus: true },
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        const panel = state.currentDiagramPanel;
        panel.onDidDispose(() => {
            if (state.currentDiagramPanel === panel) {
                state.currentDiagramPanel = null;
                state.diagramInitialResult = null;
                state.diagramWebviewReady = false;
            }
        }, null, context.subscriptions);

        panel.webview.onDidReceiveMessage((message) => {
            if (message && message.type === 'ready') {
                state.diagramWebviewReady = true;
                const result = state.diagramInitialResult || initialResult;
                if (result.error) {
                    flushDiagramError(state, result.error);
                    return;
                }

                flushDiagramUpdate(state, result.svg);
                return;
            }

            if (message && message.type === 'reload-diagram') {
                refreshDiagramFromFile(state).catch((error) => {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    flushDiagramError(state, errorMessage);
                });
                return;
            }

            if (message && message.type === 'update-rendering') {
                if (!state.currentProjectFiles) {
                    return;
                }

                handleUpdateRendering(context, state, state.currentProjectFiles, refreshDiagramFromFile).catch((error) => {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    vscode.window.showErrorMessage(`Update Rendering failed: ${errorMessage}`);
                    flushDiagramError(state, `Update Rendering failed: ${errorMessage}`);
                });
                return;
            }

            if (message && message.type === 'update-rendering-vscode') {
                if (!state.currentProjectFiles) {
                    return;
                }

                handleUpdateRenderingVSCode(context, state, state.currentProjectFiles, refreshDiagramFromFile).catch((error) => {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    vscode.window.showErrorMessage(`Copilot Update failed: ${errorMessage}`);
                    flushDiagramError(state, `Copilot Update failed: ${errorMessage}`);
                });
                return;
            }

            if (message && message.type === 'select-prompt') {
                selectPromptTemplate(context, state).catch((error) => {
                    console.error('Failed to select prompt template:', error);
                });
            }
        }, null, context.subscriptions);

        panel.webview.html = await buildDiagramWebviewHtml(context, panel.webview, {
            initialSvg: initialResult.svg,
            initialError: initialResult.error,
            currentPromptLabel: state.currentPromptTemplate.replace(/\.md$/i, '')
        });
    }

    const document = await vscode.workspace.openTextDocument(project.diagramUri);
    await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.Two, preserveFocus: false });
}

module.exports = {
    disposeDiagramWorkspace,
    flushDiagramError,
    flushDiagramUpdate,
    loadDiagramRenderResult,
    openDiagramWorkspace,
    refreshDiagramFromFile,
    renderDiagramSvg
};

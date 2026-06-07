// @ts-nocheck

'use strict';

const vscode = require('vscode');
const { readTextFile } = require('../utils/fileSystem');

function serializeInlineState(value) {
    return JSON.stringify(value)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026');
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {vscode.Webview} webview
 * @param {object} options
 * @param {string} options.initialSvg
 * @param {string | null} options.initialError
 * @param {string} options.currentPromptLabel
 * @returns {Promise<string>}
 */
async function buildDiagramWebviewHtml(context, webview, options) {
    const templateUri = vscode.Uri.joinPath(context.extensionUri, 'media', 'diagram', 'diagram-webview.html');
    const template = await readTextFile(templateUri);
    if (!template) {
        throw new Error('Could not read diagram webview template.');
    }

    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'diagram', 'diagram-webview.css')).toString();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'diagram', 'diagram-webview.js')).toString();
    const nonce = getNonce();
    const initialState = serializeInlineState({
        svg: options.initialSvg,
        error: options.initialError,
        currentPromptTemplate: options.currentPromptLabel
    });

    return template
        .replaceAll('{{nonce}}', nonce)
        .replaceAll('{{cspSource}}', webview.cspSource)
        .replaceAll('{{styleUri}}', styleUri)
        .replaceAll('{{scriptUri}}', scriptUri)
        .replaceAll('{{currentPromptLabel}}', options.currentPromptLabel)
        .replaceAll('{{initialState}}', initialState);
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

module.exports = {
    buildDiagramWebviewHtml
};

'use strict';

const vscode = require('vscode');

/**
 * @param {vscode.Uri} uri
 * @returns {Promise<boolean>}
 */
async function fileExists(uri) {
    try {
        await vscode.workspace.fs.stat(uri);
        return true;
    } catch {
        return false;
    }
}

/**
 * @param {vscode.Uri} uri
 * @returns {Promise<string>}
 */
async function readTextFile(uri) {
    try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        return Buffer.from(bytes).toString('utf8');
    } catch {
        return '';
    }
}

/**
 * @param {vscode.Uri} uri
 * @param {string} content
 * @returns {Promise<void>}
 */
async function writeTextFile(uri, content) {
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
}

/**
 * @param {vscode.Uri} uri
 * @returns {Promise<unknown[]>}
 */
async function readJsonArray(uri) {
    try {
        const text = (await readTextFile(uri)).trim();
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
 * @param {vscode.Uri} uri
 * @returns {Promise<void>}
 */
async function ensureDirectory(uri) {
    await vscode.workspace.fs.createDirectory(uri);
}

module.exports = {
    ensureDirectory,
    fileExists,
    readJsonArray,
    readTextFile,
    writeTextFile
};

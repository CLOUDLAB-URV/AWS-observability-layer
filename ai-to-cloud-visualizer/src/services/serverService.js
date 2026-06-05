// @ts-nocheck

'use strict';

const vscode = require('vscode');
const { WebSocketServer } = require('ws');
const { readJsonArray, writeTextFile } = require('../utils/fileSystem');

/**
 * @typedef {Object} OutputMessage
 * @property {string} [action]
 * @property {unknown} [resource_state]
 * @property {string} [error]
 */

/**
 * @param {object} state
 * @param {number} port
 * @param {(payload: string) => Promise<void>} onPayload
 */
function startWebSocketServer(state, port, onPayload) {
    if (state.server) {
        return state.server;
    }

    const server = new WebSocketServer({ port });
    state.server = server;

    server.on('connection', (socket) => {
        socket.on('message', (data) => {
            const payload = data.toString();
            state.writeQueue = state.writeQueue
                .then(() => onPayload(payload))
                .catch((error) => {
                    const message = error instanceof Error ? error.message : String(error);
                    vscode.window.showErrorMessage(`Failed to persist WebSocket payload: ${message}`);
                });
        });
    });

    return server;
}

/**
 * @param {object} state
 */
function stopServer(state) {
    if (state.server) {
        state.server.close();
        state.server = null;
    }

    state.currentProjectFiles = null;
    state.writeQueue = Promise.resolve();
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

        if (structuredContent && structuredContent.suggestions) {
            return outputMessages;
        }

        if (structuredContent && Array.isArray(structuredContent.result)) {
            for (const res of structuredContent.result) {
                if (!res.cli_command) {
                    continue;
                }

                let resourceState = {};
                if (res.response) {
                    if (typeof res.response.as_json !== 'undefined') {
                        try {
                            const parsedJson = typeof res.response.as_json === 'string'
                                ? JSON.parse(res.response.as_json)
                                : res.response.as_json;

                            if (parsedJson && parsedJson.ResponseMetadata) {
                                delete parsedJson.ResponseMetadata;
                            }

                            resourceState = parsedJson;
                        } catch {
                            resourceState = res.response;
                        }
                    } else {
                        resourceState = res.response;
                    }
                }

                const outputMessage = {
                    action: res.cli_command,
                    resource_state: resourceState
                };

                if (res.error) {
                    outputMessage.error = res.error;
                }

                outputMessages.push(outputMessage);
            }
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outputMessages.push({
            error: `[Error de parseo: ${message}]`
        });
    }

    return outputMessages;
}

/**
 * @param {object} state
 * @param {string} payload
 * @returns {Promise<void>}
 */
async function appendPayloadToSelectedFile(state, payload) {
    if (!state.currentProjectFiles) {
        return;
    }

    const outputMessages = extractOutputMessages(payload);
    if (outputMessages.length === 0) {
        return;
    }

    const [fullWorkflowContent, queueContent] = await Promise.all([
        readJsonArray(state.currentProjectFiles.fullWorkflowUri),
        readJsonArray(state.currentProjectFiles.queueUri)
    ]);

    fullWorkflowContent.push(...outputMessages);
    queueContent.push(...outputMessages);

    await Promise.all([
        writeTextFile(state.currentProjectFiles.fullWorkflowUri, `${JSON.stringify(fullWorkflowContent, null, 2)}\n`),
        writeTextFile(state.currentProjectFiles.queueUri, `${JSON.stringify(queueContent, null, 2)}\n`)
    ]);
}

module.exports = {
    appendPayloadToSelectedFile,
    extractOutputMessages,
    startWebSocketServer,
    stopServer
};

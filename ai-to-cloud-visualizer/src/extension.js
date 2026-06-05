// @ts-nocheck

'use strict';

const { createAppState } = require('./state/appState');
const { registerCommands } = require('./commands/registerCommands');
const { disposeDiagramWorkspace } = require('./services/diagramService');
const { stopServer } = require('./services/serverService');

const state = createAppState();

/**
 * @param {import('vscode').ExtensionContext} context
 */
function activate(context) {
    console.log('AI-to-cloud-visualizer is now active.');
    registerCommands(context, state);
}

function deactivate() {
    stopServer(state);
    disposeDiagramWorkspace(state);
}

module.exports = {
    activate,
    deactivate
};

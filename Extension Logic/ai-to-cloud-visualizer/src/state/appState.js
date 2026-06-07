'use strict';

function createAppState() {
    return {
        server: null,
        currentProjectFiles: null,
        currentDiagramPanel: null,
        diagramInitialResult: null,
        diagramWebviewReady: false,
        d2RendererPromise: null,
        writeQueue: Promise.resolve(),
        currentPromptTemplate: 'default.md',
        statusBarItem: null
    };
}

module.exports = {
    createAppState
};

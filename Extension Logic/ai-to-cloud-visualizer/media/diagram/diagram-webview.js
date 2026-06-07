// @ts-nocheck
/* global acquireVsCodeApi, document, window */

(() => {
    const vscode = acquireVsCodeApi();
    const diagramEl = document.getElementById('diagram');
    const statusEl = document.getElementById('status');
    const reloadBtn = document.getElementById('reloadBtn');
    const updateBtn = document.getElementById('updateBtn');
    const updateVscodeBtn = document.getElementById('updateVscodeBtn');
    const selectPromptBtn = document.getElementById('selectPromptBtn');
    const activePromptDisplay = document.getElementById('activePromptDisplay');
    const initialState = window.__DIAGRAM_INITIAL_STATE__ || {};

    function escapeHtml(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function setEmptyState(message) {
        diagramEl.innerHTML = '<div class="empty">' + escapeHtml(message) + '</div>';
        statusEl.textContent = message;
    }

    function setErrorState(message) {
        diagramEl.innerHTML = '<div class="error">' + escapeHtml(message) + '</div>';
        statusEl.textContent = 'Render failed';
    }

    function requestReload() {
        statusEl.textContent = 'Compiling latest diagram...';
        vscode.postMessage({ type: 'reload-diagram' });
    }

    function requestUpdate() {
        statusEl.textContent = 'Gathering queued commands (MCP)...';
        vscode.postMessage({ type: 'update-rendering' });
    }

    function requestUpdateVSCode() {
        statusEl.textContent = 'Generating with Copilot...';
        vscode.postMessage({ type: 'update-rendering-vscode' });
    }

    function applyInitialState() {
        if (activePromptDisplay && initialState.currentPromptTemplate) {
            activePromptDisplay.textContent = initialState.currentPromptTemplate;
        }

        if (initialState.error) {
            setErrorState(initialState.error);
            return;
        }

        if (initialState.svg) {
            diagramEl.innerHTML = initialState.svg;
            statusEl.textContent = 'Compiled from latest file content';
            return;
        }

        setEmptyState('The selected .d2 file is empty. Add D2 text to render the diagram.');
    }

    reloadBtn.addEventListener('click', requestReload);
    updateBtn.addEventListener('click', requestUpdate);
    updateVscodeBtn.addEventListener('click', requestUpdateVSCode);
    selectPromptBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'select-prompt' });
    });

    window.addEventListener('message', (event) => {
        const message = event.data;
        if (message && message.type === 'active-prompt-changed') {
            activePromptDisplay.textContent = message.content;
        }

        if (message && message.type === 'render-svg') {
            if (!message.content) {
                setEmptyState('The selected .d2 file is empty. Add D2 text to render the diagram.');
                return;
            }

            diagramEl.innerHTML = message.content;
            statusEl.textContent = 'Compiled from latest file content';
        }

        if (message && message.type === 'render-error') {
            setErrorState(message.content || 'Unknown compilation error');
        }
    });

    vscode.postMessage({ type: 'ready' });
    applyInitialState();

    const stage = document.querySelector('.stage');
    let scale = 1;
    let pointX = 0;
    let pointY = 0;
    let panning = false;
    let start = { x: 0, y: 0 };

    function updateTransform() {
        diagramEl.style.transform = `translate(${pointX}px, ${pointY}px) scale(${scale})`;
    }

    stage.addEventListener('mousedown', (event) => {
        event.preventDefault();
        start = { x: event.clientX - pointX, y: event.clientY - pointY };
        panning = true;
    });

    window.addEventListener('mouseup', () => {
        panning = false;
    });

    window.addEventListener('mousemove', (event) => {
        if (!panning) {
            return;
        }

        event.preventDefault();
        pointX = event.clientX - start.x;
        pointY = event.clientY - start.y;
        updateTransform();
    });

    stage.addEventListener('wheel', (event) => {
        event.preventDefault();
        const rect = stage.getBoundingClientRect();
        const mouseX = event.clientX - rect.left;
        const mouseY = event.clientY - rect.top;

        const zoomIntensity = 0.1;
        const wheel = event.deltaY < 0 ? 1 : -1;
        const zoomFactor = Math.exp(wheel * zoomIntensity);

        const newScale = scale * zoomFactor;
        pointX = mouseX - (mouseX - pointX) * zoomFactor;
        pointY = mouseY - (mouseY - pointY) * zoomFactor;
        scale = newScale;

        updateTransform();
    }, { passive: false });
})();

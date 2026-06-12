'use strict';

// Port of the extension's diagramService.js D2 pipeline (lazy-loaded WASM renderer).
let d2RendererPromise = null;

function getD2Renderer() {
    if (!d2RendererPromise) {
        d2RendererPromise = import('@terrastruct/d2').then(({ D2 }) => new D2());
    }
    return d2RendererPromise;
}

export async function renderDiagramSvg(diagramText) {
    const text = (diagramText ?? '').trim();
    if (!text) {
        return { svg: '', error: null };
    }

    try {
        const d2 = await getD2Renderer();
        const compiled = await d2.compile(text);
        const svg = await d2.render(compiled.diagram, compiled.renderOptions);
        return { svg: typeof svg === 'string' ? svg : String(svg), error: null };
    } catch (error) {
        return { svg: '', error: error instanceof Error ? error.message : String(error) };
    }
}

// LLMs sometimes wrap D2 in fences despite instructions — strip them defensively.
export function stripCodeFences(text) {
    return text
        .trim()
        .replace(/^```(?:d2)?\s*\n?/i, '')
        .replace(/\n?```\s*$/i, '')
        .trim();
}

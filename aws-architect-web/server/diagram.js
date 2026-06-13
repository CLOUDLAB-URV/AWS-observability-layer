'use strict';

// Port of the extension's diagramService.js D2 pipeline (lazy-loaded WASM renderer).
let d2RendererPromise = null;

function getD2Renderer() {
    if (!d2RendererPromise) {
        d2RendererPromise = import('@terrastruct/d2').then(({ D2 }) => new D2());
    }
    return d2RendererPromise;
}

// The D2 WASM worker uses a single shared `currentResolve` variable, so concurrent
// compile/render calls race and corrupt each other's results. Serialize all calls
// through this queue so only one compile+render pipeline runs at a time.
let _renderQueue = Promise.resolve();

export function renderDiagramSvg(diagramText) {
    const task = () => _doRender(diagramText);
    const next = _renderQueue.then(task, task);
    _renderQueue = next.then(() => {}, () => {});
    return next;
}

async function _doRender(diagramText) {
    const text = (diagramText ?? '').trim();
    if (!text) {
        return { svg: '', error: null };
    }

    try {
        const d2 = await getD2Renderer();
        const compiled = await d2.compile(text);
        const rawSvg = await d2.render(compiled.diagram, compiled.renderOptions);
        const svgStr = typeof rawSvg === 'string' ? rawSvg : String(rawSvg);
        return { svg: prepareSvgForEmbed(svgStr), error: null };
    } catch (error) {
        return { svg: '', error: error instanceof Error ? error.message : String(error) };
    }
}

// Strip the XML declaration (invalid inside HTML) and inject explicit width/height
// from the viewBox so the SVG has an intrinsic size for CSS layout.
function prepareSvgForEmbed(svg) {
    let s = svg.replace(/^<\?xml[^?]*\?>\s*/i, '');
    s = s.replace(
        /<svg([^>]*\s)viewBox="0 0 ([0-9.]+) ([0-9.]+)"/,
        (m, before, w, h) =>
            before.includes('width=') ? m
            : `<svg${before}viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"`
    );
    return s;
}

// LLMs sometimes wrap D2 in fences despite instructions — strip them defensively.
export function stripCodeFences(text) {
    return text
        .trim()
        .replace(/^```(?:d2)?\s*\n?/i, '')
        .replace(/\n?```\s*$/i, '')
        .trim();
}

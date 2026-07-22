// Turning the rendered sigil into a downloadable file.
//
// We export from the pristine SVG string the backend sent (the one in DeployedContext), NOT the
// live DOM: the DOM copy carries app-injected divergence badges, the selection glow and svc-node
// classes whose colors come from the app stylesheet and would not survive in a standalone file.

// The diagram canvas colour (--stage). Raster exports default to it because the diagram is drawn
// for a dark canvas — light labels, light arrows, bright icons.
export const CANVAS_BG = '#070708';

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

// Icon fetches are cached for the session: a diagram usually repeats the same few service icons,
// and the modal re-runs this on every format/scale change.
const dataUriCache = new Map();

function parseSvg(svgString) {
    const doc = new DOMParser().parseFromString(svgString, 'image/svg+xml');
    const svg = doc.querySelector('svg');
    if (!svg || doc.querySelector('parsererror')) throw new Error('The diagram could not be read.');
    return svg;
}

// Intrinsic size, written by the server's prepareSvgForEmbed from the viewBox.
export function svgSize(svgString) {
    try {
        const svg = parseSvg(svgString);
        const w = parseFloat(svg.getAttribute('width'));
        const h = parseFloat(svg.getAttribute('height'));
        return (w && h) ? { width: w, height: h } : null;
    } catch {
        return null;
    }
}

function blobToDataUri(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('Could not read image data.'));
        reader.readAsDataURL(blob);
    });
}

// THE critical step for raster export. The stateviz prompt draws services with external icons
// (`icon: "https://api.iconify.design/logos:aws-lambda.svg"`), which D2 emits as
// <image href="https://…">. When an SVG is rasterized through <img> the browser refuses to load
// ANY external reference — so without this every AWS icon would silently vanish from the PNG/JPG
// with no error at all. Inline each one as a data: URI so the SVG is self-contained.
// Returns how many icons could not be fetched, so the caller can warn instead of failing.
async function inlineExternalImages(svgEl) {
    const images = [...svgEl.querySelectorAll('image')];
    let failed = 0;

    await Promise.all(images.map(async (img) => {
        // D2 may emit either the plain or the namespaced attribute.
        const attr = img.hasAttribute('href') ? 'href' : 'xlink:href';
        const url = img.getAttribute('href') || img.getAttributeNS(XLINK_NS, 'href');
        if (!url || url.startsWith('data:')) return;

        try {
            if (!dataUriCache.has(url)) {
                const res = await fetch(url, { mode: 'cors' });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                dataUriCache.set(url, await blobToDataUri(await res.blob()));
            }
            const dataUri = dataUriCache.get(url);
            if (attr === 'href') img.setAttribute('href', dataUri);
            else img.setAttributeNS(XLINK_NS, 'href', dataUri);
        } catch {
            failed += 1;
        }
    }));

    return failed;
}

// The server strips D2's own background rect (prepareSvgForEmbed) so the app canvas shows through,
// which leaves exports transparent. Put one back when the user wants a solid background — and JPEG
// has no alpha channel, so it always needs one.
function addBackground(svgEl, color) {
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', '0');
    rect.setAttribute('y', '0');
    rect.setAttribute('width', '100%');
    rect.setAttribute('height', '100%');
    rect.setAttribute('fill', color);
    svgEl.insertBefore(rect, svgEl.firstChild);
}

// Build the standalone, self-contained SVG for export. Exported so the modal's live preview can
// build the EXACT same markup the download would produce (icons inlined, background applied) —
// the preview must never be a separate re-derivation that could drift from what actually downloads.
export async function buildExportSvg(svgString, { background }) {
    const svgEl = parseSvg(svgString);
    const failedIcons = await inlineExternalImages(svgEl);
    if (background) addBackground(svgEl, background);
    if (!svgEl.getAttribute('xmlns')) svgEl.setAttribute('xmlns', SVG_NS);
    return { svgEl, failedIcons, markup: new XMLSerializer().serializeToString(svgEl) };
}

function loadImage(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('The diagram image could not be rendered.'));
        img.src = url;
    });
}

async function rasterize(markup, { width, height, scale, mime, background }) {
    const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }));
    try {
        const img = await loadImage(url);
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(width * scale);
        canvas.height = Math.round(height * scale);
        const ctx = canvas.getContext('2d');
        // JPEG has no alpha: without this the transparent areas come out black.
        if (background) {
            ctx.fillStyle = background;
            ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        return await new Promise((resolve, reject) => {
            canvas.toBlob(
                (blob) => (blob ? resolve(blob) : reject(new Error('The image could not be encoded.'))),
                mime,
                mime === 'image/jpeg' ? 0.92 : undefined
            );
        });
    } finally {
        URL.revokeObjectURL(url);
    }
}

// A filesystem-safe stem from the sigil's name.
export function exportFilename(name, ext) {
    const slug = String(name || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60);
    return `${slug || 'sigil'}.${ext}`;
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke on the next tick — revoking synchronously can cancel the download in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 0);
}

// Export the sigil. `format` is 'png' | 'jpg' | 'svg'; `background` is a colour or null for
// transparent (JPEG callers must pass a colour). Resolves with the number of icons that could not
// be inlined, so the caller can report a partial result.
export async function exportDiagram(svgString, { format, scale = 2, background, name }) {
    const size = svgSize(svgString);
    if (!size) throw new Error('The diagram has no usable size.');

    const { markup, failedIcons } = await buildExportSvg(svgString, { background });

    if (format === 'svg') {
        downloadBlob(new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }), exportFilename(name, 'svg'));
        return { failedIcons };
    }

    const mime = format === 'jpg' ? 'image/jpeg' : 'image/png';
    const blob = await rasterize(markup, { ...size, scale, mime, background });
    downloadBlob(blob, exportFilename(name, format));
    return { failedIcons };
}

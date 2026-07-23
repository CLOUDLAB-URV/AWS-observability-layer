// Turning the rendered sigil into a downloadable file.
//
// We export from the pristine SVG string the backend sent (the one in DeployedContext), NOT the
// live DOM: the DOM copy carries app-injected divergence badges, the selection glow and svc-node
// classes whose colors come from the app stylesheet and would not survive in a standalone file.
//
// The on-screen diagram's label/group/animation preferences (set in Sigil Options, applied live
// via CSS in Diagram.jsx) are re-applied here too — by REMOVING the actual elements from this
// detached copy, since there's no app stylesheet attached to inherit from. Both call sites share
// the same classification rules from svgClassify.js so the two views of "the same diagram" never
// silently disagree about what counts as a label or a group box.

import { decodeNodePath, edgeTouchesPath, isEdgeGroup, isExternalNode, isSemanticGroup, sanitizeId } from './svgClassify.js';

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

// Remove (not just hide — this copy has no app stylesheet to hide things WITH) whatever the
// current display preferences say shouldn't be shown, using the same classification rules
// Diagram.jsx uses live on screen. Resources are identified the same way Diagram.jsx does: by
// sanitized id, so a "resource node" and "a semantic group box" are never confused.
function applyVizPrefs(svgEl, vizPrefs, resourceIds) {
    const {
        showConnectionLabels = true, showServiceLabels = true, showGroupBoxes = true,
        showExternalActor = true
    } = vizPrefs || {};
    if (showConnectionLabels && showServiceLabels && showGroupBoxes && showExternalActor) return;

    // The external actor (Internet/user/browser…) can't be told apart from a semantic group by an
    // id match alone — it's sometimes purely decorative, with no backing resource at all — so its
    // paths are collected structurally first (see isExternalNode), before the main pass needs them
    // to recognize both the node and whichever edge touches it.
    const externalPaths = new Set();
    if (!showExternalActor) {
        svgEl.querySelectorAll('g[class]').forEach((g) => {
            const cls = g.getAttribute('class');
            if (isEdgeGroup(cls)) return;
            const path = decodeNodePath(cls);
            if (path && isExternalNode(path)) externalPaths.add(path);
        });
    }

    svgEl.querySelectorAll('g[class]').forEach((g) => {
        const cls = g.getAttribute('class');
        if (isEdgeGroup(cls)) {
            // Hiding the external actor removes its one connecting edge whole. Its <marker> is NOT
            // always self-contained — D2 can dedupe identical arrowheads into a single <marker>
            // element that several edges' `marker-end` all reference by the same id (confirmed by
            // inspecting real output: one <marker> shared across every edge in the diagram), so it
            // could physically live inside THIS edge's own <g>. Migrate any <marker> out to the
            // root SVG before deleting the rest of the group, or every other edge sharing it would
            // silently lose its arrowhead in the exported file.
            if (!showExternalActor) {
                for (const path of externalPaths) {
                    if (edgeTouchesPath(cls, path)) {
                        [...g.children].forEach((child) => {
                            if (child.tagName === 'marker') svgEl.appendChild(child);
                        });
                        g.remove();
                        return;
                    }
                }
            }
            // A connection's label + its dark background pill are every child except the line and
            // its <marker> — the marker must be KEPT (not just hidden) here: this is a real DOM
            // removal on a standalone file, and deleting the <marker> element outright would break
            // the path's `marker-end="url(#id)"` reference, silently losing every arrowhead in the
            // exported file (display:none on it, as the live canvas does, is harmless — actually
            // deleting it is not). D2 also masks a label-shaped gap into the path's own geometry
            // (a <mask> cut where the text used to sit), so the mask attribute is stripped too or
            // the line would show an unexplained break once the label is gone.
            if (!showConnectionLabels) {
                [...g.children].forEach((child) => {
                    if (child.tagName === 'path') child.removeAttribute('mask');
                    else if (child.tagName !== 'marker') child.remove();
                });
            }
            return;
        }
        const path = decodeNodePath(cls);
        if (!path) return;
        if (!showExternalActor && externalPaths.has(path)) {
            g.remove();
            return;
        }
        if (isSemanticGroup(path, resourceIds)) {
            // The group's own boundary shape + its COMPUTE/MESSAGING-style label are its only
            // direct children — the rendered SVG is flat (a container's <g> never actually nests
            // the resources drawn "inside" it; those are separate top-level siblings positioned by
            // absolute coordinates), so there is nothing else here to protect.
            if (!showGroupBoxes) {
                [...g.children].forEach((child) => child.remove());
            }
            return;
        }
        // A resource/service node (including the external actor, when shown): its label is a
        // direct <text> child next to the icon.
        if (!showServiceLabels) {
            [...g.children].forEach((child) => { if (child.tagName === 'text') child.remove(); });
        }
    });
}

// Embed the actual moving-dashes look as real CSS so the file itself animates when opened in a
// browser — the only export format a still image can't fake motion for is skipped by the caller
// (see exportDiagram below): a raster file is one static frame, so it always gets the plain line.
function applyAnimation(svgEl) {
    let any = false;
    svgEl.querySelectorAll('g[class]').forEach((g) => {
        if (!isEdgeGroup(g.getAttribute('class'))) return;
        g.querySelectorAll('path').forEach((p) => {
            p.setAttribute('stroke-dasharray', '6 6');
            p.style.animation = 'viz-flow 0.9s linear infinite';
            any = true;
        });
    });
    if (any) {
        const style = document.createElementNS(SVG_NS, 'style');
        style.textContent = '@keyframes viz-flow { to { stroke-dashoffset: -12; } }';
        svgEl.insertBefore(style, svgEl.firstChild);
    }
}

// Build the standalone, self-contained SVG for export. Exported so the modal's live preview can
// build the EXACT same markup the download would produce (icons inlined, background applied,
// display preferences applied) — the preview must never be a separate re-derivation that could
// drift from what actually downloads. `resourceIds` is a Set of sanitized resource ids (see
// svgClassify.sanitizeId), needed to tell a semantic group box apart from a resource node.
// `embedAnimation` is true only for a real SVG-format download — see exportDiagram below.
export async function buildExportSvg(svgString, { background, vizPrefs, resourceIds, embedAnimation = false }) {
    const svgEl = parseSvg(svgString);
    const failedIcons = await inlineExternalImages(svgEl);
    if (vizPrefs) applyVizPrefs(svgEl, vizPrefs, resourceIds || new Set());
    if (embedAnimation && vizPrefs?.animateArrows) applyAnimation(svgEl);
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

// Export the sigil exactly as the user currently has it displayed (Sigil Options' label/group/
// animation preferences). `format` is 'png' | 'jpg' | 'svg'; `background` is a colour or null for
// transparent (JPEG callers must pass a colour). `resourceIds` is a Set of sanitized resource ids
// (see svgClassify.sanitizeId) so a group box can be told apart from a resource node. Resolves
// with the number of icons that could not be inlined, so the caller can report a partial result.
export async function exportDiagram(svgString, { format, scale = 2, background, name, vizPrefs, resourceIds }) {
    const size = svgSize(svgString);
    if (!size) throw new Error('The diagram has no usable size.');

    // A raster file is a single static frame — animating it would just be an arbitrary snapshot of
    // the dash pattern, not a meaningful picture of "animated." Only a real SVG file can actually
    // move when opened, so only SVG gets the embedded animation.
    const embedAnimation = format === 'svg';
    const { markup, failedIcons } = await buildExportSvg(svgString, { background, vizPrefs, resourceIds, embedAnimation });

    if (format === 'svg') {
        downloadBlob(new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }), exportFilename(name, 'svg'));
        return { failedIcons };
    }

    const mime = format === 'jpg' ? 'image/jpeg' : 'image/png';
    const blob = await rasterize(markup, { ...size, scale, mime, background });
    downloadBlob(blob, exportFilename(name, format));
    return { failedIcons };
}

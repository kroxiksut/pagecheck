// Shield for TASKS 8.5: the suspicious-stacking branch must not spend hit tests on ordinary
// decorated UI. Reaching resolveStackingEvidence costs up to five full-viewport
// document.elementsFromPoint calls plus a computed style and a closest() per layer, so the gate
// in front of it decides the module's cost on pages where nothing is wrong.
// Run: node modules/visual-manipulation/detectors/stackingGate.test.mjs
//
// Contract pinned here:
//  - two generic stacking-context signals (transform + opacity, the animated-card shape) buy
//    nothing on an element that is not positioned;
//  - the same pair on a positioned element still does;
//  - an overlay marker and an already-found overlay finding still do, positioned or not.

import assert from 'node:assert/strict';

class StubElement {}
globalThis.Element = StubElement;
globalThis.HTMLInputElement = class extends StubElement {};
globalThis.document = { getElementById: () => null };

const { scanOverlays } = await import('./overlayDetector.js');

const VIEWPORT = { width: 1280, height: 900 };

const BASE_COMPUTED = {
    display: 'block',
    visibility: 'visible',
    opacity: '1',
    position: 'static',
    zIndex: 'auto',
    transform: 'none',
    filter: 'none',
    backdropFilter: 'none',
    webkitBackdropFilter: 'none',
    mixBlendMode: 'normal',
    isolation: 'auto',
    contain: 'none',
    willChange: 'auto',
    clip: 'auto',
    clipPath: 'none',
    pointerEvents: 'auto',
    backgroundColor: 'rgba(0, 0, 0, 0)',
    backgroundImage: 'none',
    borderTopWidth: '0px',
    borderRightWidth: '0px',
    borderBottomWidth: '0px',
    borderLeftWidth: '0px',
    boxShadow: 'none',
    outlineStyle: 'none',
    cursor: 'auto',
    overflow: 'visible',
    overflowX: 'visible',
    overflowY: 'visible'
};

function makeNode({ tagName = 'DIV', attributes = {}, computed = {}, text = 'card body text' } = {}) {
    const node = Object.assign(Object.create(StubElement.prototype), {
        tagName,
        attributes,
        style: {},
        computed: { ...BASE_COMPUTED, ...computed },
        rect: { left: 100, top: 100, right: 700, bottom: 500, width: 600, height: 400 },
        textContent: text,
        childNodes: text ? [{ nodeType: 3, data: text }] : [],
        children: [],
        parentElement: null,
        isConnected: true,
        isContentEditable: false,
        get id() {
            return this.attributes.id || '';
        },
        get className() {
            return this.attributes.class || '';
        },
        getAttribute: (name) => (Object.hasOwn(attributes, name) ? attributes[name] : null),
        hasAttribute: (name) => Object.hasOwn(attributes, name),
        matches: () => false,
        closest: () => null,
        querySelector: () => null,
        contains(other) {
            return other === node;
        }
    });
    return node;
}

function createModule(element) {
    let hitTests = 0;
    // Two more layers under the element, so evidence would be found if the gate let it through.
    const under = [makeNode({ tagName: 'SECTION' }), makeNode({ tagName: 'BUTTON' })];
    const module = {
        config: { detectOverlays: true, detectDeceptiveCapture: false },
        getViewportSize: () => VIEWPORT,
        getComputedStyle: (node) => node.computed,
        getRect: (node) => node.rect,
        resolveViewportGeometry: (node) => {
            const rect = node.rect;
            return {
                visibleWidth: rect.width,
                visibleHeight: rect.height,
                visibleLeft: rect.left,
                visibleTop: rect.top,
                visibleRight: rect.right,
                visibleBottom: rect.bottom,
                viewportWidth: VIEWPORT.width,
                viewportHeight: VIEWPORT.height,
                coverageRatio: (rect.width * rect.height) / (VIEWPORT.width * VIEWPORT.height),
                widthRatio: rect.width / VIEWPORT.width,
                heightRatio: rect.height / VIEWPORT.height
            };
        },
        elementsFromPoint: () => {
            hitTests += 1;
            return [element, ...under];
        },
        isLikelyOverlay: () => false,
        isInputHidden: () => false,
        describeElement: (node) => node.tagName.toLowerCase(),
        getElementPath: () => 'html>body>div'
    };
    return { module, hitTests: () => hitTests };
}

function run(element) {
    const { module, hitTests } = createModule(element);
    const findings = scanOverlays({ element, style: element.computed, module });
    return { findings, hitTests: hitTests() };
}

// --- the animated-card shape: two generic signals, no positioning ---------------------------------

const animatedCard = makeNode({
    attributes: { class: 'card promo' },
    computed: { transform: 'matrix(1, 0, 0, 1, 0, 0)', opacity: '0.98', willChange: 'transform' }
});
const cardResult = run(animatedCard);
assert.equal(cardResult.hitTests, 0, 'an unpositioned decorated card must not buy a hit test');
assert.equal(cardResult.findings.length, 0, 'and must not produce a stacking finding');

// --- the same signals on a positioned layer still pay for the test --------------------------------

const positionedLayer = makeNode({
    attributes: { class: 'card promo' },
    computed: {
        transform: 'matrix(1, 0, 0, 1, 0, 0)',
        opacity: '0.98',
        position: 'fixed',
        zIndex: '30'
    }
});
const positionedResult = run(positionedLayer);
assert.ok(positionedResult.hitTests > 0, 'a positioned layer with stacking signals must still be tested');

// --- overlay vocabulary is enough on its own, positioned or not -----------------------------------

const namedOverlay = makeNode({ attributes: { class: 'cookie-consent-overlay' } });
assert.ok(run(namedOverlay).hitTests > 0, 'an overlay-named element must still be tested');

const modalRole = makeNode({ attributes: { role: 'dialog' } });
assert.ok(run(modalRole).hitTests > 0, 'a dialog role must still be tested');

// --- an element that already produced an overlay finding is tested regardless ---------------------

const capturedElement = makeNode({
    attributes: { class: 'plain' },
    computed: { position: 'static' }
});
const { module: captureModule, hitTests: captureHits } = createModule(capturedElement);
captureModule.config = { detectOverlays: true, detectDeceptiveCapture: true };
captureModule.isLikelyOverlay = () => true;
scanOverlays({ element: capturedElement, style: capturedElement.computed, module: captureModule });
assert.ok(captureHits() > 0, 'an element with a related overlay finding must still be tested');

console.log('stackingGate.test.mjs: ok');

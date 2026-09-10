// Shield for TASKS 8.11: a zero-sized ANCESTOR hides a descendant only when it clips it.
// The unconditional walk matched the ordinary anchor/measurement pattern - `position: relative;
// width: 0; height: 0` wrapping an absolutely positioned, fully visible control - and reported a
// perfectly visible input as hidden.
// Run: node modules/visual-manipulation/detectors/zeroSizeAttribution.test.mjs

import assert from 'node:assert/strict';

class StubElement {}
globalThis.Element = StubElement;
globalThis.HTMLInputElement = class extends StubElement {};
globalThis.CSS = { escape: (value) => String(value) };
globalThis.document = { querySelectorAll: () => [] };

const { scanHiddenInputs } = await import('./hiddenInputDetector.js');

const BASE_COMPUTED = {
    display: 'block',
    visibility: 'visible',
    opacity: '1',
    position: 'static',
    zIndex: 'auto',
    transform: 'none',
    filter: 'none',
    clip: 'auto',
    clipPath: 'none',
    overflow: 'visible',
    overflowX: 'visible',
    overflowY: 'visible',
    pointerEvents: 'auto',
    fontSize: '16px',
    textIndent: '0px'
};

const VISIBLE_RECT = { left: 40, top: 40, right: 240, bottom: 80, width: 200, height: 40 };
const ZERO_RECT = { left: 40, top: 40, right: 40, bottom: 40, width: 0, height: 0 };

function makeNode({ tagName = 'DIV', attributes = {}, computed = {}, rect = VISIBLE_RECT } = {}) {
    const node = Object.assign(Object.create(
        tagName === 'INPUT' ? globalThis.HTMLInputElement.prototype : StubElement.prototype
    ), {
        tagName,
        attributes,
        style: {},
        computed: { ...BASE_COMPUTED, ...computed },
        rect,
        textContent: '',
        childNodes: [],
        children: [],
        parentElement: null,
        labels: [],
        isConnected: true,
        isContentEditable: false,
        get id() {
            return this.attributes.id || '';
        },
        get type() {
            return this.attributes.type || '';
        },
        getAttribute: (name) => (Object.hasOwn(attributes, name) ? attributes[name] : null),
        hasAttribute: (name) => Object.hasOwn(attributes, name),
        matches: () => false,
        closest: () => null,
        querySelector: () => null
    });
    return node;
}

// The module facade: `isInputHidden` answers about the ELEMENT's own box, which for an
// ancestor-hidden control is a perfectly ordinary one - that is why the detector cannot lean on it
// as a sanity check for ancestor attributions.
const module = {
    getComputedStyle: (node) => node.computed,
    getRect: (node) => node.rect,
    getViewportSize: () => ({ width: 1280, height: 900 }),
    isInputSurface: (node) => node.tagName === 'INPUT',
    isInputHidden: (style, node) => node.rect.width <= 0 || node.rect.height <= 0 || style.display === 'none',
    describeElement: (node) => node.tagName.toLowerCase(),
    getElementPath: () => 'html>body>div>input'
};

function scanInputUnder(wrapperComputed, { inputRect = VISIBLE_RECT, inputComputed = {} } = {}) {
    const wrapper = makeNode({ computed: wrapperComputed, rect: ZERO_RECT });
    const input = makeNode({
        tagName: 'INPUT',
        attributes: { type: 'text', id: 'field' },
        computed: inputComputed,
        rect: inputRect
    });
    input.parentElement = wrapper;
    wrapper.children.push(input);
    return scanHiddenInputs({ element: input, style: input.computed, module });
}

function reasonOf(findings) {
    if (findings.length === 0) {
        return 'none';
    }
    const match = /reason=([a-z-]+); source=([a-z]+)/.exec(findings[0].details);
    return match ? `${match[1]}|${match[2]}` : 'unknown';
}

// --- the anchor pattern: a zero-sized, non-clipping wrapper hides nothing ------------------------

assert.equal(
    reasonOf(scanInputUnder({ position: 'relative' })),
    'none',
    'an absolutely positioned, visible input inside a zero-sized anchor is not hidden'
);

// --- a zero-sized wrapper that actually clips still counts ---------------------------------------

assert.equal(
    reasonOf(scanInputUnder({ position: 'relative', overflow: 'hidden', overflowX: 'hidden', overflowY: 'hidden' })),
    'zero-size|ancestor',
    'a zero-sized clipping container does hide its contents'
);

assert.equal(
    reasonOf(scanInputUnder({ position: 'relative', overflowY: 'clip' })),
    'zero-size|ancestor',
    'overflow: clip on one axis is clipping too'
);

// --- the element's own zero size is unconditional -------------------------------------------------

assert.equal(
    reasonOf(scanInputUnder({ position: 'relative' }, { inputRect: ZERO_RECT })),
    'zero-size|self',
    "an input with no box of its own is still hidden, whatever the ancestor does"
);

// --- other hiding reasons are untouched ------------------------------------------------------------

assert.equal(
    reasonOf(scanInputUnder({ display: 'none' })),
    'display-none|ancestor',
    'display:none attribution must be unaffected'
);

console.log('zeroSizeAttribution.test.mjs: ok');

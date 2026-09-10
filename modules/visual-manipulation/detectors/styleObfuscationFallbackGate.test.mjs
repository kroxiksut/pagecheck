// Shield for TASKS 8.8: the "unexplained semantic mismatch only" gate must behave like its three
// neighbours - it may silence the generic style-obfuscation fallback only when the semantic signal
// is the ONLY thing wrong with the element, and it must not look further up the tree than
// resolveSemanticMismatchMatch does (self + 4 ancestors).
// Run: node modules/visual-manipulation/detectors/styleObfuscationFallbackGate.test.mjs
//
// Before the fix any aria-hidden ancestor at any depth silenced the fallback outright, so an
// element carrying real suppression - clip-path plus filter - produced no finding at all: the
// specialised branch could not reach it and the gate hid it from the fallback too.

import assert from 'node:assert/strict';

class StubElement {}
globalThis.Element = StubElement;
globalThis.HTMLInputElement = class extends StubElement {};

const { scanStyleObfuscation } = await import('./styleObfuscationDetector.js');
const { hasStyleObfuscationSignals } = await import('../utils/domUtils.js');

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
    backgroundBlendMode: 'normal',
    clip: 'auto',
    clipPath: 'none',
    overflow: 'visible',
    overflowX: 'visible',
    overflowY: 'visible',
    pointerEvents: 'auto',
    fontSize: '16px',
    textIndent: '0px',
    direction: 'ltr',
    unicodeBidi: 'normal',
    whiteSpace: 'normal',
    webkitTextSecurity: 'none',
    color: 'rgb(0, 0, 0)',
    backgroundColor: 'rgba(0, 0, 0, 0)',
    backgroundImage: 'none'
};

function makeNode({ tagName = 'DIV', attributes = {}, computed = {}, text = '' } = {}) {
    const node = Object.assign(Object.create(StubElement.prototype), {
        tagName,
        attributes,
        style: {},
        computed: { ...BASE_COMPUTED, ...computed },
        rect: { left: 10, top: 10, right: 210, bottom: 60, width: 200, height: 50 },
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
        querySelector: () => null,
        closest(selector) {
            // Only the ancestor lookups the detector actually performs.
            let current = node;
            while (current) {
                if (selector === '[aria-hidden="true"]' && current.getAttribute('aria-hidden') === 'true') {
                    return current;
                }
                current = current.parentElement;
            }
            return null;
        }
    });
    return node;
}

const module = {
    getComputedStyle: (node) => node.computed,
    getRect: (node) => node.rect,
    describeElement: (node) => node.tagName.toLowerCase(),
    getElementPath: () => 'html>body>div>span',
    hasCandidateText: (node) => Boolean((node.textContent || '').trim().length > 1),
    hasStyleObfuscationSignals: (style, node) => hasStyleObfuscationSignals(style, node)
};

// Builds `depth` plain wrappers under an aria-hidden container and returns the leaf.
function buildUnderAriaHidden(depth, leafSpec) {
    const container = makeNode({ tagName: 'SECTION', attributes: { 'aria-hidden': 'true' } });
    let current = container;
    for (let index = 0; index < depth; index += 1) {
        const wrapper = makeNode({ tagName: 'DIV' });
        wrapper.parentElement = current;
        current.children.push(wrapper);
        current = wrapper;
    }
    const leaf = makeNode(leafSpec);
    leaf.parentElement = current;
    current.children.push(leaf);
    return leaf;
}

function scan(element) {
    return scanStyleObfuscation({ element, style: element.computed, module });
}

function typesOf(findings) {
    return findings.map((finding) => finding.type);
}

// --- real suppression under an aria-hidden ancestor is reported ----------------------------------

const suppressed = buildUnderAriaHidden(5, {
    tagName: 'SPAN',
    computed: { clipPath: 'inset(100%)', filter: 'blur(10px)' }
});
assert.ok(
    typesOf(scan(suppressed)).includes('style-obfuscation'),
    'clip-path + filter under an aria-hidden ancestor must reach the fallback'
);

// The same element directly inside the aria-hidden container - within the detector reach - is
// reported too: the gate is about "other signals present", not about depth.
const suppressedShallow = buildUnderAriaHidden(1, {
    tagName: 'SPAN',
    computed: { clipPath: 'inset(100%)', filter: 'blur(10px)' }
});
assert.ok(
    typesOf(scan(suppressedShallow)).includes('style-obfuscation'),
    'the same element one level down must be reported as well'
);

// --- a bare semantic mismatch is still silenced ---------------------------------------------------

const semanticOnly = makeNode({
    tagName: 'SPAN',
    attributes: { 'aria-hidden': 'true' },
    text: 'hidden but not suppressed'
});
const semanticOnlyFindings = scan(semanticOnly);
assert.ok(
    !typesOf(semanticOnlyFindings).includes('style-obfuscation'),
    'aria-hidden alone must not produce a generic fallback finding'
);

const presentationOnly = makeNode({
    tagName: 'SPAN',
    attributes: { role: 'presentation', 'aria-hidden': 'true' },
    text: 'decorative'
});
assert.ok(
    !typesOf(scan(presentationOnly)).includes('style-obfuscation'),
    'role=presentation with aria-hidden alone must stay silenced'
);

// --- scale suppression is not a fallback signal (TASKS 8.9) ---------------------------------------

const scaleSuppressed = makeNode({
    tagName: 'SPAN',
    computed: { transform: 'matrix(0, 0, 0, 0, 0, 0)' },
    text: 'invisible text'
});
assert.ok(
    !typesOf(scan(scaleSuppressed)).includes('style-obfuscation'),
    'the generic fallback must not claim scale suppression: scanTransformSuppression owns it'
);
assert.equal(
    hasStyleObfuscationSignals(scaleSuppressed.computed, scaleSuppressed),
    false,
    'a matrix-serialised zero scale is not a style-obfuscation signal on its own'
);

// A partial style object must not throw where the dead transform test used to dereference it.
assert.doesNotThrow(
    () => hasStyleObfuscationSignals({ mixBlendMode: 'normal', clip: 'auto', clipPath: 'none' }, scaleSuppressed),
    'hasStyleObfuscationSignals must tolerate a style object without every property'
);

console.log('styleObfuscationFallbackGate.test.mjs: ok');

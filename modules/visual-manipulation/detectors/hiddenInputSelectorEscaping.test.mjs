// Shield for TASKS 8.7: an element id is attacker-controlled text, so every id that reaches a
// selector has to be escaped. The unescaped `[aria-controls="<id>"]` lookup threw a SyntaxError
// that travelled scanHiddenInputs -> scanElement -> scanCandidates -> firstScan and killed the
// module for the whole page.
// Run: node modules/visual-manipulation/detectors/hiddenInputSelectorEscaping.test.mjs

import assert from 'node:assert/strict';

// Mirrors what a browser does: an attribute selector whose value contains an unescaped quote or
// backslash is invalid, and querySelector throws.
const VALID_ARIA_CONTROLS = /^\[aria-controls="(?:[^"\\]|\\.)*"\]$/;
const VALID_LABEL_FOR = /^label\[for="(?:[^"\\]|\\.)*"\]$/;

const seenSelectors = [];

function assertValidSelector(selector, pattern) {
    seenSelectors.push(selector);
    if (pattern && !pattern.test(selector)) {
        const error = new Error(`Failed to execute 'querySelector': '${selector}' is not a valid selector.`);
        error.name = 'SyntaxError';
        throw error;
    }
}

// `instanceof Element` / `instanceof HTMLInputElement` guards run inside the detector, so the stub
// nodes have to be instances of something the detector recognises.
class StubElement {}
class StubHTMLInputElement extends StubElement {}
globalThis.Element = StubElement;
globalThis.HTMLInputElement = StubHTMLInputElement;

globalThis.CSS = {
    escape: (value) => String(value).replace(/["'\\\]]/g, (match) => `\\${match}`)
};

globalThis.document = {
    querySelectorAll: (selector) => {
        assertValidSelector(selector, VALID_LABEL_FOR);
        return [];
    }
};

const { scanHiddenInputs } = await import('./hiddenInputDetector.js');

const BASE_COMPUTED = {
    display: 'none',
    visibility: 'visible',
    opacity: '1',
    pointerEvents: 'auto',
    position: 'static',
    zIndex: 'auto',
    fontSize: '16px',
    textIndent: '0px',
    clip: 'auto',
    clipPath: 'none',
    transform: 'none',
    filter: 'none'
};

// An id a page can legitimately carry and an attacker can certainly choose.
const HOSTILE_ID = 'a"]:has(*),b\\c';

function makeNode({ tagName = 'DIV', attributes = {}, computed = {}, text = '' } = {}) {
    const node = {
        tagName,
        attributes,
        style: {},
        computed: { ...BASE_COMPUTED, ...computed },
        rect: { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 },
        textContent: text,
        childNodes: text ? [{ nodeType: 3, data: text }] : [],
        children: [],
        parentElement: null,
        labels: [],
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
        closest(selector) {
            let current = node;
            while (current) {
                if (selector.split(',').some((part) => part.trim() === current.tagName.toLowerCase())) {
                    return current;
                }
                current = current.parentElement;
            }
            return null;
        },
        querySelector(selector) {
            assertValidSelector(selector, selector.startsWith('[aria-controls') ? VALID_ARIA_CONTROLS : null);
            return null;
        }
    };
    node.isConnected = true;
    Object.setPrototypeOf(node, tagName === 'INPUT' ? StubHTMLInputElement.prototype : StubElement.prototype);
    return node;
}

const module = {
    getComputedStyle: (node) => node.computed,
    getRect: (node) => node.rect,
    getViewportSize: () => ({ width: 1280, height: 900 }),
    isInputSurface: (node) => node.tagName === 'INPUT',
    isInputHidden: () => true,
    describeElement: (node) => node.tagName.toLowerCase(),
    getElementPath: () => 'html>body>form>input'
};

function scanFileInput(id) {
    seenSelectors.length = 0;
    const form = makeNode({ tagName: 'FORM' });
    const input = makeNode({ tagName: 'INPUT', attributes: { type: 'file', id } });
    input.parentElement = form;
    form.children.push(input);

    return scanHiddenInputs({ element: input, style: input.computed, module });
}

// --- a hostile id must not throw and must reach the selector escaped ------------------------------

const findings = scanFileInput(HOSTILE_ID);
assert.ok(Array.isArray(findings), 'the scan must return findings, not throw');

const ariaControlsSelectors = seenSelectors.filter((selector) => selector.startsWith('[aria-controls'));
assert.equal(ariaControlsSelectors.length, 1, 'the upload branch asks for an aria-controls trigger exactly once');
assert.ok(
    VALID_ARIA_CONTROLS.test(ariaControlsSelectors[0]),
    `the aria-controls selector must be valid, got ${ariaControlsSelectors[0]}`
);
assert.ok(
    ariaControlsSelectors[0].includes('\\"'),
    `the quote in the id must be escaped, got ${ariaControlsSelectors[0]}`
);

// --- an empty id must not produce a lookup at all -------------------------------------------------

scanFileInput('');
assert.equal(
    seenSelectors.filter((selector) => selector.startsWith('[aria-controls')).length,
    0,
    'an element without an id has nothing to look up'
);

// --- an ordinary id still queries -----------------------------------------------------------------

scanFileInput('upload-field');
const ordinary = seenSelectors.filter((selector) => selector.startsWith('[aria-controls'));
assert.equal(ordinary.length, 1, 'an ordinary id must still be looked up');
assert.equal(ordinary[0], '[aria-controls="upload-field"]', 'escaping must not alter a plain id');

console.log('hiddenInputSelectorEscaping.test.mjs: ok');

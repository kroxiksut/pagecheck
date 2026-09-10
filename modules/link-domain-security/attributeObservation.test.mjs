// Shield for the C5.4 contract (root TASKS) as applied here - item 6.5.
// The module reads two attribute values and used to watch neither, so `el.href = '...'` after the
// render was a one-line bypass of every detect this module has: bait-and-switch was invisible.
// Run: node modules/link-domain-security/attributeObservation.test.mjs

import assert from 'node:assert/strict';

class StubElement {}
globalThis.Element = StubElement;
globalThis.Node = class { static TEXT_NODE = 3; static ELEMENT_NODE = 1; };
globalThis.performance = { now: () => 0 };
globalThis.window = { location: new URL('https://shop.example.com/catalog') };

const LINK_TEXT_PRIVACY_SELECTOR = 'input, textarea, select, option, optgroup, [contenteditable]:not([contenteditable="false"]), [role="textbox" i]';

function makeElement(tagName, attributes = {}, text = '') {
    return Object.assign(Object.create(StubElement.prototype), {
        tagName: tagName.toUpperCase(),
        // The module classifies candidates by localName + hasAttribute, not by a selector (7.7).
        localName: tagName.toLowerCase(),
        attributes,
        children: [],
        childNodes: text ? [{ nodeType: 3, textContent: text }] : [],
        parentElement: null,
        isConnected: true,
        getAttribute: (name) => (Object.hasOwn(attributes, name) ? attributes[name] : null),
        hasAttribute: (name) => Object.hasOwn(attributes, name),
        contains(other) {
            if (other === this) return true;
            return this.children.some((child) => child.contains(other));
        },
        matches(selector) {
            if (selector === 'a[href]') return this.tagName === 'A' && Object.hasOwn(attributes, 'href');
            if (selector === 'form[action]') return this.tagName === 'FORM' && Object.hasOwn(attributes, 'action');
            if (selector === LINK_TEXT_PRIVACY_SELECTOR) return ['INPUT', 'TEXTAREA', 'SELECT'].includes(this.tagName);
            throw new Error(`unexpected selector: ${selector}`);
        }
    });
}

function appendChild(parent, child) {
    child.parentElement = parent;
    parent.children.push(child);
    parent.childNodes.push(child);
    return child;
}

const { default: LinkDomainSecurityDetector } = await import('./LinkDomainSecurityDetector.js');

const root = makeElement('html');
const body = appendChild(root, makeElement('body'));
// An honest link at render time: the caption names the host the href points at.
const bait = appendChild(body, makeElement('a', { href: 'https://shop.example.com/pay' }, 'shop.example.com'));
globalThis.document = { documentElement: root, baseURI: globalThis.window.location.href };

const detector = new LinkDomainSecurityDetector();
detector.config = {
    detectHomographs: true,
    detectLinkMismatch: true,
    detectRedirectPatterns: true,
    detectUnsafeProtocols: true
};
detector.isEnabled = true;

// --- the observer configuration is part of the contract ---------------------------------------------

assert.equal(detector.observerConfig.attributes, true, 'attribute records must be requested');
assert.deepEqual(
    detector.observerConfig.attributeFilter,
    ['href', 'action', 'formaction'],
    'the filter must stay narrow: attributes: true alone would push every class change through this pipeline'
);
assert.equal(detector.observerConfig.childList, true, 'child list observation must be kept');

await detector.firstScan();
assert.equal(detector.stats.threatsDetected, 0, 'an honest link produces nothing');

// --- the switch ---------------------------------------------------------------------------------------

bait.attributes.href = 'https://evil.example.net/pay';
detector.handleMutations([{ type: 'attributes', attributeName: 'href', target: bait, addedNodes: [] }]);

assert.ok(detector.pendingMutationRoots.has(bait), 'the changed element must be queued for re-analysis');

detector.processMutationRoots([...detector.pendingMutationRoots]);
detector.pendingMutationRoots.clear();

assert.equal(detector.stats.threatsDetected, 1, 'the swapped href must be reported');
assert.equal(detector.recentFindings[0].type, 'link-mismatch');
assert.match(detector.recentFindings[0].details, /evil\.example\.net/);

// --- the same switch twice is still one problem (identity from 6.4 keeps holding) -----------------------

detector.handleMutations([{ type: 'attributes', attributeName: 'href', target: bait, addedNodes: [] }]);
detector.processMutationRoots([...detector.pendingMutationRoots]);
detector.pendingMutationRoots.clear();
assert.equal(detector.stats.threatsDetected, 1, 're-reporting the same swap must not add a finding');

// --- attribute records ride the same batch limits --------------------------------------------------------

detector.pendingMutationRoots.clear();
detector.maxPendingMutationRoots = 1;
const first = appendChild(body, makeElement('a', { href: 'https://shop.example.com/1' }, 'One'));
const second = appendChild(body, makeElement('a', { href: 'https://shop.example.com/2' }, 'Two'));
detector.handleMutations([
    { type: 'attributes', attributeName: 'href', target: first, addedNodes: [] },
    { type: 'attributes', attributeName: 'href', target: second, addedNodes: [] }
]);
assert.equal(detector.pendingMutationRoots.size, 1, 'the pending-roots cap applies to attribute records too');
assert.ok(detector.mutationRootsSkippedByLimit > 0, 'and the overflow is counted');

console.log('attributeObservation.test.mjs: ok');

// Shield for TASKS 6.4: findings must have an identity that survives a re-render.
// The module used to key nothing: the WeakSet of processed elements lived exactly one batch, so a
// SPA re-rendering its list of links handed over brand-new elements describing the same links and
// every batch reported them again - recentFindings filled with copies of one line and
// stats.threatsDetected, which is the module badge, grew for as long as the page lived.
// Run: node modules/link-domain-security/findingIdentity.test.mjs

import assert from 'node:assert/strict';

class StubElement {}
globalThis.Element = StubElement;
globalThis.Node = class { static TEXT_NODE = 3; static ELEMENT_NODE = 1; };
globalThis.performance = { now: () => 0 };
globalThis.window = { location: new URL('https://shop.example.com/catalog') };

const LINK_TEXT_PRIVACY_SELECTOR = 'input, textarea, select, option, optgroup, [contenteditable]:not([contenteditable="false"]), [role="textbox" i]';

function makeElement(tagName, attributes = {}, text = '') {
    const element = Object.assign(Object.create(StubElement.prototype), {
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
        matches(selector) {
            if (selector === 'a[href]') {
                return this.tagName === 'A' && Object.hasOwn(attributes, 'href');
            }
            if (selector === 'form[action]') {
                return this.tagName === 'FORM' && Object.hasOwn(attributes, 'action');
            }
            if (selector === LINK_TEXT_PRIVACY_SELECTOR) {
                return ['INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'OPTGROUP'].includes(this.tagName);
            }
            throw new Error(`unexpected selector in the stub: ${selector}`);
        }
    });
    return element;
}

function appendChild(parent, child) {
    child.parentElement = parent;
    parent.children.push(child);
    parent.childNodes.push(child);
    return child;
}

// The same three problems, rendered from scratch every time - exactly what a framework does.
function renderLinks(container) {
    container.children = [];
    container.childNodes = [];
    appendChild(container, makeElement('a', { href: 'https://partner.example.org/login' }, 'example.com'));
    appendChild(container, makeElement('a', { href: 'javascript:steal()' }, 'Continue'));
    appendChild(container, makeElement('a', { href: 'https://xn--80ak6aa92e.com/account' }, 'Sign in'));
    return container;
}

const { default: LinkDomainSecurityDetector } = await import('./LinkDomainSecurityDetector.js');

const root = makeElement('html');
const body = appendChild(root, makeElement('body'));
const list = appendChild(body, makeElement('div'));
renderLinks(list);
globalThis.document = { documentElement: root, baseURI: globalThis.window.location.href };

const detector = new LinkDomainSecurityDetector();
detector.config = {
    detectHomographs: true,
    detectLinkMismatch: true,
    detectRedirectPatterns: true,
    detectUnsafeProtocols: true
};
detector.isEnabled = true;

await detector.firstScan();

const afterFirstScan = detector.stats.threatsDetected;
assert.ok(afterFirstScan >= 3, `the three planted problems must be reported, got ${afterFirstScan}`);

// The identity lives in the module, not in the published finding: since TASKS 7.16 `dedupeKey` is
// stripped on the way out, because it carried a slice of the raw target across the module boundary.
// So the key set is what this assertion has to read.
const keys = [...detector.seenFindingKeys];
assert.ok(keys.every(Boolean), 'every finding must carry an identity key');
assert.equal(keys.length, afterFirstScan, 'one key per reported finding, no duplicates');
assert.ok(
    detector.recentFindings.every((finding) => !Object.hasOwn(finding, 'dedupeKey')),
    'the identity key must not travel out with the finding (7.16)'
);

// --- five re-renders of the very same list --------------------------------------------------------

for (let round = 0; round < 5; round += 1) {
    renderLinks(list);
    detector.processMutationRoots([list]);
}

assert.equal(
    detector.stats.threatsDetected,
    afterFirstScan,
    `re-rendering the same links must not add findings, got ${detector.stats.threatsDetected} after ${afterFirstScan}`
);
assert.equal(
    detector.recentFindings.length,
    afterFirstScan,
    'recentFindings must not fill up with copies of the same finding'
);

// --- a genuinely new problem still gets through ------------------------------------------------------

appendChild(list, makeElement('a', { href: 'https://evil.example.net/pay' }, 'shop.example.com'));
detector.processMutationRoots([list]);

assert.equal(
    detector.stats.threatsDetected,
    afterFirstScan + 1,
    'a new link with a new problem must still be reported'
);

// --- the key set is bounded ---------------------------------------------------------------------------

assert.ok(detector.seenFindingKeys.size <= detector.maxFindingKeys, 'the key set must respect its cap');

// --- a fresh scan starts from a clean slate ------------------------------------------------------------

await detector.firstScan();
assert.equal(detector.seenFindingKeys.size > 0, true, 'a new scan records its own keys');
assert.equal(
    detector.stats.threatsDetected >= 3,
    true,
    'a new scan reports the page again - identity is scan-scoped, not permanent'
);

console.log(`findingIdentity.test.mjs: ok (${afterFirstScan} findings, stable across 5 re-renders)`);

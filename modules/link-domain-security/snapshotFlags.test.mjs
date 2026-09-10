// Shield for the C5.2 contract (root TASKS) as applied here - item 6.6.
// One flag used to answer three different questions, so a page that was scanned end to end reported
// itself partial forever because a single link caption was longer than the cap. `partialResult`
// travels all the way to the findings API, so a flag that lies, lies to an external consumer.
// Run: node modules/link-domain-security/snapshotFlags.test.mjs

import assert from 'node:assert/strict';

class StubElement {}
globalThis.Element = StubElement;
globalThis.Node = class { static TEXT_NODE = 3; static ELEMENT_NODE = 1; };
globalThis.window = { location: new URL('https://shop.example.com/catalog') };

let clock = 0;
globalThis.performance = { now: () => clock };

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

async function scanPage(build) {
    clock = 0;
    const root = makeElement('html');
    const body = appendChild(root, makeElement('body'));
    build(body);
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
    return detector.getSnapshotState();
}

// --- an ordinary page is complete -------------------------------------------------------------------

const clean = await scanPage((body) => {
    appendChild(body, makeElement('a', { href: 'https://shop.example.com/a' }, 'Read more'));
});
assert.equal(clean.status, 'complete');
assert.equal(clean.partialResult, false);
assert.equal(clean.budgetReached, false);
assert.equal(clean.contentTruncated, false);

// --- one very long caption is truncation, NOT incomplete coverage --------------------------------------

const longCaption = await scanPage((body) => {
    appendChild(body, makeElement('a', { href: 'https://shop.example.com/a' }, 'x'.repeat(4096)));
});
assert.equal(longCaption.contentTruncated, true, 'the caption was shortened and that must be reported');
assert.equal(longCaption.partialResult, false, 'the link itself was analysed, so coverage is complete');
assert.equal(longCaption.status, 'complete', 'a fully scanned page must not call itself partial');
assert.equal(longCaption.budgetReached, false, 'no budget was exhausted');

// --- an over-long href means the candidate was never analysed ------------------------------------------

const longHref = await scanPage((body) => {
    appendChild(body, makeElement('a', { href: `https://shop.example.com/${'a'.repeat(9000)}` }, 'Read more'));
});
assert.equal(longHref.partialResult, true, 'a candidate that was skipped entirely is a coverage gap');
assert.equal(longHref.contentTruncated, true, 'and it is reported as truncated content too');
assert.equal(longHref.budgetReached, false, 'but no budget was exhausted');

// --- a real budget stop is budgetReached, partial and aborted -------------------------------------------

clock = 0;
const root = makeElement('html');
const body = appendChild(root, makeElement('body'));
for (let index = 0; index < 50; index += 1) {
    appendChild(body, makeElement('a', { href: `https://shop.example.com/${index}` }, 'Read more'));
}
globalThis.document = { documentElement: root, baseURI: globalThis.window.location.href };

const detector = new LinkDomainSecurityDetector();
detector.config = { detectHomographs: true, detectLinkMismatch: true, detectRedirectPatterns: true, detectUnsafeProtocols: true };
detector.isEnabled = true;
// Every clock read advances time, so the 100 ms initial budget runs out inside the traversal.
globalThis.performance = { now: () => (clock += 4) };
await detector.firstScan();
const budgeted = detector.getSnapshotState();

assert.equal(budgeted.budgetReached, true, 'the time budget was exhausted');
assert.equal(budgeted.partialResult, true, 'an exhausted budget means incomplete coverage');
assert.equal(budgeted.traversalAborted, true, 'the traversal was cut short and says so');
assert.equal(budgeted.status, 'partial');

console.log('snapshotFlags.test.mjs: ok');

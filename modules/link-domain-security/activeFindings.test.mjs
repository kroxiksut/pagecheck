// Shield for B1 in the root TASKS (2026-09-11): the badge means "problems on the page NOW".
// Findings used to be counted from the last full scan on: a removed link stayed a finding until the
// page was reloaded, so the badge grew on a long-lived SPA (15 -> 48 -> 50 on github.com) and never
// went down. A finding is now anchored to the nodes that carry it and leaves when none of them is in
// the document any more - while a re-render of the same links must NOT drop it.
// Run: node modules/link-domain-security/activeFindings.test.mjs

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
        localName: tagName.toLowerCase(),
        attributes,
        children: [],
        childNodes: text ? [{ nodeType: 3, textContent: text }] : [],
        parentElement: null,
        isConnected: true,
        getAttribute: (name) => (Object.hasOwn(attributes, name) ? attributes[name] : null),
        hasAttribute: (name) => Object.hasOwn(attributes, name),
        closest: () => null,
        matches(selector) {
            if (selector === LINK_TEXT_PRIVACY_SELECTOR) {
                return ['INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'OPTGROUP'].includes(this.tagName);
            }
            return false;
        }
    });
}

function appendChild(parent, child) {
    child.parentElement = parent;
    parent.children.push(child);
    parent.childNodes.push(child);
    return child;
}

function detach(element) {
    element.isConnected = false;
    element.children.forEach(detach);
}

// What a framework does: throw the old nodes away and render new ones.
function renderLinks(container, links) {
    container.children.forEach(detach);
    container.children = [];
    container.childNodes = [];
    for (const [href, text] of links) {
        appendChild(container, makeElement('a', { href }, text));
    }
}

const PLANTED = [
    ['https://partner.example.org/login', 'example.com'],
    ['javascript:steal()', 'Continue'],
    ['https://xn--80ak6aa92e.com/account', 'Sign in']
];

const { default: LinkDomainSecurityDetector } = await import('./LinkDomainSecurityDetector.js');

function makeDetector() {
    const detector = new LinkDomainSecurityDetector();
    detector.config = {
        detectHomographs: true,
        detectLinkMismatch: true,
        detectRedirectPatterns: true,
        detectUnsafeProtocols: true
    };
    detector.isEnabled = true;
    return detector;
}

const root = makeElement('html');
const body = appendChild(root, makeElement('body'));
const list = appendChild(body, makeElement('div'));
renderLinks(list, PLANTED);
globalThis.document = { documentElement: root, baseURI: globalThis.window.location.href };

// The expected count is measured by a fresh detector on the same DOM, so the test does not hardcode
// how many findings one link produces - only that the long-lived detector agrees with a fresh one.
async function countOnFreshDetector() {
    const fresh = makeDetector();
    await fresh.firstScan();
    return fresh.buildScanSnapshot().threatsDetected;
}

const detector = makeDetector();
const announced = [];
detector.on('findingStateChanged', ({ count }) => announced.push(count));
await detector.firstScan();

const full = detector.buildScanSnapshot().threatsDetected;
assert.ok(full >= 3, `the three planted problems must be reported, got ${full}`);

// --- 1. a removed link takes its findings with it -------------------------------------------------

renderLinks(list, [PLANTED[0], PLANTED[2]]);
await detector.processMutationRoots([list]);
const withoutOne = await countOnFreshDetector();
assert.ok(withoutOne < full, 'the removed link must have carried at least one finding');
assert.equal(
    detector.buildScanSnapshot().threatsDetected,
    withoutOne,
    'after a link is removed the module must report what a fresh scan of the page reports'
);
assert.equal(detector.recentFindings.length, withoutOne, 'the finding list must shrink with the count');

// --- 2. a re-render of the same links drops nothing ----------------------------------------------

for (let round = 0; round < 3; round += 1) {
    renderLinks(list, [PLANTED[0], PLANTED[2]]);
    await detector.processMutationRoots([list]);
    assert.equal(
        detector.buildScanSnapshot().threatsDetected,
        withoutOne,
        `re-render ${round + 1}: new nodes carry the same findings, the count must not move`
    );
}

// --- 3. a link that comes back is counted again -----------------------------------------------------

renderLinks(list, PLANTED);
await detector.processMutationRoots([list]);
assert.equal(detector.buildScanSnapshot().threatsDetected, full, 'a problem that is back on the page is counted again');

// --- 4. the runtime hears about a change, and only about a change -----------------------------------

announced.length = 0;
detector.settleFindingCount();
assert.deepEqual(announced, [], 'no change since the last snapshot - nothing to announce');

renderLinks(list, []);
detector.settleFindingCount();
const empty = await countOnFreshDetector();
assert.deepEqual(announced, [empty], 'removing every link must be announced once, with the new count');
detector.settleFindingCount();
assert.deepEqual(announced, [empty], 'the same count is not announced twice');

// --- 5. a removal alone is a reason to run a batch ---------------------------------------------------

renderLinks(list, PLANTED);
await detector.processMutationRoots([list]);
const removedLink = list.children[1];
list.children.splice(1, 1);
list.childNodes = list.childNodes.filter((node) => node !== removedLink);
detach(removedLink);
detector.handleMutations([{ type: 'childList', target: list, addedNodes: [], removedNodes: [removedLink] }]);
assert.notEqual(detector.mutationBatchTimer, null, 'a mutation that only removes nodes must schedule a batch');
detector.stopScheduledWork();

// --- 6. the identity key still never leaves the module (7.16) ---------------------------------------

assert.ok(
    detector.recentFindings.every((finding) => !Object.hasOwn(finding, 'dedupeKey')),
    'anchoring must not bring dedupeKey back into the published findings'
);

console.log(`activeFindings.test.mjs (link): ok (${full} -> ${withoutOne} -> ${full} -> ${empty})`);

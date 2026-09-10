// Shield for TASKS 7.4: `<base href>` and where a relative link actually goes.
// The module resolved relative targets against window.location.href, but the browser resolves them
// against document.baseURI. One line in the head - `<base href="https://evil.io/">` - and every
// relative link on the page went somewhere the module never looked at: the caption matched, the
// host looked like the page's own, and the redirect analysis inspected the wrong URL.
// The second half of the item: a <base> pointing at another origin is a signal in itself, because
// it retargets every relative link at once, which no single href can do.
// Run: node modules/link-domain-security/baseUri.test.mjs

import assert from 'node:assert/strict';

class StubElement {}
globalThis.Element = StubElement;
globalThis.Node = class { static TEXT_NODE = 3; static ELEMENT_NODE = 1; };
globalThis.performance = { now: () => 0 };
globalThis.window = { location: new URL('https://shop.example.com/catalog/page') };

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

async function scanWithBase(baseURI, links) {
    const root = makeElement('html');
    const body = appendChild(root, makeElement('body'));
    for (const [href, text] of links) {
        appendChild(body, makeElement('a', { href }, text));
    }
    globalThis.document = { documentElement: root, baseURI };

    const detector = new LinkDomainSecurityDetector();
    detector.config = {
        detectHomographs: true,
        detectLinkMismatch: true,
        detectRedirectPatterns: true,
        detectUnsafeProtocols: true
    };
    detector.isEnabled = true;
    await detector.firstScan();
    return detector;
}

const PAGE = 'https://shop.example.com/catalog/page';

// --- 1. A relative link under a foreign <base> is a mismatch ------------------------------------
{
    // The caption says shop.example.com and the browser will navigate to evil.io/login.
    const detector = await scanWithBase('https://evil.io/', [['/login', 'shop.example.com']]);
    const mismatches = detector.recentFindings.filter((finding) => finding.type === 'link-mismatch');

    assert.equal(mismatches.length, 1, 'the relative link must be compared against the real destination');
    assert.ok(
        mismatches[0].details.includes('evil.io'),
        `the finding must name the real target, got: ${mismatches[0].details}`
    );
}

// --- 2. Control: without a <base> the same link is same-host and quiet --------------------------
{
    const detector = await scanWithBase(PAGE, [['/login', 'shop.example.com']]);
    const mismatches = detector.recentFindings.filter((finding) => finding.type === 'link-mismatch');

    assert.equal(mismatches.length, 0, 'a relative link to the page own host is not a mismatch');
}

// --- 3. The foreign <base> is a finding of its own ----------------------------------------------
{
    const detector = await scanWithBase('https://evil.io/', [['/login', 'Sign in']]);
    const baseFindings = detector.recentFindings.filter((finding) => finding.type === 'base-origin-mismatch');

    assert.equal(baseFindings.length, 1, 'a base href on another origin must be reported');
    assert.equal(baseFindings[0].severity, 'high', 'it retargets every relative link on the page');
    assert.ok(baseFindings[0].details.includes('https://evil.io'), 'the details must name the foreign origin');
    assert.ok(baseFindings[0].details.includes('https://shop.example.com'), 'and the page origin it replaced');
}

// --- 4. A same-origin <base> is normal and silent -----------------------------------------------
{
    for (const baseURI of [PAGE, 'https://shop.example.com/', 'https://shop.example.com/other/path']) {
        const detector = await scanWithBase(baseURI, [['/login', 'Sign in']]);
        assert.equal(
            detector.recentFindings.filter((finding) => finding.type === 'base-origin-mismatch').length,
            0,
            `a same-origin base (${baseURI}) is ordinary markup`
        );
    }
}

// --- 5. Absolute links are unaffected by the base -----------------------------------------------
{
    const withBase = await scanWithBase('https://evil.io/', [['https://partner.example.org/x', 'shop.example.com']]);
    const withoutBase = await scanWithBase(PAGE, [['https://partner.example.org/x', 'shop.example.com']]);
    const types = (detector) => detector.recentFindings
        .filter((finding) => finding.type !== 'base-origin-mismatch')
        .map((finding) => `${finding.type}|${finding.details}`)
        .sort();

    assert.deepEqual(types(withBase), types(withoutBase), 'an absolute href does not depend on the base');
}

// --- 6. A missing or broken baseURI falls back to the location ----------------------------------
{
    for (const baseURI of ['', undefined, 'not a url']) {
        const detector = await scanWithBase(baseURI, [['/login', 'shop.example.com']]);
        assert.equal(
            detector.recentFindings.filter((finding) => finding.type === 'link-mismatch').length,
            0,
            `a base of ${JSON.stringify(baseURI)} must fall back to the page location, not break the scan`
        );
        assert.equal(detector.unitErrorCount, 0, 'and must not be recorded as a lost unit of work');
    }
}

console.log('baseUri.test.mjs: OK');

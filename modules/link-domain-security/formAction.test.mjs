// Shield for question В6 after Priority 7: `formaction` on a submit control.
// The attribute OVERRIDES the form's own action, so a form whose action points at its own host can
// still submit anywhere. The module only ever looked at `a[href]` and `form[action]`, so this was
// the same hole `<base>` was (7.4): markup elsewhere silently decides where navigation goes.
// The second half of the shield is a privacy one: a submit control's label lives in its `value`
// attribute, and the module must never read that - so a formaction candidate gets no visible text
// and no mismatch check, deliberately.
// Run: node modules/link-domain-security/formAction.test.mjs

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

async function scan(build) {
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
    return detector;
}

// --- 1. An innocent form action with a hostile formaction -------------------------------------
{
    const detector = await scan((body) => {
        const form = appendChild(body, makeElement('form', { action: 'https://shop.example.com/submit' }));
        appendChild(form, makeElement('button', { type: 'submit', formaction: 'javascript:void(steal())' }));
    });

    const unsafe = detector.recentFindings.filter((finding) => finding.type === 'unsafe-protocol');
    assert.equal(unsafe.length, 1, 'the overriding target must be analysed');
    assert.ok(unsafe[0].details.includes('<button>'), `the finding must name the control: ${unsafe[0].details}`);
}

// --- 2. A homograph host in formaction ---------------------------------------------------------
{
    const detector = await scan((body) => {
        const form = appendChild(body, makeElement('form', { action: '/submit' }));
        appendChild(form, makeElement('input', { type: 'submit', formaction: 'https://xn--80ak6aa92e.com/pay' }));
    });

    assert.ok(
        detector.recentFindings.some((finding) => finding.type === 'hostname-confusable'),
        'hostname analysis applies to a formaction target like any other'
    );
}

// --- 3. A same-host formaction is ordinary markup ----------------------------------------------
{
    const detector = await scan((body) => {
        const form = appendChild(body, makeElement('form', { action: 'https://shop.example.com/submit' }));
        appendChild(form, makeElement('button', { type: 'submit', formaction: 'https://shop.example.com/save' }));
    });

    assert.equal(detector.stats.threatsDetected, 0, 'a same-host override is not a finding');
    assert.equal(detector.scanCandidatesAnalyzed, 2, 'but it is still a scanned candidate');
}

// --- 4. Controls without formaction are not candidates -----------------------------------------
{
    const detector = await scan((body) => {
        const form = appendChild(body, makeElement('form', { action: 'https://shop.example.com/submit' }));
        appendChild(form, makeElement('button', { type: 'submit' }));
        appendChild(form, makeElement('input', { type: 'text', value: 'secret' }));
    });

    assert.equal(detector.scanCandidatesAnalyzed, 1, 'only the form itself is a candidate here');
}

// --- 5. Privacy: a submit control contributes no visible text ----------------------------------
{
    const detector = await scan((body) => {
        const form = appendChild(body, makeElement('form', { action: '/submit' }));
        // The label is in `value` - the module must not read it, and must not run a mismatch check
        // that would put it into a finding.
        appendChild(form, makeElement('input', {
            type: 'submit',
            value: 'shop.example.com',
            formaction: 'https://partner.example.org/pay'
        }));
    });

    assert.equal(
        detector.recentFindings.filter((finding) => finding.type === 'link-mismatch').length,
        0,
        'a submit control has no link caption to compare'
    );
    assert.ok(
        !JSON.stringify(detector.recentFindings).includes('shop.example.com'),
        'the control value must not reach a finding'
    );
}

// --- 6. The observer watches the attribute ------------------------------------------------------
{
    const detector = new LinkDomainSecurityDetector();
    assert.ok(
        detector.observerConfig.attributeFilter.includes('formaction'),
        'a formaction added after render must reach the module'
    );
}

console.log('formAction.test.mjs: OK');

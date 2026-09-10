// Shield for TASKS 6.3: an open redirect whose destination is not URL-shaped used to be dropped
// silently. `hasRedirectPattern` computed `hasUnknownDestination: true` for exactly that case and
// nobody read the flag, so the code looked like it handled what it ignored.
// Run: node modules/link-domain-security/utils/urlUtils.test.mjs

import assert from 'node:assert/strict';
import { hasRedirectPattern } from './urlUtils.js';

const PAGE = 'https://shop.example.com/r';

function analyze(query) {
    return hasRedirectPattern(new URL(`${PAGE}?${query}`));
}

function signalsOf(pattern) {
    const parameter = pattern?.redirectParameters?.find((entry) => entry.destinationType === 'unknown');
    return parameter ? parameter.opaqueSignals : [];
}

// --- destinations that are plainly external keep working ------------------------------------------

const external = analyze(`url=${encodeURIComponent('https://evil.example.net/steal')}`);
assert.equal(external.hasExternalDestination, true, 'a URL-shaped external destination is still external');
assert.equal(external.hasSuspiciousUnknownDestination, false, 'a parsed destination is not opaque');

const sameHost = analyze(`next=${encodeURIComponent('https://shop.example.com/target')}`);
assert.equal(sameHost.hasSameHostDestination, true);
assert.equal(sameHost.hasExternalDestination, false, 'a bounce to the same host is not external');
assert.equal(sameHost.hasSuspiciousUnknownDestination, false);

// --- the shapes that used to disappear --------------------------------------------------------------

const bareHost = analyze('url=evil.example.net');
assert.equal(bareHost.hasUnknownDestination, true);
assert.equal(bareHost.hasSuspiciousUnknownDestination, true, 'a bare hostname is a destination, not an id');
assert.deepEqual(signalsOf(bareHost), ['bare-hostname']);

const base64 = analyze('next=aHR0cHM6Ly9ldmlsLmV4YW1wbGUubmV0L3N0ZWFs');
assert.equal(base64.hasSuspiciousUnknownDestination, true, 'a base64 payload decoding to a URL must be seen');
assert.ok(signalsOf(base64).includes('base64-url'));

const doubleEncoded = analyze(`dest=${encodeURIComponent(encodeURIComponent('https://evil.example.net/steal'))}`);
assert.equal(doubleEncoded.hasSuspiciousUnknownDestination, true, 'double encoding must not hide a destination');
assert.ok(signalsOf(doubleEncoded).includes('encoded-url'));

const encodedDots = analyze('redirect=evil%2Eexample%2Enet');
assert.equal(encodedDots.hasSuspiciousUnknownDestination, true, 'percent-encoded dots still spell a hostname');

// --- values that are not destinations ----------------------------------------------------------------

for (const query of [
    'url=42',
    'next=checkout',
    'dest=step2',
    'target=cart',
    'continue=true',
    'redirect=1',
    'destination=order-42'
]) {
    const pattern = analyze(query);
    assert.equal(
        pattern.hasSuspiciousUnknownDestination,
        false,
        `"${query}" is an id or a flag, not a destination`
    );
}

// A long opaque token that decodes to nothing URL-like stays quiet.
const token = analyze('next=Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4');
assert.equal(token.hasSuspiciousUnknownDestination, false, 'base64 that is not a URL is not a redirect signal');

// --- no redirect key at all ----------------------------------------------------------------------------

assert.equal(analyze('utm_source=newsletter&utm_medium=email'), null, 'tracking parameters are not redirect keys');
assert.equal(analyze('id=42&ref=sidebar'), null);

// --- TASKS 7.5: a short bare hostname is still a bare hostname ----------------------------------
// The length floor was there to keep ids out, and it applied to all three signals at once - so the
// most ordinary open redirect of all, `?url=evil.com`, produced nothing because it is 8 characters.
for (const query of ['url=evil.com', 'next=bad.io', 'dest=a-b.co.uk']) {
    const pattern = analyze(query);
    assert.equal(
        pattern?.hasSuspiciousUnknownDestination,
        true,
        `"${query}" is a bare hostname destination whatever its length`
    );
    const bare = pattern.redirectParameters.find((parameter) => parameter.opaqueSignals.includes('bare-hostname'));
    assert.ok(bare, `"${query}" must be labelled bare-hostname`);
}

// The floor still does its job where it was actually needed: short values that are not host-shaped.
for (const query of ['url=order-42', 'next=abcdefgh', 'dest=42']) {
    assert.equal(
        analyze(query)?.hasSuspiciousUnknownDestination,
        false,
        `"${query}" is not host-shaped and must stay quiet`
    );
}

// And the guard behind bare-hostname is what keeps ids out, not the length: a short value with a
// TLD that does not exist is not a destination.
assert.equal(
    analyze('url=build.info2')?.hasSuspiciousUnknownDestination,
    false,
    'a value whose last label is not a real zone is not a bare hostname'
);

console.log('urlUtils.test.mjs: ok');

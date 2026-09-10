// Shield for TASKS 6.1 and 6.2 - the two mirror defects of the same class: the module was loud
// where nothing happens and quiet where the canonical attack happens.
//   6.1 any dotted caption counted as a hostname, so `annual-report.pdf` produced a HIGH severity
//       link-mismatch on an ordinary download link.
//   6.2 script mixing was required INSIDE one label, so a whole-script lookalike (`аррӏе.com` for
//       `apple.com`) reached the user only as the low-severity punycode notice.
// Run: node modules/link-domain-security/utils/domainUtils.test.mjs

import assert from 'node:assert/strict';
import { analyzeHostname, hasVisibleTargetMismatch, isUnsafeProtocol } from './domainUtils.js';

// --- 6.1: captions that are not hostnames ---------------------------------------------------------

const NOT_HOSTNAME_CAPTIONS = [
    'annual-report.pdf',
    'index.html',
    'bundle.min.js',
    'data.json',
    'photo.png',
    'archive.tar.gz',
    'notes.txt',
    'style.css',
    'report.docx',
    'setup.exe',
    '12.05.2023',
    '19.99',
    '1.2',
    '3.14',
    '2023.11',
    'v1.2.3',
    'chapter.1'
];

for (const caption of NOT_HOSTNAME_CAPTIONS) {
    const result = hasVisibleTargetMismatch(caption, 'cdn.example.com');
    assert.equal(result.eligible, false, `caption "${caption}" must not be read as a hostname`);
    assert.equal(result.mismatchReason, 'not-domain-like', `caption "${caption}" must be rejected as not domain-like`);
}

// --- 6.1: real hostnames in the caption still work -------------------------------------------------

const realMismatch = hasVisibleTargetMismatch('example.com', 'partner.example.org');
assert.equal(realMismatch.eligible, true, 'a real hostname caption must stay eligible');
assert.equal(realMismatch.matches, false, 'a caption pointing elsewhere is a mismatch');
assert.equal(realMismatch.visibleHostname, 'example.com');

const honestLink = hasVisibleTargetMismatch('shop.example.com', 'shop.example.com');
assert.equal(honestLink.eligible, true);
assert.equal(honestLink.matches, true, 'a caption naming its own host must not be a mismatch');

const wwwPrefixed = hasVisibleTargetMismatch('www.shop.example.com', 'shop.example.com');
assert.equal(wwwPrefixed.matches, true, 'www. must be normalised away on both sides');

const subdomain = hasVisibleTargetMismatch('example.com', 'cdn.example.com');
assert.equal(subdomain.matches, true, 'a subdomain of the visible host is not a mismatch');

const urlCaption = hasVisibleTargetMismatch('https://example.com/path', 'partner.example.org');
assert.equal(urlCaption.eligible, true, 'a full URL caption is still a hostname caption');
assert.equal(urlCaption.matches, false);

// Non-ASCII TLDs are letters too and must survive the guard.
const idnCaption = hasVisibleTargetMismatch('пример.рф', 'partner.example.org');
assert.equal(idnCaption.eligible, true, 'an IDN caption must stay eligible');
assert.equal(idnCaption.matches, false);

// --- 6.2: whole-script confusables ----------------------------------------------------------------

// аррӏе.com - every letter is a Cyrillic lookalike of a Latin one, no script mixing at all.
const wholeScript = analyzeHostname('xn--80ak6aa92e.com');
assert.equal(wholeScript.hasPunycode, true);
assert.equal(wholeScript.hasWholeScriptConfusable, true, 'a whole-script Latin lookalike must be recognised');
assert.equal(wholeScript.hasMixedScript, false, 'there is no script mixing in this hostname');
assert.deepEqual(wholeScript.confusableLabels.length, 1);

// аpple.com - one Cyrillic letter inside a Latin word: the case that already worked.
const mixed = analyzeHostname('xn--pple-43d.com');
assert.equal(mixed.hasMixedScript, true, 'mixed-script detection must be untouched');
assert.equal(mixed.hasWholeScriptConfusable, false, 'a label with Latin letters is not a whole-script lookalike');

// --- 6.2: legitimate IDN must not be escalated ------------------------------------------------------

for (const [hostname, label] of [
    ['xn--e1afmkfd.xn--p1ai', 'пример.рф'],
    ['xn--mnchen-3ya.de', 'münchen.de'],
    ['xn--bcher-kva.de', 'bücher.de'],
    ['xn--80aswg.xn--p1ai', 'сайт.рф']
]) {
    const analysis = analyzeHostname(hostname);
    assert.equal(analysis.hasWholeScriptConfusable, false, `${label} is a legitimate IDN, not a lookalike`);
    assert.equal(analysis.hasMixedScript, false, `${label} must not be reported as mixed-script`);
    assert.equal(analysis.hasPunycode, true, `${label} is still a punycode hostname`);
}

// A plain Latin hostname triggers nothing at all.
const plain = analyzeHostname('shop.example.com');
assert.equal(plain.hasPunycode, false);
assert.equal(plain.hasMixedScript, false);
assert.equal(plain.hasWholeScriptConfusable, false);

// The TLD itself is never the confusable signal: an all-lookalike ccTLD is how IDN ccTLDs look.
const idnTld = analyzeHostname('example.xn--e1afmkfd');
assert.equal(idnTld.hasWholeScriptConfusable, false, 'the TLD label is excluded from the confusable check');

// Excluded hostnames keep returning null.
assert.equal(analyzeHostname('localhost'), null);
assert.equal(analyzeHostname('192.168.0.1'), null);

// --- TASKS 7.1: a dotted code identifier is not a hostname --------------------------------------
// The file-extension blacklist could never cover this class: extensions are a finite list, dotted
// identifiers are not. Every caption below used to produce a HIGH severity link-mismatch.
for (const caption of [
    'Object.keys', 'Array.prototype', 'React.Component', 'System.out', 'String.raw',
    'os.path', 'numpy.array', 'torch.nn', 'math.floor', 'json.dumps', 'Ctrl.Shift',
    'app.services', 'user.name', 'файл.архив'
]) {
    assert.equal(
        hasVisibleTargetMismatch(caption, 'shop.example.com').eligible,
        false,
        `"${caption}" is an identifier, not a hostname`
    );
}

// Real captions must keep working - ccTLDs, legacy gTLDs, new gTLDs and IDN zones alike.
for (const caption of [
    'shop.example.com', 'example.com', 'mail.example.co.uk', 'docs.example.io',
    'x.app', 'site.xyz', 'a.dev', 'сайт.рф', 'пример.москва'
]) {
    assert.equal(
        hasVisibleTargetMismatch(caption, 'other.example.net').eligible,
        true,
        `"${caption}" is a hostname and must still be compared`
    );
}

// The file-extension list overrides the allowlist, which is why it is still needed: several of its
// entries are real zones.
for (const caption of ['archive.zip', 'clip.mov', 'script.sh', 'notes.md', 'setup.py']) {
    assert.equal(
        hasVisibleTargetMismatch(caption, 'shop.example.com').eligible,
        false,
        `"${caption}" reads as a file name even though its last label is a real zone`
    );
}

// --- TASKS 7.2: script mixing is not only Latin+Cyrillic ---------------------------------------
// A Greek letter inside a Latin word produced NOTHING before: mixed-script only looked for
// Cyrillic, and the whole-script check refuses any label containing Latin letters.
for (const [hostname, label] of [
    ['αpple.com', 'Greek alpha inside a Latin word'],
    ['pαypal.com', 'the same shape on another brand'],
    ['аpple.com', 'Cyrillic а inside a Latin word - the case that always worked']
]) {
    const analysis = analyzeHostname(hostname);
    assert.equal(analysis.hasMixedScript, true, `${label} must be reported as mixed-script`);
}

// One script alone is never mixing, whichever script it is.
for (const hostname of ['ελλάδα.gr', 'пример.рф', 'münchen.de', 'shop.example.com']) {
    assert.equal(
        analyzeHostname(hostname).hasMixedScript,
        false,
        `${hostname} is written in one script and must not be reported as mixed`
    );
}

// --- TASKS 7.3: the whole-script signal must not fire on legitimate national domains ------------
// Every letter of these Russian words happens to have a Latin lookalike, but the ZONE is the
// Cyrillic one - that is how a Russian domain is normally written.
for (const hostname of ['сахар.рф', 'роса.рф', 'аура.рф', 'сера.рф']) {
    assert.equal(
        analyzeHostname(hostname).hasWholeScriptConfusable,
        false,
        `${hostname} is a legitimate domain in its own zone, not a lookalike`
    );
}

// A short label satisfies "every letter is a lookalike" by accident, in any zone.
for (const hostname of ['оса.com', 'сор.com', 'рос.net']) {
    assert.equal(
        analyzeHostname(hostname).hasWholeScriptConfusable,
        false,
        `${hostname} is too short for the signal to mean anything`
    );
}

// The attack shape still fires: a Cyrillic name of real length in a Latin zone.
for (const hostname of ['аррӏе.com', 'ѕсоре.com', 'раураӏ.net']) {
    assert.equal(
        analyzeHostname(hostname).hasWholeScriptConfusable,
        true,
        `${hostname} is the case this signal exists for`
    );
}

// --- TASKS 7.6: the executable-protocol list ----------------------------------------------------
for (const [protocol, severity] of [['javascript:', 'high'], ['vbscript:', 'high'], ['VBScript:', 'high'], ['data:', 'medium'], ['file:', 'medium']]) {
    const verdict = isUnsafeProtocol(protocol);
    assert.ok(verdict, `${protocol} must be reported as unsafe`);
    assert.equal(verdict.severity, severity, `${protocol} severity`);
}

// Ordinary and deliberately-excluded protocols stay quiet - blob: is how a page offers a generated
// file for download, so reporting it would be noise.
for (const protocol of ['https:', 'http:', 'mailto:', 'tel:', 'blob:', 'filesystem:', '']) {
    assert.equal(isUnsafeProtocol(protocol), null, `${protocol || '(empty)'} must not be reported`);
}

// --- В4: punycode notice only where the script does not belong to its zone --------------------
// The notice is the module's weakest signal and, after 7.3, became the main outcome for ordinary
// hostnames: every `.рф` link on a Russian page.
const punycodeOf = (hostname) => new URL(`https://${hostname}/`).hostname;

// Silent: the name is written in the script of its own IDN zone.
for (const hostname of ['сахар.рф', 'www.сахар.рф', 'пример.рф', 'сайт.рф']) {
    assert.equal(
        analyzeHostname(punycodeOf(hostname)).hasScriptZoneMismatch,
        false,
        `${hostname} is written in the script of its own zone`
    );
}

// Reported: the script does not belong to the zone.
assert.equal(analyzeHostname(punycodeOf('оса.com')).hasScriptZoneMismatch, true, 'Cyrillic under .com');

// Reported: an ASCII zone never suppresses, because there the notice is the only thing that can see
// a Latin-INTERNAL lookalike. `gogleɟ.com` (U+025F is a Latin letter) carries no script mixing and
// no whole-script confusable - suppressing it would leave the hostname with no signal at all.
const latinInternal = analyzeHostname('xn--gogle-jmc.com');
assert.equal(latinInternal.hasMixedScript, false, 'a Latin-internal lookalike has no script mixing');
assert.equal(latinInternal.hasWholeScriptConfusable, false, 'and no whole-script confusable');
assert.equal(latinInternal.hasScriptZoneMismatch, true, 'so the punycode notice must survive for it');

// The same reason keeps legitimate European IDN reported - nothing offline tells ü from ɟ.
for (const hostname of ['münchen.de', 'bücher.de', 'ελλάδα.gr']) {
    assert.equal(
        analyzeHostname(punycodeOf(hostname)).hasScriptZoneMismatch,
        true,
        `${hostname} sits in an ASCII zone, where the notice is kept on purpose`
    );
}

// A hostname without punycode has nothing to report either way.
assert.equal(analyzeHostname('shop.example.com').hasScriptZoneMismatch, false, 'no punycode, no notice');

// --- Latin-internal lookalikes (the gap the В4 measurement exposed) -----------------------------
// A substituted letter INSIDE a Latin name carries no script mixing and no whole-script confusable,
// so before this rule nothing in the module could see it - only the generic punycode notice
// mentioned it, and only by accident.
for (const [hostname, note] of [
    ['xn--gogle-jmc.com', 'gogleɟ.com, U+025F'],
    ['paypᴀl.com', 'a small-capital A'],
    ['ɡoogle.com', 'a script g']
]) {
    const analysis = analyzeHostname(hostname.startsWith('xn--') ? hostname : punycodeOf(hostname));
    assert.equal(analysis.hasLatinLookalike, true, `${note} must be recognised`);
    assert.equal(analysis.hasMixedScript, false, `${note} carries no script mixing`);
    assert.equal(analysis.hasWholeScriptConfusable, false, `${note} is not a whole-script lookalike`);
}

// Letters of real orthographies are NOT lookalikes, however confusable they look. Flagging them
// would repeat the mistake 7.3 had to undo for Cyrillic.
for (const hostname of ['münchen.de', 'bücher.de', 'ısparta.com', 'łódź.pl', 'køge.dk', 'straße.de']) {
    assert.equal(
        analyzeHostname(punycodeOf(hostname)).hasLatinLookalike,
        false,
        `${hostname} is written in the letters of a real language`
    );
}

// A plain ASCII hostname has nothing to substitute.
assert.equal(analyzeHostname('shop.example.com').hasLatinLookalike, false);

// The zone label is out of scope here as it is everywhere else in this file.
assert.equal(analyzeHostname('example.com').hasLatinLookalike, false);

// --- В5: a hostname NAMED inside a sentence -----------------------------------------------------
// Any whitespace used to disqualify the whole caption, so the most ordinary phishing caption there
// is - "Войти на paypal.com" - went unchecked.
for (const [caption, target] of [
    ['Войти на paypal.com', 'partner.example.org'],
    ['Смотрите на paypal.com, там всё', 'evil.example.net'],
    ['Sign in at paypal.com now', 'evil.example.net'],
    ['Открыть (paypal.com) в новой вкладке', 'evil.example.net']
]) {
    const result = hasVisibleTargetMismatch(caption, target);
    assert.equal(result.eligible, true, `"${caption}" names a host`);
    assert.equal(result.matches, false, `"${caption}" does not name ${target}`);
    assert.equal(result.visibleHostname, 'paypal.com', 'sentence punctuation must not stick to the host');
}

// The named host IS the destination - silence, including a subdomain of it.
for (const [caption, target] of [
    ['Скачать с example.com', 'example.com'],
    ['Скачать с example.com', 'cdn.example.com'],
    ['Read more at shop.example.com', 'www.shop.example.com']
]) {
    assert.equal(hasVisibleTargetMismatch(caption, target).matches, true, `"${caption}" -> ${target}`);
}

// Several hosts named, the link lands on one of them: an honest link, not a mismatch.
assert.equal(
    hasVisibleTargetMismatch('Зеркала: a.example.com или b.example.com', 'b.example.com').matches,
    true,
    'any named host matching the destination clears the caption'
);

// A sentence with no hostname in it stays out of the comparison entirely - including the shapes
// 7.1 removed, which must not come back through the token path.
for (const caption of [
    'Читать далее',
    'Версия 1.2 доступна',
    'Скачайте annual-report.pdf сейчас',
    'Подробнее в Object.keys документации',
    'Цена 19.99 за штуку'
]) {
    assert.equal(
        hasVisibleTargetMismatch(caption, 'shop.example.com').eligible,
        false,
        `"${caption}" names no host`
    );
}

// The known cost of opening this up, asserted rather than hidden: a brand named in the caption with
// the file served from a CDN on a DIFFERENT registrable domain reads as a mismatch. Nothing offline
// can tell that from a real one - no Public Suffix List, no ownership data.
assert.equal(
    hasVisibleTargetMismatch('Скачать с example.com', 'cdn.example.net').matches,
    false,
    'documented false-positive shape - kept in sight on purpose'
);

console.log('domainUtils.test.mjs: ok');

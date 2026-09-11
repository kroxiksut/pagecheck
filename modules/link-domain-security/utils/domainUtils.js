// @data-list (см. комментарий ниже: что это, чем оборачивается устаревание)
// Two lists decide whether the last label of a dotted caption is a TLD, and they answer two
// DIFFERENT questions (TASKS 7.1):
//   KNOWN_TLDS      - "does a zone with this name exist at all?"
//   NON_TLD_FILE_EXTENSIONS - "in a link caption, is this more likely a file extension than a zone?"
// The blacklist alone was not enough: it can only enumerate file extensions, and the noise it left
// behind was code, not files. `Object.keys`, `React.Component`, `os.path`, `numpy.array`,
// `torch.nn`, `System.out` all passed as hostnames and produced HIGH severity link-mismatch
// findings on every documentation page.
// The allowlist is short on purpose - all ccTLDs (two ASCII letters, ISO 3166-1, which changes
// about once a decade), the legacy gTLDs, the new gTLDs people actually see, and the IDN zones.
// When it goes stale the module gets QUIETER, never louder: an unknown zone means "this caption is
// not a hostname", i.e. one missed mismatch. And a caption has to look like a familiar brand to
// deceive anyone in the first place, so forgeries live in familiar zones.
// The long tail of generic-word gTLDs (`.services`, `.systems`, `.name`, `.tools`, `.pro`, ...) is
// deliberately absent: those words are far more often the tail of a dotted code identifier in a
// caption than the zone of a link, and the trade is one missed low-signal mismatch against constant
// HIGH-severity noise. Adding an entry here is cheap; adding one that reads like an English word in
// `namespace.word` is not.
// Maintenance: this list, and both lookalike tables below, go stale silently - a new zone means a
// MISSED detection and nothing fails to tell you. They are reviewed by hand before a release
// (C7.2 in the root TASKS); that is why every one of them carries its selection criterion in a
// comment, so the review is a decision and not a fresh investigation.
const KNOWN_TLDS = new Set(`
ad ae af ag ai al am ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bl bm bn bo bq br bs bt
bv bw by bz ca cc cd cf cg ch ci ck cl cm cn co cr cu cv cw cx cy cz de dj dk dm do dz ec ee eg eh
er es et eu fi fj fk fm fo fr ga gb gd ge gf gg gh gi gl gm gn gp gq gr gs gt gu gw gy hk hm hn hr
ht hu id ie il im in io iq ir is it je jm jo jp ke kg kh ki km kn kp kr kw ky kz la lb lc li lk lr
ls lt lu lv ly ma mc md me mf mg mh mk ml mm mn mo mp mq mr ms mt mu mv mw mx my mz na nc ne nf ng
ni nl no np nr nu nz om pa pe pf pg ph pk pl pm pn pr ps pt pw py qa re ro rs ru rw sa sb sc sd se
sg sh si sj sk sl sm sn so sr ss st su sv sx sy sz tc td tf tg th tj tk tl tm tn to tr tt tv tw tz
ua ug uk um us uy uz va vc ve vg vi vn vu wf ws ye yt za zm zw
com net org info biz edu gov mil
app dev page site online store shop tech cloud blog news live top xyz club fun life world space
website digital wiki art icu vip link click work today best
рф рус москва дети онлайн сайт бел укр қаз срб мкд ею
中国 中國 公司 网络 台湾 台灣 香港 新加坡 商城 网站 在线 我爱你
한국 日本 みんな コム インド भारत বাংলা ভারত ਭਾਰਤ ભારત இந்தியா భారత్ ಭಾರತ ලංකා ไทย
مصر السعودية الاردن المغرب امارات ايران عمان قطر بھارت پاکستان سورية تونس شبكة موقع كوم عرب
ישראל קום
`.trim().split(/\s+/u));

// @data-list (см. комментарий ниже: что это, чем оборачивается устаревание)
// Last labels that a link caption can plausibly end with while being a file name rather than a
// hostname (TASKS 6.1). This list OVERRIDES the allowlist above, which is why it survived 7.1:
// several of its entries are perfectly real TLDs (`zip`, `mov`, `sh`, `py`, `so`, `md`, `ai`).
// The collision is resolved in favour of the file reading on purpose: a caption saying
// `archive.zip` is overwhelmingly more common on the web than a link captioned with a .zip domain,
// and the cost of the wrong guess is one missed low-signal mismatch versus constant high-severity
// noise.
const NON_TLD_FILE_EXTENSIONS = new Set([
    'ai', 'apk', 'asp', 'aspx', 'avi', 'bak', 'bat', 'bmp', 'css', 'csv', 'dll', 'dmg', 'doc',
    'docx', 'dtd', 'eot', 'exe', 'flv', 'gif', 'gz', 'htm', 'html', 'ico', 'iso', 'jar', 'jpeg',
    'jpg', 'js', 'json', 'jsp', 'log', 'md', 'mov', 'mp', 'mpeg', 'mpg', 'msi', 'odt', 'otf', 'pdf',
    'php', 'png', 'ppt', 'pptx', 'psd', 'py', 'rar', 'rb', 'rtf', 'sh', 'so', 'sql', 'svg', 'tar',
    'tgz', 'tiff', 'tmp', 'ttf', 'txt', 'wav', 'webp', 'xls', 'xlsx', 'xml', 'yaml', 'yml', 'zip'
]);

// @data-list (см. комментарий ниже: что это, чем оборачивается устаревание)
// Cyrillic and Greek letters whose LOWERCASE glyph is a Latin lookalike - hostnames are displayed
// lowercased, so letters that are confusable only in their uppercase form (Cyrillic м/т/в/н against
// Latin M/T/B/H) are deliberately absent. Used to recognise whole-script homographs (TASKS 6.2).
const LATIN_LOOKALIKE_LETTERS = new Set([
    // Cyrillic
    'а', 'е', 'о', 'р', 'с', 'х', 'у', 'і', 'ј', 'ѕ', 'ԁ', 'ԛ', 'ԝ', 'ӏ', 'ѵ', 'ԍ', 'һ',
    // Greek
    'ο', 'α', 'ρ', 'ν', 'ι', 'χ', 'ϲ', 'ε', 'υ', 'ϳ'
]);

// @data-list (см. комментарий ниже: что это, чем оборачивается устаревание)
// Latin-script characters that no language writes its domain names with: the IPA / phonetic
// extensions and the small-capital block. Their whole purpose in a hostname is
// to stand in for an ASCII letter - `gogleɟ.com`, `paypᴀl.com`.
// The selection criterion is deliberately narrow and is what makes this list safe: a letter that
// belongs to a real orthography is NOT here, however confusable it looks. `ı` (Turkish), `ł`
// (Polish), `ø` (Danish), `ü`, `ö`, `ß`, `ğ`, `đ` are legitimate letters of legitimate names, and
// including them would flag ordinary national domains - the mistake 7.3 had to undo for Cyrillic.
// This is the gap the В4 measurement exposed: a lookalike written INSIDE Latin carries no script
// mixing (7.2) and no whole-script confusable (6.2), so nothing in the module could see it and only
// the generic punycode notice mentioned it, by accident.
const LATIN_ONLY_LOOKALIKE_LETTERS = new Set([
    // IPA and phonetic extensions
    'ɡ', 'ɟ', 'ɪ', 'ɩ', 'ʏ', 'ʙ', 'ʜ', 'ɴ', 'ʀ', 'ʟ', 'ɑ', 'ɐ', 'ɢ', 'ʁ', 'ɜ', 'ɹ', 'ʇ', 'ʞ',
    // Latin small capitals
    'ᴀ', 'ᴄ', 'ᴅ', 'ᴇ', 'ᴋ', 'ᴍ', 'ᴏ', 'ᴘ', 'ᴛ', 'ᴜ', 'ᴠ', 'ᴡ', 'ᴢ', 'ᴊ'
    // Fullwidth Latin letters are deliberately absent: UTS-46 folds them to plain ASCII before the
    // hostname ever reaches this module, so `ｇoogle.com` IS `google.com` and there is nothing to
    // detect. Checked, not assumed.
]);

export function isUnsafeProtocol(protocol) {
    const normalizedProtocol = String(protocol || '').toLowerCase();

    // `vbscript:` is the same class of executable target as `javascript:` and was simply missing
    // (TASKS 7.6). `blob:` and `filesystem:` are deliberately NOT here: blob: is the ordinary way a
    // page offers a generated file for download, so it would be noise, not signal.
    if (normalizedProtocol === 'javascript:' || normalizedProtocol === 'vbscript:') {
        return { protocol: normalizedProtocol, severity: 'high' };
    }

    if (normalizedProtocol === 'data:' || normalizedProtocol === 'file:') {
        return { protocol: normalizedProtocol, severity: 'medium' };
    }

    return null;
}

export function analyzeHostname(hostname) {
    const normalizedHostname = normalizeHostname(hostname);
    const labels = getHostnameLabels(normalizedHostname);

    if (isExcludedHostname(normalizedHostname, labels)) {
        return null;
    }

    const punycodeLabels = labels.filter((label) => label.startsWith('xn--'));
    const decodedLabels = labels.map((label) => {
        if (!label.startsWith('xn--')) {
            return label;
        }

        return decodePunycodeLabel(label) || label;
    });
    const mixedScriptLabels = decodedLabels.filter(hasMixedScriptLetters);
    // The TLD is excluded on purpose: a homograph attack lives in the registrable name, and whole
    // IDN ccTLDs (`.рф`, `.ευ`) are lookalike-only by their nature, so including them would flag
    // every legitimate IDN site.
    // The whole hostname is excluded when the ZONE itself is an IDN one (TASKS 7.3): a Cyrillic
    // name under `.рф` is how a Russian domain is normally written, not a forgery - `сахар.рф` and
    // `роса.рф` used to be reported as high-severity lookalikes. A Cyrillic name under a LATIN zone
    // (`аррӏе.com`) stays reported: that is the shape of the attack this signal exists for.
    const confusableLabels = isIdnZone(labels[labels.length - 1], decodedLabels[decodedLabels.length - 1])
        ? []
        : decodedLabels.slice(0, -1).filter(isWholeScriptConfusableLabel);
    // Not limited to a Latin zone: a substituted letter is a substituted letter wherever it sits.
    const latinLookalikeLabels = decodedLabels.slice(0, -1).filter(hasLatinOnlyLookalikeLetter);

    return {
        originalHostname: String(hostname || ''),
        normalizedHostname,
        labels,
        punycodeLabels,
        decodedLabels,
        mixedScriptLabels,
        confusableLabels,
        hasPunycode: punycodeLabels.length > 0,
        // Not the same question as hasPunycode: "is this hostname written in punycode" is a fact
        // about encoding, "is its script the script of its own zone" is what makes the encoding
        // worth reporting on its own.
        hasScriptZoneMismatch: punycodeLabels.length > 0 && hasScriptZoneMismatch(labels, decodedLabels),
        latinLookalikeLabels,
        hasMixedScript: mixedScriptLabels.length > 0,
        hasWholeScriptConfusable: confusableLabels.length > 0,
        // A separate flag from hasWholeScriptConfusable because the two rules are different - one
        // is "the whole name is in another script", the other is "an ASCII name with a substituted
        // letter". They produce the same finding because the sentence a user reads is the same.
        hasLatinLookalike: latinLookalikeLabels.length > 0
    };
}

export function hasVisibleTargetMismatch(linkText, hostname, hostnameAnalysis = null) {
    const normalizedText = normalizeVisibleText(linkText);
    const targetHostname = normalizeComparableHostname(hostname);

    if (!normalizedText.normalizedText || !targetHostname) {
        return {
            eligible: false,
            matches: false,
            visibleHostname: '',
            targetHostname,
            normalizedText: normalizedText.normalizedText,
            originalText: normalizedText.originalText,
            mismatchReason: 'empty-input'
        };
    }

    const visibleHostnames = extractVisibleHostnames(normalizedText.normalizedText);
    if (visibleHostnames.length === 0) {
        return {
            eligible: false,
            matches: false,
            visibleHostname: '',
            targetHostname,
            normalizedText: normalizedText.normalizedText,
            originalText: normalizedText.originalText,
            mismatchReason: 'not-domain-like'
        };
    }

    const targetHostnames = getComparableTargetHostnames(targetHostname, hostnameAnalysis);
    // ANY named host matching the destination clears the caption (В5). "Mirror at a.example.com or
    // b.example.com" names two hosts and lands on one of them - that is an honest link, and
    // reporting it because the other name did not match would be pure noise.
    const matches = visibleHostnames.some(
        (visible) => targetHostnames.some((candidate) => hostnameMatches(visible, candidate))
    );

    return {
        eligible: true,
        matches,
        visibleHostname: visibleHostnames[0],
        visibleHostnames,
        targetHostname,
        normalizedText: normalizedText.normalizedText,
        originalText: normalizedText.originalText,
        mismatchReason: matches ? '' : 'hostname-mismatch'
    };
}

function normalizeHostname(hostname) {
    return String(hostname || '')
        .trim()
        .toLowerCase()
        .replace(/\.$/, '');
}

function getHostnameLabels(hostname) {
    if (!hostname) {
        return [];
    }

    return hostname
        .split('.')
        .map((label) => label.trim())
        .filter(Boolean);
}

function isExcludedHostname(hostname, labels) {
    if (!hostname || labels.length === 0) {
        return true;
    }

    if (hostname === 'localhost' || labels.length === 1) {
        return true;
    }

    return isIpv4Hostname(hostname) || isIpv6Hostname(hostname);
}

function isIpv4Hostname(hostname) {
    const parts = hostname.split('.');
    if (parts.length !== 4) {
        return false;
    }

    return parts.every((part) => {
        if (!/^\d+$/.test(part)) {
            return false;
        }

        const value = Number(part);
        return value >= 0 && value <= 255;
    });
}

function isIpv6Hostname(hostname) {
    const normalized = hostname.replace(/^\[/, '').replace(/\]$/, '');
    return normalized.includes(':') && /^[0-9a-f:]+$/i.test(normalized);
}

function decodePunycodeLabel(label) {
    const input = label.slice(4);
    const delimiterIndex = input.lastIndexOf('-');
    const output = [];

    if (delimiterIndex >= 0) {
        for (let inputIndex = 0; inputIndex < delimiterIndex; inputIndex += 1) {
            output.push(input.charCodeAt(inputIndex));
        }
    }

    let inputIndex = delimiterIndex >= 0 ? delimiterIndex + 1 : 0;
    let insertionIndex = 0;
    let codePoint = 128;
    let bias = 72;

    while (inputIndex < input.length) {
        const oldInsertionIndex = insertionIndex;
        let weight = 1;

        for (let base = 36; ; base += 36) {
            if (inputIndex >= input.length) {
                return '';
            }

            const digit = decodePunycodeDigit(input.charCodeAt(inputIndex));
            inputIndex += 1;

            if (digit >= 36) {
                return '';
            }

            insertionIndex += digit * weight;

            if (insertionIndex > Number.MAX_SAFE_INTEGER) {
                return '';
            }

            const threshold = base <= bias ? 1 : (base >= bias + 26 ? 26 : base - bias);
            if (digit < threshold) {
                break;
            }

            weight *= 36 - threshold;
        }

        const outputLength = output.length + 1;
        bias = adaptPunycodeBias(insertionIndex - oldInsertionIndex, outputLength, oldInsertionIndex === 0);
        codePoint += Math.floor(insertionIndex / outputLength);

        if (codePoint > 0x10ffff) {
            return '';
        }

        insertionIndex %= outputLength;
        output.splice(insertionIndex, 0, codePoint);
        insertionIndex += 1;
    }

    return String.fromCodePoint(...output);
}

function decodePunycodeDigit(codePoint) {
    if (codePoint >= 48 && codePoint <= 57) {
        return codePoint - 22;
    }

    if (codePoint >= 65 && codePoint <= 90) {
        return codePoint - 65;
    }

    if (codePoint >= 97 && codePoint <= 122) {
        return codePoint - 97;
    }

    return 36;
}

function adaptPunycodeBias(delta, numPoints, isFirstTime) {
    let adjustedDelta = isFirstTime ? Math.floor(delta / 700) : delta >> 1;
    adjustedDelta += Math.floor(adjustedDelta / numPoints);

    let base = 0;
    while (adjustedDelta > 455) {
        adjustedDelta = Math.floor(adjustedDelta / 35);
        base += 36;
    }

    return base + Math.floor((36 * adjustedDelta) / (adjustedDelta + 38));
}

// Two or more of these in ONE label is script mixing (TASKS 7.2). The previous form asked a
// narrower question - "Latin and Cyrillic" - and the Greek half of the lookalike table added in 6.2
// was therefore unreachable: `\u03b1pple.com` (Greek alpha in a Latin word) produced no finding at all,
// not even the whole-script one, because the Latin letters around the alpha disqualify it there.
// @data-list Письменности Unicode, по которым определяется смешение внутри одной метки домена.
// Устаревание = ТИШИНА в сторону пропуска: письменность, которой здесь нет, не участвует в проверке
// смешения вообще, поэтому имя, собранное из латиницы и, например, эфиопского письма, не даст ни
// одной находки - и об этом ничто не сообщит. Обратного риска (лишний шум) у списка нет: добавление
// письменности само по себе находок не создаёт, смешение требует ДВУХ письменностей в одной метке.
// Ревизия: при обновлении набора письменностей Unicode, руками, перед релизом.
const SCRIPT_PATTERNS = [
    ['latin', /\p{Script=Latin}/u],
    ['cyrillic', /\p{Script=Cyrillic}/u],
    ['greek', /\p{Script=Greek}/u],
    ['han', /\p{Script=Han}/u],
    ['hiragana', /\p{Script=Hiragana}/u],
    ['katakana', /\p{Script=Katakana}/u],
    ['hangul', /\p{Script=Hangul}/u],
    ['arabic', /\p{Script=Arabic}/u],
    ['hebrew', /\p{Script=Hebrew}/u],
    ['devanagari', /\p{Script=Devanagari}/u],
    ['bengali', /\p{Script=Bengali}/u],
    ['thai', /\p{Script=Thai}/u],
    ['tamil', /\p{Script=Tamil}/u],
    ['armenian', /\p{Script=Armenian}/u],
    ['georgian', /\p{Script=Georgian}/u]
];

// Only these three carry Latin lookalikes, so only they define script MIXING. Latin next to Han is
// a multilingual name, not a homograph, and counting it would turn 7.2 into noise.
const CONFUSABLE_SCRIPTS = new Set(['latin', 'cyrillic', 'greek']);

function resolveLabelScripts(label) {
    const text = String(label || '');
    const scripts = new Set();

    for (const [name, pattern] of SCRIPT_PATTERNS) {
        if (pattern.test(text)) {
            scripts.add(name);
        }
    }

    // A letter belonging to none of the listed scripts still has to count as SOMETHING, otherwise a
    // hostname in an unlisted script would silently look like a hostname with no script at all.
    if (scripts.size === 0 && /\p{L}/u.test(text)) {
        scripts.add('other');
    }

    return scripts;
}

function hasMixedScriptLetters(label) {
    let scriptsPresent = 0;

    for (const script of resolveLabelScripts(label)) {
        if (CONFUSABLE_SCRIPTS.has(script)) {
            scriptsPresent += 1;
            if (scriptsPresent >= 2) {
                return true;
            }
        }
    }

    return false;
}

// Is the punycode in this hostname worth mentioning on its own? (В4 in the Priority 7 questions.)
// The `hostname-punycode` notice is the module's weakest signal, and after 7.3 it became the main
// outcome for a whole class of perfectly ordinary hostnames: every `.рф` link on a Russian page.
// What deserves a look is not "this name is not ASCII" but "this name is written in a script that
// is not the script of its own zone".
//
// Suppression is possible ONLY inside an IDN zone, and that limit is the whole point. In an ASCII
// zone the notice stays, because there it is the only thing in this module that can see a
// Latin-INTERNAL lookalike: `gogleɟ.com` (U+025F, a Latin letter) carries no script mixing and no
// whole-script confusable, so `münchen.de` and `gogleɟ.com` are structurally identical here and
// nothing offline tells ü from ɟ. Measured both ways: the wider rule that also silences ASCII zones
// removes nothing extra on ordinary traffic (its IDN hosts are all in IDN zones anyway) and costs
// that detect - so the narrow rule is strictly better. The uncovered class is written up as a task
// of its own rather than left to an accidental catch-all.
//
// Pure-ASCII labels are skipped on purpose: `www`, `mail`, `shop` are technical labels that carry no
// script intent, and comparing them would make `www.сахар.рф` look anomalous.
// A hostname whose punycode failed to decode reports the notice: an undecodable label is exactly the
// case where a human should look at it.
function hasScriptZoneMismatch(labels, decodedLabels) {
    if (decodedLabels.length < 2) {
        return true;
    }

    if (!isIdnZone(labels[labels.length - 1], decodedLabels[decodedLabels.length - 1])) {
        return true;
    }

    const zoneScripts = resolveLabelScripts(decodedLabels[decodedLabels.length - 1]);
    const nonAsciiLabels = decodedLabels
        .slice(0, -1)
        .filter((label) => [...String(label || '')].some((character) => character.codePointAt(0) > 127));

    if (nonAsciiLabels.length === 0) {
        return true;
    }

    return nonAsciiLabels.some((label) => {
        for (const script of resolveLabelScripts(label)) {
            if (!zoneScripts.has(script)) {
                return true;
            }
        }
        return false;
    });
}

// An IDN zone: either the raw label is punycode, or its decoded form is not ASCII. Both forms are
// checked because a label that fails to decode falls back to its raw `xn--` text.
function isIdnZone(rawTldLabel, decodedTldLabel) {
    if (String(rawTldLabel || '').startsWith('xn--')) {
        return true;
    }

    // A plain code-point test rather than a regex range: the question is simply whether the
    // zone label is written outside ASCII.
    return [...String(decodedTldLabel || '')].some((character) => character.codePointAt(0) > 127);
}

// A label written entirely in a non-Latin script whose every letter has a Latin lookalike: that is
// the canonical homograph (`аррӏе.com` for `apple.com`), and it carries no script MIXING at all, so
// hasMixedScriptLetters cannot see it (TASKS 6.2).
// The "every letter" requirement is what keeps legitimate IDN out: `пример` fails on `п`, `м`, `и`,
// and any Latin-script name fails on the first Latin letter.
// Short labels are excluded (TASKS 7.3): on a three-letter word the "every letter is a lookalike"
// test is satisfied by accident - `оса`, `сор`, `рос` are ordinary Russian words - while the brands
// that homograph attacks imitate are practically never shorter than four letters.
const MIN_CONFUSABLE_LABEL_LETTERS = 4;

function isWholeScriptConfusableLabel(label) {
    const letters = [...String(label || '')].filter((character) => /\p{L}/u.test(character));
    if (letters.length < MIN_CONFUSABLE_LABEL_LETTERS) {
        return false;
    }

    if (letters.some((character) => /[a-z]/iu.test(character))) {
        return false;
    }

    return letters.every((character) => LATIN_LOOKALIKE_LETTERS.has(character));
}
// One substituted character is enough: these letters do not occur in names, so a single one is the
// whole signal. The label must also carry ordinary ASCII letters - a name written entirely in
// phonetic characters imitates nothing, it is simply not a name.
function hasLatinOnlyLookalikeLetter(label) {
    const characters = [...String(label || '')];
    if (!characters.some((character) => LATIN_ONLY_LOOKALIKE_LETTERS.has(character))) {
        return false;
    }

    return characters.some((character) => /[a-z0-9]/iu.test(character));
}

function normalizeVisibleText(linkText) {
    const originalText = String(linkText || '');
    let normalizedText = originalText.replace(/\s+/g, ' ').trim();
    normalizedText = normalizedText.replace(/[.,;:!?]+$/u, '').trim();
    normalizedText = stripMatchedWrapper(normalizedText);
    normalizedText = normalizedText.replace(/[.,;:!?]+$/u, '').trim().toLowerCase();

    return { originalText, normalizedText };
}

function stripMatchedWrapper(text) {
    const wrapperPairs = [
        ['(', ')'],
        ['[', ']'],
        ['{', '}'],
        ['"', '"'],
        ["'", "'"],
        ['«', '»'],
        ['“', '”'],
        ['‘', '’']
    ];

    let strippedText = text;
    let changed = true;

    while (changed && strippedText.length >= 2) {
        changed = false;

        for (const [open, close] of wrapperPairs) {
            if (strippedText.startsWith(open) && strippedText.endsWith(close)) {
                strippedText = strippedText.slice(open.length, -close.length).trim();
                changed = true;
                break;
            }
        }
    }

    return strippedText;
}

// Every hostname NAMED in the caption, not just a caption that is nothing but a hostname (В5).
// "Войти на paypal.com" used to be invisible to this module: any whitespace disqualified the whole
// caption, so the most ordinary phishing caption there is went unchecked.
// The cost of opening this up is a known false-positive shape: "Скачать с example.com" pointing at
// a CDN on a DIFFERENT registrable domain reads as a mismatch, and without a Public Suffix List
// nothing offline can tell "another host of the same owner" from "another owner". Same-domain CDNs
// (`cdn.example.com`) are covered by hostnameMatches and are quiet.
// Only a handful of tokens are inspected: a caption is a caption, not a document, and this keeps the
// work bounded on a long CTA.
const MAX_CAPTION_HOSTNAME_TOKENS = 8;

function extractVisibleHostnames(text) {
    if (!text) {
        return [];
    }

    const hostnames = [];
    const tokens = text.split(/[\s,;]+/u);
    let inspected = 0;

    for (const token of tokens) {
        if (!token || !token.includes('.')) {
            continue;
        }
        if (inspected >= MAX_CAPTION_HOSTNAME_TOKENS) {
            break;
        }
        inspected += 1;

        const hostname = extractVisibleHostname(token);
        if (hostname && !hostnames.includes(hostname)) {
            hostnames.push(hostname);
        }
    }

    return hostnames;
}

function extractVisibleHostname(text) {
    if (!text || /\s/u.test(text)) {
        return '';
    }

    const urlLikeMatch = text.match(/^https?:\/\/([^/?#]+)(?:[/?#].*)?$/iu);
    const domainText = urlLikeMatch ? urlLikeMatch[1] : text.replace(/^(?:\/\/)/u, '').split(/[/?#]/u)[0];
    // A hostname sitting inside a sentence carries the sentence punctuation with it: "на paypal.com,"
    // and "(paypal.com)" are the same host. Wrapping characters are stripped from both ends; the
    // trailing dot of a fully qualified name is handled by normalizeComparableHostname.
    const trimmedDomainText = domainText.replace(/^[("'«“‘\[{]+/u, '').replace(/[)"'»”’\]}.,;:!?]+$/u, '');
    const normalizedHostname = normalizeComparableHostname(trimmedDomainText);

    if (!normalizedHostname || !isDomainLikeHostname(normalizedHostname)) {
        return '';
    }

    return normalizedHostname;
}

function normalizeComparableHostname(hostname) {
    return String(hostname || '')
        .trim()
        .toLowerCase()
        .replace(/^www\./u, '')
        .replace(/\.$/, '');
}

export function isDomainLikeHostname(hostname) {
    if (!hostname.includes('.') || hostname.startsWith('.') || hostname.endsWith('.')) {
        return false;
    }

    if (/[:@\s]/u.test(hostname)) {
        return false;
    }

    const labels = hostname.split('.');
    if (!labels.every((label) => /^[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?$/u.test(label))) {
        return false;
    }

    return isPlausibleTld(labels[labels.length - 1]);
}

// Without this guard any dotted caption was treated as a hostname, so `annual-report.pdf`,
// `index.html`, `12.05.2023`, `19.99` and `1.2` all produced a HIGH severity link-mismatch finding
// on ordinary pages (TASKS 6.1), and `Object.keys` or `os.path` kept doing it afterwards (7.1).
// Three questions in order, cheapest first: is this shaped like a zone label at all, is it a file
// extension in disguise, and does a zone with this name actually exist.
function isPlausibleTld(label) {
    if (!/^\p{L}{2,}$/u.test(label)) {
        return false;
    }

    if (NON_TLD_FILE_EXTENSIONS.has(label)) {
        return false;
    }

    return KNOWN_TLDS.has(label);
}

function getComparableTargetHostnames(targetHostname, hostnameAnalysis) {
    const candidates = new Set([targetHostname]);

    if (hostnameAnalysis?.decodedLabels?.length) {
        candidates.add(normalizeComparableHostname(hostnameAnalysis.decodedLabels.join('.')));
    }

    return Array.from(candidates).filter(Boolean);
}

function hostnameMatches(visibleHostname, targetHostname) {
    return targetHostname === visibleHostname || targetHostname.endsWith(`.${visibleHostname}`);
}
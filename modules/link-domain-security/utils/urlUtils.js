import { isDomainLikeHostname } from './domainUtils.js';

// A redirect value that is not URL-shaped is not automatically harmless: a bare host, a base64
// payload or a doubly encoded URL are the ordinary shapes of an open redirect (TASKS 6.3). The
// parser only labels them; whether a label is worth a finding is the detector's decision.
const MIN_OPAQUE_DESTINATION_LENGTH = 12;

// @data-list (см. комментарий ниже: что это, чем оборачивается устаревание)
// Query keys that carry a navigation destination. A module-level Set rather than an array rebuilt
// on every call, for every link on the page (TASKS 7.13).
const REDIRECT_KEYS = new Set(['url', 'target', 'dest', 'destination', 'redirect', 'next', 'continue']);

// The base a relative href actually resolves against is `document.baseURI`, not the location
// (TASKS 7.4). One `<base href="https://evil.io/">` in the head and every relative link on the page
// goes somewhere else than the module thought: `<a href="/login">example.com</a>` looked same-host
// and perfectly matched, while the browser navigated to evil.io. Same-host classification and the
// redirect analysis were both reading the wrong address.
export function resolveDocumentBase() {
    const baseUri = typeof document !== 'undefined' ? document.baseURI : '';
    return baseUri || window.location.href;
}

export function parseUrl(rawTarget) {
    if (!rawTarget) {
        return null;
    }

    try {
        return new URL(rawTarget, resolveDocumentBase());
    } catch {
        return null;
    }
}

// A `<base>` element pointing at another origin is a signal in its own right: it silently retargets
// every relative link of the page at once, which no single href can do (TASKS 7.4).
export function findForeignBaseOrigin() {
    const baseUri = typeof document !== 'undefined' ? document.baseURI : '';
    if (!baseUri) {
        return null;
    }

    try {
        const baseUrl = new URL(baseUri);
        const pageUrl = new URL(window.location.href);
        if (baseUrl.origin === pageUrl.origin) {
            return null;
        }

        return { baseOrigin: baseUrl.origin, pageOrigin: pageUrl.origin };
    } catch {
        return null;
    }
}

export function hasRedirectPattern(targetUrl) {
    // A link without a query string cannot carry a redirect parameter, and most links on a page are
    // exactly that - so the query is not parsed at all for them (TASKS 7.13).
    if (!targetUrl.search) {
        return null;
    }

    const redirectParameters = [];

    for (const [key, value] of targetUrl.searchParams.entries()) {
        const normalizedKey = key.toLowerCase();
        if (!REDIRECT_KEYS.has(normalizedKey) || !value.trim()) {
            continue;
        }

        redirectParameters.push(classifyRedirectParameter(normalizedKey, value, targetUrl));
    }

    if (redirectParameters.length === 0) {
        return null;
    }

    return {
        redirectParameters,
        hasRedirectKey: true,
        hasExternalDestination: redirectParameters.some((parameter) => parameter.destinationType === 'external'),
        hasSameHostDestination: redirectParameters.some((parameter) => parameter.destinationType === 'same-host'),
        hasUnknownDestination: redirectParameters.some((parameter) => parameter.destinationType === 'unknown'),
        hasSuspiciousUnknownDestination: redirectParameters.some(
            (parameter) => parameter.destinationType === 'unknown' && parameter.opaqueSignals.length > 0
        )
    };
}

function classifyRedirectParameter(key, value, targetUrl) {
    const trimmedValue = value.trim();
    const destinationUrl = parseRedirectDestination(trimmedValue, targetUrl);

    if (!destinationUrl || !destinationUrl.hostname) {
        return {
            key,
            value: trimmedValue,
            destinationType: 'unknown',
            destinationHostname: '',
            opaqueSignals: resolveOpaqueDestinationSignals(trimmedValue)
        };
    }

    const targetHostname = normalizeHostname(targetUrl.hostname);
    const destinationHostname = normalizeHostname(destinationUrl.hostname);

    return {
        key,
        value: trimmedValue,
        destinationType: destinationHostname === targetHostname ? 'same-host' : 'external',
        destinationHostname,
        opaqueSignals: []
    };
}

// searchParams already decodes the value once, so an ordinary `?url=https%3A%2F%2F...` arrives
// URL-shaped and never reaches this function. What does reach it: a bare host, a base64 payload, a
// value encoded twice. Short values are ignored - redirect keys also carry ids and flags.
function resolveOpaqueDestinationSignals(value) {
    // The length floor exists to keep ids and flags out, and it applies only to the two signals
    // that need it (TASKS 7.5). `bare-hostname` has a far stronger guard of its own - no spaces, no
    // `/ ? # @ :`, and a plausible TLD - which no id can pass, so the floor only blinded it:
    // `?url=evil.com` is eight characters and is the canonical shape of an open redirect.
    const isLongEnough = value.length >= MIN_OPAQUE_DESTINATION_LENGTH;

    const signals = [];
    if (isLongEnough && (/%25(?:2f|3a)/i.test(value) || /%3a%2f%2f|%2f%2f|https?%3a/i.test(value))) {
        signals.push('encoded-url');
    }
    if (isBareHostnameDestination(value)) {
        signals.push('bare-hostname');
    }
    if (isLongEnough && isBase64UrlDestination(value)) {
        signals.push('base64-url');
    }

    return [...new Set(signals)];
}

function isBareHostnameDestination(value) {
    if (/[\s/?#@:]/u.test(value)) {
        return false;
    }

    return isDomainLikeHostname(value.trim().toLowerCase());
}

function isBase64UrlDestination(value) {
    if (!/^[A-Za-z0-9+/_-]{16,}={0,2}$/u.test(value)) {
        return false;
    }

    try {
        const decoded = atob(value.replace(/-/gu, '+').replace(/_/gu, '/'));
        return /^https?:\/\//iu.test(decoded) || decoded.includes('://');
    } catch {
        return false;
    }
}

function parseRedirectDestination(value, targetUrl) {
    if (!looksLikeUrlDestination(value)) {
        return null;
    }

    try {
        return new URL(value, targetUrl.href);
    } catch {
        return null;
    }
}

function looksLikeUrlDestination(value) {
    return /^(https?:)?\/\//i.test(value)
        || value.startsWith('/')
        || value.startsWith('./')
        || value.startsWith('../')
        || value.startsWith('?');
}

function normalizeHostname(hostname) {
    return String(hostname || '')
        .trim()
        .toLowerCase()
        .replace(/\.$/, '');
}
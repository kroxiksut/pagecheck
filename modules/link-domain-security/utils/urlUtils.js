export function parseUrl(rawTarget) {
    if (!rawTarget) {
        return null;
    }

    try {
        return new URL(rawTarget, window.location.href);
    } catch {
        return null;
    }
}

export function hasRedirectPattern(targetUrl) {
    const redirectKeys = ['url', 'target', 'dest', 'destination', 'redirect', 'next', 'continue'];
    const redirectParameters = [];

    for (const [key, value] of targetUrl.searchParams.entries()) {
        const normalizedKey = key.toLowerCase();
        if (!redirectKeys.includes(normalizedKey) || !value.trim()) {
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
        hasUnknownDestination: redirectParameters.some((parameter) => parameter.destinationType === 'unknown')
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
            destinationHostname: ''
        };
    }

    const targetHostname = normalizeHostname(targetUrl.hostname);
    const destinationHostname = normalizeHostname(destinationUrl.hostname);

    return {
        key,
        value: trimmedValue,
        destinationType: destinationHostname === targetHostname ? 'same-host' : 'external',
        destinationHostname
    };
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
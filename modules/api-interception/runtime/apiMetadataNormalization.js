const ALLOWED_RESOURCE_TYPES = new Set(['xmlhttprequest', 'image']);
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const MAX_RESPONSE_HEADERS = 64;
const MAX_RAW_CONTENT_TYPE_LENGTH = 256;
const MAX_MIME_LENGTH = 128;
const MIME_TOKEN_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;

export function normalizeRequestMethod(value) {
    if (typeof value !== 'string') {
        return 'other';
    }

    const method = value.trim().toUpperCase();
    return ALLOWED_METHODS.has(method) ? method : 'other';
}

export function normalizeResponseStatus(value) {
    const status = Number(value);
    return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

export function extractDeclaredContentType(responseHeaders) {
    if (!Array.isArray(responseHeaders)) {
        return { state: 'missing', raw: null };
    }

    for (const header of responseHeaders.slice(0, MAX_RESPONSE_HEADERS)) {
        if (typeof header?.name !== 'string'
            || header.name.toLowerCase() !== 'content-type'
            || typeof header.value !== 'string') {
            continue;
        }

        const raw = header.value.trim();
        if (!raw) {
            continue;
        }
        if (raw.length > MAX_RAW_CONTENT_TYPE_LENGTH) {
            return { state: 'malformed', raw: null };
        }
        return { state: 'present', raw };
    }

    return { state: 'missing', raw: null };
}

export function normalizeDeclaredMime(contentType) {
    if (!contentType || contentType.state === 'missing') {
        return { state: 'missing', mime: null };
    }

    const raw = typeof contentType === 'string' ? contentType : contentType.raw;
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_RAW_CONTENT_TYPE_LENGTH) {
        return { state: 'malformed', mime: null };
    }

    const mime = raw.split(';', 1)[0].trim().toLowerCase();
    if (!mime || mime.length > MAX_MIME_LENGTH || !MIME_TOKEN_PATTERN.test(mime)) {
        return { state: 'malformed', mime: null };
    }

    return { state: 'valid', mime };
}

export function createNormalizedObservation(record) {
    if (!record || !ALLOWED_RESOURCE_TYPES.has(record.resourceType)) {
        return null;
    }

    const redirectCount = Number.isInteger(record.redirectCount)
        ? Math.max(0, Math.min(record.redirectCount, 8))
        : 0;
    const declaredMime = record.declaredMime?.state
        ? record.declaredMime
        : normalizeDeclaredMime(record.declaredMime);

    return {
        resourceType: record.resourceType,
        method: normalizeRequestMethod(record.method),
        responseStatus: normalizeResponseStatus(record.responseStatus),
        declaredMimeState: declaredMime.state,
        declaredMime: declaredMime.mime,
        completed: record.completed === true,
        networkError: record.networkError === true,
        redirected: record.redirected === true,
        fromCache: record.fromCache === true,
        redirectCount,
        sessionRevision: Number.isInteger(record.sessionRevision)
            ? Math.max(0, record.sessionRevision)
            : 0
    };
}

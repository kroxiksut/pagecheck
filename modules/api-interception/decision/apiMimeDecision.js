const DOCUMENT_MIME_TYPES = new Set([
    'text/html',
    'application/xhtml+xml'
]);

const SCRIPT_MIME_TYPES = new Set([
    'application/ecmascript',
    'application/javascript',
    'application/x-ecmascript',
    'application/x-javascript',
    'text/ecmascript',
    'text/javascript'
]);

const CANDIDATE_TYPE = 'image-resource-declared-mime-anomaly';

export function evaluateImageMimeObservation(observation) {
    if (!observation
        || observation.resourceType !== 'image'
        || observation.completed !== true
        || observation.networkError === true
        || observation.partial === true
        || !Number.isInteger(observation.sessionRevision)
        || observation.sessionRevision < 0
        || observation.declaredMimeState !== 'valid'
        || typeof observation.declaredMime !== 'string'
        || !Number.isInteger(observation.responseStatus)
        || observation.responseStatus < 200
        || observation.responseStatus > 299
        || observation.responseStatus === 204
        || observation.responseStatus === 205) {
        return null;
    }

    const category = DOCUMENT_MIME_TYPES.has(observation.declaredMime)
        ? 'document'
        : SCRIPT_MIME_TYPES.has(observation.declaredMime)
            ? 'script'
            : null;
    if (!category) {
        return null;
    }

    return Object.freeze({
        type: CANDIDATE_TYPE,
        category,
        severity: 'low'
    });
}

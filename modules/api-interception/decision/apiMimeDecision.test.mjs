import assert from 'node:assert/strict';
import { evaluateImageMimeObservation } from './apiMimeDecision.js';

function observation(overrides = {}) {
    return {
        resourceType: 'image',
        method: 'GET',
        responseStatus: 200,
        declaredMimeState: 'valid',
        declaredMime: 'text/html',
        completed: true,
        networkError: false,
        redirected: false,
        fromCache: false,
        redirectCount: 0,
        sessionRevision: 4,
        ...overrides
    };
}

const suspiciousCases = [
    ['text/html', 'document'],
    ['application/xhtml+xml', 'document'],
    ['application/ecmascript', 'script'],
    ['application/javascript', 'script'],
    ['application/x-ecmascript', 'script'],
    ['application/x-javascript', 'script'],
    ['text/ecmascript', 'script'],
    ['text/javascript', 'script']
];
for (const [declaredMime, category] of suspiciousCases) {
    const decision = evaluateImageMimeObservation(observation({ declaredMime }));
    assert.deepEqual(decision, {
        type: 'image-resource-declared-mime-anomaly',
        category,
        severity: 'low'
    });
    assert.equal(Object.isFrozen(decision), true);
}
assert.deepEqual(evaluateImageMimeObservation(observation({ redirected: true })), {
    type: 'image-resource-declared-mime-anomaly',
    category: 'document',
    severity: 'low'
});

for (const declaredMime of [
    'image/png',
    'image/svg+xml',
    'application/octet-stream',
    'text/plain',
    'application/json',
    'application/xml',
    'text/javascriptish'
]) {
    assert.equal(evaluateImageMimeObservation(observation({ declaredMime })), null);
}

for (const overrides of [
    { resourceType: 'xmlhttprequest' },
    { completed: false },
    { networkError: true },
    // { partial: true } УБРАН: createNormalizedObservation такого поля не создаёт, поэтому кейс
    // проверял ветку, недостижимую в продакшене, и маскировал мёртвую проверку (TASKS 13.6).
    // Частичность живёт на уровне батча и проверяется в ApiFindingState.
    { responseStatus: 199 },
    { responseStatus: 204 },
    { responseStatus: 205 },
    { responseStatus: 300 },
    { declaredMimeState: 'missing', declaredMime: null },
    { declaredMimeState: 'malformed', declaredMime: null },
    { sessionRevision: -1 },
    { sessionRevision: '4' }
]) {
    assert.equal(evaluateImageMimeObservation(observation(overrides)), null);
}

assert.equal(evaluateImageMimeObservation(null), null);
assert.equal(evaluateImageMimeObservation({}), null);

console.log('API MIME decision checks passed');

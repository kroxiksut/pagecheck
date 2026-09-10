import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ApiResourceObserver from './ApiResourceObserver.js';
import {
    createNormalizedObservation,
    extractDeclaredContentType,
    normalizeDeclaredMime,
    normalizeRequestMethod,
    normalizeResponseStatus
} from './apiMetadataNormalization.js';

class FakeEvent {
    constructor() {
        this.listeners = new Set();
        this.registrations = new Map();
    }

    addListener(listener, filter, extraInfoSpec) {
        this.listeners.add(listener);
        this.registrations.set(listener, { filter, extraInfoSpec });
    }

    removeListener(listener) {
        this.listeners.delete(listener);
        this.registrations.delete(listener);
    }

    emit(details) {
        for (const listener of this.listeners) {
            listener(details);
        }
    }
}

function createFakeWebRequest() {
    return {
        onBeforeRequest: new FakeEvent(),
        onHeadersReceived: new FakeEvent(),
        onBeforeRedirect: new FakeEvent(),
        onCompleted: new FakeEvent(),
        onErrorOccurred: new FakeEvent()
    };
}

function details(overrides = {}) {
    return {
        tabId: 7,
        frameId: 0,
        type: 'image',
        requestId: 'request-1',
        method: 'GET',
        statusCode: 200,
        fromCache: false,
        ...overrides
    };
}

assert.equal(normalizeRequestMethod('post'), 'POST');
assert.equal(normalizeRequestMethod('TRACK'), 'other');
assert.equal(normalizeResponseStatus(204), 204);
assert.equal(normalizeResponseStatus(700), null);
assert.deepEqual(extractDeclaredContentType([{ name: 'CONTENT-TYPE', value: 'image/png; charset=binary' }]), {
    state: 'present',
    raw: 'image/png; charset=binary'
});
assert.deepEqual(normalizeDeclaredMime({ state: 'present', raw: 'Image/PNG; charset=binary' }), {
    state: 'valid',
    mime: 'image/png'
});
assert.deepEqual(normalizeDeclaredMime({ state: 'present', raw: 'not a mime' }), {
    state: 'malformed',
    mime: null
});
assert.deepEqual(extractDeclaredContentType([
    ...Array.from({ length: 64 }, () => ({ name: 'X-Test', value: 'ignored' })),
    { name: 'Content-Type', value: 'image/png' }
]), { state: 'missing', raw: null });
assert.deepEqual(normalizeDeclaredMime({ state: 'present', raw: 'a'.repeat(257) }), {
    state: 'malformed',
    mime: null
});

const privacyProjection = createNormalizedObservation({
    resourceType: 'image',
    method: 'POST',
    responseStatus: 201,
    declaredMime: { state: 'valid', mime: 'image/png' },
    completed: true,
    networkError: false,
    redirected: false,
    fromCache: false,
    redirectCount: 0,
    sessionRevision: 3,
    url: 'https://sentinel.invalid/?raw-url=do-not-store',
    requestId: 'raw-request-id',
    responseHeaders: [{ name: 'X-Sentinel', value: 'do-not-store' }],
    error: 'do-not-store'
});
assert.equal(JSON.stringify(privacyProjection).includes('do-not-store'), false);
assert.equal('url' in privacyProjection, false);
assert.equal('requestId' in privacyProjection, false);

const contentRuntimeSource = await readFile(new URL('../../../js/content.js', import.meta.url), 'utf8');
const backgroundRuntimeSource = await readFile(new URL('../../../js/background.js', import.meta.url), 'utf8');
const observerRuntimeSource = await readFile(new URL('./ApiResourceObserver.js', import.meta.url), 'utf8');
assert.equal(contentRuntimeSource.includes('ApiInterceptorClass'), false);
assert.equal(contentRuntimeSource.includes('modules/api-interception/ApiInterceptor.js'), false);

// Отрицательного утверждения мало: оно молчит о том, СКОЛЬКО модулей грузится на самом деле, и
// поэтому три кроссмодульных щита годами считали пятым модулем файл, который не выполняется.
// Пинуем положительный список: если content-модуль появится или исчезнет, это увидят здесь, а не
// в отчёте «проверено на всех пяти».
const LOADED_CONTENT_MODULES = [
    'modules/visual-manipulation/VisualManipulationDetector.js',
    'modules/link-domain-security/LinkDomainSecurityDetector.js',
    'modules/trigger-phrases/TriggerPhrases.js',
    'modules/prompt-splitting/PromptSplitting.js'
];
const loadedModulePaths = [...contentRuntimeSource.matchAll(/getURL\('(modules\/[^']+)'\)/g)].map((match) => match[1]);
assert.deepEqual(
    loadedModulePaths,
    LOADED_CONTENT_MODULES,
    'js/content.js грузит РОВНО эти четыре детектора; изменился состав - обнови кроссмодульные щиты (loopSafety, timeSlicing, explicitScanErrorLevel)'
);
assert.equal(contentRuntimeSource.includes('apiInterceptionFindings'), false);
assert.equal(contentRuntimeSource.includes('apiInterceptionRevision'), false);
assert.equal(backgroundRuntimeSource.includes('moduleId !== API_INTERCEPTION_MODULE_ID'), true);
assert.equal(backgroundRuntimeSource.includes('syncApiObserverForForeground'), true);
assert.equal(backgroundRuntimeSource.includes('apiInterceptionFindings'), false);
assert.equal(backgroundRuntimeSource.includes('apiInterceptionRevision'), false);
assert.equal(observerRuntimeSource.includes('requestBody'), false);
assert.equal(observerRuntimeSource.includes('requestHeaders'), false);
assert.equal(observerRuntimeSource.includes('extraHeaders'), false);
assert.equal(observerRuntimeSource.includes('chrome.storage'), false);
assert.equal(observerRuntimeSource.includes('sendMessage'), false);
assert.equal(observerRuntimeSource.includes('Logger.'), false);

const webRequest = createFakeWebRequest();
let time = 0;
const observer = new ApiResourceObserver({ webRequest, clock: () => time });
assert.equal(observer.activate({ tabId: 7, revision: 1, enabled: true, autoScan: true, monitorOnly: true }), true);
assert.equal(webRequest.onBeforeRequest.listeners.size, 1);
assert.deepEqual([...webRequest.onBeforeRequest.registrations.values()][0], {
    filter: { urls: ['<all_urls>'], types: ['xmlhttprequest', 'image'], tabId: 7 },
    extraInfoSpec: undefined
});
assert.deepEqual([...webRequest.onHeadersReceived.registrations.values()][0], {
    filter: { urls: ['<all_urls>'], types: ['xmlhttprequest', 'image'], tabId: 7 },
    extraInfoSpec: ['responseHeaders']
});
assert.equal(observer.activate({ tabId: 7, revision: 1, enabled: true, autoScan: true, monitorOnly: true }), true);
assert.equal(webRequest.onBeforeRequest.listeners.size, 1);

webRequest.onBeforeRequest.emit(details({ requestId: 'subframe-request', frameId: 1 }));
webRequest.onBeforeRequest.emit(details({ requestId: 'script-request', type: 'script' }));
assert.equal(observer.getObservationState().counters.acceptedEvents, 0);

webRequest.onBeforeRequest.emit(details());
webRequest.onBeforeRequest.emit(details({ method: 'POST' }));
assert.equal(observer.activeRecords.size, 1);
assert.equal(observer.activeRecords.get('request-1').method, 'GET');
assert.equal(observer.getObservationState().counters.acceptedEvents, 1);
webRequest.onHeadersReceived.emit(details({
    responseHeaders: [{ name: 'Content-Type', value: 'image/png; charset=binary' }]
}));
webRequest.onCompleted.emit(details());
await new Promise((resolve) => setTimeout(resolve, 0));

let state = observer.getObservationState();
assert.equal(state.status, 'active');
assert.equal(state.counters.completedObservations, 1);
assert.equal(JSON.stringify(state).includes('request-1'), false);
assert.equal(JSON.stringify(state).includes('image/png'), false);

const methodSentinel = 'METHOD-SENTINEL-MUST-NOT-BE-RETAINED';
webRequest.onBeforeRequest.emit(details({
    requestId: 'method-normalization',
    method: methodSentinel
}));
assert.equal(observer.activeRecords.get('method-normalization').method, 'other');
webRequest.onCompleted.emit(details({ requestId: 'method-normalization' }));
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(observer.observationRing.at(-1).method, 'other');
assert.equal(JSON.stringify(observer.getObservationState()).includes(methodSentinel), false);

const privacyRequestId = 'request-id-do-not-store';
webRequest.onBeforeRequest.emit(details({
    requestId: privacyRequestId,
    method: 'POST',
    url: 'https://sentinel.invalid/?query=do-not-store',
    requestBody: { formData: { password: ['do-not-store'] } },
    requestHeaders: [{ name: 'Authorization', value: 'do-not-store' }]
}));
webRequest.onHeadersReceived.emit(details({
    requestId: privacyRequestId,
    responseHeaders: [
        { name: 'X-Sentinel', value: 'do-not-store' },
        { name: 'Content-Type', value: 'image/png; boundary=do-not-store' }
    ]
}));
webRequest.onErrorOccurred.emit(details({
    requestId: privacyRequestId,
    error: 'do-not-store'
}));
await new Promise((resolve) => setTimeout(resolve, 0));
state = observer.getObservationState();
assert.equal(JSON.stringify(state).includes('do-not-store'), false);
assert.equal(JSON.stringify(state).includes(privacyRequestId), false);
webRequest.onHeadersReceived.emit(details({
    requestId: 'orphan-header-sentinel',
    responseHeaders: [{ name: 'Content-Type', value: 'image/png; sentinel=must-not-be-published' }]
}));
assert.equal(JSON.stringify(observer.getObservationState()).includes('must-not-be-published'), false);

webRequest.onBeforeRequest.emit(details({ requestId: 'redirected' }));
webRequest.onBeforeRedirect.emit(details({ requestId: 'redirected' }));
webRequest.onHeadersReceived.emit(details({
    requestId: 'redirected',
    responseHeaders: [{ name: 'Content-Type', value: 'image/jpeg' }]
}));
webRequest.onCompleted.emit(details({ requestId: 'redirected' }));
await new Promise((resolve) => setTimeout(resolve, 0));
state = observer.getObservationState();
assert.equal(state.counters.completedObservations, 4);

const responseLifecycleWebRequest = createFakeWebRequest();
const responseLifecycleObserver = new ApiResourceObserver({ webRequest: responseLifecycleWebRequest });
assert.equal(responseLifecycleObserver.activate({
    tabId: 7,
    revision: 1,
    enabled: true,
    autoScan: true,
    monitorOnly: true
}), true);
responseLifecycleWebRequest.onBeforeRequest.emit(details({ requestId: 'redirect-metadata-reset' }));
responseLifecycleWebRequest.onHeadersReceived.emit(details({
    requestId: 'redirect-metadata-reset',
    statusCode: 302,
    responseHeaders: [{ name: 'Content-Type', value: 'text/html' }]
}));
responseLifecycleWebRequest.onBeforeRedirect.emit(details({ requestId: 'redirect-metadata-reset' }));
responseLifecycleWebRequest.onCompleted.emit(details({ requestId: 'redirect-metadata-reset' }));
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(responseLifecycleObserver.observationRing[0], {
    resourceType: 'image',
    method: 'GET',
    responseStatus: null,
    declaredMimeState: 'missing',
    declaredMime: null,
    completed: true,
    networkError: false,
    redirected: true,
    fromCache: false,
    redirectCount: 1,
    sessionRevision: 1
});
responseLifecycleWebRequest.onBeforeRequest.emit(details({ requestId: 'network-error' }));
responseLifecycleWebRequest.onHeadersReceived.emit(details({
    requestId: 'network-error',
    statusCode: 503,
    responseHeaders: [{ name: 'Content-Type', value: 'text/html' }]
}));
responseLifecycleWebRequest.onErrorOccurred.emit(details({ requestId: 'network-error', error: 'must-not-be-published' }));
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(responseLifecycleObserver.activeRecords.size, 0);
assert.equal(responseLifecycleObserver.observationRing[1].completed, false);
assert.equal(responseLifecycleObserver.observationRing[1].networkError, true);
assert.equal(JSON.stringify(responseLifecycleObserver.getObservationState()).includes('must-not-be-published'), false);
const completedErrorOrphans = responseLifecycleObserver.getObservationState().counters.orphanEvents;
responseLifecycleWebRequest.onCompleted.emit(details({ requestId: 'network-error' }));
assert.equal(responseLifecycleObserver.getObservationState().counters.orphanEvents, completedErrorOrphans + 1);
responseLifecycleObserver.pause(2);

webRequest.onCompleted.emit(details({ requestId: 'orphan' }));
state = observer.getObservationState();
assert.equal(state.counters.orphanEvents, 2);
assert.equal(state.partial, true);

observer.pause(2);
state = observer.getObservationState();
assert.equal(state.status, 'not-observed');
assert.equal(webRequest.onBeforeRequest.listeners.size, 0);
assert.equal(webRequest.onCompleted.listeners.size, 0);

observer.destroy();
assert.equal(webRequest.onHeadersReceived.listeners.size, 0);

const disableWebRequest = createFakeWebRequest();
const disableObserver = new ApiResourceObserver({ webRequest: disableWebRequest });
assert.equal(disableObserver.activate({
    tabId: 7,
    revision: 1,
    enabled: true,
    autoScan: true,
    monitorOnly: true
}), true);
disableWebRequest.onBeforeRequest.emit(details({ requestId: 'disabled-pending' }));
assert.equal(disableObserver.activate({
    tabId: 7,
    revision: 2,
    enabled: false,
    autoScan: true,
    monitorOnly: true
}), false);
assert.equal(disableWebRequest.onBeforeRequest.listeners.size, 0);
assert.equal(disableObserver.activeRecords.size, 0);
assert.equal(disableObserver.getObservationState().status, 'not-observed');

const monitorOnlyWebRequest = createFakeWebRequest();
const monitorOnlyObserver = new ApiResourceObserver({ webRequest: monitorOnlyWebRequest });
assert.equal(monitorOnlyObserver.activate({
    tabId: 7,
    revision: 1,
    enabled: true,
    autoScan: true,
    monitorOnly: false
}), false);
assert.equal(monitorOnlyObserver.getObservationState().status, 'not-observed');
assert.equal(monitorOnlyWebRequest.onBeforeRequest.listeners.size, 0);
assert.equal(monitorOnlyObserver.activate({
    tabId: 7,
    revision: 2,
    enabled: true,
    autoScan: true,
    monitorOnly: true
}), true);
monitorOnlyObserver.pause(3);

const staleWebRequest = createFakeWebRequest();
const staleObserver = new ApiResourceObserver({ webRequest: staleWebRequest });
assert.equal(staleObserver.activate({
    tabId: 7,
    revision: 5,
    enabled: true,
    autoScan: true,
    monitorOnly: true
}), true);
staleObserver.pause(6);
assert.equal(staleObserver.activate({
    tabId: 7,
    revision: 5,
    enabled: true,
    autoScan: true,
    monitorOnly: true
}), false);
assert.equal(staleWebRequest.onBeforeRequest.listeners.size, 0);

const destroyedWebRequest = createFakeWebRequest();
const destroyedObserver = new ApiResourceObserver({ webRequest: destroyedWebRequest });
assert.equal(destroyedObserver.activate({
    tabId: 7,
    revision: 1,
    enabled: true,
    autoScan: true,
    monitorOnly: true
}), true);
destroyedWebRequest.onBeforeRequest.emit(details({ requestId: 'destroy-pending' }));
destroyedWebRequest.onCompleted.emit(details({ requestId: 'destroy-pending' }));
destroyedObserver.destroy();
assert.equal(destroyedWebRequest.onBeforeRequest.listeners.size, 0);
assert.equal(destroyedObserver.activeRecords.size, 0);
assert.equal(destroyedObserver.completedQueue.length, 0);
assert.equal(destroyedObserver.observationRing.length, 0);
assert.equal(destroyedObserver.activate({
    tabId: 7,
    revision: 2,
    enabled: true,
    autoScan: true,
    monitorOnly: true
}), false);

const budgetWebRequest = createFakeWebRequest();
const budgetObserver = new ApiResourceObserver({ webRequest: budgetWebRequest });
assert.equal(budgetObserver.activate({
    tabId: 7,
    revision: 1,
    enabled: true,
    autoScan: true,
    monitorOnly: true
}), true);
for (let index = 0; index < 257; index += 1) {
    budgetWebRequest.onBeforeRequest.emit(details({ requestId: `active-${index}` }));
}
assert.equal(budgetObserver.getObservationState().overflowCounters.activeRecords, 1);
budgetObserver.pause(2);
assert.equal(budgetWebRequest.onBeforeRequest.listeners.size, 0);

const callbackWebRequest = createFakeWebRequest();
const callbackStates = [];
const callbackObserver = new ApiResourceObserver({
    webRequest: callbackWebRequest,
    onStateChange: (nextState) => callbackStates.push(nextState)
});
assert.equal(callbackObserver.activate({
    tabId: 7,
    revision: 1,
    enabled: true,
    autoScan: true,
    monitorOnly: true
}), true);
assert.equal(callbackStates.length, 1);
for (let index = 0; index < 3; index += 1) {
    callbackWebRequest.onCompleted.emit(details({ requestId: `callback-orphan-${index}` }));
}
await new Promise((resolve) => setTimeout(resolve, 100));
assert.equal(callbackStates.length, 1);
await new Promise((resolve) => setTimeout(resolve, 450));
assert.equal(callbackStates.length, 2);
assert.equal(callbackStates.every((nextState) => JSON.stringify(nextState).includes('callback-orphan') === false), true);
callbackObserver.pause(2);
assert.equal(callbackWebRequest.onBeforeRequest.listeners.size, 0);

const callbackErrorWebRequest = createFakeWebRequest();
const callbackErrorObserver = new ApiResourceObserver({
    webRequest: callbackErrorWebRequest,
    onStateChange: () => {
        throw new Error('synthetic callback failure');
    }
});
assert.equal(callbackErrorObserver.activate({
    tabId: 7,
    revision: 1,
    enabled: true,
    autoScan: true,
    monitorOnly: true
}), true);
callbackErrorWebRequest.onCompleted.emit(details({ requestId: 'callback-error-orphan' }));
callbackErrorObserver.pause(2);
assert.equal(callbackErrorWebRequest.onBeforeRequest.listeners.size, 0);
assert.equal(callbackErrorObserver.activeRecords.size, 0);

const redirectWebRequest = createFakeWebRequest();
const redirectObserver = new ApiResourceObserver({ webRequest: redirectWebRequest });
assert.equal(redirectObserver.activate({
    tabId: 7,
    revision: 1,
    enabled: true,
    autoScan: true,
    monitorOnly: true
}), true);
redirectWebRequest.onBeforeRequest.emit(details({ requestId: 'redirect-overflow' }));
for (let index = 0; index < 9; index += 1) {
    redirectWebRequest.onBeforeRedirect.emit(details({ requestId: 'redirect-overflow' }));
}
assert.equal(redirectObserver.getObservationState().overflowCounters.redirects, 1);
assert.equal(redirectObserver.activeRecords.size, 0);
redirectObserver.pause(2);

const queueWebRequest = createFakeWebRequest();
const queueObserver = new ApiResourceObserver({ webRequest: queueWebRequest });
assert.equal(queueObserver.activate({
    tabId: 7,
    revision: 1,
    enabled: true,
    autoScan: true,
    monitorOnly: true
}), true);
for (let index = 0; index < 257; index += 1) {
    const requestId = `queue-${index}`;
    queueWebRequest.onBeforeRequest.emit(details({ requestId }));
    queueWebRequest.onCompleted.emit(details({ requestId }));
}
assert.equal(queueObserver.completedQueue.length, 256);
assert.equal(queueObserver.getObservationState().overflowCounters.completedQueue, 1);
assert.equal(queueObserver.getObservationState().partial, true);
queueObserver.pause(2);
assert.equal(queueWebRequest.onBeforeRequest.listeners.size, 0);

const batchWebRequest = createFakeWebRequest();
let batchClockCalls = 0;
const batchObserver = new ApiResourceObserver({
    webRequest: batchWebRequest,
    clock: () => {
        batchClockCalls += 1;
        return batchClockCalls >= 3 ? 20 : 0;
    }
});
assert.equal(batchObserver.activate({
    tabId: 7,
    revision: 1,
    enabled: true,
    autoScan: true,
    monitorOnly: true
}), true);
for (let index = 0; index < 2; index += 1) {
    const requestId = `batch-${index}`;
    batchWebRequest.onBeforeRequest.emit(details({ requestId }));
    batchWebRequest.onCompleted.emit(details({ requestId }));
}
batchObserver.processCompletedBatch();
assert.equal(batchObserver.getObservationState().overflowCounters.batchBudget, 1);
assert.equal(batchObserver.getObservationState().partial, true);
batchObserver.pause(2);
assert.equal(batchWebRequest.onBeforeRequest.listeners.size, 0);

const switchingWebRequest = createFakeWebRequest();
const switchingObserver = new ApiResourceObserver({ webRequest: switchingWebRequest });
for (let revision = 1; revision <= 100; revision += 1) {
    const tabId = revision % 2 === 0 ? 7 : 8;
    assert.equal(switchingObserver.activate({
        tabId,
        revision: revision * 2,
        enabled: true,
        autoScan: true,
        monitorOnly: true
    }), true);
    assert.equal(switchingWebRequest.onBeforeRequest.listeners.size, 1);
    switchingObserver.pause((revision * 2) + 1);
    assert.equal(switchingWebRequest.onBeforeRequest.listeners.size, 0);
    assert.equal(switchingWebRequest.onCompleted.listeners.size, 0);
    assert.equal(switchingObserver.activeRecords.size, 0);
    assert.equal(switchingObserver.completedQueue.length, 0);
}

const floodWebRequest = createFakeWebRequest();
const floodObserver = new ApiResourceObserver({ webRequest: floodWebRequest });
assert.equal(floodObserver.activate({
    tabId: 7,
    revision: 1,
    enabled: true,
    autoScan: true,
    monitorOnly: true
}), true);
for (let index = 0; index < 10000; index += 1) {
    const requestId = `flood-${index}`;
    floodWebRequest.onBeforeRequest.emit(details({ requestId }));
    floodWebRequest.onCompleted.emit(details({ requestId }));
}
assert.equal(floodObserver.getObservationState().partial, true);
assert.ok(floodObserver.getObservationState().overflowCounters.completedQueue > 0);
floodObserver.pause(2);
assert.equal(floodWebRequest.onBeforeRequest.listeners.size, 0);
assert.equal(floodObserver.activeRecords.size, 0);
assert.equal(floodObserver.completedQueue.length, 0);
assert.equal(floodObserver.observationRing.length, 0);

const observationBatches = [];
const observationBatchWebRequest = createFakeWebRequest();
const observationBatchObserver = new ApiResourceObserver({
    webRequest: observationBatchWebRequest,
    onObservationBatch: (batch, context) => observationBatches.push({ batch, context })
});
assert.equal(observationBatchObserver.activate({
    tabId: 7,
    revision: 4,
    enabled: true,
    autoScan: true,
    monitorOnly: true
}), true);
observationBatchWebRequest.onBeforeRequest.emit(details({ requestId: 'candidate-batch' }));
observationBatchWebRequest.onHeadersReceived.emit(details({
    requestId: 'candidate-batch',
    responseHeaders: [{ name: 'Content-Type', value: 'text/html; marker=must-not-persist' }]
}));
observationBatchWebRequest.onCompleted.emit(details({ requestId: 'candidate-batch' }));
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(observationBatches.length, 1);
assert.equal(Object.isFrozen(observationBatches[0].batch), true);
assert.equal(Object.isFrozen(observationBatches[0].batch[0]), true);
assert.equal(Object.isFrozen(observationBatches[0].context), true);
assert.equal(observationBatches[0].context.sessionRevision, 4);
assert.equal(JSON.stringify(observationBatches).includes('must-not-persist'), false);
observationBatchObserver.pause(5);

const decisionErrorWebRequest = createFakeWebRequest();
const decisionErrorObserver = new ApiResourceObserver({
    webRequest: decisionErrorWebRequest,
    onObservationBatch: () => {
        throw new Error('synthetic decision failure');
    }
});
assert.equal(decisionErrorObserver.activate({
    tabId: 7,
    revision: 1,
    enabled: true,
    autoScan: true,
    monitorOnly: true
}), true);
decisionErrorWebRequest.onBeforeRequest.emit(details({ requestId: 'decision-error' }));
decisionErrorWebRequest.onCompleted.emit(details({ requestId: 'decision-error' }));
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(decisionErrorObserver.getObservationState().counters.decisionErrors, 1);
assert.equal(decisionErrorObserver.getObservationState().partial, true);
decisionErrorObserver.pause(2);

const unavailableObserver = new ApiResourceObserver({ webRequest: null });
assert.equal(unavailableObserver.activate({
    tabId: 7,
    revision: 1,
    enabled: true,
    autoScan: true,
    monitorOnly: true
}), false);
assert.equal(unavailableObserver.getObservationState().status, 'unavailable');

const failingWebRequest = createFakeWebRequest();
failingWebRequest.onHeadersReceived.addListener = () => {
    throw new Error('synthetic registration failure');
};
const registrationFailureObserver = new ApiResourceObserver({ webRequest: failingWebRequest });
assert.equal(registrationFailureObserver.activate({
    tabId: 7,
    revision: 1,
    enabled: true,
    autoScan: true,
    monitorOnly: true
}), false);
assert.equal(failingWebRequest.onBeforeRequest.listeners.size, 0);
assert.equal(registrationFailureObserver.getObservationState().status, 'unavailable');
failingWebRequest.onHeadersReceived.addListener = FakeEvent.prototype.addListener;
assert.equal(registrationFailureObserver.activate({
    tabId: 7,
    revision: 2,
    enabled: true,
    autoScan: true,
    monitorOnly: true
}), true);
assert.equal(registrationFailureObserver.getObservationState().status, 'active');
registrationFailureObserver.pause(3);

const publicationStates = [];
let publicationClock = 501;
const publicationWebRequest = createFakeWebRequest();
const publicationObserver = new ApiResourceObserver({
    webRequest: publicationWebRequest,
    clock: () => publicationClock,
    onStateChange: (nextState) => publicationStates.push(nextState)
});
assert.equal(publicationObserver.activate({
    tabId: 7,
    revision: 1,
    enabled: true,
    autoScan: true,
    monitorOnly: true
}), true);
publicationWebRequest.onCompleted.emit(details({ requestId: 'delayed-publication-orphan' }));
publicationObserver.pause(2);
publicationClock = 1001;
await new Promise((resolve) => setTimeout(resolve, 510));
assert.equal(publicationStates.at(-1).status, 'not-observed');
assert.equal(publicationStates.at(-1).partial, false);
assert.equal(publicationStates.filter((nextState) => nextState.status === 'partial').length, 0);

console.log('ApiResourceObserver Priority 2 checks passed');

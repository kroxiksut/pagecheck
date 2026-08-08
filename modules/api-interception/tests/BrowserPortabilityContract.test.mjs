import assert from 'node:assert/strict';
import ApiResourceObserver from '../runtime/ApiResourceObserver.js';
import ApiFindingState from '../runtime/ApiFindingState.js';
import { evaluateImageMimeObservation } from '../decision/apiMimeDecision.js';
import ApiTestHarness from './helpers/ApiTestHarness.mjs';

async function runSyntheticFacadeCorpus() {
    const harness = new ApiTestHarness();
    const batches = [];
    const observer = new ApiResourceObserver({
        webRequest: harness.createWebRequestApi(),
        onObservationBatch: (observations, context) => batches.push({ observations, context })
    });

    assert.equal(observer.activate({
        tabId: 7,
        revision: 1,
        enabled: true,
        autoScan: true,
        monitorOnly: true
    }), true);

    harness.emit('onBeforeRequest', { tabId: 7, frameId: 0, type: 'image', requestId: 'benign', method: 'GET' });
    harness.emit('onHeadersReceived', {
        tabId: 7,
        frameId: 0,
        type: 'image',
        requestId: 'benign',
        statusCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'image/png' }]
    });
    harness.emit('onCompleted', { tabId: 7, frameId: 0, type: 'image', requestId: 'benign' });

    harness.emit('onBeforeRequest', { tabId: 7, frameId: 0, type: 'image', requestId: 'document', method: 'GET' });
    harness.emit('onHeadersReceived', {
        tabId: 7,
        frameId: 0,
        type: 'image',
        requestId: 'document',
        statusCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'text/html' }]
    });
    harness.emit('onCompleted', { tabId: 7, frameId: 0, type: 'image', requestId: 'document' });

    harness.emit('onBeforeRequest', { tabId: 7, frameId: 0, type: 'image', requestId: 'redirect', method: 'GET' });
    harness.emit('onHeadersReceived', {
        tabId: 7,
        frameId: 0,
        type: 'image',
        requestId: 'redirect',
        statusCode: 302,
        responseHeaders: [{ name: 'Content-Type', value: 'text/html' }]
    });
    harness.emit('onBeforeRedirect', { tabId: 7, frameId: 0, type: 'image', requestId: 'redirect' });
    harness.emit('onHeadersReceived', {
        tabId: 7,
        frameId: 0,
        type: 'image',
        requestId: 'redirect',
        statusCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'application/javascript' }]
    });
    harness.emit('onCompleted', { tabId: 7, frameId: 0, type: 'image', requestId: 'redirect' });

    harness.emit('onBeforeRequest', { tabId: 7, frameId: 0, type: 'xmlhttprequest', requestId: 'error', method: 'POST' });
    harness.emit('onErrorOccurred', { tabId: 7, frameId: 0, type: 'xmlhttprequest', requestId: 'error' });

    harness.emit('onBeforeRequest', { tabId: 7, frameId: 0, type: 'image', requestId: 'malformed', method: 'GET' });
    harness.emit('onHeadersReceived', {
        tabId: 7,
        frameId: 0,
        type: 'image',
        requestId: 'malformed',
        statusCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'not a media type' }]
    });
    harness.emit('onCompleted', { tabId: 7, frameId: 0, type: 'image', requestId: 'malformed' });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const observations = batches.flatMap((batch) => batch.observations);
    assert.equal(observations.length, 5);
    assert.equal(observations.some((observation) => observation.networkError === true), true);
    assert.equal(observations.some((observation) => observation.declaredMimeState === 'malformed'), true);

    const decisions = observations.map(evaluateImageMimeObservation).filter(Boolean);
    const findingState = new ApiFindingState();
    findingState.reset({ navigationRevision: 1 });
    findingState.applyDecisions(decisions, { navigationRevision: 1, partial: false });
    assert.deepEqual(findingState.getCandidateSnapshot().candidates, [{
        type: 'image-resource-declared-mime-anomaly',
        category: 'document',
        severity: 'low',
        occurrenceCount: 1
    }, {
        type: 'image-resource-declared-mime-anomaly',
        category: 'script',
        severity: 'low',
        occurrenceCount: 1
    }]);
    assert.deepEqual(findingState.getProductSnapshot().findings, []);

    const registration = harness.getListenerSnapshot();
    for (const eventName of ['onBeforeRequest', 'onHeadersReceived', 'onBeforeRedirect', 'onCompleted', 'onErrorOccurred']) {
        assert.equal(registration[eventName].listenerCount, 1);
        assert.deepEqual(registration[eventName].registrations[0].filter, {
            urls: ['<all_urls>'],
            types: ['xmlhttprequest', 'image'],
            tabId: 7
        });
    }
    assert.deepEqual(registration.onHeadersReceived.registrations[0].extraInfoSpec, ['responseHeaders']);

    harness.emit('onCompleted', { tabId: 7, frameId: 0, type: 'image', requestId: 'orphan' });
    assert.equal(observer.getObservationState().partial, true);
    observer.pause(2);
    assert.equal(observer.getObservationState().status, 'not-observed');
    assert.equal(observer.activeRecords.size, 0);
    assert.equal(observer.completedQueue.length, 0);
    assert.equal(Object.values(harness.getListenerSnapshot()).every((snapshot) => snapshot.listenerCount === 0), true);

    return {
        observations,
        candidates: findingState.getCandidateSnapshot().candidates,
        product: findingState.getProductSnapshot()
    };
}

const chromeFacade = await runSyntheticFacadeCorpus();
const edgeFacade = await runSyntheticFacadeCorpus();
const firefoxFacade = await runSyntheticFacadeCorpus();
assert.deepEqual(edgeFacade, chromeFacade);
assert.deepEqual(firefoxFacade, chromeFacade);

const stormHarness = new ApiTestHarness();
const stormObserver = new ApiResourceObserver({ webRequest: stormHarness.createWebRequestApi() });
assert.equal(stormObserver.activate({
    tabId: 7,
    revision: 1,
    enabled: true,
    autoScan: true,
    monitorOnly: true
}), true);
for (let index = 0; index < 257; index += 1) {
    const requestId = `storm-${index}`;
    stormHarness.emit('onBeforeRequest', { tabId: 7, frameId: 0, type: 'image', requestId, method: 'GET' });
    stormHarness.emit('onCompleted', { tabId: 7, frameId: 0, type: 'image', requestId });
}
assert.equal(stormObserver.getObservationState().partial, true);
assert.equal(stormObserver.getObservationState().overflowCounters.completedQueue, 1);
stormObserver.pause(2);
assert.equal(stormObserver.completedQueue.length, 0);
assert.equal(Object.values(stormHarness.getListenerSnapshot()).every((snapshot) => snapshot.listenerCount === 0), true);

const missingCapabilityHarness = new ApiTestHarness();
const missingCapabilityApi = missingCapabilityHarness.createWebRequestApi();
delete missingCapabilityApi.onErrorOccurred;
const missingCapabilityObserver = new ApiResourceObserver({ webRequest: missingCapabilityApi });
assert.equal(missingCapabilityObserver.activate({
    tabId: 7,
    revision: 1,
    enabled: true,
    autoScan: true,
    monitorOnly: true
}), false);
assert.equal(missingCapabilityObserver.getObservationState().status, 'unavailable');
assert.equal(Object.values(missingCapabilityHarness.getListenerSnapshot()).every((snapshot) => snapshot.listenerCount === 0), true);

const registrationFailureHarness = new ApiTestHarness();
const registrationFailureApi = registrationFailureHarness.createWebRequestApi();
registrationFailureApi.onCompleted.addListener = () => {
    throw new Error('synthetic registration failure');
};
const registrationFailureObserver = new ApiResourceObserver({ webRequest: registrationFailureApi });
assert.equal(registrationFailureObserver.activate({
    tabId: 7,
    revision: 1,
    enabled: true,
    autoScan: true,
    monitorOnly: true
}), false);
assert.equal(registrationFailureObserver.getObservationState().status, 'unavailable');
assert.equal(registrationFailureObserver.getObservationState().overflowCounters.registration, 1);
assert.equal(Object.values(registrationFailureHarness.getListenerSnapshot()).every((snapshot) => snapshot.listenerCount === 0), true);

console.log('Browser portability contract checks passed');

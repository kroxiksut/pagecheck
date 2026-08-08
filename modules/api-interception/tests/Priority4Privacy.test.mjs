import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ApiResourceObserver from '../runtime/ApiResourceObserver.js';
import ApiFindingState from '../runtime/ApiFindingState.js';
import { evaluateImageMimeObservation } from '../decision/apiMimeDecision.js';
import ApiTestHarness from './helpers/ApiTestHarness.mjs';

const sentinel = 'privacy-sentinel';
const harness = new ApiTestHarness();
const batches = [];
const observer = new ApiResourceObserver({
    webRequest: harness.createWebRequestApi(),
    onObservationBatch: (batch) => batches.push(batch)
});
assert.equal(observer.activate({ tabId: 7, revision: 1, enabled: true, autoScan: true, monitorOnly: true }), true);
harness.emit('onBeforeRequest', {
    tabId: 7,
    frameId: 0,
    type: 'image',
    requestId: sentinel,
    method: 'POST',
    url: `https://fixture.invalid/?${sentinel}`,
    requestBody: { formData: { password: [sentinel] } },
    requestHeaders: [{ name: 'Authorization', value: sentinel }, { name: 'Cookie', value: sentinel }]
});
harness.emit('onHeadersReceived', {
    tabId: 7,
    frameId: 0,
    type: 'image',
    requestId: sentinel,
    statusCode: 200,
    responseHeaders: [
        { name: 'X-Response-Sentinel', value: sentinel },
        { name: 'Content-Type', value: `text/html; marker=${sentinel}` }
    ]
});
harness.emit('onCompleted', { tabId: 7, frameId: 0, type: 'image', requestId: sentinel });
await new Promise((resolve) => setTimeout(resolve, 0));

const findingState = new ApiFindingState();
const decisions = batches[0].map(evaluateImageMimeObservation).filter(Boolean);
findingState.applyDecisions(decisions, { navigationRevision: 1 });
const safeProjection = JSON.stringify({
    observer: observer.getObservationState(),
    batch: batches,
    candidate: findingState.getCandidateSnapshot(),
    product: findingState.getProductSnapshot(),
    harness: harness.getRuntimeSnapshot()
});
assert.equal(safeProjection.includes(sentinel), false, 'privacy sentinel leaked into a safe projection');

const observerSource = await readFile(new URL('../runtime/ApiResourceObserver.js', import.meta.url), 'utf8');
assert.equal(observerSource.includes('requestBody'), false);
assert.equal(observerSource.includes('requestHeaders'), false);
assert.equal(observerSource.includes('extraHeaders'), false);
assert.equal(observerSource.includes('Logger.'), false);
observer.pause(2);

console.log('Priority 4 privacy sentinel checks passed');

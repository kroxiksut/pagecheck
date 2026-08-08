import assert from 'node:assert/strict';
import ApiTestHarness from './helpers/ApiTestHarness.mjs';

const harness = new ApiTestHarness();
const webRequest = harness.createWebRequestApi();
const received = [];
const listener = (details) => received.push(details.tabId);
webRequest.onBeforeRequest.addListener(listener, { tabId: 7, types: ['image'] });
assert.equal(webRequest.onBeforeRequest.hasListener(listener), true);
assert.throws(() => webRequest.onBeforeRequest.addListener(listener), /Duplicate/);
harness.emit('onBeforeRequest', { tabId: 7, requestId: 'not-retained' });
assert.deepEqual(received, [7]);
assert.deepEqual(harness.getListenerSnapshot().onBeforeRequest, {
    listenerCount: 1,
    registrations: [{ filter: { tabId: 7, types: ['image'] }, extraInfoSpec: null }]
});
webRequest.onBeforeRequest.removeListener(listener);
assert.equal(webRequest.onBeforeRequest.hasListener(listener), false);

assert.equal(harness.advanceTime(25), 25);
assert.throws(() => harness.advanceTime(-1), /non-negative/);
const delayed = harness.delayOperation('activation');
assert.equal(harness.getRuntimeSnapshot().delayedOperationNames.includes('activation'), true);
assert.equal(harness.releaseOperation('activation'), true);
await delayed;
assert.equal(harness.releaseOperation('activation'), false);

for (let index = 0; index < 80; index += 1) {
    harness.emit('onCompleted', { tabId: 7, requestId: `ignored-${index}` });
}
assert.equal(harness.getRuntimeSnapshot().retainedEventCount, 64);
assert.throws(() => harness.emit('unknown', {}), /Unknown/);

console.log('API test harness checks passed');

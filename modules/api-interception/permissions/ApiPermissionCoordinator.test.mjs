import assert from 'node:assert/strict';
import ApiPermissionCoordinator from './ApiPermissionCoordinator.js';
import { API_PERMISSION_DESCRIPTOR, isApiPermissionDescriptorRelevant } from './apiPermissionContract.js';

let granted = false;
let desiredEnabled = false;
let removalFails = false;
const lifecycle = [];
const permissionsApi = {
    async contains(descriptor) {
        assert.deepEqual(descriptor, API_PERMISSION_DESCRIPTOR);
        return granted;
    },
    async remove(descriptor) {
        assert.deepEqual(descriptor, API_PERMISSION_DESCRIPTOR);
        if (removalFails) {
            throw new Error('private browser failure');
        }
        granted = false;
        return true;
    }
};

const coordinator = new ApiPermissionCoordinator({
    permissionsApi,
    readDesiredEnabled: () => desiredEnabled,
    commitDesiredEnabled: (nextValue) => { desiredEnabled = nextValue; },
    pauseObserver: () => { lifecycle.push('pause'); },
    reconcileObserver: () => { lifecycle.push('reconcile'); }
});

assert.equal(Object.isFrozen(API_PERMISSION_DESCRIPTOR), true);
assert.deepEqual(API_PERMISSION_DESCRIPTOR, { permissions: ['webRequest'], origins: ['http://*/*', 'https://*/*'] });
assert.equal(isApiPermissionDescriptorRelevant({ permissions: ['tabs'] }), false);
assert.equal(isApiPermissionDescriptorRelevant({ permissions: ['webRequest'] }), true);
assert.equal(isApiPermissionDescriptorRelevant({ origins: ['https://*/*'] }), true);

await coordinator.reconcile();
assert.deepEqual(coordinator.getState(), {
    capability: 'missing', transaction: 'idle', desiredEnabled: false, revision: 1, removalFailed: false
});
assert.deepEqual(lifecycle, ['pause']);

const enable = await coordinator.beginEnable();
assert.equal(enable.transactionId, 'api-2');
assert.equal(coordinator.getState().transaction, 'requesting');
granted = true;
const committed = await coordinator.commitEnable(enable.transactionId, true);
assert.equal(committed.success, true);
assert.deepEqual(coordinator.getState(), {
    capability: 'granted', transaction: 'idle', desiredEnabled: true, revision: 2, removalFailed: false
});
assert.deepEqual(lifecycle, ['pause', 'pause', 'reconcile']);

const secondEnable = await coordinator.beginEnable();
const disabled = await coordinator.disable();
assert.equal(disabled.success, true);
assert.equal(desiredEnabled, false);
const staleGrant = await coordinator.commitEnable(secondEnable.transactionId, true);
assert.equal(staleGrant.stale, true);
assert.equal(coordinator.getState().desiredEnabled, false);

const deniedEnable = await coordinator.beginEnable();
const denied = await coordinator.commitEnable(deniedEnable.transactionId, false);
assert.equal(denied.granted, false);
assert.equal(desiredEnabled, false);
assert.equal(coordinator.getState().capability, 'missing');

granted = true;
removalFails = true;
const failedRemoval = await coordinator.disable();
assert.equal(failedRemoval.removalFailed, true);
assert.deepEqual(coordinator.getState(), {
    capability: 'granted', transaction: 'idle', desiredEnabled: false, revision: 6, removalFailed: true
});
assert.equal(JSON.stringify(coordinator.getState()).includes('private browser failure'), false);

const unavailable = new ApiPermissionCoordinator({ readDesiredEnabled: () => true });
await unavailable.reconcile();
assert.equal(unavailable.getState().capability, 'unavailable');
assert.equal(unavailable.getState().desiredEnabled, true);

removalFails = false;
for (let iteration = 0; iteration < 100; iteration += 1) {
    granted = iteration % 2 === 0;
    const transaction = await coordinator.beginEnable();
    if (iteration % 3 === 0) {
        await coordinator.disable();
        const stale = await coordinator.commitEnable(transaction.transactionId, true);
        assert.equal(stale.stale, true);
    } else {
        await coordinator.commitEnable(transaction.transactionId, granted);
    }
    assert.equal(coordinator.getState().transaction, 'idle');
}

console.log('API permission coordinator contract checks passed');

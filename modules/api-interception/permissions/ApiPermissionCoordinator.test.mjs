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


// --- Переплетение reconcile из слушателя разрешений с идущей транзакцией (TASKS 13.1, 13.3) ------
// Ради этого события транзакция и существует, но прежде набор её ни разу с ним не переплетал: он
// проверял транзакцию в отсутствие ровно того, что ей угрожает (тот же класс, что C5.5 в корневом
// TASKS). Сценарий разыгран в трёх видах: без гейта вызывающего (так выглядел дефект), с гейтом
// (так работает js/background.js) и с настоящим внешним отзывом разрешения во время транзакции.
//
// Гейт живёт у вызывающего, а не здесь, и это осознанно: reconcile() - полное перевыведение
// состояния из конфигурации, поэтому поднимать ревизию он обязан. Отсюда контракт координатора:
// звать reconcile() посреди транзакции нельзя, и первый раздел ниже фиксирует, чем именно это
// кончается, чтобы «самозащита» не появилась в координаторе молча.

function createPermissionStand() {
    const stand = { granted: false, desiredEnabled: false, removeCalls: 0, lifecycle: [] };
    stand.coordinator = new ApiPermissionCoordinator({
        permissionsApi: {
            async contains(descriptor) {
                assert.deepEqual(descriptor, API_PERMISSION_DESCRIPTOR);
                return stand.granted;
            },
            async remove(descriptor) {
                assert.deepEqual(descriptor, API_PERMISSION_DESCRIPTOR);
                stand.removeCalls += 1;
                stand.granted = false;
                return true;
            }
        },
        readDesiredEnabled: () => stand.desiredEnabled,
        commitDesiredEnabled: (nextValue) => { stand.desiredEnabled = nextValue; },
        pauseObserver: () => { stand.lifecycle.push('pause'); },
        reconcileObserver: () => { stand.lifecycle.push('reconcile'); }
    });
    // Гейт вызывающего в том же виде, что reconcileApiPermissionWhenIdle/flushPending... в background.
    stand.reconcilePending = false;
    stand.reconcileWhenIdle = async () => {
        if (stand.coordinator.getState().transaction !== 'idle') {
            stand.reconcilePending = true;
            return;
        }
        stand.reconcilePending = false;
        await stand.coordinator.reconcile();
    };
    stand.flushPendingReconcile = () => (stand.reconcilePending ? stand.reconcileWhenIdle() : Promise.resolve());
    return stand;
}

// 1. Без гейта: onAdded приходит раньше commit - разрешение выдано и тут же отозвано.
const ungated = createPermissionStand();
const ungatedEnable = await ungated.coordinator.beginEnable();
ungated.granted = true;
await ungated.coordinator.reconcile();
const ungatedCommit = await ungated.coordinator.commitEnable(ungatedEnable.transactionId, true);
assert.equal(ungatedCommit.stale, true, 'reconcile посреди транзакции обязан делать её устаревшей');
assert.equal(ungated.removeCalls, 1, 'без гейта reconcile отзывает только что выданное разрешение (13.1)');
assert.equal(ungated.granted, false);
assert.equal(ungated.desiredEnabled, false, 'commitDesiredEnabled(true) до конфигурации не доезжает');

// 2. С гейтом: то же событие откладывается и доезжает после транзакции, ничего не отзывая.
const gated = createPermissionStand();
const gatedEnable = await gated.coordinator.beginEnable();
gated.granted = true;
await gated.reconcileWhenIdle();
assert.equal(gated.reconcilePending, true, 'событие при незавершённой транзакции откладывается, а не теряется');
assert.equal(gated.removeCalls, 0);
const gatedCommit = await gated.coordinator.commitEnable(gatedEnable.transactionId, true);
assert.equal(gatedCommit.success, true, 'транзакция доводится до конца, UI показывает успех');
assert.equal(gated.desiredEnabled, true);
await gated.flushPendingReconcile();
assert.equal(gated.reconcilePending, false, 'отложенное событие обязано доехать после транзакции');
assert.equal(gated.removeCalls, 0, 'отложенный reconcile видит desiredEnabled === true и разрешение не трогает');
assert.equal(gated.granted, true);
assert.deepEqual(gated.coordinator.getState(), {
    capability: 'granted', transaction: 'idle', desiredEnabled: true, revision: 2, removalFailed: false
});
assert.equal(gated.lifecycle.at(-1), 'reconcile', 'наблюдатель остаётся поднятым, а не встаёт на паузу');

// 3. Настоящий внешний отзыв во время транзакции гейт откладывает, но не проглатывает.
const revoked = createPermissionStand();
const revokedEnable = await revoked.coordinator.beginEnable();
revoked.granted = true;
await revoked.reconcileWhenIdle();
assert.equal(revoked.reconcilePending, true);
revoked.granted = false;
const revokedCommit = await revoked.coordinator.commitEnable(revokedEnable.transactionId, true);
assert.equal(revokedCommit.success, false, 'commit перечитывает разрешение и не верит grantResult на слово');
assert.equal(revokedCommit.granted, false);
assert.equal(revoked.coordinator.getState().capability, 'missing');
await revoked.flushPendingReconcile();
assert.equal(revoked.reconcilePending, false);
assert.equal(revoked.coordinator.getState().capability, 'missing');
assert.equal(revoked.coordinator.getState().desiredEnabled, false);
assert.equal(revoked.removeCalls, 0, 'отзывать нечего: разрешения уже нет');
assert.equal(revoked.lifecycle.at(-1), 'pause', 'наблюдатель встаёт на паузу, а не остаётся «включённым»');

console.log('API permission coordinator contract checks passed');

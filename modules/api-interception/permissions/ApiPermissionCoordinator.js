import { API_PERMISSION_DESCRIPTOR } from './apiPermissionContract.js';

const CAPABILITIES = new Set(['unknown', 'missing', 'granted', 'unavailable']);
const TRANSACTIONS = new Set(['idle', 'requesting', 'committing', 'removing']);

function createState({ capability, transaction, desiredEnabled, revision, removalFailed = false }) {
    return Object.freeze({
        capability: CAPABILITIES.has(capability) ? capability : 'unavailable',
        transaction: TRANSACTIONS.has(transaction) ? transaction : 'idle',
        desiredEnabled: desiredEnabled === true,
        revision: Number.isSafeInteger(revision) && revision >= 0 ? revision : 0,
        removalFailed: removalFailed === true
    });
}

export default class ApiPermissionCoordinator {
    constructor({ permissionsApi, readDesiredEnabled, commitDesiredEnabled, pauseObserver, reconcileObserver, onStateChange } = {}) {
        this.permissionsApi = permissionsApi;
        this.readDesiredEnabled = readDesiredEnabled;
        this.commitDesiredEnabled = commitDesiredEnabled;
        this.pauseObserver = pauseObserver;
        this.reconcileObserver = reconcileObserver;
        this.onStateChange = onStateChange;
        this.revision = 0;
        this.currentTransactionId = null;
        this.state = createState({
            capability: 'unknown',
            transaction: 'idle',
            desiredEnabled: false,
            revision: this.revision
        });
    }

    getState() {
        return this.state;
    }

    async reconcile(context = {}) {
        const revision = ++this.revision;
        this.currentTransactionId = null;
        const desiredEnabled = await this.resolveDesiredEnabled(context);
        let capability = await this.containsDescriptor();
        let removalFailed = false;
        if (!desiredEnabled && capability === 'granted') {
            try {
                if (typeof this.permissionsApi?.remove !== 'function') {
                    throw new Error('Permission removal is unavailable');
                }
                await this.permissionsApi.remove(API_PERMISSION_DESCRIPTOR);
            } catch {
                removalFailed = true;
            }
            capability = await this.containsDescriptor();
        }
        if (revision !== this.revision) {
            return this.getState();
        }
        this.publish({ capability, transaction: 'idle', desiredEnabled, revision, removalFailed });
        if (desiredEnabled && capability === 'granted') {
            await this.runLifecycle('reconcile', context);
        } else {
            await this.runLifecycle('pause', context);
        }
        return this.getState();
    }

    async beginEnable(context = {}) {
        const revision = ++this.revision;
        await this.runLifecycle('pause', context);
        const transactionId = `api-${revision}`;
        this.currentTransactionId = transactionId;
        this.publish({
            capability: this.state.capability,
            transaction: 'requesting',
            desiredEnabled: await this.resolveDesiredEnabled(context),
            revision,
            removalFailed: false
        });
        return Object.freeze({ transactionId, revision, state: this.getState() });
    }

    async commitEnable(transactionId, grantResult, context = {}) {
        if (!this.isCurrentTransaction(transactionId)) {
            return Object.freeze({ success: false, stale: true, state: this.getState() });
        }
        const revision = this.revision;
        const desiredEnabled = this.state.desiredEnabled;
        this.publish({
            capability: this.state.capability,
            transaction: 'committing',
            desiredEnabled,
            revision,
            removalFailed: false
        });
        const capability = grantResult === true ? await this.containsDescriptor() : 'missing';
        if (!this.isCurrentTransaction(transactionId) || revision !== this.revision) {
            return Object.freeze({ success: false, stale: true, state: this.getState() });
        }
        this.currentTransactionId = null;
        if (capability !== 'granted') {
            await this.runLifecycle('pause', context);
            this.publish({ capability, transaction: 'idle', desiredEnabled, revision, removalFailed: false });
            return Object.freeze({ success: false, granted: false, state: this.getState() });
        }
        await this.commitDesiredEnabled?.(true);
        if (revision !== this.revision) {
            return Object.freeze({ success: false, stale: true, state: this.getState() });
        }
        this.publish({ capability, transaction: 'idle', desiredEnabled: true, revision, removalFailed: false });
        await this.runLifecycle('reconcile', context);
        return Object.freeze({ success: true, granted: true, state: this.getState() });
    }

    async disable(context = {}) {
        const revision = ++this.revision;
        this.currentTransactionId = null;
        await this.runLifecycle('pause', context);
        this.publish({ capability: this.state.capability, transaction: 'removing', desiredEnabled: false, revision, removalFailed: false });
        await this.commitDesiredEnabled?.(false);
        let removalFailed = false;
        try {
            if (typeof this.permissionsApi?.remove !== 'function') {
                throw new Error('Permission removal is unavailable');
            }
            await this.permissionsApi.remove(API_PERMISSION_DESCRIPTOR);
        } catch {
            removalFailed = true;
        }
        const capability = await this.containsDescriptor();
        if (revision !== this.revision) {
            return Object.freeze({ success: false, stale: true, state: this.getState() });
        }
        this.publish({ capability, transaction: 'idle', desiredEnabled: false, revision, removalFailed });
        return Object.freeze({ success: true, removalFailed, state: this.getState() });
    }

    destroy() {
        this.revision += 1;
        this.currentTransactionId = null;
        this.publish({ capability: 'unavailable', transaction: 'idle', desiredEnabled: false, revision: this.revision, removalFailed: false });
    }

    async resolveDesiredEnabled(context) {
        if (typeof context.desiredEnabled === 'boolean') {
            return context.desiredEnabled;
        }
        try {
            return (await this.readDesiredEnabled?.()) === true;
        } catch {
            return false;
        }
    }

    async containsDescriptor() {
        if (typeof this.permissionsApi?.contains !== 'function') {
            return 'unavailable';
        }
        try {
            return await this.permissionsApi.contains(API_PERMISSION_DESCRIPTOR) ? 'granted' : 'missing';
        } catch {
            return 'unavailable';
        }
    }

    isCurrentTransaction(transactionId) {
        return typeof transactionId === 'string'
            && transactionId === this.currentTransactionId
            && transactionId === `api-${this.revision}`;
    }

    async runLifecycle(operation, context) {
        const lifecycle = operation === 'pause' ? this.pauseObserver : this.reconcileObserver;
        if (typeof lifecycle === 'function') {
            await lifecycle(context);
        }
    }

    publish(nextState) {
        this.state = createState(nextState);
        try {
            this.onStateChange?.(this.state);
        } catch {
            // State observers are isolated from permission lifecycle decisions.
        }
    }
}

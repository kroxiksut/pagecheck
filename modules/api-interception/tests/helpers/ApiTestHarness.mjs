const EVENT_NAMES = Object.freeze([
    'onBeforeRequest',
    'onHeadersReceived',
    'onBeforeRedirect',
    'onCompleted',
    'onErrorOccurred'
]);
const MAX_RETAINED_EVENTS = 64;

class HarnessEvent {
    constructor(harness, name) {
        this.harness = harness;
        this.name = name;
        this.listeners = new Map();
    }

    addListener(listener, filter, extraInfoSpec) {
        if (this.listeners.has(listener)) {
            throw new Error('Duplicate harness listener');
        }
        this.listeners.set(listener, {
            filter: filter ? JSON.parse(JSON.stringify(filter)) : null,
            extraInfoSpec: Array.isArray(extraInfoSpec) ? [...extraInfoSpec] : null
        });
    }

    removeListener(listener) {
        this.listeners.delete(listener);
    }

    hasListener(listener) {
        return this.listeners.has(listener);
    }

    emit(details) {
        this.harness.recordEvent(this.name);
        for (const listener of this.listeners.keys()) {
            listener({ ...details });
        }
    }

    snapshot() {
        return {
            listenerCount: this.listeners.size,
            registrations: [...this.listeners.values()].map((registration) => ({
                filter: registration.filter ? JSON.parse(JSON.stringify(registration.filter)) : null,
                extraInfoSpec: registration.extraInfoSpec ? [...registration.extraInfoSpec] : null
            }))
        };
    }
}

export default class ApiTestHarness {
    constructor() {
        this.now = 0;
        this.retainedEvents = [];
        this.delayedOperations = new Map();
        this.events = new Map(EVENT_NAMES.map((name) => [name, new HarnessEvent(this, name)]));
        this.webRequestApi = Object.fromEntries(this.events);
    }

    createWebRequestApi() {
        return this.webRequestApi;
    }

    emit(eventName, details) {
        const event = this.events.get(eventName);
        if (!event) {
            throw new Error('Unknown harness event');
        }
        event.emit(details);
    }

    advanceTime(milliseconds) {
        if (!Number.isInteger(milliseconds) || milliseconds < 0) {
            throw new Error('Harness time must advance by a non-negative integer');
        }
        this.now += milliseconds;
        return this.now;
    }

    delayOperation(name) {
        if (typeof name !== 'string' || name.length === 0) {
            throw new Error('Harness operation name is required');
        }
        if (this.delayedOperations.has(name)) {
            return this.delayedOperations.get(name).promise;
        }
        let release;
        const promise = new Promise((resolve) => {
            release = resolve;
        });
        this.delayedOperations.set(name, { promise, release });
        return promise;
    }

    releaseOperation(name) {
        const operation = this.delayedOperations.get(name);
        if (!operation) {
            return false;
        }
        this.delayedOperations.delete(name);
        operation.release();
        return true;
    }

    getListenerSnapshot() {
        return Object.freeze(Object.fromEntries(
            [...this.events.entries()].map(([name, event]) => [name, event.snapshot()])
        ));
    }

    getRuntimeSnapshot() {
        return Object.freeze({
            now: this.now,
            retainedEventCount: this.retainedEvents.length,
            delayedOperationNames: Object.freeze([...this.delayedOperations.keys()])
        });
    }

    recordEvent(eventName) {
        this.retainedEvents.push(eventName);
        if (this.retainedEvents.length > MAX_RETAINED_EVENTS) {
            this.retainedEvents.shift();
        }
    }
}

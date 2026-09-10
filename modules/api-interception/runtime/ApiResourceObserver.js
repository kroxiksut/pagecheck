import {
    createNormalizedObservation,
    extractDeclaredContentType,
    normalizeDeclaredMime,
    normalizeRequestMethod,
    normalizeResponseStatus
} from './apiMetadataNormalization.js';

const RESOURCE_TYPES = ['xmlhttprequest', 'image'];
const MAX_ACTIVE_RECORDS = 256;
const MAX_COMPLETED_QUEUE = 256;
const MAX_OBSERVATION_RING = 128;
const MAX_BATCH_WORK = 64;
const MAX_REDIRECTS = 8;
const BATCH_BUDGET_MS = 10;
const STATUS_PUBLISH_INTERVAL_MS = 500;

export default class ApiResourceObserver {
    constructor({
        webRequest = globalThis.chrome?.webRequest,
        clock = () => Date.now(),
        onStateChange = null,
        onObservationBatch = null
    } = {}) {
        // Раньше здесь фиксировалось ЗНАЧЕНИЕ chrome.webRequest на момент инициализации service
        // worker. Разрешение опциональное и модуль выключен по умолчанию, поэтому при чистом старте
        // это значение - undefined, и оно сохранялось навсегда: после выдачи разрешения Chrome
        // добавляет chrome.webRequest в namespace, но наблюдатель держал устаревшую ссылку и до
        // перезапуска SW отдавал status: 'unavailable' (TASKS 13.2). Инъекция сохраняется для
        // тестов, а рабочий путь резолвится лениво - в момент обращения.
        this.injectedWebRequest = webRequest || null;
        this.clock = clock;
        this.onStateChange = typeof onStateChange === 'function' ? onStateChange : null;
        this.onObservationBatch = typeof onObservationBatch === 'function' ? onObservationBatch : null;
        this.lifecycleState = 'inactive';
        this.lifecycleRevision = 0;
        this.activeSession = null;
        this.activeRecords = new Map();
        this.completedQueue = [];
        this.observationRing = [];
        this.batchTimer = null;
        this.statusTimer = null;
        this.lastStatusPublicationAt = 0;
        this.partial = false;
        this.observerUnavailable = false;
        this.counters = this.createCounters();
        this.listeners = null;
    }

    get webRequest() {
        return this.injectedWebRequest || globalThis.chrome?.webRequest || globalThis.browser?.webRequest || null;
    }

    activate(context) {
        const revision = this.normalizeRevision(context?.revision);
        if (this.lifecycleState === 'destroyed' || revision < this.lifecycleRevision) {
            return false;
        }
        if (this.lifecycleState === 'active'
            && this.activeSession?.tabId === context?.tabId
            && this.activeSession?.revision === revision
            && this.isActivatableContext(context)) {
            return true;
        }

        this.lifecycleRevision = revision;
        this.unregisterListeners();
        this.clearSession();
        if (!this.isActivatableContext(context)) {
            this.observerUnavailable = !this.isWebRequestAvailable();
            this.lifecycleState = 'inactive';
            this.publishState();
            return false;
        }

        this.lifecycleState = 'activating';
        this.activeSession = { tabId: context.tabId, revision };
        try {
            this.registerListeners(context.tabId);
            if (!this.isCurrentSession(context.tabId, revision)) {
                this.unregisterListeners();
                this.clearSession();
                this.lifecycleState = 'inactive';
                return false;
            }
            this.observerUnavailable = false;
            this.lifecycleState = 'active';
            this.publishState();
            return true;
        } catch {
            this.unregisterListeners();
            this.clearSession();
            this.observerUnavailable = true;
            this.lifecycleState = 'inactive';
            this.counters.registrationFailures += 1;
            this.publishState();
            return false;
        }
    }

    pause(revision) {
        if (this.lifecycleState === 'destroyed') {
            return;
        }
        this.lifecycleRevision = Math.max(this.lifecycleRevision, this.normalizeRevision(revision));
        this.lifecycleState = 'pausing';
        this.unregisterListeners();
        this.clearSession();
        // observerUnavailable писался только в activate(), поэтому после одной неудачной активации
        // каждая последующая пауза публиковала 'unavailable' вместо 'not-observed' - наблюдатель
        // выглядел сломанным, когда он просто простаивает (TASKS 13.7). Пересчитываем по факту:
        // «недоступен сейчас», а не «когда-то не удалось активировать».
        this.observerUnavailable = !this.isWebRequestAvailable();
        this.lifecycleState = 'inactive';
        this.publishState();
    }

    destroy() {
        if (this.lifecycleState === 'destroyed') {
            return;
        }
        this.lifecycleRevision += 1;
        this.unregisterListeners();
        this.clearSession();
        this.lifecycleState = 'destroyed';
        this.publishState();
    }

    getObservationState() {
        const partial = this.partial === true;
        return {
            revision: this.lifecycleRevision,
            status: this.observerUnavailable
                ? 'unavailable'
                : this.lifecycleState === 'active'
                    ? (partial ? 'partial' : 'active')
                    : 'not-observed',
            partial,
            counters: {
                acceptedEvents: this.counters.acceptedEvents,
                completedObservations: this.counters.completedObservations,
                orphanEvents: this.counters.orphanEvents,
                normalizationErrors: this.counters.normalizationErrors,
                decisionErrors: this.counters.decisionErrors
            },
            overflowCounters: {
                activeRecords: this.counters.activeRecordOverflow,
                completedQueue: this.counters.completedQueueOverflow,
                redirects: this.counters.redirectOverflow,
                batchBudget: this.counters.batchBudgetOverflow,
                registration: this.counters.registrationFailures
            }
        };
    }

    createCounters() {
        return {
            acceptedEvents: 0,
            completedObservations: 0,
            orphanEvents: 0,
            normalizationErrors: 0,
            decisionErrors: 0,
            activeRecordOverflow: 0,
            completedQueueOverflow: 0,
            redirectOverflow: 0,
            batchBudgetOverflow: 0,
            registrationFailures: 0
        };
    }

    isActivatableContext(context) {
        return Number.isInteger(context?.tabId)
            && context.tabId >= 0
            && context.enabled === true
            && context.autoScan !== false
            && context.monitorOnly === true
            && this.isWebRequestAvailable();
    }

    isWebRequestAvailable() {
        return this.webRequest
            && typeof this.webRequest.onBeforeRequest?.addListener === 'function'
            && typeof this.webRequest.onHeadersReceived?.addListener === 'function'
            && typeof this.webRequest.onBeforeRedirect?.addListener === 'function'
            && typeof this.webRequest.onCompleted?.addListener === 'function'
            && typeof this.webRequest.onErrorOccurred?.addListener === 'function';
    }

    normalizeRevision(value) {
        return Number.isInteger(value) && value >= 0 ? value : this.lifecycleRevision + 1;
    }

    isCurrentSession(tabId, revision) {
        return this.lifecycleState === 'activating' || this.lifecycleState === 'active'
            ? this.activeSession?.tabId === tabId && this.activeSession?.revision === revision
            : false;
    }

    registerListeners(tabId) {
        if (!this.webRequest?.onBeforeRequest
            || !this.webRequest?.onHeadersReceived
            || !this.webRequest?.onBeforeRedirect
            || !this.webRequest?.onCompleted
            || !this.webRequest?.onErrorOccurred) {
            throw new Error('webRequest observation API is unavailable');
        }

        const filter = { urls: ['<all_urls>'], types: RESOURCE_TYPES, tabId };
        const listeners = {
            beforeRequest: (details) => this.handleBeforeRequest(details),
            headersReceived: (details) => this.handleHeadersReceived(details),
            beforeRedirect: (details) => this.handleBeforeRedirect(details),
            completed: (details) => this.handleCompleted(details),
            errorOccurred: (details) => this.handleErrorOccurred(details)
        };

        this.listeners = listeners;
        this.webRequest.onBeforeRequest.addListener(listeners.beforeRequest, filter);
        this.webRequest.onHeadersReceived.addListener(listeners.headersReceived, filter, ['responseHeaders']);
        this.webRequest.onBeforeRedirect.addListener(listeners.beforeRedirect, filter);
        this.webRequest.onCompleted.addListener(listeners.completed, filter);
        this.webRequest.onErrorOccurred.addListener(listeners.errorOccurred, filter);
    }

    unregisterListeners() {
        if (!this.listeners) {
            return;
        }
        const listeners = this.listeners;
        this.listeners = null;
        this.webRequest?.onBeforeRequest?.removeListener(listeners.beforeRequest);
        this.webRequest?.onHeadersReceived?.removeListener(listeners.headersReceived);
        this.webRequest?.onBeforeRedirect?.removeListener(listeners.beforeRedirect);
        this.webRequest?.onCompleted?.removeListener(listeners.completed);
        this.webRequest?.onErrorOccurred?.removeListener(listeners.errorOccurred);
    }

    clearSession() {
        if (this.batchTimer !== null) {
            clearTimeout(this.batchTimer);
            this.batchTimer = null;
        }
        if (this.statusTimer !== null) {
            clearTimeout(this.statusTimer);
            this.statusTimer = null;
        }
        this.activeSession = null;
        this.activeRecords.clear();
        this.completedQueue.length = 0;
        this.observationRing.length = 0;
        this.partial = false;
        this.counters = this.createCounters();
    }

    acceptsEvent(details) {
        return this.lifecycleState === 'active'
            && this.activeSession
            && details?.tabId === this.activeSession.tabId
            && details?.frameId === 0
            && RESOURCE_TYPES.includes(details?.type);
    }

    handleBeforeRequest(details) {
        if (!this.acceptsEvent(details)) {
            return;
        }
        if (typeof details.requestId !== 'string' && typeof details.requestId !== 'number') {
            this.noteOrphanEvent();
            return;
        }
        if (this.activeRecords.has(details.requestId)) {
            return;
        }
        if (this.activeRecords.size >= MAX_ACTIVE_RECORDS) {
            this.counters.activeRecordOverflow += 1;
            this.markPartial();
            return;
        }
        this.activeRecords.set(details.requestId, {
            resourceType: details.type,
            method: normalizeRequestMethod(details.method),
            responseStatus: null,
            declaredMime: { state: 'missing', mime: null },
            completed: false,
            networkError: false,
            redirected: false,
            fromCache: false,
            redirectCount: 0,
            sessionRevision: this.activeSession.revision
        });
        this.counters.acceptedEvents += 1;
    }

    handleHeadersReceived(details) {
        const record = this.getActiveRecord(details);
        if (!record) {
            return;
        }
        record.responseStatus = normalizeResponseStatus(details.statusCode);
        const contentType = extractDeclaredContentType(details.responseHeaders);
        record.declaredMime = normalizeDeclaredMime(contentType);
    }

    handleBeforeRedirect(details) {
        const record = this.getActiveRecord(details);
        if (!record) {
            return;
        }
        if (record.redirectCount >= MAX_REDIRECTS) {
            this.counters.redirectOverflow += 1;
            this.activeRecords.delete(details.requestId);
            this.markPartial();
            return;
        }
        record.redirectCount += 1;
        record.redirected = true;
        record.responseStatus = null;
        record.declaredMime = { state: 'missing', mime: null };
    }

    handleCompleted(details) {
        const record = this.takeActiveRecord(details);
        if (!record) {
            return;
        }
        record.completed = true;
        record.networkError = false;
        record.fromCache = details.fromCache === true;
        this.enqueueObservation(record);
    }

    handleErrorOccurred(details) {
        const record = this.takeActiveRecord(details);
        if (!record) {
            return;
        }
        record.completed = false;
        record.networkError = true;
        this.enqueueObservation(record);
    }

    getActiveRecord(details) {
        if (!this.acceptsEvent(details)) {
            return null;
        }
        const record = this.activeRecords.get(details.requestId);
        if (!record || record.sessionRevision !== this.activeSession.revision) {
            this.noteOrphanEvent();
            return null;
        }
        return record;
    }

    takeActiveRecord(details) {
        const record = this.getActiveRecord(details);
        if (record) {
            this.activeRecords.delete(details.requestId);
        }
        return record;
    }

    enqueueObservation(record) {
        const observation = createNormalizedObservation(record);
        if (!observation) {
            this.counters.normalizationErrors += 1;
            this.markPartial();
            return;
        }
        if (this.completedQueue.length >= MAX_COMPLETED_QUEUE) {
            this.counters.completedQueueOverflow += 1;
            this.markPartial();
            return;
        }
        this.completedQueue.push(observation);
        this.scheduleBatch();
    }

    scheduleBatch() {
        if (this.batchTimer !== null || this.lifecycleState !== 'active') {
            return;
        }
        this.batchTimer = setTimeout(() => {
            this.batchTimer = null;
            this.processCompletedBatch();
        }, 0);
    }

    processCompletedBatch() {
        if (this.lifecycleState !== 'active') {
            return;
        }
        const deadline = this.clock() + BATCH_BUDGET_MS;
        let processed = 0;
        const observationBatch = [];
        while (this.completedQueue.length > 0 && processed < MAX_BATCH_WORK && this.clock() <= deadline) {
            const observation = this.completedQueue.shift();
            this.observationRing.push(observation);
            if (this.observationRing.length > MAX_OBSERVATION_RING) {
                this.observationRing.shift();
            }
            this.counters.completedObservations += 1;
            observationBatch.push(observation);
            processed += 1;
        }
        this.publishObservationBatch(observationBatch);
        if (this.completedQueue.length > 0) {
            if (processed < MAX_BATCH_WORK) {
                this.counters.batchBudgetOverflow += 1;
                this.markPartial();
            }
            this.scheduleBatch();
        }
        this.publishState();
    }

    publishObservationBatch(observations) {
        if (!this.onObservationBatch || observations.length === 0 || !this.activeSession) {
            return;
        }
        const batch = Object.freeze(observations.map((observation) => Object.freeze({ ...observation })));
        const context = Object.freeze({
            sessionRevision: this.activeSession.revision,
            partial: this.partial === true
        });
        try {
            this.onObservationBatch(batch, context);
        } catch {
            this.counters.decisionErrors += 1;
            this.markPartial();
        }
    }

    noteOrphanEvent() {
        this.counters.orphanEvents += 1;
        this.markPartial();
    }

    markPartial() {
        this.partial = true;
        this.publishState();
    }

    publishState() {
        if (!this.onStateChange || this.lifecycleState === 'destroyed') {
            return;
        }
        const now = this.clock();
        const wait = Math.max(0, STATUS_PUBLISH_INTERVAL_MS - (now - this.lastStatusPublicationAt));
        if (wait === 0) {
            this.lastStatusPublicationAt = now;
            try {
                this.onStateChange(this.getObservationState());
            } catch {
                // Status publication is passive; callback failures must not affect observation cleanup.
            }
            return;
        }
        if (this.statusTimer === null) {
            this.statusTimer = setTimeout(() => {
                this.statusTimer = null;
                this.publishState();
            }, wait);
        }
    }
}

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

class FakeEvent {
    constructor() {
        this.listeners = new Set();
    }

    addListener(listener) {
        this.listeners.add(listener);
    }

    removeListener(listener) {
        this.listeners.delete(listener);
    }

    emit(...args) {
        for (const listener of this.listeners) {
            listener(...args);
        }
    }
}

function callbackStorageArea() {
    const writes = [];
    return {
        writes,
        get(_keys, callback) {
            if (typeof callback === 'function') {
                callback({});
                return;
            }
            return Promise.resolve({});
        },
        set(_values, callback) {
            writes.push(_values);
            if (typeof callback === 'function') {
                callback();
                return;
            }
            return Promise.resolve();
        },
        remove(_keys, callback) {
            if (typeof callback === 'function') {
                callback();
                return;
            }
            return Promise.resolve();
        }
    };
}

function createFakeChrome() {
    let apiPermissionGranted = true;
    const webRequest = {
        onBeforeRequest: new FakeEvent(),
        onHeadersReceived: new FakeEvent(),
        onBeforeRedirect: new FakeEvent(),
        onCompleted: new FakeEvent(),
        onErrorOccurred: new FakeEvent()
    };
    return {
        webRequest,
        windows: {
            WINDOW_ID_NONE: -1,
            onFocusChanged: new FakeEvent(),
            async getLastFocused() {
                return { id: 1, focused: true };
            },
            async get(windowId) {
                return { id: windowId, focused: true };
            }
        },
        tabs: {
            onUpdated: new FakeEvent(),
            onRemoved: new FakeEvent(),
            onActivated: new FakeEvent(),
            async query(query) {
                if (query?.active) {
                    return [{ id: 7, windowId: 1, url: 'https://example.test/' }];
                }
                return Array.from({ length: 50 }, (_value, index) => ({
                    id: index + 7,
                    windowId: index % 2 === 0 ? 1 : 2,
                    url: `https://restored-${index}.example.test/`
                }));
            },
            async sendMessage() {
                return { success: true };
            }
        },
        webNavigation: {
            onCommitted: new FakeEvent()
        },
        runtime: {
            onMessage: new FakeEvent(),
            onInstalled: new FakeEvent(),
            getManifest() {
                return { version: 'test' };
            }
        },
        permissions: {
            onAdded: new FakeEvent(),
            onRemoved: new FakeEvent(),
            async contains() {
                return apiPermissionGranted;
            },
            async remove() {
                apiPermissionGranted = false;
                return true;
            },
            _setGranted(value) {
                apiPermissionGranted = value === true;
            }
        },
        storage: {
            onChanged: new FakeEvent(),
            sync: callbackStorageArea(),
            local: callbackStorageArea(),
            session: callbackStorageArea()
        },
        action: {
            setBadgeText: async () => {},
            setBadgeBackgroundColor: async () => {},
            setBadgeTextColor: async () => {}
        },
        notifications: {
            create: async () => {},
            clear: async () => {}
        },
        i18n: {
            getMessage: () => ''
        }
    };
}

globalThis.__PAGECHECK_BACKGROUND_TEST__ = true;
globalThis.chrome = createFakeChrome();
const { BackgroundManager } = await import(new URL('../../../js/background.js', import.meta.url));
const contentRuntimeSource = await readFile(new URL('../../../js/content.js', import.meta.url), 'utf8');
const manager = new BackgroundManager();
await new Promise((resolve) => setTimeout(resolve, 0));

const apiModuleId = 'Api-Interceptor';
chrome.permissions._setGranted(true);
const initialEnable = await manager.handleApiPermissionBegin();
const initialCommit = await manager.handleApiPermissionCommit(initialEnable.transactionId, true);
assert.equal(initialCommit.success, true);
assert.equal(manager.config.modules[apiModuleId].enabled, true);
manager.activeTabs.set(7, { url: 'https://example.test/', modules: [], lastUpdated: Date.now() });
manager.activeTabs.set(8, { url: 'https://second.example.test/', modules: [], lastUpdated: Date.now() });
manager.foregroundTabId = null;
manager.focusedWindowId = chrome.windows.WINDOW_ID_NONE;
manager.foregroundTransitionRevision += 1;
await manager.setForegroundTab(7, 1, manager.foregroundTransitionRevision);

assert.equal(chrome.webRequest.onBeforeRequest.listeners.size, 1);
assert.equal(manager.getEnabledModulesForUrl('https://example.test/').includes(apiModuleId), false);
assert.equal(manager.getModuleState(apiModuleId).observation.status, 'active');

const privacySentinel = 'background-cache-sentinel-must-not-store';
chrome.webRequest.onBeforeRequest.emit({
    tabId: 7,
    frameId: 0,
    type: 'image',
    requestId: privacySentinel,
    method: 'POST',
    url: `https://example.test/?${privacySentinel}`,
    requestBody: { formData: { password: [privacySentinel] } }
});
chrome.webRequest.onHeadersReceived.emit({
    tabId: 7,
    frameId: 0,
    type: 'image',
    requestId: privacySentinel,
    statusCode: 200,
    responseHeaders: [{ name: 'Content-Type', value: `image/png; marker=${privacySentinel}` }]
});
chrome.webRequest.onCompleted.emit({
    tabId: 7,
    frameId: 0,
    type: 'image',
    requestId: privacySentinel
});
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(JSON.stringify(manager.getModuleState(apiModuleId)).includes(privacySentinel), false);
await manager.persistPageStatusCache();
assert.equal(JSON.stringify(chrome.storage.session.writes.at(-1)).includes(privacySentinel), false);

chrome.webRequest.onBeforeRequest.emit({
    tabId: 7,
    frameId: 0,
    type: 'image',
    requestId: 'candidate-document-image',
    method: 'GET'
});
chrome.webRequest.onHeadersReceived.emit({
    tabId: 7,
    frameId: 0,
    type: 'image',
    requestId: 'candidate-document-image',
    statusCode: 200,
    responseHeaders: [{ name: 'Content-Type', value: 'text/html' }]
});
chrome.webRequest.onCompleted.emit({
    tabId: 7,
    frameId: 0,
    type: 'image',
    requestId: 'candidate-document-image'
});
await new Promise((resolve) => setTimeout(resolve, 0));
const candidateSnapshot = manager.apiFindingState.getCandidateSnapshot();
assert.deepEqual(candidateSnapshot.candidates, [{
    type: 'image-resource-declared-mime-anomaly',
    category: 'document',
    severity: 'low',
    occurrenceCount: 1
}]);
assert.deepEqual(manager.apiFindingState.getProductSnapshot().findings, []);
assert.equal('candidate' in manager.getModuleState(apiModuleId), false);
assert.equal(contentRuntimeSource.includes('apiMimeDecision'), false);
assert.equal(contentRuntimeSource.includes('ApiFindingState'), false);
assert.equal(JSON.stringify(manager.pageStatusByTab).includes('image-resource-declared-mime-anomaly'), false);
await manager.persistPageStatusCache();
assert.equal(JSON.stringify(chrome.storage.session.writes.at(-1)).includes('image-resource-declared-mime-anomaly'), false);
await manager.applyConfigToAllTabs(manager.config, manager.config);
assert.deepEqual(manager.apiFindingState.getCandidateSnapshot().candidates, []);
assert.equal(chrome.webRequest.onBeforeRequest.listeners.size, 1);

chrome.webRequest.onBeforeRequest.emit({
    tabId: 7,
    frameId: 0,
    type: 'image',
    requestId: 'old-tab-request',
    method: 'GET'
});
assert.equal(manager.apiResourceObserver.activeRecords.size, 1);

manager.foregroundTransitionRevision += 1;
await manager.setForegroundTab(8, 1, manager.foregroundTransitionRevision);
assert.equal(chrome.webRequest.onBeforeRequest.listeners.size, 1);
assert.equal(manager.apiResourceObserver.activeRecords.size, 0);
assert.deepEqual(manager.apiFindingState.getCandidateSnapshot().candidates, []);

chrome.webRequest.onBeforeRequest.emit({
    tabId: 7,
    frameId: 0,
    type: 'image',
    requestId: 'background-request',
    method: 'GET'
});
assert.equal(manager.apiResourceObserver.activeRecords.size, 0);

const killSwitchSentinel = 'kill-switch-pending-work-must-not-persist';
chrome.webRequest.onBeforeRequest.emit({
    tabId: 8,
    frameId: 0,
    type: 'image',
    requestId: killSwitchSentinel,
    method: 'GET'
});
assert.equal(manager.apiResourceObserver.activeRecords.size, 1);
chrome.webRequest.onHeadersReceived.emit({
    tabId: 8,
    frameId: 0,
    type: 'image',
    requestId: killSwitchSentinel,
    statusCode: 200,
    responseHeaders: [{ name: 'Content-Type', value: 'text/html' }]
});
chrome.webRequest.onCompleted.emit({
    tabId: 8,
    frameId: 0,
    type: 'image',
    requestId: killSwitchSentinel
});
assert.equal(manager.apiResourceObserver.completedQueue.length, 1);
manager.schedulePageStatusCacheWrite();
assert.notEqual(manager.pageStatusCacheWriteTimer, null);
const disabledPermission = await manager.handleApiPermissionDisable();
assert.equal(disabledPermission.success, true);
assert.equal(chrome.webRequest.onBeforeRequest.listeners.size, 0);
assert.equal(manager.config.modules[apiModuleId].enabled, false);
assert.equal(manager.getModuleState(apiModuleId).permission.capability, 'missing');
assert.equal(manager.getModuleState(apiModuleId).observation.status, 'not-observed');
assert.equal(manager.apiResourceObserver.activeRecords.size, 0);
assert.equal(manager.apiResourceObserver.completedQueue.length, 0);
assert.deepEqual(manager.apiFindingState.getCandidateSnapshot().candidates, []);
await manager.persistPageStatusCache();
assert.equal(JSON.stringify(chrome.storage.session.writes.at(-1)).includes(killSwitchSentinel), false);

chrome.permissions._setGranted(true);
const enablePermission = await manager.handleApiPermissionBegin();
const enabledPermission = await manager.handleApiPermissionCommit(enablePermission.transactionId, true);
assert.equal(enabledPermission.success, true);
assert.equal(chrome.webRequest.onBeforeRequest.listeners.size, 1);
manager.handleNavigation(8, 'https://second.example.test/next');
assert.equal(chrome.webRequest.onBeforeRequest.listeners.size, 0);

manager.config.settings.autoScan = false;
manager.syncApiObserverForForeground(manager.foregroundTransitionRevision);
assert.equal(chrome.webRequest.onBeforeRequest.listeners.size, 0);

manager.config.settings.autoScan = true;
manager.focusedWindowId = chrome.windows.WINDOW_ID_NONE;
manager.syncApiObserverForForeground(manager.foregroundTransitionRevision);
assert.equal(chrome.webRequest.onBeforeRequest.listeners.size, 0);

await manager.handleScanPage(8);
assert.equal(chrome.webRequest.onBeforeRequest.listeners.size, 0);

manager.config.modules[apiModuleId].enabled = true;
manager.config.settings.autoScan = true;
manager.foregroundTabId = 8;
manager.focusedWindowId = 1;
manager.syncApiObserverForForeground(manager.foregroundTransitionRevision);
assert.equal(chrome.webRequest.onBeforeRequest.listeners.size, 1);

manager.activeTabs.set(9, { url: 'https://third.example.test/', modules: [], lastUpdated: Date.now() });
const pendingLifecycleMessages = [];
chrome.tabs.sendMessage = () => new Promise((resolve) => {
    pendingLifecycleMessages.push(resolve);
});
const staleTransition = manager.enqueueForegroundTransition(
    (revision) => manager.setForegroundTab(8, 1, revision)
);
assert.equal(chrome.webRequest.onBeforeRequest.listeners.size, 0);
const latestTransition = manager.enqueueForegroundTransition(
    (revision) => manager.setForegroundTab(9, 1, revision)
);
assert.equal(chrome.webRequest.onBeforeRequest.listeners.size, 0);

for (let iteration = 0; iteration < 4; iteration += 1) {
    const pending = pendingLifecycleMessages.splice(0);
    for (const resolve of pending) {
        resolve({ success: true });
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
}
await Promise.all([staleTransition, latestTransition]);
assert.equal(manager.foregroundTabId, 9);
assert.equal(chrome.webRequest.onBeforeRequest.listeners.size, 1);
assert.equal(manager.apiResourceObserver.activeSession.tabId, 9);

manager.apiResourceObserver.destroy();
assert.equal(chrome.webRequest.onBeforeRequest.listeners.size, 0);
chrome.storage.session.get = (_keys, callback) => {
    const obsoleteCache = {
        pagecheckPageStatusCache: {
            schemaVersion: 6,
            tabs: {
                '7': {
                    status: 'issues',
                    totalFindings: 1,
                    frames: [{
                        frameId: 0,
                        findings: [{ type: 'api-surface', summary: 'legacy-api-snapshot-must-not-restore' }]
                    }]
                }
            }
        }
    };
    if (typeof callback === 'function') {
        callback(obsoleteCache);
        return;
    }
    return Promise.resolve(obsoleteCache);
};
const reloadedManager = new BackgroundManager();
await new Promise((resolve) => setTimeout(resolve, 0));
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(reloadedManager.activeTabs.size, 50);
assert.equal(reloadedManager.pageStatusByTab.size, 50);
assert.equal(JSON.stringify(reloadedManager.pageStatusByTab).includes('legacy-api-snapshot-must-not-restore'), false);
assert.equal(Array.from(reloadedManager.pageStatusByTab.values()).every((status) => (
    status.status === 'clean' && status.totalFindings === 0 && status.frames.size === 0
)), true);
assert.equal(reloadedManager.foregroundTabId, 7);
assert.equal(chrome.webRequest.onBeforeRequest.listeners.size, 1);
assert.equal(reloadedManager.apiResourceObserver.activeSession.tabId, 7);

chrome.permissions._setGranted(false);
chrome.permissions.onRemoved.emit({ permissions: ['webRequest'] });
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(chrome.webRequest.onBeforeRequest.listeners.size, 0);
assert.equal(reloadedManager.config.modules[apiModuleId].enabled, true);
assert.equal(reloadedManager.getModuleState(apiModuleId).permission.capability, 'missing');

chrome.permissions._setGranted(true);
chrome.permissions.onAdded.emit({ permissions: ['webRequest'] });
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(chrome.webRequest.onBeforeRequest.listeners.size, 1);

reloadedManager.apiResourceObserver.destroy();
chrome.webRequest = null;
const unavailableManager = new BackgroundManager();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(unavailableManager.getModuleState(apiModuleId).observation.status, 'unavailable');
assert.equal(unavailableManager.getEnabledModulesForUrl('https://example.test/').includes(apiModuleId), false);

console.log('ApiResourceObserver background integration checks passed');

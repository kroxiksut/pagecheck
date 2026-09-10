// Щит для C2: старт браузера, восстановление сессии и перезапуск service worker НЕ БУДЯТ вкладки.
// Это корень инцидента с 54 вкладками: активная вкладка есть в каждом окне, включая свёрнутые и
// фоновые, поэтому `tabs.Tab.active` в роли разрешения означает «работают все окна сразу».
// Правило живёт в одном именованном месте - BackgroundManager.isForegroundScanAllowed() - и этот
// тест проверяет именно наблюдаемое следствие: сколько вкладок получило команду работать.
// Запуск: node js/startupNoScan.test.mjs

import assert from 'node:assert/strict';

function createEventSource() {
    const listeners = [];
    return {
        listeners,
        addListener: (listener) => listeners.push(listener),
        emit: (...args) => listeners.map((listener) => listener(...args))
    };
}

const storageAreas = { sync: new Map(), local: new Map(), session: new Map() };

function createStorageArea(name) {
    return {
        get(keys, callback) {
            const list = Array.isArray(keys) ? keys : [keys];
            const result = {};
            for (const key of list) {
                if (storageAreas[name].has(key)) {
                    result[key] = JSON.parse(JSON.stringify(storageAreas[name].get(key)));
                }
            }
            if (typeof callback === 'function') {
                callback(result);
                return undefined;
            }
            return Promise.resolve(result);
        },
        set(values, callback) {
            for (const [key, value] of Object.entries(values)) {
                storageAreas[name].set(key, JSON.parse(JSON.stringify(value)));
            }
            if (typeof callback === 'function') {
                callback();
                return undefined;
            }
            return Promise.resolve();
        },
        remove(keys, callback) {
            for (const key of Array.isArray(keys) ? keys : [keys]) {
                storageAreas[name].delete(key);
            }
            if (typeof callback === 'function') {
                callback();
                return undefined;
            }
            return Promise.resolve();
        }
    };
}

// --- восстановленная сессия: 54 вкладки в трёх окнах ---------------------------------------------
// Ровно та форма, на которой всё и произошло. В каждом окне есть своя активная вкладка.

const WINDOW_IDS = [10, 20, 30];
const FOCUSED_WINDOW_ID = 10;
const tabsById = new Map();
let nextTabId = 1;
for (const windowId of WINDOW_IDS) {
    for (let index = 0; index < 18; index += 1) {
        const id = nextTabId++;
        tabsById.set(id, {
            id,
            url: `https://example.com/window-${windowId}/tab-${index}`,
            active: index === 0,
            windowId
        });
    }
}
const FOREGROUND_TAB_ID = [...tabsById.values()]
    .find((tab) => tab.windowId === FOCUSED_WINDOW_ID && tab.active).id;

assert.equal(tabsById.size, 54, 'стенд обязан воспроизводить именно масштаб инцидента');

const sentTabMessages = [];

const events = {
    onMessage: createEventSource(),
    onMessageExternal: createEventSource(),
    onInstalled: createEventSource(),
    onTabUpdated: createEventSource(),
    onTabRemoved: createEventSource(),
    onTabActivated: createEventSource(),
    onWindowFocusChanged: createEventSource(),
    onCommitted: createEventSource(),
    onStorageChanged: createEventSource(),
    onPermissionAdded: createEventSource(),
    onPermissionRemoved: createEventSource()
};

globalThis.chrome = {
    runtime: {
        lastError: undefined,
        id: 'abcdefghijklmnopabcdefghijklmnop',
        getManifest: () => ({ version: '0.0.1' }),
        getURL: (path) => `chrome-extension://test/${path}`,
        onMessage: events.onMessage,
        onMessageExternal: events.onMessageExternal,
        onInstalled: events.onInstalled
    },
    storage: {
        sync: createStorageArea('sync'),
        local: createStorageArea('local'),
        session: createStorageArea('session'),
        onChanged: events.onStorageChanged
    },
    tabs: {
        onUpdated: events.onTabUpdated,
        onRemoved: events.onTabRemoved,
        onActivated: events.onTabActivated,
        query: async (query) => [...tabsById.values()].filter((tab) => {
            if (query.active === true && tab.active !== true) return false;
            if (query.windowId !== undefined && tab.windowId !== query.windowId) return false;
            return true;
        }),
        get: async (tabId) => {
            const tab = tabsById.get(tabId);
            if (!tab) {
                throw new Error(`No tab with id: ${tabId}`);
            }
            return tab;
        },
        sendMessage: async (tabId, message) => {
            if (!Number.isInteger(tabId)) {
                throw new TypeError('Error in invocation of tabs.sendMessage: tabId must be an integer');
            }
            sentTabMessages.push({ tabId, message });
            return { success: true };
        }
    },
    windows: {
        WINDOW_ID_NONE: -1,
        onFocusChanged: events.onWindowFocusChanged,
        get: async (windowId) => ({ id: windowId, focused: windowId === FOCUSED_WINDOW_ID }),
        getLastFocused: async () => ({ id: FOCUSED_WINDOW_ID, focused: true })
    },
    webNavigation: { onCommitted: events.onCommitted },
    permissions: {
        onAdded: events.onPermissionAdded,
        onRemoved: events.onPermissionRemoved,
        contains: async () => false,
        remove: async () => true
    },
    action: {
        setBadgeText: async () => {},
        setBadgeBackgroundColor: async () => {},
        setBadgeTextColor: async () => {}
    },
    notifications: { create: () => {}, clear: () => {} },
    i18n: { getMessage: () => '' }
};

const quietConsole = { ...console };
for (const level of ['info', 'warn', 'debug', 'error']) {
    console[level] = () => {};
}

globalThis.__PAGECHECK_BACKGROUND_TEST__ = true;
const { BackgroundManager } = await import('./background.js');
Object.assign(console, quietConsole);

function settle(rounds = 16) {
    let chain = Promise.resolve();
    for (let index = 0; index < rounds; index += 1) {
        chain = chain.then(() => undefined);
    }
    return chain;
}

function activations() {
    return sentTabMessages.filter(
        (entry) => entry.message?.action === 'setPageLifecycle' && entry.message?.state === 'active'
    );
}

// --- 1. Холодный старт при восстановленной сессии ------------------------------------------------

const manager = new BackgroundManager();
await manager.whenReady();
await settle();

const activatedTabIds = new Set(activations().map((entry) => entry.tabId));
assert.equal(
    activatedTabIds.size <= 1,
    true,
    `старт обязан разбудить не больше одной вкладки, разбужено: ${activatedTabIds.size} (${[...activatedTabIds]})`
);
if (activatedTabIds.size === 1) {
    assert.equal(
        [...activatedTabIds][0],
        FOREGROUND_TAB_ID,
        'разбужена может быть только активная вкладка сфокусированного окна'
    );
}

// Вкладки других окон - в том числе активные в своих окнах - работать не начинают.
for (const tab of tabsById.values()) {
    if (tab.id === FOREGROUND_TAB_ID) continue;
    assert.equal(
        activatedTabIds.has(tab.id),
        false,
        `вкладка ${tab.id} окна ${tab.windowId} не имеет права работать: она активна в своём окне, но окно не в фокусе`
    );
}

// --- 2. Правило записано в одном месте и отвечает то же самое -------------------------------------

assert.equal(typeof manager.isForegroundScanAllowed, 'function', 'правило обязано существовать как именованный guard');
assert.equal(
    manager.isForegroundScanAllowed(FOREGROUND_TAB_ID, tabsById.get(FOREGROUND_TAB_ID).url),
    true,
    'foreground-вкладка сфокусированного окна работать обязана'
);
for (const tab of tabsById.values()) {
    if (tab.id === FOREGROUND_TAB_ID) continue;
    assert.equal(
        manager.isForegroundScanAllowed(tab.id, tab.url),
        false,
        `guard обязан отказывать вкладке ${tab.id} (активна: ${tab.active}, окно: ${tab.windowId})`
    );
}

// --- 3. Потеря фокуса браузером снимает разрешение ------------------------------------------------

manager.focusedWindowId = chrome.windows.WINDOW_ID_NONE;
assert.equal(
    manager.isForegroundScanAllowed(FOREGROUND_TAB_ID, tabsById.get(FOREGROUND_TAB_ID).url),
    false,
    'когда фокуса нет ни у одного окна, работать не имеет права никто - tabs.Tab.active тут ничего не решает'
);
manager.focusedWindowId = FOCUSED_WINDOW_ID;

// --- 4. Выключенный автоскан отменяет разрешение для всех ------------------------------------------

const savedAutoScan = manager.config?.settings?.autoScan;
if (manager.config?.settings) {
    manager.config.settings.autoScan = false;
    assert.equal(
        manager.isForegroundScanAllowed(FOREGROUND_TAB_ID, tabsById.get(FOREGROUND_TAB_ID).url),
        false,
        'при выключенном автоскане не работает и foreground-вкладка'
    );
    manager.config.settings.autoScan = savedAutoScan;
}

// --- 5. Перезапуск service worker на той же сессии ничего не будит ---------------------------------

sentTabMessages.length = 0;
const restarted = new BackgroundManager();
await restarted.whenReady();
await settle();

const activatedAfterRestart = new Set(activations().map((entry) => entry.tabId));
assert.equal(
    activatedAfterRestart.size <= 1,
    true,
    `перезапуск worker обязан разбудить не больше одной вкладки, разбужено: ${activatedAfterRestart.size}`
);
for (const tabId of activatedAfterRestart) {
    assert.equal(tabId, FOREGROUND_TAB_ID, 'и это может быть только вкладка, которую пользователь смотрит');
}

console.log(`C2: старт и восстановление сессии не будят вкладки (в сессии ${tabsById.size} вкладок в ${WINDOW_IDS.length} окнах)`);

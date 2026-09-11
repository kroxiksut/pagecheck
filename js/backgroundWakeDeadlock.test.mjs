// Щит взаимной блокировки при пробуждении service worker (найдена в браузере 2026-09-11).
//
// Цепочка была такой: init() ждал перехода foreground, переход ждал ответа вкладки на
// setPageLifecycle, а content-скрипт, прежде чем ответить, публикует статус страницы
// (pageStatusUpdate) и ждёт ответа - обработчик которого ждёт готовности, то есть конца init().
// Каждая сторона ждала другую. Всё висело, пока Chrome не останавливал worker, после чего каналы
// закрывались и content-скрипты, стартовавшие в это время, получали «message channel closed before
// a response was received» и оставались без конфигурации до перезагрузки страницы.
// В MV3 worker засыпает после 30 секунд простоя, так что это обычный путь, а не редкость.
//
// Существующие стенды этого не видели: их tabs.sendMessage отвечает мгновенно. Здесь заглушка
// вкладки ведёт себя как настоящий content-скрипт.
// Запуск: node js/backgroundWakeDeadlock.test.mjs

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
            const list = Array.isArray(keys) ? keys : [keys];
            for (const key of list) {
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

const PAGE_URL = 'https://example.com/article';
const tabsById = new Map([[1, { id: 1, url: PAGE_URL, active: true, windowId: 10 }]]);

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

// Слушатель onMessage того менеджера, которого будит тест. Заполняется сразу после конструктора.
let backgroundListener = null;
const lifecycleReplies = [];

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
        // Ровно то, что делает js/content.js в handlePageLifecycle: сначала publishPageStatus -
        // pageStatusUpdate с ОЖИДАНИЕМ ответа - и только потом ответ на setPageLifecycle.
        sendMessage: async (tabId, message) => {
            if (message?.action !== 'setPageLifecycle' || !backgroundListener) {
                return { success: true };
            }
            const published = await new Promise((resolve) => {
                backgroundListener(
                    {
                        action: 'pageStatusUpdate',
                        data: { url: PAGE_URL, moduleCounts: {}, totalFindings: 0, timestamp: 1 }
                    },
                    { tab: { id: tabId, url: PAGE_URL }, frameId: 0 },
                    resolve
                );
            });
            lifecycleReplies.push({ state: message.state, published });
            return { success: true, state: message.state, activeModules: message.modules };
        }
    },
    windows: {
        WINDOW_ID_NONE: -1,
        onFocusChanged: events.onWindowFocusChanged,
        get: async (windowId) => ({ id: windowId, focused: true }),
        getLastFocused: async () => ({ id: 10, focused: true })
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

for (const level of ['info', 'warn', 'debug', 'error', 'log']) {
    console[level] = () => {};
}

globalThis.__PAGECHECK_BACKGROUND_TEST__ = true;
const { BackgroundManager } = await import('./background.js');

function withinDeadline(promise, label, ms = 1500) {
    let timer;
    const deadline = new Promise((resolve) => {
        timer = setTimeout(() => resolve(`${label}: deadlock`), ms);
    });
    return Promise.race([promise.then(() => `${label}: ok`), deadline]).finally(() => clearTimeout(timer));
}

// --- пробуждение worker при живом content-скрипте в foreground-вкладке -----------------------------

const manager = new BackgroundManager();
backgroundListener = events.onMessage.listeners.at(-1);

assert.equal(
    await withinDeadline(manager.whenReady(), 'whenReady'),
    'whenReady: ok',
    'готовность не имеет права зависеть от ответа вкладки: вкладка, чтобы ответить, сама ждёт нас'
);

// Сообщение из другой вкладки, стартующей в этот же момент, - то, что в браузере падало с
// «Failed to get configuration from background».
const configAnswer = await withinDeadline(
    new Promise((resolve) => backgroundListener({ action: 'getConfig' }, { tab: { id: 7, url: PAGE_URL }, frameId: 0 }, resolve)),
    'getConfig'
);
assert.equal(configAnswer, 'getConfig: ok', 'content-скрипт новой вкладки обязан получить конфигурацию');

// Сам переход при этом не потерян: он доходит до вкладки, и она становится foreground.
for (let attempt = 0; attempt < 50 && manager.foregroundTabId !== 1; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
}
assert.equal(manager.foregroundTabId, 1, 'переход на foreground-вкладку обязан завершиться');
assert.ok(
    lifecycleReplies.some((reply) => reply.state === 'active' && reply.published?.success === true),
    'вкладка обязана получить active и успешно опубликовать свой статус'
);

console.log('backgroundWakeDeadlock.test.mjs: ok (worker wake with a live foreground tab does not deadlock)');

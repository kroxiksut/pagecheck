// Щит для C6.1, C6.5, C6.6 и C6.7 (корневой TASKS).
// C6.1: в MV3 событие, разбудившее service worker, диспатчится сразу после вычисления скрипта.
//       Пока слушатели регистрировались за await внутри init(), вычисление завершалось с нулём
//       слушателей и разбудившее событие терялось.
// C6.5: одно сохранение конфигурации поднимало storage.onChanged дважды (sync + local), а из popup -
//       до четырёх раз, и каждый раз шло полное переприменение по ВСЕМ вкладкам.
// C6.6: handleScanPage не проверял ни foreground, ни владение вкладкой.
// C6.7: закрытие foreground-вкладки с уже стоящим в очереди переходом доводило до sendMessage(null).
// Запуск: node js/backgroundRuntime.test.mjs

import assert from 'node:assert/strict';

// --- стенд: минимальный chrome ------------------------------------------------------------------

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

const permissionState = { granted: false, removeCalls: 0 };

const tabsById = new Map([
    [1, { id: 1, url: 'https://example.com/a', active: true, windowId: 10 }],
    [2, { id: 2, url: 'https://example.com/b', active: false, windowId: 10 }]
]);
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
                // ровно то, что делает настоящий chrome.tabs.sendMessage
                throw new TypeError('Error in invocation of tabs.sendMessage: tabId must be an integer');
            }
            sentTabMessages.push({ tabId, message });
            return { success: true };
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
        contains: async () => permissionState.granted,
        remove: async () => {
            permissionState.removeCalls += 1;
            permissionState.granted = false;
            return true;
        }
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
const loggedErrors = [];
console.error = (...args) => loggedErrors.push(args.join(' '));

globalThis.__PAGECHECK_BACKGROUND_TEST__ = true;
const { BackgroundManager } = await import('./background.js');
const { ConfigManager } = await import('../utils/config-manager.js');

function settle(rounds = 12) {
    let chain = Promise.resolve();
    for (let index = 0; index < rounds; index += 1) {
        chain = chain.then(() => undefined);
    }
    return chain;
}

// --- C6.1: слушатели зарегистрированы к моменту возврата конструктора ----------------------------

const listenerCountBefore = {
    message: events.onMessage.listeners.length,
    activated: events.onTabActivated.listeners.length,
    focus: events.onWindowFocusChanged.listeners.length,
    storage: events.onStorageChanged.listeners.length,
    installed: events.onInstalled.listeners.length
};

const manager = new BackgroundManager();
const managerStorageListener = events.onStorageChanged.listeners.at(-1);
const managerPermissionAdded = events.onPermissionAdded.listeners.at(-1);
const managerPermissionRemoved = events.onPermissionRemoved.listeners.at(-1);

// Ни одного await между new и этой строкой: это и есть момент «вычисление скрипта завершилось».
assert.equal(events.onMessage.listeners.length, listenerCountBefore.message + 1, 'onMessage обязан быть зарегистрирован синхронно');
assert.equal(events.onTabActivated.listeners.length, listenerCountBefore.activated + 1, 'onActivated обязан быть зарегистрирован синхронно');
assert.equal(events.onWindowFocusChanged.listeners.length, listenerCountBefore.focus + 1, 'onFocusChanged обязан быть зарегистрирован синхронно');
assert.equal(events.onStorageChanged.listeners.length, listenerCountBefore.storage + 1, 'onChanged обязан быть зарегистрирован синхронно');
assert.equal(events.onInstalled.listeners.length, listenerCountBefore.installed + 1, 'onInstalled обязан быть зарегистрирован синхронно');
assert.equal(manager.config, null, 'конфигурация на этот момент ещё НЕ прочитана - в этом и суть дефекта');

// Событие, разбудившее worker, приходит сразу же - до того, как init() успел что-либо прочитать.
events.onTabActivated.emit({ tabId: 2, windowId: 10 });
await manager.whenReady();
await settle();

assert.equal(
    manager.foregroundTabId,
    2,
    'событие, пришедшее до окончания инициализации, обязано быть обработано, а не потеряно'
);

// Сообщение, разбудившее worker, тоже обязано получить ответ, а не «Receiving end does not exist».
const earlyManager = new BackgroundManager();
const earlyResponses = [];
events.onMessage.listeners.at(-1)(
    { action: 'getConfig' },
    { tab: undefined },
    (response) => earlyResponses.push(response)
);
await earlyManager.whenReady();
await settle();
assert.equal(earlyResponses.length, 1, 'ответ обязан прийти');
assert.equal(typeof earlyResponses[0]?.modules, 'object', 'и это обязана быть конфигурация, а не null');

// --- C6.5: одно логическое изменение - одно переприменение ---------------------------------------

let applyCount = 0;
const nativeApply = manager.applyConfigToAllTabs.bind(manager);
manager.applyConfigToAllTabs = async (...args) => {
    applyCount += 1;
    return nativeApply(...args);
};

const storageListener = managerStorageListener;
const changedConfig = JSON.parse(JSON.stringify(manager.config));
changedConfig.modules['Link-Domain-Security'].enabled = false;

// пользователь переключил модуль: popup сохранил конфигурацию (sync + local) и попросил background
// сохранить её ещё раз (sync + local) - четыре события storage.onChanged на одно нажатие
await ConfigManager.saveConfig(changedConfig, true);
for (const area of ['sync', 'local', 'sync', 'local']) {
    storageListener({ extensionConfig: { newValue: {} } }, area);
}
await settle(30);

assert.equal(applyCount, 1, `на одно логическое изменение обязано приходиться одно переприменение (было ${applyCount})`);
assert.equal(manager.config.modules['Link-Domain-Security'].enabled, false, 'само изменение обязано доехать');

// повторные события без изменения содержимого не дают переприменений вовсе
for (const area of ['sync', 'local']) {
    storageListener({ extensionConfig: { newValue: {} } }, area);
}
await settle(30);
assert.equal(applyCount, 1, 'событие без изменения конфигурации не должно вызывать переприменение');

manager.applyConfigToAllTabs = nativeApply;

// --- C6.6: цель скана ----------------------------------------------------------------------------

manager.foregroundTabId = 1;
manager.focusedWindowId = 10;

const foreignScan = await manager.handleScanPage(2, { tab: { id: 1 } });
assert.equal(foreignScan.success, false, 'скан чужой фоновой вкладки обязан быть отклонён');
assert.match(foreignScan.error, /neither the sender tab nor the foreground tab/);

const ownScan = await manager.handleScanPage(2, { tab: { id: 2 } });
assert.equal(ownScan.success, true, 'вкладка вправе сканировать сама себя');

const foregroundScan = await manager.handleScanPage(1, { tab: undefined });
assert.equal(foregroundScan.success, true, 'popup сканирует текущую foreground-вкладку - это разрешено');

// --- C6.7: закрытие foreground-вкладки не доводит до sendMessage(null) ---------------------------

loggedErrors.length = 0;
sentTabMessages.length = 0;

manager.foregroundTabId = 1;
manager.focusedWindowId = 10;
manager.activeTabs.set(1, { url: 'https://example.com/a', modules: [], lastUpdated: Date.now() });

const queued = manager.applyConfigToAllTabs(manager.config, manager.config);
manager.handleTabRemoved(1); // вкладку закрыли, пока переход стоял в очереди
await queued;
await settle();

assert.equal(
    sentTabMessages.some((entry) => !Number.isInteger(entry.tabId)),
    false,
    'sendMessage(null, ...) не должен вызываться вовсе'
);
assert.equal(
    loggedErrors.some((line) => /must be an integer/.test(line)),
    false,
    `обычное закрытие вкладки не должно писать ошибку в лог: ${loggedErrors.join(' | ')}`
);

// --- 13.1 и 13.3: reconcile из слушателя разрешений не срывает идущую транзакцию -----------------

// Реальная последовательность Chrome: permissions.onAdded приходит РАНЬШЕ, чем до нас доходит
// apiPermissionCommit. Раньше слушатель звал reconcile(), тот поднимал ревизию, транзакция
// становилась устаревшей, а сам reconcile тут же отзывал только что выданное разрешение.
{
    permissionState.granted = false;
    permissionState.removeCalls = 0;

    const begin = await manager.handleApiPermissionBegin();
    assert.equal(begin.success, true, 'транзакция включения обязана начаться');

    // пользователь согласился: разрешение выдано, событие пришло до commit
    permissionState.granted = true;
    managerPermissionAdded({ permissions: ['webRequest'], origins: ['<all_urls>'] });
    await settle(30);

    assert.equal(
        permissionState.removeCalls,
        0,
        'reconcile из слушателя не имеет права отозвать разрешение посреди транзакции включения'
    );

    const commit = await manager.handleApiPermissionCommit(begin.transactionId, true);
    await settle(30);
    assert.equal(commit.success, true, 'commit обязан пройти: раньше он возвращал stale и модуль оставался выключенным');
    assert.equal(permissionState.granted, true, 'разрешение обязано остаться выданным');
}

// Отключение: disable() рапортовал stale на фактически успешном отключении, и пользователь видел
// ошибку вместо успеха.
{
    permissionState.granted = true;
    permissionState.removeCalls = 0;

    const disableResultPromise = manager.handleApiPermissionDisable();
    // Событие приходит, пока remove() ещё в полёте - то есть уже после публикации 'removing'.
    await settle(5);
    managerPermissionRemoved({ permissions: ['webRequest'], origins: ['<all_urls>'] });
    const disableResult = await disableResultPromise;
    await settle(30);

    assert.equal(disableResult.success, true, 'успешное отключение обязано отчитываться успехом');
    assert.equal(disableResult.stale, undefined, 'и не как устаревшая транзакция');
}

// --- 13.2: chrome.webRequest резолвится лениво ----------------------------------------------------

{
    assert.equal(
        manager.apiResourceObserver.webRequest,
        null,
        'при старте service worker без опционального разрешения namespace отсутствует'
    );

    const listenerApi = { addListener: () => {}, removeListener: () => {} };
    chrome.webRequest = {
        onBeforeRequest: listenerApi,
        onHeadersReceived: listenerApi,
        onBeforeRedirect: listenerApi,
        onCompleted: listenerApi,
        onErrorOccurred: listenerApi
    };
    assert.equal(
        manager.apiResourceObserver.isWebRequestAvailable(),
        true,
        'после выдачи разрешения наблюдатель обязан увидеть namespace без перезапуска worker'
    );
    delete chrome.webRequest;
}

// --- 13.4: идентичность навигации входит в сигнатуру наблюдателя ---------------------------------

{
    manager.foregroundTabId = 1;
    manager.focusedWindowId = 10;
    manager.activeTabs.set(1, { url: 'https://example.com/first', modules: [], lastUpdated: Date.now() });
    manager.config.modules['Api-Interceptor'] = { enabled: true, monitorOnly: true };
    manager.getApiPermissionState = () => ({ capability: 'granted', transaction: 'idle' });

    manager.apiObserverSignature = '';
    manager.syncApiObserverForForeground();
    const firstSignature = manager.apiObserverSignature;

    manager.activeTabs.set(1, { url: 'https://example.com/second', modules: [], lastUpdated: Date.now() });
    manager.syncApiObserverForForeground();
    const secondSignature = manager.apiObserverSignature;

    assert.notEqual(
        firstSignature,
        secondSignature,
        'переход в той же вкладке обязан менять сигнатуру: иначе состояние наблюдателя не сбрасывается и кандидаты предыдущей страницы остаются в снапшоте'
    );
    assert.equal(firstSignature.includes('inactive'), false, 'сигнатура должна быть активной, иначе проверка ничего не значит');
}

Object.assign(console, quietConsole);
console.log('Background runtime contract checks passed (C6.1, C6.5, C6.6, C6.7, 13.1-13.4)');

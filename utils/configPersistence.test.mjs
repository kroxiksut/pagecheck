// Щит для C6.2, C6.3 и C6.4 (корневой TASKS): сохранение настроек обязано быть долговечным.
// До правок: debounce ВЫБРАСЫВАЛ запись, отчитываясь об успехе; local писался как резерв, но
// никогда не читался как резерв, поэтому устаревший sync затирал свежее локальное значение;
// миграция со старого ключа стартовала с дефолтов и стирала текущую конфигурацию.
// Запуск: node utils/configPersistence.test.mjs

import assert from 'node:assert/strict';

// --- стенд: chrome.storage на картах + управляемое время ---------------------------------------

const areas = { sync: new Map(), local: new Map() };
let syncSetFails = false;
const syncSetCalls = [];

function makeArea(name) {
    return {
        get(keys, callback) {
            const map = areas[name];
            const list = Array.isArray(keys) ? keys : [keys];
            const result = {};
            for (const key of list) {
                if (map.has(key)) {
                    result[key] = JSON.parse(JSON.stringify(map.get(key)));
                }
            }
            callback(result);
        },
        set(values, callback) {
            if (name === 'sync') {
                syncSetCalls.push(Object.keys(values));
                if (syncSetFails) {
                    chrome.runtime.lastError = { message: 'QUOTA_BYTES_PER_ITEM quota exceeded' };
                    callback();
                    chrome.runtime.lastError = undefined;
                    return;
                }
            }
            for (const [key, value] of Object.entries(values)) {
                areas[name].set(key, JSON.parse(JSON.stringify(value)));
            }
            callback();
        },
        remove(keys, callback) {
            const list = Array.isArray(keys) ? keys : [keys];
            for (const key of list) {
                areas[name].delete(key);
            }
            callback();
        }
    };
}

const installedListeners = [];
globalThis.chrome = {
    runtime: {
        lastError: undefined,
        onInstalled: { addListener: (listener) => installedListeners.push(listener) }
    },
    storage: { sync: makeArea('sync'), local: makeArea('local') },
    i18n: { getMessage: () => '' }
};

// Управляемое время: таймеры не ждут реальную секунду, но и не срабатывают сами.
let now = 100000;
const pendingTimers = [];
const nativeSetTimeout = globalThis.setTimeout;
const nativeDateNow = Date.now;
Date.now = () => now;
globalThis.setTimeout = (callback, delay) => {
    const timer = { callback, dueAt: now + delay, cancelled: false };
    pendingTimers.push(timer);
    return timer;
};
globalThis.clearTimeout = (timer) => {
    if (timer && typeof timer === 'object') {
        timer.cancelled = true;
    }
};

async function advanceTime(ms) {
    now += ms;
    for (const timer of [...pendingTimers]) {
        if (!timer.cancelled && timer.dueAt <= now) {
            timer.cancelled = true;
            await timer.callback();
        }
    }
    await Promise.resolve();
}

const quietConsole = { ...console };
for (const level of ['info', 'warn', 'debug', 'error']) {
    console[level] = () => {};
}

const { ConfigManager, CONFIG_STORAGE_KEYS } = await import('./config-manager.js');

const CONFIG_KEY = CONFIG_STORAGE_KEYS.EXTENSION_CONFIG;
const FLAG_KEY = CONFIG_STORAGE_KEYS.CONFIG_LOCAL_AUTHORITATIVE;
const MODULE_ID = 'Hidden-Content-Visual-Manipulation';

function resetStand() {
    areas.sync.clear();
    areas.local.clear();
    syncSetCalls.length = 0;
    syncSetFails = false;
    pendingTimers.length = 0;
    ConfigManager.configCache = null;
    ConfigManager.pendingSyncConfig = null;
    ConfigManager.syncWriteTimer = null;
    ConfigManager.localAuthoritative = null;
    ConfigManager.lastSaveTime = 0;
}

function configWith(scanInterval) {
    const config = ConfigManager.getDefaultConfig();
    config.modules[MODULE_ID].scanInterval = scanInterval;
    return config;
}

// --- C6.2: вторая запись в пределах debounce не теряется ----------------------------------------

resetStand();
await ConfigManager.saveConfig(configWith(1111));
assert.equal(areas.sync.get(CONFIG_KEY).modules[MODULE_ID].scanInterval, 1111, 'первая запись уходит сразу');

now += 10; // внутри окна debounce
await ConfigManager.saveConfig(configWith(2222));
assert.equal(
    areas.local.get(CONFIG_KEY).modules[MODULE_ID].scanInterval,
    2222,
    'local обязан получить последнее состояние немедленно, без ожидания debounce'
);
assert.equal(areas.local.get(FLAG_KEY), true, 'пока sync-запись отложена, авторитетен local');

await advanceTime(1000);
assert.equal(
    areas.sync.get(CONFIG_KEY).modules[MODULE_ID].scanInterval,
    2222,
    'отложенная запись обязана ДОЙТИ до sync, а не быть выброшенной'
);
assert.equal(areas.local.has(FLAG_KEY), false, 'после успешной записи в sync признак снимается');

// --- C6.2: несколько записей подряд схлопываются в одну, но состояние остаётся последним --------

resetStand();
for (let index = 0; index < 5; index += 1) {
    now += 5;
    await ConfigManager.saveConfig(configWith(index));
}
await advanceTime(1000);
assert.equal(areas.sync.get(CONFIG_KEY).modules[MODULE_ID].scanInterval, 4, 'в sync лежит последнее состояние');
assert.equal(areas.local.get(CONFIG_KEY).modules[MODULE_ID].scanInterval, 4, 'в local лежит последнее состояние');
assert.equal(syncSetCalls.length <= 2, true, `квота sync не должна расходоваться на каждую правку (записей: ${syncSetCalls.length})`);

// --- C6.3: отказ sync не даёт устаревшему значению победить -------------------------------------

resetStand();
await ConfigManager.saveConfig(configWith(10), true);
assert.equal(areas.sync.get(CONFIG_KEY).modules[MODULE_ID].scanInterval, 10);

syncSetFails = true;
now += 5000;
await ConfigManager.saveConfig(configWith(20), true);
assert.equal(areas.sync.get(CONFIG_KEY).modules[MODULE_ID].scanInterval, 10, 'запись в sync отклонена - там осталось старое');
assert.equal(areas.local.get(CONFIG_KEY).modules[MODULE_ID].scanInterval, 20, 'но local получил новое');
assert.equal(areas.local.get(FLAG_KEY), true, 'и помечен авторитетным');

// именно этот путь раньше откатывал настройки: refreshConfig читал sync и затирал им кэш
const refreshed = await ConfigManager.refreshConfig();
assert.equal(
    refreshed.modules[MODULE_ID].scanInterval,
    20,
    'после перечитывания конфигурации изменение пользователя обязано остаться'
);

// когда sync снова доступен, признак снимается и синхронизация продолжается
syncSetFails = false;
now += 5000;
await ConfigManager.saveConfig(configWith(30), true);
assert.equal(areas.sync.get(CONFIG_KEY).modules[MODULE_ID].scanInterval, 30);
assert.equal(areas.local.has(FLAG_KEY), false, 'залипший признак обязан сниматься после успешной записи');
assert.equal((await ConfigManager.refreshConfig()).modules[MODULE_ID].scanInterval, 30);

// --- C6.4: миграция не затирает существующую конфигурацию ---------------------------------------

resetStand();
const existing = configWith(777);
existing.settings.findingsApiAllowedExtensionIds = ['abcdefghijklmnopabcdefghijklmnop'];
existing.modules['Trigger-Phrases'].enabled = false;
areas.sync.set(CONFIG_KEY, existing);
areas.local.set(CONFIG_KEY, existing);
areas.sync.set('pagecheck_settings', { language: 'ru', theme: 'dark' });

await ConfigManager.migrateFromPreviousVersion('0.0.1');
assert.equal(areas.sync.has('pagecheck_settings'), false, 'легаси-ключ обязан быть убран');
assert.equal(areas.sync.get(CONFIG_KEY).modules[MODULE_ID].scanInterval, 777, 'настройки модулей обязаны пережить миграцию');
assert.deepEqual(
    areas.sync.get(CONFIG_KEY).settings.findingsApiAllowedExtensionIds,
    ['abcdefghijklmnopabcdefghijklmnop'],
    'allowlist findings-API обязан пережить миграцию'
);
assert.equal(areas.sync.get(CONFIG_KEY).modules['Trigger-Phrases'].enabled, false);

// --- C6.4: если актуального ключа нет, легаси действительно переносится -------------------------

resetStand();
areas.sync.set('pagecheck_settings', { language: 'ru', theme: 'dark' });
await ConfigManager.migrateFromPreviousVersion('0.0.1');
assert.equal(areas.local.get(CONFIG_KEY).language, 'ru');
assert.equal(areas.local.get(CONFIG_KEY).theme, 'dark');
assert.equal(areas.sync.has('pagecheck_settings'), false);

// --- C6.4: отсутствующий previousVersion не роняет миграцию ------------------------------------

resetStand();
areas.sync.set('pagecheck_settings', { language: 'ru' });
await ConfigManager.migrateFromPreviousVersion(undefined);
assert.equal(areas.local.get(CONFIG_KEY).language, 'ru', 'миграция без номера версии обязана отработать, а не уйти в catch');

Date.now = nativeDateNow;
globalThis.setTimeout = nativeSetTimeout;
Object.assign(console, quietConsole);
console.log('Config persistence contract checks passed (C6.2, C6.3, C6.4)');

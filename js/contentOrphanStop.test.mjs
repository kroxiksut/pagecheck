// Щит «сироты» (2026-09-11). После перезагрузки или обновления расширения content-скрипт остаётся на
// уже открытой странице без связи с расширением: chrome.runtime.id пропадает, sendMessage бросает
// «Extension context invalidated», а наблюдатели модулей и таймеры продолжают работать в main-thread
// страницы. Раньше сирота так и крутился до перезагрузки страницы, а с живым бейджем (Б1) ещё и писал
// ошибку на каждую публикацию - это и было на странице ошибок расширения в chrome://extensions.
// Сирота обязан остановиться сам, один раз и без ошибок в журнале.
// Тест гоняет НАСТОЯЩИЙ ModuleManager из js/content.js (стенд - как в snapshotShape.test.mjs).
// Запуск: node js/contentOrphanStop.test.mjs

import assert from 'node:assert/strict';

const ROOT = new URL('..', import.meta.url);

class StubElement {
    constructor(tagName = 'div', attributes = {}) {
        this.tagName = tagName.toUpperCase();
        this.localName = tagName.toLowerCase();
        this.attributes = new Map(Object.entries(attributes));
        this.childNodes = [];
        this.parentElement = null;
        this.isConnected = true;
        this.nodeType = 1;
    }

    get children() { return this.childNodes.filter((node) => node.nodeType === 1); }

    appendChild(node) {
        node.parentElement = this;
        this.childNodes.push(node);
        return node;
    }

    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
    setAttribute(name, value) { this.attributes.set(name, value); }
    hasAttribute(name) { return this.attributes.has(name); }
    removeAttribute(name) { this.attributes.delete(name); }
    matches() { return false; }
    closest() { return null; }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    getBoundingClientRect() { return { top: 0, left: 0, width: 10, height: 10, bottom: 10, right: 10 }; }

    contains(node) {
        let current = node;
        while (current) {
            if (current === this) return true;
            current = current.parentElement;
        }
        return false;
    }

    get textContent() {
        return this.childNodes.map((node) => (node.nodeType === 3 ? node.data : node.textContent)).join('');
    }

    set textContent(value) {
        this.childNodes = [new StubText(String(value))];
        this.childNodes[0].parentElement = this;
    }
}

class StubText {
    constructor(data) {
        this.nodeType = 3;
        this.data = data;
        this.parentElement = null;
    }

    get textContent() { return this.data; }
}

const documentRoot = new StubElement('html');
const body = new StubElement('body');
documentRoot.appendChild(body);
const link = new StubElement('a', { href: 'javascript:alert(1)' });
link.appendChild(new StubText('Continue to your bank'));
body.appendChild(link);

globalThis.performance = { now: () => 0 };
globalThis.Element = StubElement;
globalThis.Node = class { static TEXT_NODE = 3; static ELEMENT_NODE = 1; };
globalThis.document = {
    documentElement: documentRoot,
    baseURI: 'https://shop.example.com/catalog',
    readyState: 'complete',
    addEventListener() {},
    createElement: (tagName) => new StubElement(tagName),
    head: new StubElement('head')
};
globalThis.window = {
    location: new URL('https://shop.example.com/catalog'),
    addEventListener() {},
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    innerWidth: 1280,
    innerHeight: 800
};
globalThis.getComputedStyle = globalThis.window.getComputedStyle;

const MODULE_IDS = [
    'Hidden-Content-Visual-Manipulation',
    'Link-Domain-Security',
    'Trigger-Phrases',
    'Prompt-Splitting'
];

const CONFIG = {
    modules: Object.fromEntries(MODULE_IDS.map((id) => [id, {
        enabled: true,
        sensitivity: 'medium',
        actionOnDetect: 'notify',
        detectHomographs: true,
        detectLinkMismatch: true,
        detectRedirectPatterns: true,
        detectUnsafeProtocols: true
    }]))
};

globalThis.chrome = {
    runtime: {
        id: 'abcdefghijklmnopabcdefghijklmnop',
        getURL: (path) => new URL(path, ROOT).href,
        onMessage: { addListener() {} },
        sendMessage: (message) => Promise.resolve(
            message?.action === 'getConfig'
                ? CONFIG
                : { state: 'paused', modules: [], config: CONFIG }
        ),
        lastError: null
    },
    i18n: { getMessage: () => '' }
};

const contentModule = await import(new URL('js/content.js', ROOT).href);
const ModuleManager = contentModule.default?.ModuleManager || contentModule.ModuleManager;
assert.ok(ModuleManager, 'ModuleManager обязан быть доступен этому тесту');

const { Logger } = await import(new URL('utils/logger.js', ROOT).href);
Logger.setLevel('error');
const loggedErrors = [];
console.error = (...args) => loggedErrors.push(args.join(' '));

const manager = new ModuleManager();
await new Promise((resolve) => setTimeout(resolve, 0));
manager.currentConfig = CONFIG;
if (manager.modules.size === 0) {
    await manager.initializeModules();
}
manager.lifecycleRequestRevision += 1;
await manager.handlePageLifecycle('active', MODULE_IDS, CONFIG, manager.lifecycleRequestRevision);
assert.ok(manager.activeModuleNames.size >= 2, 'до «перезагрузки» модули обязаны работать');

// --- 1. обрыв канала при ЖИВОМ расширении - это ошибка, а не сиротство ------------------------------

chrome.runtime.sendMessage = () => Promise.reject(new Error('The message channel closed before a response was received.'));
loggedErrors.length = 0;
assert.equal(await manager.sendMessageToBackground({ action: 'pageStatusUpdate', data: {} }), null);
assert.equal(manager.orphaned === true, false, 'обрыв канала при живом расширении не делает скрипт сиротой');
assert.ok(manager.activeModuleNames.size >= 2, 'модули продолжают работать: worker перезапустится сам');
assert.equal(loggedErrors.length, 1, 'обрыв канала при живом расширении остаётся видимой ошибкой');

// --- 2. расширение перезагружено: скрипт останавливается сам ----------------------------------------

delete chrome.runtime.id;
chrome.runtime.sendMessage = () => { throw new Error('Extension context invalidated.'); };
loggedErrors.length = 0;
const activeBefore = [...manager.activeModuleNames];

assert.equal(await manager.sendMessageToBackground({ action: 'pageStatusUpdate', data: {} }), null);
assert.equal(manager.orphaned, true, 'сирота обязан это заметить');
assert.equal(manager.activeModuleNames.size, 0, 'у сироты не остаётся активных модулей');
assert.equal(manager.lifecycleState, 'paused', 'сирота на паузе');
for (const name of activeBefore) {
    const module = manager.modules.get(name);
    assert.equal(module.isEnabled, false, `${name}: модуль сироты обязан быть остановлен`);
    assert.equal(module.observer ?? null, null, `${name}: наблюдатель сироты обязан быть снят`);
}
assert.deepEqual(loggedErrors, [], 'сиротство - не ошибка: в журнал ошибок оно не пишет');

// --- 3. повторные попытки ничего не делают и тоже молчат --------------------------------------------

await manager.publishPageStatus({ pageStatus: { totalFindings: 1 } });
manager.scheduleModuleStatusPublish(activeBefore[0]);
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(loggedErrors, [], 'сирота не пишет ошибку на каждую публикацию');

console.log(`contentOrphanStop.test.mjs: ok (${activeBefore.length} modules stopped after the extension context was lost)`);

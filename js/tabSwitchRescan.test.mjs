// Shield for the tab-switch rescan contract (root TASKS C1 + C2, 2026-09-07).
// Pausing a tab used to destroy its modules, so returning re-ran init() + firstScan() for every one
// of them. On an unchanged page that produced nothing new - measured on the stand at 1044 `matches`
// and 2183 clock reads per switch, for one module out of five.
// This test drives the REAL ModuleManager pipeline from js/content.js with the REAL module classes,
// because the thing being protected is the lifecycle, not a helper:
//   - a paused tab does no work (the property the 54-tab incident is about);
//   - returning to an unchanged page does not rescan;
//   - returning to a CHANGED page does rescan - the tripwire is what decides;
//   - anything the tripwire cannot prove counts as changed.
// Run: node js/tabSwitchRescan.test.mjs

import assert from 'node:assert/strict';

const ROOT = new URL('..', import.meta.url);

// --- a DOM just rich enough for the real modules to run ----------------------------------------

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

    get children() {
        return this.childNodes.filter((node) => node.nodeType === 1);
    }

    appendChild(node) {
        node.parentElement = this;
        this.childNodes.push(node);
        return node;
    }

    getAttribute(name) {
        return this.attributes.has(name) ? this.attributes.get(name) : null;
    }

    setAttribute(name, value) {
        this.attributes.set(name, value);
    }

    hasAttribute(name) {
        return this.attributes.has(name);
    }

    matches() {
        return false;
    }

    contains(node) {
        let current = node;
        while (current) {
            if (current === this) return true;
            current = current.parentElement;
        }
        return false;
    }

    get textContent() {
        return this.childNodes.map((node) => node.textContent || '').join('');
    }

    querySelectorAll() {
        return [];
    }

    closest() {
        return null;
    }
}

class StubText {
    constructor(text) {
        this.nodeType = 3;
        this.textContent = text;
        this.parentElement = null;
    }
}

function buildPage() {
    const root = new StubElement('html');
    const body = root.appendChild(new StubElement('body'));
    for (let index = 0; index < 5; index += 1) {
        const link = body.appendChild(new StubElement('a', { href: 'javascript:void(steal())' }));
        link.appendChild(new StubText(`link ${index}`));
    }
    return root;
}

const documentRoot = buildPage();

// --- the tripwire's observer: one instance, fired by hand --------------------------------------

const observers = [];
globalThis.MutationObserver = class {
    constructor(callback) {
        this.callback = callback;
        this.connected = false;
        this.queued = [];
        observers.push(this);
    }

    observe() {
        this.connected = true;
    }

    disconnect() {
        this.connected = false;
    }

    takeRecords() {
        const records = this.queued;
        this.queued = [];
        return records;
    }
};

function fireDocumentChange() {
    for (const observer of observers) {
        if (observer.connected) {
            observer.callback([{ type: 'childList' }], observer);
        }
    }
}

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

const LINK_MODULE_ID = 'Link-Domain-Security';

const CONFIG = {
    modules: {
        [LINK_MODULE_ID]: {
            enabled: true,
            detectHomographs: true,
            detectLinkMismatch: true,
            detectRedirectPatterns: true,
            detectUnsafeProtocols: true,
            sensitivity: 'medium',
            actionOnDetect: 'notify'
        }
    }
};

globalThis.chrome = {
    runtime: {
        getURL: (path) => new URL(path, ROOT).href,
        onMessage: { addListener() {} },
        // initializeModules() asks the background for the configuration; the lifecycle handshake
        // asks for the current state. Both go through the same channel.
        sendMessage: (message) => Promise.resolve(
            message?.action === 'getConfig'
                ? CONFIG
                : { state: 'paused', modules: [], config: CONFIG }
        ),
        lastError: null
    },
    i18n: { getMessage: () => '' }
};

// content.js is a classic content script, not an ES module: it publishes ModuleManager through
// `module.exports` when such a binding exists. Providing it before the import is how the class
// becomes reachable here - and importing the real file is the point, since the lifecycle is what
// this test protects.
// The project has no package.json, so a `.js` file is CommonJS to Node - which is convenient here:
// content.js already publishes ModuleManager through `module.exports`, and importing the real file
// is the point, since the lifecycle is what this test protects.
const contentModule = await import(new URL('js/content.js', ROOT).href);
const ModuleManager = contentModule.default?.ModuleManager || contentModule.ModuleManager;

assert.ok(ModuleManager, 'ModuleManager must be reachable for this test');

const { Logger } = await import(new URL('utils/logger.js', ROOT).href);
Logger.setLevel('silent');

function countScans(manager) {
    return manager.modules.get(LINK_MODULE_ID).scanRevision;
}

async function activate(manager) {
    manager.lifecycleRequestRevision += 1;
    return manager.handlePageLifecycle('active', [LINK_MODULE_ID], CONFIG, manager.lifecycleRequestRevision);
}

async function pause(manager) {
    manager.lifecycleRequestRevision += 1;
    return manager.handlePageLifecycle('paused', [], CONFIG, manager.lifecycleRequestRevision);
}

// The manager created at import time runs its own init(); build a clean one for the test.
const manager = new ModuleManager();
await new Promise((resolve) => setTimeout(resolve, 0));
manager.currentConfig = CONFIG;
if (!manager.modules.has(LINK_MODULE_ID)) {
    await manager.initializeModules();
}
assert.ok(manager.modules.has(LINK_MODULE_ID), 'the link module must be registered');

// --- 1. first activation scans -----------------------------------------------------------------
await activate(manager);
const module = manager.modules.get(LINK_MODULE_ID);
assert.ok(manager.activeModuleNames.has(LINK_MODULE_ID), 'the module must be active');
const scansAfterFirstActivation = countScans(manager);
assert.ok(scansAfterFirstActivation > 0, 'the first activation must scan the page');
const findingsAfterFirstScan = module.recentFindings.length;
assert.ok(findingsAfterFirstScan > 0, 'the page has javascript: links, so there must be findings');

// --- 2. pausing stops the module but keeps what it found ---------------------------------------
await pause(manager);
assert.equal(manager.activeModuleNames.has(LINK_MODULE_ID), false, 'a paused module is not active');
assert.equal(manager.pausedModuleNames.has(LINK_MODULE_ID), true, 'and is tracked as paused');
assert.equal(module.isEnabled, false, 'a paused module must not be allowed to work');
assert.equal(module.observer, null, 'its observer must be gone');
assert.equal(
    module.recentFindings.length,
    findingsAfterFirstScan,
    'this module keeps its findings across a pause'
);

// --- 3. returning to an UNCHANGED page does not rescan ------------------------------------------
await activate(manager);
assert.equal(countScans(manager), scansAfterFirstActivation, 'an unchanged page must not be rescanned');
assert.equal(manager.activeModuleNames.has(LINK_MODULE_ID), true, 'the module is working again');
assert.ok(module.observer, 'and is observing again');
assert.equal(
    module.recentFindings.length,
    findingsAfterFirstScan,
    'the findings are still there to report'
);

// --- 4. returning to a CHANGED page does rescan ------------------------------------------------
await pause(manager);
fireDocumentChange();
assert.equal(manager.documentChangedWhilePaused, true, 'the tripwire must record the change');
await activate(manager);
assert.ok(countScans(manager) > scansAfterFirstActivation, 'a changed page must be rescanned');

// --- 5. what cannot be proven counts as changed ------------------------------------------------
{
    await pause(manager);
    const scansBefore = countScans(manager);
    // Someone removed the tripwire without proving anything - the fail-safe must hold.
    manager.documentChangedWhilePaused = true;
    await activate(manager);
    assert.ok(countScans(manager) > scansBefore, 'an unproven page must be rescanned');
}

// --- 6. disabling a paused module clears it completely -----------------------------------------
{
    await pause(manager);
    await manager.disableModule(LINK_MODULE_ID);
    assert.equal(manager.pausedModuleNames.has(LINK_MODULE_ID), false, 'no longer paused');
    assert.equal(manager.activeModuleNames.has(LINK_MODULE_ID), false, 'and not active');
    assert.deepEqual(module.recentFindings, [], 'disabling drops what a pause kept');
}

console.log('tabSwitchRescan.test.mjs: OK');

// Shield for C7.3 (root TASKS): an explicit scan that fails is a level-2 event in EVERY module.
// `performScan()` was copied verbatim into all five modules. When link-domain-security 7.15 wrapped
// it in the level-2 handler, the copies drifted: four modules still let the exception escape, and
// js/content.js calls performScan inside a try/finally WITHOUT a catch - so one module's bad page
// aborted the scan response for all of them.
// The test runs against the real module classes, not a stand-in, because the point is that no
// module goes its own way here.
// Run: node modules/explicitScanErrorLevel.test.mjs

import assert from 'node:assert/strict';

globalThis.performance = { now: () => 0 };
globalThis.Element = class StubElement {};
globalThis.Node = class { static TEXT_NODE = 3; static ELEMENT_NODE = 1; };
globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
    takeRecords() { return []; }
};
globalThis.document = { documentElement: null, baseURI: 'https://shop.example.com/' };
globalThis.window = {
    location: new URL('https://shop.example.com/catalog'),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    innerWidth: 1280,
    innerHeight: 800
};
globalThis.getComputedStyle = globalThis.window.getComputedStyle;
globalThis.chrome = undefined;

const MODULES = [
    // ЧЕТЫРЕ, а не пять. `modules/api-interception/ApiInterceptor.js` сюда не входит: js/content.js
    // его не импортирует (Priority 7.3, quarantine), поэтому в браузере он не выполняется НИКОГДА.
    // Пока он стоял в этом списке, отчёт «проверено на всех пяти модулях» означал четыре живых плюс
    // один мёртвый - то есть щит завышал охват. Фактическую загрузку content-модулей пинует
    // modules/api-interception/runtime/ApiResourceObserver.test.mjs (позитивный список + отсутствие
    // ApiInterceptor). Файл остаётся в дереве до Chrome-валидации (Priority 7.7), но проверять его
    // как рабочий модуль нельзя.
    ['visual-manipulation', './visual-manipulation/VisualManipulationDetector.js'],
    ['link-domain-security', './link-domain-security/LinkDomainSecurityDetector.js'],
    ['trigger-phrases', './trigger-phrases/TriggerPhrases.js'],
    ['prompt-splitting', './prompt-splitting/PromptSplitting.js']
];

const { Logger } = await import('../utils/logger.js');
Logger.setLevel('silent');

let checked = 0;

for (const [name, path] of MODULES) {
    const { default: ModuleClass } = await import(path);
    const module = new ModuleClass();
    module.isEnabled = true;
    module.config = { ...module.config, enabled: true };

    // Break the scan itself, whatever the module does inside it.
    module.firstScan = async () => {
        throw new Error(`${name} scan exploded`);
    };

    let result;
    let threw = false;
    try {
        result = await module.performScan();
    } catch {
        threw = true;
    }

    assert.equal(threw, false, `${name}: a failed explicit scan must not reject - it aborts every other module`);
    assert.equal(module.scanFailed, true, `${name}: the failure must be recorded (level 2)`);
    assert.ok(result && typeof result === 'object', `${name}: a snapshot must still be returned`);
    assert.equal(result.module, module.moduleName, `${name}: the snapshot must name its module`);
    // The module is alive and can try again - level 2 is not level 3.
    assert.equal(module.isEnabled, true, `${name}: a bad page must not disable the module`);

    checked += 1;
}

assert.equal(checked, MODULES.length, 'every module must be covered');

// --- the shared helper is what makes that true, not five copies --------------------------------
{
    const { default: ModuleCore } = await import('./ModuleCore.js');
    assert.equal(
        typeof ModuleCore.prototype.runExplicitScan,
        'function',
        'the gate and the error level live in the core'
    );

    class Healthy extends ModuleCore {
        constructor() {
            super('Healthy', true);
            this.scans = 0;
        }

        async firstScan() {
            this.scans += 1;
        }
    }

    const healthy = new Healthy();
    healthy.resetErrorState();
    await healthy.runExplicitScan();
    assert.equal(healthy.scans, 1, 'a healthy scan still runs');
    assert.equal(healthy.scanFailed, false, 'and is not marked failed');
}

console.log(`explicitScanErrorLevel.test.mjs: OK (${checked} modules)`);

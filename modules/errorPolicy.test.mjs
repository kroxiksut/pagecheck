// Shield for the C5.6 contract (root TASKS): one error policy, three levels, and none of them may
// look like "the page is clean".
// Before this contract the two live modules sat at opposite extremes: visual-manipulation rethrew a
// scan error so ModuleCore.init() destroyed the module for the whole page, and link-domain-security
// swallowed a candidate error without a trace, so a page that lost candidates still reported itself
// fully analysed.
// Run: node modules/errorPolicy.test.mjs

import assert from 'node:assert/strict';

globalThis.performance = { now: () => 0 };
globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
    takeRecords() { return []; }
};
globalThis.document = { documentElement: { children: [] } };

const { default: ModuleCore } = await import('./ModuleCore.js');

// --- level 1: a failed unit of work is counted, the scan goes on -------------------------------------

class UnitFailingModule extends ModuleCore {
    constructor() {
        super('Unit-Failing', true);
        this.scanned = [];
    }

    async firstScan() {
        this.resetErrorState();
        for (const unit of ['a', 'b', 'c']) {
            try {
                if (unit === 'b') {
                    throw new Error('bad unit');
                }
                this.scanned.push(unit);
            } catch (error) {
                this.recordUnitError('unit', error);
            }
        }
    }
}

const unitModule = new UnitFailingModule();
await unitModule.init();

assert.deepEqual(unitModule.scanned, ['a', 'c'], 'a failed unit must not stop the ones after it');
assert.equal(unitModule.unitErrorCount, 1, 'the failed unit must be counted');
assert.equal(unitModule.scanFailed, false, 'one bad unit is not a failed scan');
assert.equal(unitModule.isInitialized, true, 'and certainly not a dead module');
assert.equal(unitModule.getStats().unitErrorCount, 1, 'the count must be visible from outside');

// --- level 2: a failed scan leaves the module alive ----------------------------------------------------

class ScanFailingModule extends ModuleCore {
    constructor() {
        super('Scan-Failing', true);
        this.usesMutationObserver = true;
    }

    async firstScan() {
        throw new Error('scan exploded');
    }
}

const scanModule = new ScanFailingModule();
const initialized = await scanModule.init();

assert.equal(initialized, true, 'a failed scan must not fail the initialization');
assert.equal(scanModule.isEnabled, true, 'the module must stay enabled');
assert.equal(scanModule.isInitialized, true, 'and initialized');
assert.equal(scanModule.observer !== null, true, 'its observer must still be attached for the next chance');
assert.equal(scanModule.scanFailed, true, 'the failure must be recorded');
assert.equal(scanModule.getStats().scanFailed, true, '"it broke" must be readable from the outside');
assert.equal(scanModule.getStats().lastErrorContext, 'first-scan');

// --- level 3: only initialization is fatal ---------------------------------------------------------------

class InitFailingModule extends ModuleCore {
    async beforeInit() {
        throw new Error('cannot initialize');
    }
}

const initModule = new InitFailingModule('Init-Failing', true);
const initResult = await initModule.init();

assert.equal(initResult, false, 'a failed initialization must report failure');
assert.equal(initModule.isEnabled, false, 'and it is the only level that disables the module');
assert.equal(initModule.isInitialized, false);

// --- the log is rate-limited per context -------------------------------------------------------------------

const noisy = new UnitFailingModule();
for (let index = 0; index < 100; index += 1) {
    noisy.recordUnitError('same-context', new Error('again'));
}
assert.equal(noisy.unitErrorCount, 100, 'every failure is counted');
assert.equal(noisy.loggedUnitErrorContexts.size, 1, 'but one context is logged once');

console.log('errorPolicy.test.mjs: ok');

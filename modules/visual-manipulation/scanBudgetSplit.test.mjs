// Shield test for TASKS 8.3: candidate classification and detection must not share one time
// budget. With a shared clock a candidate-heavy page could spend the whole budget classifying and
// then return from the very first detection check - zero elements scanned, zero findings, and a
// log line that still said "Scan completed".
// Run: node modules/visual-manipulation/scanBudgetSplit.test.mjs

import assert from 'node:assert/strict';

// Every performance.now() call advances the clock by one unit, so "time" is the number of budget
// checks made. That makes the budget arithmetic exact and the test independent of real timing.
let clock = 0;
globalThis.performance = {
    now() {
        clock += 1;
        return clock;
    }
};

const { default: VisualManipulationDetector } = await import('./VisualManipulationDetector.js');

function createHarness(entryCount) {
    const scanned = [];
    const entries = [];
    for (let index = 0; index < entryCount; index += 1) {
        entries.push([{ index }, 1]);
    }

    const harness = {
        scanTimeBudgetReached: 0,
        partialResult: false,
        currentScanCache: null,
        isEnabled: true,
        // Слайсинг (C2): бюджеты теперь считаются по активной работе, а уступки в этом стенде не
        // нужны - он проверяет ДЕЛЕНИЕ бюджета, а не нарезку. Потолок куска поднят в бесконечность,
        // поэтому shouldYieldSlice() всегда false, и арифметика остаётся ровно прежней: каждое
        // обращение к часам - одна единица бюджета.
        getScanActiveMs() { return performance.now(); },
        shouldYieldSlice() { return false; },
        async yieldSlice() {},
        getCandidatePriority() {
            throw new Error('priority must come from the entry, not be recomputed (TASKS 8.2)');
        },
        scanElement(element) {
            scanned.push(element);
        }
    };

    return { harness, entries, scanned };
}

const scanCandidates = VisualManipulationDetector.prototype.scanCandidates;

// --- classification cannot starve detection -----------------------------------------------------

clock = 0;
const busy = createHarness(1000);
await scanCandidates.call(busy.harness, busy.entries, 60);

assert.ok(busy.scanned.length > 0, 'detection must scan candidates even when classification hits its budget');
assert.ok(busy.harness.partialResult, 'a truncated scan must be reported as partial');
assert.ok(busy.harness.scanTimeBudgetReached >= 1, 'the budget stop must be counted');
// Classification gets 25% of 60 = 15 ticks and costs one tick per entry, so it buckets 14 of the
// 1000 candidates. Detection then starts its own 45-tick clock and scans every one of them - under
// a shared clock the budget was already spent and this number was zero.
assert.equal(busy.scanned.length, 14, `expected the classified candidates to be scanned, got ${busy.scanned.length}`);

// --- detection stops on its own budget, not on the classification one ---------------------------

clock = 0;
const heavy = createHarness(1000);
heavy.harness.scanElement = (element) => {
    // Four extra clock reads stand in for detector work, so each detection step costs five ticks.
    for (let index = 0; index < 4; index += 1) {
        performance.now();
    }
    heavy.scanned.push(element);
};
await scanCandidates.call(heavy.harness, heavy.entries, 60);

assert.ok(heavy.scanned.length > 0, 'expensive detection must still scan something');
assert.ok(
    heavy.scanned.length < busy.scanned.length,
    `detection must stop on its own budget, scanned ${heavy.scanned.length}`
);
assert.ok(
    heavy.scanned.length >= 8 && heavy.scanned.length <= 10,
    `expected ~45/5 detection steps, got ${heavy.scanned.length}`
);
assert.ok(heavy.harness.partialResult, 'a detection-truncated scan must be reported as partial');

// --- a scan that fits the budget stays complete --------------------------------------------------

clock = 0;
const small = createHarness(10);
await scanCandidates.call(small.harness, small.entries, 60);

assert.equal(small.scanned.length, 10, 'every candidate must be scanned when the budget is ample');
assert.equal(small.harness.partialResult, false, 'a complete scan must not be marked partial');
assert.equal(small.harness.scanTimeBudgetReached, 0, 'no budget stop expected');
assert.equal(small.harness.currentScanCache, null, 'the scan-local cache must be dropped');

// --- the mutation path shape (priority not yet known) --------------------------------------------

clock = 0;
const lazy = createHarness(5);
let priorityCalls = 0;
lazy.harness.getCandidatePriority = () => {
    priorityCalls += 1;
    return 2;
};
await scanCandidates.call(lazy.harness, lazy.entries.map(([element]) => [element, null]), 60);

assert.equal(priorityCalls, 5, 'entries without a known priority must be classified once each');
assert.equal(lazy.scanned.length, 5, 'lazily classified candidates must still be scanned');

console.log('scanBudgetSplit.test.mjs: ok');

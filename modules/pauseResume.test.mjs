// Shield for the pause/resume contract (root TASKS C1 + C2, 2026-09-07).
// A background tab used to be handled with destroy(), so returning to it re-ran init() + firstScan()
// for every module. Measured on the stand: on an unchanged page nine of ten switches produced not a
// single new finding. Pause keeps the module alive; the rescan is skipped only when the document
// provably did not change.
// The safety property this file exists to protect: a PAUSED MODULE DOES NO WORK. Everything else
// here is about not making that worse while making the return cheaper.
// Run: node modules/pauseResume.test.mjs

import assert from 'node:assert/strict';

let observedTargets = [];

globalThis.performance = { now: () => 0 };
globalThis.MutationObserver = class {
    constructor(callback) {
        this.callback = callback;
        this.connected = false;
    }

    observe(target) {
        this.connected = true;
        observedTargets.push(target);
    }

    disconnect() {
        this.connected = false;
        observedTargets = observedTargets.filter((entry) => entry !== this.target);
    }

    takeRecords() {
        return [];
    }
};
globalThis.document = { documentElement: { children: [] } };

const { default: ModuleCore } = await import('./ModuleCore.js');
const { Logger } = await import('../utils/logger.js');
Logger.setLevel('silent');

class TestModule extends ModuleCore {
    constructor(name = 'Test') {
        super(name, true);
        this.usesMutationObserver = true;
        this.scans = 0;
        this.findings = ['finding-from-the-first-scan'];
        this.timerRunning = false;
        this.queue = ['queued-root'];
    }

    // Every real module starts firstScan with this guard - checked across all five before this
    // design relied on it. `isEnabled = false` is therefore what actually stops a paused module.
    async firstScan() {
        if (!this.isEnabled) {
            return;
        }
        this.scans += 1;
        this.timerRunning = true;
    }

    onDestroy() {
        this.timerRunning = false;
        this.queue = [];
        this.findings = [];
    }
}

class StatefulModule extends TestModule {
    constructor() {
        super('Stateful');
        this.keepsStateWhilePaused = true;
    }

    // Stops the work, keeps the results - the only shape in which skipping a rescan is correct.
    onPause() {
        this.timerRunning = false;
        this.queue = [];
    }
}

// --- 1. A paused module does no work ------------------------------------------------------------
{
    const module = new TestModule();
    await module.init();
    assert.equal(module.scans, 1, 'init scans once');

    module.pause();

    assert.equal(module.isEnabled, false, 'a paused module must read as not enabled - every guard checks it');
    assert.equal(module.isPaused, true, 'and must be distinguishable from a disabled one');
    assert.equal(module.observer, null, 'the observer must be disconnected');
    assert.equal(module.timerRunning, false, 'scheduled work must be stopped');
    assert.deepEqual(module.queue, [], 'queued work must be dropped');

    // Anything that arrives after the pause must not restart the pipeline.
    module.handleMutations([{ type: 'childList', addedNodes: [] }]);
    await module.runExplicitScan();
    assert.equal(module.scans, 1, 'nothing may scan while paused - not even an explicit scan request');
}

// --- 2. Default behaviour is exactly what it was before pause existed ---------------------------
{
    const module = new TestModule();
    await module.init();
    module.pause();

    assert.deepEqual(module.findings, [], 'onPause defaults to onDestroy: state is dropped as before');

    await module.resume();
    assert.equal(module.scans, 2, 'a module that keeps nothing must be rescanned on resume');
    assert.equal(module.isEnabled, true);
    assert.equal(module.isPaused, false);
    assert.ok(module.observer, 'the observer must be back');
}

// --- 3. A module that keeps its state may be resumed without a rescan ---------------------------
{
    const module = new StatefulModule();
    await module.init();
    const findingsBefore = [...module.findings];

    module.pause();
    assert.deepEqual(module.findings, findingsBefore, 'the results survive the pause');
    assert.equal(module.timerRunning, false, 'but the work does not');

    await module.resume({ rescan: false });
    assert.equal(module.scans, 1, 'an unchanged document must not be scanned again');
    assert.deepEqual(module.findings, findingsBefore, 'and the findings are still there to report');
    assert.ok(module.observer, 'the observer must be back even without a rescan');
    assert.equal(module.isInitialized, true, 'the module counts as initialised again');
}

// --- 4. rescan: true still works for a stateful module ------------------------------------------
{
    const module = new StatefulModule();
    await module.init();
    module.pause();
    await module.resume({ rescan: true });
    assert.equal(module.scans, 2, 'a changed document is rescanned');
}

// --- 5. In-flight work from before the pause cannot publish afterwards --------------------------
{
    const module = new TestModule();
    const revisionBefore = module.lifecycleRevision;
    await module.init();
    module.pause();
    assert.ok(module.lifecycleRevision > revisionBefore, 'pause must stale in-flight passes');

    const revisionPaused = module.lifecycleRevision;
    await module.resume();
    assert.ok(module.lifecycleRevision > revisionPaused, 'resume starts its own generation');
}

// --- 6. A failing resume scan is level 2, not a dead module -------------------------------------
{
    const module = new TestModule();
    await module.init();
    module.pause();
    module.firstScan = async () => {
        throw new Error('resume scan exploded');
    };

    let threw = false;
    try {
        await module.resume();
    } catch {
        threw = true;
    }

    assert.equal(threw, false, 'a failed resume must not reject');
    assert.equal(module.scanFailed, true, 'it must be recorded as a scan failure');
    assert.equal(module.isEnabled, true, 'and must not disable the module');
}

// --- 7. destroy() still clears the paused state -------------------------------------------------
{
    const module = new StatefulModule();
    await module.init();
    module.pause();
    module.destroy();

    assert.equal(module.isPaused, false, 'a destroyed module is not a paused one');
    assert.deepEqual(module.findings, [], 'destroy drops the state a pause kept');
    assert.equal(module.isEnabled, false);
}

// --- 8. Pausing twice is not a second teardown --------------------------------------------------
{
    const module = new StatefulModule();
    await module.init();
    module.pause();
    module.queue = ['arrived-somehow'];
    module.pause();
    assert.deepEqual(module.queue, [], 'a repeated pause is harmless and still stops work');
    assert.equal(module.scans, 1);
}

console.log('pauseResume.test.mjs: OK');

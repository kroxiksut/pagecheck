// Shield for the C5.1 contract (root TASKS): a module runs ONE analysis pass at a time.
// Configuration revisions cannot express this - two passes of the same configuration carry the same
// configRevision and lifecycleRevision, so isScanConfigurationCurrent() calls both current and
// cancels neither. They then overwrite each other's scan state, findings and telemetry.
// Run: node modules/scanExclusion.test.mjs

import assert from 'node:assert/strict';

globalThis.performance = { now: () => 0 };
globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
    takeRecords() { return []; }
};
globalThis.document = { documentElement: { children: [] } };

const { default: ModuleCore } = await import('./ModuleCore.js');

function deferred() {
    let resolve;
    const promise = new Promise((resolveFn) => { resolve = resolveFn; });
    return { promise, resolve };
}

class GatedModule extends ModuleCore {
    constructor() {
        super('Gated', true);
        this.log = [];
    }
}

// --- two passes cannot overlap ------------------------------------------------------------------------

const module = new GatedModule();
const firstGate = deferred();

const firstPass = module.runGuardedScan('slow-pass', async () => {
    module.log.push('slow:start');
    await firstGate.promise;
    module.log.push('slow:end');
    return 'slow';
});

// While the first pass is awaiting, a timer-driven pass tries to enter - this is the exact shape of
// the defect: a setTimeout pipeline calling into the scan outside every lifecycle queue.
const blocked = await module.runGuardedScan('timer-pass', async () => {
    module.log.push('timer:ran-inline');
    return 'timer';
});

assert.equal(blocked.skipped, true, 'the second pass must not start while the first is running');
assert.equal(blocked.reason, 'scan-in-progress');
assert.equal(module.scanReentryBlocked, 1, 'the blocked entry must be counted, not silently dropped');
assert.ok(!module.log.includes('timer:ran-inline'), 'the blocked operation must not have run yet');

firstGate.resolve();
await firstPass;

// --- the blocked work is not lost: exactly one deferred rerun, running what was ASKED for -----------------

assert.deepEqual(
    module.log,
    ['slow:start', 'slow:end', 'timer:ran-inline'],
    'the deferred pass runs after the active one finishes, and runs the blocked callers operation'
);
assert.equal(module.activeScanToken, null, 'no pass is left active');
assert.equal(module.rescanRequested, false, 'and no request is left hanging');

// --- the deferred rerun happens at most once --------------------------------------------------------------

const flooded = new GatedModule();
const floodGate = deferred();
let runs = 0;

const activePass = flooded.runGuardedScan('active', async () => {
    runs += 1;
    if (runs === 1) {
        await floodGate.promise;
    }
    return runs;
});

for (let index = 0; index < 10; index += 1) {
    await flooded.runGuardedScan('flood', async () => {
        runs += 1;
        return runs;
    });
}
assert.equal(flooded.scanReentryBlocked, 10, 'every blocked entry is counted');

floodGate.resolve();
await activePass;

assert.equal(runs, 2, 'ten blocked callers collapse into exactly one deferred rerun');

// --- a token answers "is this still my pass", which revisions cannot ------------------------------------------

const tokenModule = new GatedModule();
let capturedToken = null;
await tokenModule.runGuardedScan('token-pass', async (token) => {
    capturedToken = token;
    assert.equal(tokenModule.isScanTokenCurrent(token), true, 'inside its own pass the token is current');
    assert.equal(tokenModule.isScanPassActive(), true);
});
assert.equal(tokenModule.isScanTokenCurrent(capturedToken), false, 'after the pass the token is stale');
assert.equal(tokenModule.isScanPassActive(), false);

// A pass whose module was destroyed mid-flight must not be treated as current.
const destroyedModule = new GatedModule();
await destroyedModule.runGuardedScan('doomed', async (token) => {
    destroyedModule.destroy();
    assert.equal(destroyedModule.isScanTokenCurrent(token), false, 'destroy invalidates the running pass');
});

// --- init goes through the same gate --------------------------------------------------------------------------

class InitScanModule extends ModuleCore {
    constructor() {
        super('Init-Scan', true);
        this.scanReasons = [];
    }

    async firstScan() {
        this.scanReasons.push(this.activeScanToken?.reason || 'none');
    }
}

const initModule = new InitScanModule();
await initModule.init();
assert.deepEqual(initModule.scanReasons, ['init'], 'the initial scan runs inside a guarded pass');

console.log('scanExclusion.test.mjs: ok');

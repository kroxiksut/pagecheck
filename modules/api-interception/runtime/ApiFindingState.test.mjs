import assert from 'node:assert/strict';
import ApiFindingState from './ApiFindingState.js';

const documentDecision = Object.freeze({
    type: 'image-resource-declared-mime-anomaly',
    category: 'document',
    severity: 'low'
});
const scriptDecision = Object.freeze({
    type: 'image-resource-declared-mime-anomaly',
    category: 'script',
    severity: 'low'
});

const state = new ApiFindingState();
assert.deepEqual(state.getCandidateSnapshot(), {
    schemaVersion: 1,
    mode: 'candidate',
    revision: 0,
    partial: false,
    candidates: []
});
assert.equal(Object.isFrozen(state.getCandidateSnapshot()), true);
assert.equal(Object.isFrozen(state.getCandidateSnapshot().candidates), true);
assert.deepEqual(state.getProductSnapshot().findings, []);
assert.equal(state.getProductSnapshot().mode, 'candidate');

let snapshot = state.applyDecisions([documentDecision, documentDecision, scriptDecision], {
    navigationRevision: 7
});
assert.equal(snapshot.revision, 1);
assert.deepEqual(snapshot.candidates, [
    { type: 'image-resource-declared-mime-anomaly', category: 'document', severity: 'low', occurrenceCount: 2 },
    { type: 'image-resource-declared-mime-anomaly', category: 'script', severity: 'low', occurrenceCount: 1 }
]);
assert.equal(Object.isFrozen(snapshot.candidates[0]), true);
assert.equal(JSON.stringify(snapshot).includes('Api-Interceptor'), false);
assert.equal(JSON.stringify(snapshot).includes('text/html'), false);
assert.equal(JSON.stringify(snapshot).includes('request'), false);

const unchangedRevision = snapshot.revision;
snapshot = state.applyDecisions([{ type: 'unknown', category: 'document', severity: 'low' }], {
    navigationRevision: 7
});
assert.equal(snapshot.revision, unchangedRevision);
snapshot = state.applyDecisions([documentDecision], { navigationRevision: 6 });
assert.equal(snapshot.revision, unchangedRevision);
assert.equal(snapshot.candidates[0].occurrenceCount, 2);

snapshot = state.applyDecisions(Array.from({ length: 65 }, () => documentDecision), {
    navigationRevision: 7
});
assert.equal(snapshot.partial, true);
assert.equal(snapshot.candidates[0].occurrenceCount, 66);
assert.equal(snapshot.revision, unchangedRevision + 1);

for (let index = 0; index < 20; index += 1) {
    state.applyDecisions(Array.from({ length: 64 }, () => documentDecision), { navigationRevision: 7 });
}
snapshot = state.getCandidateSnapshot();
assert.equal(snapshot.candidates[0].occurrenceCount, 999);
const cappedRevision = snapshot.revision;
snapshot = state.applyDecisions([documentDecision], { navigationRevision: 7 });
assert.equal(snapshot.candidates[0].occurrenceCount, 999);
assert.equal(snapshot.revision, cappedRevision);

snapshot = state.reset({ navigationRevision: 8 });
assert.equal(snapshot.candidates.length, 0);
assert.equal(snapshot.partial, false);
assert.equal(snapshot.revision, cappedRevision + 1);
snapshot = state.applyDecisions([scriptDecision], { navigationRevision: 8 });
assert.deepEqual(snapshot.candidates, [
    { type: 'image-resource-declared-mime-anomaly', category: 'script', severity: 'low', occurrenceCount: 1 }
]);

const copy = state.getCandidateSnapshot();
assert.notEqual(copy, state.getCandidateSnapshot());
assert.notEqual(copy.candidates, state.getCandidateSnapshot().candidates);
assert.equal(Object.isFrozen(copy.candidates[0]), true);

console.log('API finding state checks passed');

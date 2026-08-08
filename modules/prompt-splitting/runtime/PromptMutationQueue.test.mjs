import assert from 'node:assert/strict';
import PromptMutationQueue from './PromptMutationQueue.js';

function node(name) {
    return {
        name,
        connected: true,
        children: [],
        contains(other) {
            return this === other || this.children.some((child) => child.contains(other));
        }
    };
}

const root = node('root');
const child = node('child');
root.children.push(child);
const queue = new PromptMutationQueue({ maxRoots: 2, maxRemovedCandidateIds: 2 });
const isLive = (value) => value?.connected === true;

assert.equal(queue.enqueueRoot(child, isLive), true);
assert.equal(queue.enqueueRoot(root, isLive), true);
assert.equal(queue.coalescedRoots, 1);
assert.equal(queue.enqueueRemovedCandidateIds(['candidate-1', 'candidate-1', 'candidate-2']), true);
const batch = queue.takeBatch();
assert.deepEqual(batch.roots, [root]);
assert.deepEqual(batch.removedCandidateIds, ['candidate-1', 'candidate-2']);
assert.equal(queue.hasPendingWork(), false);

assert.equal(queue.enqueueRoot(root, isLive), true);
assert.equal(queue.enqueueRoot(node('second'), isLive), true);
assert.equal(queue.enqueueRoot(node('overflow'), isLive), false);
assert.equal(queue.reconciliationRequested, true);
assert.equal(queue.partial, true);
queue.clear();
assert.equal(queue.hasPendingWork(), false);

console.log('PromptMutationQueue checks passed');

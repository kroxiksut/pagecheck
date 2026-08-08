const DEFAULT_LIMITS = Object.freeze({
    maxRoots: 100,
    maxRemovedCandidateIds: 200,
    maxCounter: 1000000
});

function copyLimits(limits = {}) {
    return {
        maxRoots: Number.isInteger(limits.maxRoots) ? Math.max(0, limits.maxRoots) : DEFAULT_LIMITS.maxRoots,
        maxRemovedCandidateIds: Number.isInteger(limits.maxRemovedCandidateIds)
            ? Math.max(0, limits.maxRemovedCandidateIds)
            : DEFAULT_LIMITS.maxRemovedCandidateIds,
        maxCounter: Number.isInteger(limits.maxCounter)
            ? Math.max(1, limits.maxCounter)
            : DEFAULT_LIMITS.maxCounter
    };
}

export default class PromptMutationQueue {
    constructor(limits = {}) {
        this.limits = copyLimits(limits);
        this.roots = [];
        this.removedCandidateIds = new Set();
        this.partial = false;
        this.reconciliationRequested = false;
        this.highWaterMark = 0;
        this.coalescedRoots = 0;
        this.overflowCount = 0;
    }

    enqueueRoot(root, isLiveRoot) {
        if (typeof isLiveRoot !== 'function' || !isLiveRoot(root)) {
            return false;
        }
        for (const queuedRoot of this.roots) {
            if (queuedRoot === root || queuedRoot.contains(root)) {
                this.incrementCounter('coalescedRoots');
                return true;
            }
        }
        const retainedRoots = this.roots.filter((queuedRoot) => !root.contains(queuedRoot));
        this.incrementCounter('coalescedRoots', this.roots.length - retainedRoots.length);
        this.roots = retainedRoots;
        if (this.roots.length >= this.limits.maxRoots) {
            this.markOverflow();
            return false;
        }
        this.roots.push(root);
        this.highWaterMark = Math.max(this.highWaterMark, this.roots.length);
        return true;
    }

    enqueueRemovedCandidateIds(candidateIds) {
        for (const candidateId of candidateIds || []) {
            if (typeof candidateId !== 'string' || !candidateId) continue;
            if (this.removedCandidateIds.has(candidateId)) continue;
            if (this.removedCandidateIds.size >= this.limits.maxRemovedCandidateIds) {
                this.markOverflow();
                return false;
            }
            this.removedCandidateIds.add(candidateId);
        }
        return true;
    }

    markOverflow() {
        this.partial = true;
        this.reconciliationRequested = true;
        this.incrementCounter('overflowCount');
    }

    takeBatch() {
        const batch = {
            roots: this.roots.splice(0),
            removedCandidateIds: [...this.removedCandidateIds],
            partial: this.partial,
            reconciliationRequested: this.reconciliationRequested
        };
        this.removedCandidateIds.clear();
        this.partial = false;
        this.reconciliationRequested = false;
        return batch;
    }

    hasPendingWork() {
        return this.roots.length > 0 || this.removedCandidateIds.size > 0 || this.reconciliationRequested;
    }

    incrementCounter(name, value = 1) {
        this[name] = Math.min(this.limits.maxCounter, this[name] + Math.max(0, value));
    }

    clear() {
        this.roots.length = 0;
        this.removedCandidateIds.clear();
        this.partial = false;
        this.reconciliationRequested = false;
    }
}

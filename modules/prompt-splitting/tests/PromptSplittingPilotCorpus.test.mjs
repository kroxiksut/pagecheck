import assert from 'node:assert/strict';
import {
    PROMPT_SPLITTING_PILOT_CORPUS,
    PROMPT_SPLITTING_PILOT_CORPUS_VERSION
} from './PromptSplittingPilotCorpus.v1.mjs';

const partitions = new Map();
const ids = new Set();
for (const item of PROMPT_SPLITTING_PILOT_CORPUS) {
    assert.equal(typeof item.id, 'string');
    assert.equal(ids.has(item.id), false, `Duplicate pilot ID: ${item.id}`);
    ids.add(item.id);
    assert.equal(['calibration', 'regression', 'control'].includes(item.partition), true, `${item.id}: partition`);
    assert.equal(['en', 'ru'].includes(item.language), true, `${item.id}: language`);
    assert.equal(typeof item.fixture, 'string');
    assert.equal(Number.isInteger(item.expected.count) && item.expected.count >= 0, true, `${item.id}: count`);
    assert.equal(['complete', 'partial'].includes(item.expected.status), true, `${item.id}: status`);
    partitions.set(item.partition, (partitions.get(item.partition) || 0) + 1);
}

assert.equal(PROMPT_SPLITTING_PILOT_CORPUS_VERSION, 1);
assert.equal(partitions.get('calibration') >= 2, true);
assert.equal(partitions.get('regression') >= 2, true);
assert.equal(partitions.get('control') >= 2, true);
console.log('PromptSplitting Priority 9 pilot corpus structure checks passed.');

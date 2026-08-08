import assert from 'node:assert/strict';
import PromptDecisionEngine from '../reconstruction/PromptDecisionEngine.js';
import { PROMPT_SPLITTING_CORPUS, PROMPT_SPLITTING_CORPUS_VERSION } from './PromptSplittingCorpus.v1.mjs';

function buildCandidate(testCase) {
    const assemblyPath = testCase.assemblyPath || 'boundary-aware';
    const separator = assemblyPath === 'compact' ? '' : ' ';
    let offset = 0;
    const fragmentSpans = testCase.fragments.map((text, index) => {
        if (index > 0) offset += separator.length;
        const start = offset;
        offset += text.length;
        return {
            candidateId: `candidate-${index + 1}`,
            fragmentId: `fragment-${index + 1}`,
            start,
            end: offset
        };
    });
    const context = {
        any: {
            code: testCase.context?.code === true,
            quote: testCase.context?.quote === true,
            list: testCase.context?.list === true,
            navigation: testCase.context?.navigation === true
        },
        all: {
            code: testCase.context?.code === true,
            quote: testCase.context?.quote === true,
            list: testCase.context?.list === true,
            navigation: testCase.context?.navigation === true
        }
    };
    return {
        text: testCase.fragments.join(separator),
        sourceType: 'text',
        assemblyPath,
        regionId: `region-${testCase.id}`,
        candidateIds: testCase.fragments.map((_, index) => `candidate-${index + 1}`),
        candidateCount: testCase.fragments.length,
        fragmentCount: testCase.fragments.length,
        structuralContext: { type: 'section' },
        structuralTransitions: 0,
        context,
        sequencing: { hasStructuralMarker: false },
        partial: testCase.partial === true,
        truncated: false,
        fragmentSpans,
        sourceFragments: testCase.fragments.map((text, index) => ({
            candidateId: `candidate-${index + 1}`,
            fragmentId: `fragment-${index + 1}`,
            text
        }))
    };
}

assert.equal(PROMPT_SPLITTING_CORPUS_VERSION, 1);
assert.equal(new Set(PROMPT_SPLITTING_CORPUS.map((testCase) => testCase.id)).size, PROMPT_SPLITTING_CORPUS.length);

for (const testCase of PROMPT_SPLITTING_CORPUS) {
    const candidate = buildCandidate(testCase);
    const result = await new PromptDecisionEngine().evaluate(candidate, {}, {
        limits: { maxElapsedMs: 1000 },
        isCurrent: () => true
    });
    assert.equal(result.status, testCase.expected.status, `${testCase.id}: status`);
    assert.equal(result.decisions.length, testCase.expected.count, `${testCase.id}: decision count`);
    const decision = result.decisions[0];
    if (testCase.expected.count > 0) {
        assert.equal(decision?.eligibility, testCase.expected.eligibility, `${testCase.id}: eligibility`);
        assert.equal(decision?.reconstructionConfidence, testCase.expected.confidence, `${testCase.id}: confidence`);
    }
    if (testCase.expected.ruleId) {
        assert.equal(decision?.ruleId, testCase.expected.ruleId, `${testCase.id}: rule`);
    }
    assert.equal(candidate.text, '', `${testCase.id}: reconstructed text must be cleared`);
    assert.equal(candidate.sourceFragments.length, 0, `${testCase.id}: source text must be cleared`);
    result.dispose();
}

console.log('PromptSplitting Priority 8 corpus checks passed.');

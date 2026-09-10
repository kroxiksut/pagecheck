import assert from 'node:assert/strict';
import PromptFindingState from './PromptFindingState.js';

const decision = (overrides = {}) => ({
    eligibility: 'eligible',
    ruleId: 'authority-impersonation.en.system-directive',
    supportingRuleIds: ['agent-directed-action.en.command'],
    ruleVersion: 1,
    category: 'authority-impersonation',
    subtype: 'system-directive',
    actionGroup: 'authority-impersonation.system-directive',
    semanticSeverity: 'medium',
    semanticImpact: 'medium',
    semanticEvidenceStrength: 'strong',
    reconstructionConfidence: 'strong',
    sourceType: 'text',
    assemblyPath: 'boundary-aware',
    contributingCandidateCount: 2,
    contributingFragmentCount: 2,
    structuralEvidence: { regionType: 'section', candidateCount: 2, structuralTransitions: 0, hasStructuralMarker: false },
    reasonCodes: ['semantic-primary-match', 'distributed-required-signals'],
    mitigationCodes: [],
    partial: false,
    truncated: false,
    ...overrides
});

const evidence = (regionId, candidateIds, contributingCandidateIds = candidateIds) => ({
    regionId,
    candidateIds,
    contributingCandidateIds,
    contributingFragmentIds: candidateIds.map((candidateId) => `fragment-${candidateId}`),
    sourceType: 'text',
    assemblyPath: 'boundary-aware'
});

const state = new PromptFindingState();
const initialBatch = state.beginBatch({ scope: 'full', regionIds: ['region-a'] });
state.recordDecision(initialBatch, decision(), evidence('region-a', ['candidate-1', 'candidate-2']));
const initialCommit = state.commitBatch(initialBatch);
assert.equal(initialCommit.status, 'complete');
assert.equal(initialCommit.activeCount, 1);
assert.equal(initialCommit.findingRevision, 1);
const initialSnapshot = state.getSnapshot();
assert.equal(initialSnapshot.activeCount, 1);
assert.equal(initialSnapshot.findings[0].type, 'prompt-splitting');
assert.equal(initialSnapshot.cacheFindings[0].summary, 'findingPromptSplittingSummary');
const serialisedFinding = JSON.stringify(initialSnapshot.findings[0]);
assert.equal(serialisedFinding.includes('candidate-1'), false);
assert.equal(serialisedFinding.includes('fragment-'), false);
assert.equal(serialisedFinding.includes('internal'), false);

const repeatedBatch = state.beginBatch({ scope: 'full', regionIds: ['region-a'] });
state.recordDecision(repeatedBatch, decision(), evidence('region-a', ['candidate-1', 'candidate-2']));
const repeatedCommit = state.commitBatch(repeatedBatch);
assert.equal(repeatedCommit.materiallyChanged, false);
assert.equal(repeatedCommit.findingRevision, 1);

const overlapBatch = state.beginBatch({ scope: 'full', regionIds: ['region-a'] });
state.recordDecision(overlapBatch, decision({ assemblyPath: 'spaced', reconstructionConfidence: 'moderate' }), evidence('region-a', ['candidate-1', 'candidate-2']));
state.recordDecision(overlapBatch, decision(), evidence('region-a', ['candidate-2', 'candidate-3']));
state.recordDecision(overlapBatch, decision(), evidence('region-a', ['candidate-4', 'candidate-5']));
const overlapCommit = state.commitBatch(overlapBatch);
assert.equal(overlapCommit.activeCount, 2);
assert.equal(state.getSnapshot().findings.some((finding) => finding.contributingCandidateCount === 3), true);

const partialBatch = state.beginBatch({ scope: 'full', regionIds: ['region-a'], partial: true });
state.recordDecision(partialBatch, decision(), evidence('region-a', ['candidate-6', 'candidate-7']));
const partialCommit = state.commitBatch(partialBatch);
assert.equal(partialCommit.status, 'partial');
assert.equal(partialCommit.activeCount, 3);
assert.equal(state.getSnapshot().partialResult, true);

const regionBatch = state.beginBatch({ scope: 'region', regionIds: ['region-a'] });
state.recordDecision(regionBatch, decision({ subtype: 'replacement' }), evidence('region-a', ['candidate-8', 'candidate-9']));
const regionCommit = state.commitBatch(regionBatch);
assert.equal(regionCommit.status, 'complete');
assert.equal(state.getSnapshot().activeCount, 1);
assert.equal(state.getSnapshot().findings[0].subtype, 'replacement');

const revisionBeforeAbort = state.getSnapshot().findingRevision;
const abortedBatch = state.beginBatch({ scope: 'full', regionIds: ['region-a'] });
state.recordDecision(abortedBatch, decision(), evidence('region-a', ['candidate-10', 'candidate-11']));
assert.equal(state.commitBatch(abortedBatch, { isCurrent: () => false }).status, 'aborted');
assert.equal(state.getSnapshot().findingRevision, revisionBeforeAbort);

const removed = state.removeCandidates(['candidate-8']);
assert.equal(removed, true);
assert.equal(state.getSnapshot().activeCount, 0);

const limitedState = new PromptFindingState({ maxActiveFindings: 1 });
const limitedBatch = limitedState.beginBatch({ scope: 'full', regionIds: ['region-a'] });
limitedState.recordDecision(limitedBatch, decision(), evidence('region-a', ['candidate-1', 'candidate-2']));
limitedState.recordDecision(limitedBatch, decision({ subtype: 'independent' }), evidence('region-a', ['candidate-3', 'candidate-4']));
const limitedCommit = limitedState.commitBatch(limitedBatch);
assert.equal(limitedCommit.status, 'partial');
assert.equal(limitedState.getSnapshot().activeCount, 1);
assert.equal(limitedState.getSnapshot().partialResult, true);


// --- Ответ recordDecision: принято или отброшено (C4.3) -----------------------------------------
// Метод возвращал undefined на всех путях, и «находка принята» было неотличимо от «отброшена по
// лимиту». Ответ нужен вызывающему: узел региона отдаётся слою вмешательства ТОЛЬКО по принятой
// находке, иначе страница получила бы метку о находке, которой в отчёте нет.

const answerState = new PromptFindingState();
const answerBatch = answerState.beginBatch({ scope: 'full', regionIds: ['region-answer'] });

assert.equal(
    answerState.recordDecision(answerBatch, decision(), evidence('region-answer', ['candidate-1', 'candidate-2'])),
    true,
    'новая находка обязана отвечать «принято»'
);
assert.equal(
    answerState.recordDecision(answerBatch, decision({ reconstructionConfidence: 'moderate' }), evidence('region-answer', ['candidate-2', 'candidate-3'])),
    true,
    'слияние с существующей находкой - это тоже принятие: находка в отчёте есть'
);
assert.equal(
    answerState.recordDecision(answerBatch, decision({ eligibility: 'suppressed' }), evidence('region-answer', ['candidate-1', 'candidate-2'])),
    false,
    'подавленное решение находкой не становится'
);
assert.equal(
    answerState.recordDecision(answerBatch, decision(), evidence('region-answer', ['candidate-9'])),
    false,
    'решение с одним вкладчиком отбрасывается: распределённого промпта из одного куска не бывает'
);
assert.equal(
    answerState.recordDecision(answerBatch, decision(), { regionId: '', candidateIds: ['a', 'b'], contributingCandidateIds: ['a', 'b'] }),
    false,
    'решение без региона отбрасывается'
);

// Отказ по лимиту - это `partial`, а не находка, и отвечать он обязан «не принято».
const cappedState = new PromptFindingState({ maxPendingFindings: 1 });
const cappedBatch = cappedState.beginBatch({ scope: 'full', regionIds: ['region-1', 'region-2'] });
assert.equal(
    cappedState.recordDecision(cappedBatch, decision(), evidence('region-1', ['candidate-1', 'candidate-2'])),
    true,
    'первая находка помещается в батч'
);
assert.equal(
    cappedState.recordDecision(cappedBatch, decision({ actionGroup: 'other.group' }), evidence('region-2', ['candidate-3', 'candidate-4'])),
    false,
    'находка, не поместившаяся в батч, обязана отвечать «не принято» - иначе слой пометит регион, о котором мы не отчитались'
);
assert.equal(cappedBatch.partial, true, 'отказ по лимиту обязан взводить partial');

console.log('PromptFindingState Priority 6 checks passed.');

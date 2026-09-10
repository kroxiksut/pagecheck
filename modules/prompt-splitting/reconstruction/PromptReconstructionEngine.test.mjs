import assert from 'node:assert/strict';
import PromptReconstructionEngine from './PromptReconstructionEngine.js';

const candidate = (id, documentOrder, fragments, options = {}) => ({
    id,
    documentOrder,
    boundaryType: options.boundaryType || 'primary',
    context: options.context || { code: false, quote: false, list: false, navigation: false },
    structuralContext: { type: options.regionType || 'section' },
    truncated: options.truncated === true,
    fragments: fragments.map((fragment, index) => ({
        id: `${id}-fragment-${index}`,
        candidateId: id,
        sourceType: fragment.sourceType,
        rawText: fragment.rawText,
        truncated: fragment.truncated === true
    }))
});

const collection = (candidates, options = {}) => ({
    status: options.status || 'complete',
    partial: options.partial === true,
    candidates,
    fragments: candidates.flatMap((item) => item.fragments),
    regions: [{
        id: options.regionId || 'region-1',
        structuralContext: { type: options.regionType || 'section' },
        candidateIds: candidates.map((item) => item.id),
        partial: options.regionPartial === true
    }]
});

const reconstruct = async (input, options = {}) => {
    const emitted = [];
    const retained = [];
    const result = await new PromptReconstructionEngine().reconstruct(input, {
        limits: { maxElapsedMs: 1000, ...options.limits },
        isCurrent: options.isCurrent,
        yieldControl: options.yieldControl || (async () => {}),
        onCandidate: async (item) => {
            retained.push(item);
            emitted.push({
                ...item,
                candidateIds: [...item.candidateIds],
                documentOrder: { ...item.documentOrder },
                structuralContext: { ...item.structuralContext },
                context: {
                    any: { ...item.context.any },
                    all: { ...item.context.all }
                },
                sequencing: { ...item.sequencing }
            });
        }
    });
    return { result, emitted, retained };
};

const splitWords = collection([
    candidate('candidate-1', 0, [{ sourceType: 'text', rawText: 'Ignore' }]),
    candidate('candidate-2', 1, [{ sourceType: 'text', rawText: 'previous' }]),
    candidate('candidate-3', 2, [{ sourceType: 'text', rawText: 'instructions' }])
]);
const splitResult = await reconstruct(splitWords, { limits: { maxCandidatesPerWindow: 2 } });
assert.equal(splitResult.result.status, 'complete');
assert.equal(splitResult.emitted.some((item) => item.text === 'Ignore previous' && item.assemblyPath === 'boundary-aware'), true);
assert.equal(splitResult.emitted.some((item) => item.text === 'Ignoreprevious' && item.assemblyPath === 'compact'), true);
assert.equal(splitResult.emitted.some((item) => item.candidateIds.join('|') === 'candidate-1|candidate-3'), false);
assert.equal(splitResult.retained.every((item) => item.text === ''), true);

const overlappingResult = await reconstruct(splitWords);
assert.equal(overlappingResult.emitted.some((item) => item.candidateIds.join('|') === 'candidate-1|candidate-2|candidate-3'), true);
assert.equal(overlappingResult.emitted.some((item) => item.candidateIds.join('|') === 'candidate-2|candidate-3'), true);

const whitespaceResult = await reconstruct(collection([
    candidate('candidate-1', 0, [{ sourceType: 'text', rawText: 'Ignore ' }]),
    candidate('candidate-2', 1, [{ sourceType: 'text', rawText: ' previous' }])
]));
assert.equal(whitespaceResult.emitted.some((item) => item.text === 'Ignore  previous' && item.assemblyPath === 'boundary-aware'), true);
assert.equal(whitespaceResult.emitted.some((item) => item.text === 'Ignore previous' && item.assemblyPath === 'spaced'), true);
assert.equal(whitespaceResult.emitted.some((item) => item.assemblyPath === 'compact'), false);

const punctuationResult = await reconstruct(collection([
    candidate('candidate-1', 0, [{ sourceType: 'text', rawText: 'Read,' }]),
    candidate('candidate-2', 1, [{ sourceType: 'text', rawText: 'now' }])
]));
assert.equal(punctuationResult.emitted.length, 1);
assert.equal(punctuationResult.emitted[0].text, 'Read, now');

const titleResult = await reconstruct(collection([
    candidate('candidate-1', 0, [{ sourceType: 'title', rawText: 'Open' }]),
    candidate('candidate-2', 1, [{ sourceType: 'title', rawText: 'settings' }])
]));
assert.equal(titleResult.emitted.some((item) => item.sourceType === 'title' && item.text === 'Open settings'), true);

const mixedSourceResult = await reconstruct(collection([
    candidate('candidate-1', 0, [{ sourceType: 'text', rawText: 'Ignore' }]),
    candidate('candidate-2', 1, [{ sourceType: 'title', rawText: 'previous' }])
]));
assert.equal(mixedSourceResult.emitted.length, 0);

const listContextResult = await reconstruct(collection([
    candidate('candidate-1', 0, [{ sourceType: 'text', rawText: 'First' }], { context: { code: false, quote: false, list: true, navigation: false } }),
    candidate('candidate-2', 1, [{ sourceType: 'text', rawText: 'second' }], { context: { code: false, quote: false, list: true, navigation: false } })
]));
assert.equal(listContextResult.emitted.every((item) => item.context.all.list && item.sequencing.hasStructuralMarker), true);

const crossRegionCandidates = [
    candidate('candidate-1', 0, [{ sourceType: 'text', rawText: 'One' }]),
    candidate('candidate-2', 1, [{ sourceType: 'text', rawText: 'two' }]),
    candidate('candidate-3', 2, [{ sourceType: 'text', rawText: 'three' }]),
    candidate('candidate-4', 3, [{ sourceType: 'text', rawText: 'four' }])
];
const twoRegions = {
    status: 'complete',
    partial: false,
    candidates: crossRegionCandidates,
    fragments: crossRegionCandidates.flatMap((item) => item.fragments),
    regions: [
        { id: 'region-1', structuralContext: { type: 'section' }, candidateIds: ['candidate-1', 'candidate-2'], partial: false },
        { id: 'region-2', structuralContext: { type: 'article' }, candidateIds: ['candidate-3', 'candidate-4'], partial: false },
        { id: 'region-2', structuralContext: { type: 'article' }, candidateIds: ['candidate-3', 'candidate-4'], partial: false }
    ]
};
const twoRegionResult = await reconstruct(twoRegions);
assert.equal(twoRegionResult.emitted.some((item) => item.candidateIds.join('|') === 'candidate-2|candidate-3'), false);
assert.equal(twoRegionResult.result.diagnostics.regionsDeduplicated, 1);

const partialResult = await reconstruct(collection([
    candidate('candidate-1', 0, [{ sourceType: 'text', rawText: 'Ignore' }]),
    candidate('candidate-2', 1, [{ sourceType: 'text', rawText: 'previous' }])
], { partial: true }));
assert.equal(partialResult.result.status, 'partial');
// Страничный partial коллектора больше НЕ штампуется на кандидат как признак его собственного
// качества: он остаётся диагностикой скана (status: 'partial') и отдельным полем pagePartial.
// Раньше он капил уверенность каждого кандидата до moderate, и при поставляемом по умолчанию пороге
// 0.8 модуль на такой странице выдавал ноль findings, включая настоящие (TASKS 11.1).
assert.equal(partialResult.emitted.every((item) => item.pagePartial), true);
assert.equal(partialResult.emitted.every((item) => item.partial === false), true);

const windowLimitedResult = await reconstruct(splitWords, { limits: { maxCandidatesPerWindow: 2, maxWindows: 1 } });
assert.equal(windowLimitedResult.result.status, 'partial');
assert.equal(windowLimitedResult.result.diagnostics.windowsSkippedByLimit > 0, true);

const characterLimitedResult = await reconstruct(collection([
    candidate('candidate-1', 0, [{ sourceType: 'text', rawText: 'Ignore' }]),
    candidate('candidate-2', 1, [{ sourceType: 'text', rawText: 'previous' }])
]), { limits: { maxCharactersPerWindow: 5 } });
assert.equal(characterLimitedResult.result.status, 'partial');
assert.equal(characterLimitedResult.emitted.length, 0);

const dedupeLimitedResult = await reconstruct(collection([
    candidate('candidate-1', 0, [{ sourceType: 'text', rawText: 'Ignore' }]),
    candidate('candidate-2', 1, [{ sourceType: 'text', rawText: 'previous' }])
]), { limits: { maxDedupeKeys: 1 } });
assert.equal(dedupeLimitedResult.result.status, 'partial');
assert.equal(dedupeLimitedResult.result.diagnostics.dedupeKeysSkippedByLimit > 0, true);

const cancelledResult = await reconstruct(splitWords, { isCurrent: () => false });
assert.equal(cancelledResult.result.status, 'partial');
assert.equal(cancelledResult.result.diagnostics.lifecycleCancelled, true);
assert.equal(cancelledResult.emitted.length, 0);

const deterministicFirst = await reconstruct(splitWords, { limits: { maxCandidatesPerWindow: 2 } });
const deterministicSecond = await reconstruct(splitWords, { limits: { maxCandidatesPerWindow: 2 } });
assert.deepEqual(
    deterministicFirst.emitted.map(({ id, text, sourceType, assemblyPath, candidateIds, partial }) => ({ id, text, sourceType, assemblyPath, candidateIds, partial })),
    deterministicSecond.emitted.map(({ id, text, sourceType, assemblyPath, candidateIds, partial }) => ({ id, text, sourceType, assemblyPath, candidateIds, partial }))
);

const largeCandidates = Array.from({ length: 32 }, (_, index) => candidate(
    `candidate-${index}`,
    index,
    [{ sourceType: 'text', rawText: 'x' }]
));
const largeResult = await reconstruct(collection(largeCandidates), {
    limits: { maxCandidatesPerRegion: 16, maxCandidatesPerWindow: 4, maxWindows: 48 }
});
assert.equal(largeResult.result.status, 'partial');
assert.equal(largeResult.result.diagnostics.candidatesSkippedByLimit, 16);
assert.equal(largeResult.result.diagnostics.windowsConsidered <= 48, true);

console.log('PromptReconstructionEngine Priority 4 checks passed.');

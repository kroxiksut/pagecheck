const DEFAULT_LIMITS = Object.freeze({
    maxRegions: 80,
    maxCandidatesPerRegion: 16,
    maxStartsPerRegion: 16,
    maxCandidatesPerWindow: 4,
    maxWindowsPerRegion: 48,
    maxWindows: 1000,
    maxAssemblyVariants: 3,
    maxCharactersPerWindow: 4096,
    maxTotalCharacters: 100000,
    maxStructuralTransitions: 3,
    maxDedupeKeys: 1024,
    maxElapsedMs: 35,
    workSliceWindows: 16,
    workSliceMs: 8
});

function copyLimits(limits = {}) {
    const result = {};
    for (const [key, fallback] of Object.entries(DEFAULT_LIMITS)) {
        result[key] = Number.isInteger(limits[key]) ? Math.max(0, limits[key]) : fallback;
    }
    return result;
}

function emptyDiagnostics() {
    return {
        regionsSeen: 0,
        regionsProcessed: 0,
        regionsDeduplicated: 0,
        candidatesSkippedByLimit: 0,
        startsSkippedByLimit: 0,
        windowsConsidered: 0,
        windowsEmitted: 0,
        windowsSkippedByLimit: 0,
        variantsBuilt: 0,
        variantsDeduplicated: 0,
        charactersReconstructed: 0,
        dedupeKeysSkippedByLimit: 0,
        lifecycleCancelled: false,
        elapsedBudgetReached: false,
        partial: false,
        workSlices: 0
    };
}

function isTokenCharacter(character) {
    return /^[\p{L}\p{N}]$/u.test(character);
}

function edgeCharacter(text, fromEnd) {
    const trimmed = text.trim();
    if (!trimmed) return '';
    return fromEnd ? trimmed.at(-1) : trimmed[0];
}

function hasBoundaryWhitespace(left, right) {
    return /\s$/u.test(left) || /^\s/u.test(right);
}

function boundarySeparator(left, right) {
    if (hasBoundaryWhitespace(left, right)) return '';
    const leftEdge = edgeCharacter(left, true);
    const rightEdge = edgeCharacter(right, false);
    if (/[([{«'"\-]$/u.test(leftEdge) || /^[,.;:!?\])}»'"\-]/u.test(rightEdge)) return '';
    return ' ';
}

function assembleVariant(parts, assemblyPath) {
    let text = '';
    const fragmentSpans = [];
    for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index];
        if (index > 0) {
            if (assemblyPath === 'boundary-aware') {
                text += boundarySeparator(parts[index - 1].rawText, part.rawText);
            } else if (assemblyPath === 'spaced') {
                text += ' ';
            }
        }
        const fragmentText = assemblyPath === 'boundary-aware' ? part.rawText : part.rawText.trim();
        const start = text.length;
        text += fragmentText;
        fragmentSpans.push({ candidateId: part.candidateId, fragmentId: part.fragmentId, start, end: text.length });
    }
    return { assemblyPath, text, fragmentSpans };
}

function buildAssemblyVariants(parts, maxVariants) {
    if (parts.length < 2 || maxVariants === 0) return [];
    const compactAllowed = parts.every((part, index) => index === 0 || (
        !hasBoundaryWhitespace(parts[index - 1].rawText, part.rawText)
        && isTokenCharacter(edgeCharacter(parts[index - 1].rawText, true))
        && isTokenCharacter(edgeCharacter(part.rawText, false))
    ));
    const variants = [
        assembleVariant(parts, 'boundary-aware'),
        assembleVariant(parts, 'spaced')
    ];
    if (compactAllowed) {
        variants.push(assembleVariant(parts, 'compact'));
    }
    const uniqueTexts = new Set();
    return variants.filter((variant) => {
        if (!variant.text || uniqueTexts.has(variant.text) || uniqueTexts.size >= maxVariants) return false;
        uniqueTexts.add(variant.text);
        return true;
    });
}

function createContext(candidates) {
    const names = ['code', 'quote', 'list', 'navigation'];
    const any = {};
    const all = {};
    for (const name of names) {
        any[name] = candidates.some((candidate) => candidate.context?.[name] === true);
        all[name] = candidates.every((candidate) => candidate.context?.[name] === true);
    }
    return { any, all };
}

export default class PromptReconstructionEngine {
    async reconstruct(collection, options = {}) {
        const limits = copyLimits(options.limits);
        const isCurrent = typeof options.isCurrent === 'function' ? options.isCurrent : () => true;
        const yieldControl = typeof options.yieldControl === 'function'
            ? options.yieldControl
            : () => new Promise((resolve) => setTimeout(resolve, 0));
        const onCandidate = typeof options.onCandidate === 'function' ? options.onCandidate : async () => {};
        const diagnostics = emptyDiagnostics();
        const candidateById = new Map((collection?.candidates || []).map((candidate) => [candidate.id, candidate]));
        const fragmentsByCandidateId = new Map();
        for (const fragment of collection?.fragments || []) {
            if (!fragmentsByCandidateId.has(fragment.candidateId)) fragmentsByCandidateId.set(fragment.candidateId, []);
            fragmentsByCandidateId.get(fragment.candidateId).push(fragment);
        }
        const startedAt = performance.now();
        const dedupeKeys = new Set();
        const processedRegionIds = new Set();
        let nextReconstructedId = 1;
        let windowsSinceYield = 0;

        const markPartial = () => {
            diagnostics.partial = true;
        };
        const isElapsed = () => {
            if (performance.now() - startedAt <= limits.maxElapsedMs) return false;
            diagnostics.elapsedBudgetReached = true;
            markPartial();
            return true;
        };
        const getFragment = (candidate, sourceType) => (fragmentsByCandidateId.get(candidate.id) || [])
            .find((fragment) => fragment.sourceType === sourceType);
        const createResult = (status) => ({
            status,
            partial: status === 'partial' || status === 'error',
            diagnostics,
            dispose: () => {
                dedupeKeys.clear();
                processedRegionIds.clear();
            }
        });

        try {
            if (!collection || !Array.isArray(collection.regions) || collection.status === 'error') {
                return createResult('error');
            }
            if (collection.partial || collection.status === 'partial') markPartial();

            const regionLimit = Math.min(collection.regions.length, limits.maxRegions);
            if (collection.regions.length > regionLimit) markPartial();
            for (let regionIndex = 0; regionIndex < regionLimit; regionIndex += 1) {
                if (!isCurrent()) {
                    diagnostics.lifecycleCancelled = true;
                    markPartial();
                    break;
                }
                if (isElapsed()) break;
                diagnostics.regionsSeen += 1;
                const region = collection.regions[regionIndex];
                if (processedRegionIds.has(region.id)) {
                    // Любой выброшенный регион - это непроанализированная часть страницы (C5.2 в
                    // корневом TASKS). Раньше эта ветка меняла только счётчик, поэтому скан, молча
                    // выбросивший половину регионов, отчитывался status: 'complete', и коммит
                    // считался авторитетным - то есть дефект 11.2 маскировался именно тем, что
                    // должно было его показать (TASKS 11.3).
                    diagnostics.regionsDeduplicated += 1;
                    markPartial();
                    continue;
                }
                if (processedRegionIds.size >= limits.maxDedupeKeys) {
                    diagnostics.dedupeKeysSkippedByLimit += 1;
                    markPartial();
                    break;
                }
                processedRegionIds.add(region.id);
                const sourceCandidates = (region.candidateIds || [])
                    .map((candidateId) => candidateById.get(candidateId))
                    .filter(Boolean)
                    .sort((left, right) => left.documentOrder - right.documentOrder);
                const candidateLimit = Math.min(sourceCandidates.length, limits.maxCandidatesPerRegion);
                if (sourceCandidates.length > candidateLimit) {
                    diagnostics.candidatesSkippedByLimit += sourceCandidates.length - candidateLimit;
                    markPartial();
                }
                const candidates = sourceCandidates.slice(0, candidateLimit);
                if (candidates.length < 2) continue;
                diagnostics.regionsProcessed += 1;
                const sourceTypes = new Set();
                for (const candidate of candidates) {
                    for (const fragment of fragmentsByCandidateId.get(candidate.id) || []) sourceTypes.add(fragment.sourceType);
                }
                let windowsInRegion = 0;
                const startLimit = Math.min(candidates.length - 1, limits.maxStartsPerRegion);
                if (candidates.length - 1 > startLimit) {
                    diagnostics.startsSkippedByLimit += candidates.length - 1 - startLimit;
                    markPartial();
                }
                for (const sourceType of sourceTypes) {
                    for (let start = 0; start < startLimit; start += 1) {
                        if (!isCurrent()) {
                            diagnostics.lifecycleCancelled = true;
                            markPartial();
                            break;
                        }
                        if (isElapsed()) break;
                        const windowCandidates = [];
                        const parts = [];
                        let structuralTransitions = 0;
                        let windowCharacters = 0;
                        for (let offset = 0; offset < limits.maxCandidatesPerWindow && start + offset < candidates.length; offset += 1) {
                            const candidate = candidates[start + offset];
                            const fragment = getFragment(candidate, sourceType);
                            if (!fragment) break;
                            if (offset > 0 && candidate.boundaryType !== windowCandidates[offset - 1].boundaryType) structuralTransitions += 1;
                            if (structuralTransitions > limits.maxStructuralTransitions) {
                                diagnostics.windowsSkippedByLimit += 1;
                                markPartial();
                                break;
                            }
                            const nextLength = windowCharacters + fragment.rawText.length;
                            if (nextLength > limits.maxCharactersPerWindow) {
                                diagnostics.windowsSkippedByLimit += 1;
                                markPartial();
                                break;
                            }
                            windowCandidates.push(candidate);
                            parts.push({
                                candidateId: candidate.id,
                                fragmentId: fragment.id,
                                rawText: fragment.rawText
                            });
                            windowCharacters = nextLength;
                            if (windowCandidates.length < 2) continue;
                            if (windowsInRegion >= limits.maxWindowsPerRegion || diagnostics.windowsConsidered >= limits.maxWindows) {
                                diagnostics.windowsSkippedByLimit += 1;
                                markPartial();
                                break;
                            }
                            diagnostics.windowsConsidered += 1;
                            windowsInRegion += 1;
                            windowsSinceYield += 1;
                            const variants = buildAssemblyVariants(parts, limits.maxAssemblyVariants);
                            diagnostics.variantsBuilt += variants.length;
                            const localTexts = new Set();
                            for (const variant of variants) {
                                if (localTexts.has(variant.text)) {
                                    diagnostics.variantsDeduplicated += 1;
                                    continue;
                                }
                                localTexts.add(variant.text);
                                const dedupeKey = `${region.id}|${windowCandidates[0].id}|${windowCandidates.at(-1).id}|${sourceType}|${variant.assemblyPath}`;
                                if (dedupeKeys.has(dedupeKey)) {
                                    diagnostics.variantsDeduplicated += 1;
                                    continue;
                                }
                                if (dedupeKeys.size >= limits.maxDedupeKeys) {
                                    diagnostics.dedupeKeysSkippedByLimit += 1;
                                    markPartial();
                                    break;
                                }
                                if (diagnostics.charactersReconstructed + variant.text.length > limits.maxTotalCharacters) {
                                    diagnostics.windowsSkippedByLimit += 1;
                                    markPartial();
                                    break;
                                }
                                dedupeKeys.add(dedupeKey);
                                diagnostics.charactersReconstructed += variant.text.length;
                                const truncated = windowCandidates.some((item) => item.truncated)
                                    || windowCandidates.some((item) => getFragment(item, sourceType)?.truncated);
                                const reconstructedCandidate = {
                                    id: `reconstructed-${nextReconstructedId++}`,
                                    regionId: region.id,
                                    candidateIds: windowCandidates.map((item) => item.id),
                                    sourceType,
                                    text: variant.text,
                                    assemblyPath: variant.assemblyPath,
                                    candidateCount: windowCandidates.length,
                                    fragmentCount: windowCandidates.length,
                                    documentOrder: {
                                        start: windowCandidates[0].documentOrder,
                                        end: windowCandidates.at(-1).documentOrder
                                    },
                                    structuralContext: { ...region.structuralContext },
                                    structuralTransitions,
                                    context: createContext(windowCandidates),
                                    sequencing: {
                                        hasStructuralMarker: windowCandidates.some((item) => item.context?.list === true)
                                    },
                                    fragmentSpans: variant.fragmentSpans.map((span) => ({ ...span })),
                                    sourceFragments: parts.map((part) => ({
                                        candidateId: part.candidateId,
                                        fragmentId: part.fragmentId,
                                        text: part.rawText
                                    })),
                                    truncated,
                                    // collection.partial - СТРАНИЧНЫЙ флаг коллектора: он взводится
                                    // любым локальным событием где угодно на странице (бюджет
                                    // коллектора, элемент с > 128 детьми, контейнер с текстом
                                    // > 4096 символов, упёрлись в лимит регионов). Раньше он попадал
                                    // в каждый кандидат как признак качества ЭТОГО кандидата, а
                                    // PromptDecisionEngine капит такие кандидаты до moderate - при
                                    // поставляемом по умолчанию пороге 0.8 (= minimumConfidence
                                    // 'strong') модуль на любой такой странице выдавал НОЛЬ findings,
                                    // включая настоящие срабатывания, отчитываясь при этом успехом
                                    // (TASKS 11.1). Решение по развилке: страничный partial остаётся
                                    // только диагностикой и на уверенность не влияет; в кандидате
                                    // живёт лишь то, что относится к нему самому.
                                    partial: Boolean(region.partial || truncated),
                                    pagePartial: Boolean(collection.partial)
                                };
                                try {
                                    await onCandidate(reconstructedCandidate);
                                } finally {
                                    reconstructedCandidate.text = '';
                                    for (const sourceFragment of reconstructedCandidate.sourceFragments) sourceFragment.text = '';
                                    reconstructedCandidate.sourceFragments.length = 0;
                                    reconstructedCandidate.fragmentSpans.length = 0;
                                }
                                diagnostics.windowsEmitted += 1;
                            }
                            if (windowsSinceYield >= limits.workSliceWindows
                                || performance.now() - startedAt >= limits.workSliceMs * (diagnostics.workSlices + 1)) {
                                diagnostics.workSlices += 1;
                                windowsSinceYield = 0;
                                await yieldControl();
                            }
                        }
                    }
                    if (diagnostics.lifecycleCancelled || diagnostics.elapsedBudgetReached) break;
                }
                if (diagnostics.lifecycleCancelled || diagnostics.elapsedBudgetReached) break;
            }
            return createResult(diagnostics.partial ? 'partial' : 'complete');
        } catch {
            markPartial();
            dedupeKeys.clear();
            processedRegionIds.clear();
            return createResult('error');
        }
    }
}

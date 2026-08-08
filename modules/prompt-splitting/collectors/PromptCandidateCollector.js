const PRIMARY_CONTAINERS = new Set([
    'p', 'li', 'blockquote', 'figcaption', 'caption', 'td', 'th', 'dt', 'dd',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6'
]);
const INTERACTIVE_CONTAINERS = new Set(['a', 'button', 'summary', 'label']);
const FALLBACK_CONTAINERS = new Set(['div', 'section', 'article', 'aside', 'main', 'header', 'footer']);
const TECHNICAL_TAGS = new Set(['script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'base', 'title']);
const PRIVACY_TAGS = new Set(['input', 'textarea', 'select', 'option', 'optgroup']);
const MAJOR_REGION_TAGS = new Set(['article', 'aside', 'main', 'section', 'header', 'footer', 'nav', 'li', 'blockquote', 'td', 'th']);
const ALLOWED_ATTRIBUTE_SOURCES = [
    ['title', 'title'],
    ['aria-label', 'aria-label']
];

const DEFAULT_LIMITS = Object.freeze({
    maxElements: 10000,
    maxCandidates: 2000,
    maxFragments: 5000,
    maxCharacters: 250000,
    maxCharactersPerCandidate: 4096,
    maxChildNodesPerElement: 128,
    maxAttributesPerElement: 3,
    maxRegions: 200,
    maxCandidatesPerRegion: 32,
    maxFragmentsPerRegion: 64,
    maxCharactersPerRegion: 8192,
    maxAncestorSteps: 64,
    maxElapsedMs: 100,
    workSliceElements: 250,
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
        elementsVisited: 0,
        candidatesCreated: 0,
        fragmentsCreated: 0,
        charactersRead: 0,
        regionsCreated: 0,
        elementsSkippedByLimit: 0,
        childNodesSkippedByLimit: 0,
        attributesSkippedByLimit: 0,
        charactersSkippedByLimit: 0,
        privacySubtreesSkipped: 0,
        technicalSubtreesSkipped: 0,
        ancestorLimitReached: 0,
        workSlices: 0,
        elapsedBudgetReached: false,
        lifecycleCancelled: false,
        partial: false
    };
}

export default class PromptCandidateCollector {
    async collect(root, options = {}) {
        const limits = copyLimits(options.limits);
        const isCurrent = typeof options.isCurrent === 'function' ? options.isCurrent : () => true;
        const getCandidateId = typeof options.getCandidateId === 'function'
            ? options.getCandidateId
            : () => `candidate-${nextCandidateId++}`;
        const getRegionId = typeof options.getRegionId === 'function'
            ? options.getRegionId
            : () => `region-${nextRegionId++}`;
        const yieldControl = typeof options.yieldControl === 'function'
            ? options.yieldControl
            : () => new Promise((resolve) => setTimeout(resolve, 0));
        const diagnostics = emptyDiagnostics();
        const candidates = [];
        const fragments = [];
        const regions = [];
        const exclusionCache = new WeakMap();
        const contextCache = new WeakMap();
        const primaryAncestorCache = new WeakMap();
        const regionAnchorIds = new WeakMap();
        let nextCandidateId = 1;
        let nextFragmentId = 1;
        let nextRegionId = 1;
        let nextRegionAnchorId = 1;
        let sliceElements = 0;
        const startedAt = performance.now();

        const markPartial = () => {
            diagnostics.partial = true;
        };
        const isElapsed = () => {
            if (performance.now() - startedAt <= limits.maxElapsedMs) return false;
            diagnostics.elapsedBudgetReached = true;
            markPartial();
            return true;
        };
        const getRegionAnchorId = (element) => {
            let anchorId = regionAnchorIds.get(element);
            if (!anchorId) {
                anchorId = `anchor-${nextRegionAnchorId}`;
                nextRegionAnchorId += 1;
                regionAnchorIds.set(element, anchorId);
            }
            return anchorId;
        };

        const getExclusionState = (element) => {
            if (exclusionCache.has(element)) return exclusionCache.get(element);
            const path = [];
            let current = element;
            let state = { privacy: false, technical: false };
            let steps = 0;
            while (current instanceof Element) {
                if (exclusionCache.has(current)) {
                    state = exclusionCache.get(current);
                    break;
                }
                if (steps >= limits.maxAncestorSteps) {
                    diagnostics.ancestorLimitReached += 1;
                    markPartial();
                    state = { privacy: true, technical: false };
                    break;
                }
                steps += 1;
                path.push(current);
                const tagName = current.localName;
                const privacy = PRIVACY_TAGS.has(tagName)
                    || current.getAttribute?.('contenteditable')?.toLowerCase() !== 'false' && current.hasAttribute?.('contenteditable')
                    || current.getAttribute?.('role')?.toLowerCase() === 'textbox'
                    || current.getAttribute?.('aria-multiline')?.toLowerCase() === 'true';
                const technical = TECHNICAL_TAGS.has(tagName);
                if (privacy || technical) {
                    state = { privacy, technical };
                    break;
                }
                current = current.parentElement;
            }
            for (let index = path.length - 1; index >= 0; index -= 1) {
                const pathElement = path[index];
                state = {
                    privacy: state.privacy || PRIVACY_TAGS.has(pathElement.localName)
                        || pathElement.getAttribute?.('contenteditable')?.toLowerCase() !== 'false' && pathElement.hasAttribute?.('contenteditable')
                        || pathElement.getAttribute?.('role')?.toLowerCase() === 'textbox'
                        || pathElement.getAttribute?.('aria-multiline')?.toLowerCase() === 'true',
                    technical: state.technical || TECHNICAL_TAGS.has(pathElement.localName)
                };
                exclusionCache.set(pathElement, state);
            }
            return exclusionCache.get(element) || state;
        };

        const hasPrimaryAncestor = (element) => {
            if (primaryAncestorCache.has(element)) return primaryAncestorCache.get(element);
            const path = [];
            let current = element.parentElement;
            let found = false;
            let steps = 0;
            while (current instanceof Element) {
                if (primaryAncestorCache.has(current)) {
                    found = primaryAncestorCache.get(current);
                    break;
                }
                if (steps >= limits.maxAncestorSteps) {
                    diagnostics.ancestorLimitReached += 1;
                    markPartial();
                    break;
                }
                steps += 1;
                path.push(current);
                if (PRIMARY_CONTAINERS.has(current.localName)) {
                    found = true;
                    break;
                }
                current = current.parentElement;
            }
            primaryAncestorCache.set(element, found);
            for (const pathElement of path) primaryAncestorCache.set(pathElement, found);
            return found;
        };

        const getContext = (element) => {
            if (contextCache.has(element)) return contextCache.get(element);
            const path = [];
            let current = element;
            let context = { code: false, quote: false, list: false, navigation: false };
            let steps = 0;
            while (current instanceof Element) {
                if (contextCache.has(current)) {
                    context = contextCache.get(current);
                    break;
                }
                if (steps >= limits.maxAncestorSteps) {
                    diagnostics.ancestorLimitReached += 1;
                    markPartial();
                    break;
                }
                steps += 1;
                path.push(current);
                current = current.parentElement;
            }
            for (let index = path.length - 1; index >= 0; index -= 1) {
                const pathElement = path[index];
                const tagName = pathElement.localName;
                context = {
                    code: context.code || tagName === 'pre' || tagName === 'code',
                    quote: context.quote || tagName === 'blockquote' || tagName === 'q',
                    list: context.list || tagName === 'li',
                    navigation: context.navigation || tagName === 'nav'
                };
                contextCache.set(pathElement, context);
            }
            return contextCache.get(element) || context;
        };

        const getBoundaryType = (element, hasDirectText) => {
            const tagName = element.localName;
            if (PRIMARY_CONTAINERS.has(tagName)) return 'primary';
            if (INTERACTIVE_CONTAINERS.has(tagName)) return hasPrimaryAncestor(element) ? null : 'interactive';
            if (FALLBACK_CONTAINERS.has(tagName) && hasDirectText && !hasPrimaryAncestor(element)) return 'fallback';
            return null;
        };

        const getStructuralContext = (element) => {
            let current = element;
            let steps = 0;
            while (current instanceof Element && steps < limits.maxAncestorSteps) {
                if (MAJOR_REGION_TAGS.has(current.localName)) {
                    return {
                        key: getRegionAnchorId(current),
                        type: current.localName === 'nav' ? 'navigation' : current.localName,
                        anchor: current
                    };
                }
                current = current.parentElement;
                steps += 1;
            }
            if (steps >= limits.maxAncestorSteps) {
                diagnostics.ancestorLimitReached += 1;
                markPartial();
            }
            return {
                key: getRegionAnchorId(element.parentElement || element),
                type: 'local',
                anchor: element.parentElement || element
            };
        };

        const createCandidate = (frame) => {
            if (candidates.length >= limits.maxCandidates) {
                diagnostics.elementsSkippedByLimit += 1;
                markPartial();
                return null;
            }
            const structuralContext = getStructuralContext(frame.element);
            const candidate = {
                id: getCandidateId(frame.element),
                element: frame.element,
                boundaryType: frame.boundaryType || 'attribute',
                documentOrder: candidates.length,
                context: { ...getContext(frame.element) },
                structuralContext: { type: structuralContext.type },
                regionKey: structuralContext.key,
                regionAnchor: structuralContext.anchor,
                fragments: [],
                truncated: false
            };
            candidates.push(candidate);
            diagnostics.candidatesCreated += 1;
            return candidate;
        };

        const addFragment = (candidate, sourceType, rawText, truncated) => {
            if (!candidate || !rawText || !rawText.trim()) return;
            if (fragments.length >= limits.maxFragments) {
                markPartial();
                candidate.truncated = true;
                return;
            }
            const fragment = {
                id: `fragment-${nextFragmentId}`,
                candidateId: candidate.id,
                sourceType,
                rawText,
                documentOrder: fragments.length,
                truncated: truncated === true
            };
            nextFragmentId += 1;
            fragments.push(fragment);
            candidate.fragments.push(fragment);
            candidate.truncated = candidate.truncated || fragment.truncated;
            diagnostics.fragmentsCreated += 1;
        };

        const addAttributeFragments = (element, candidate) => {
            let attributesRead = 0;
            const seenTexts = new Set();
            for (const [attributeName, sourceType] of ALLOWED_ATTRIBUTE_SOURCES) {
                if (!element.hasAttribute?.(attributeName)) continue;
                if (attributesRead >= limits.maxAttributesPerElement) {
                    diagnostics.attributesSkippedByLimit += 1;
                    markPartial();
                    break;
                }
                attributesRead += 1;
                const value = element.getAttribute(attributeName) || '';
                const normalized = value.trim();
                if (!normalized || seenTexts.has(`${sourceType}:${normalized}`)) continue;
                seenTexts.add(`${sourceType}:${normalized}`);
                const remaining = Math.max(0, limits.maxCharacters - diagnostics.charactersRead);
                const boundedValue = value.slice(0, Math.min(remaining, limits.maxCharactersPerCandidate));
                const truncated = boundedValue.length !== value.length;
                if (truncated) {
                    diagnostics.charactersSkippedByLimit += value.length - boundedValue.length;
                    markPartial();
                }
                diagnostics.charactersRead += boundedValue.length;
                addFragment(candidate, sourceType, boundedValue, truncated);
            }
            if (['img', 'area'].includes(element.localName) && element.hasAttribute?.('alt')) {
                if (attributesRead >= limits.maxAttributesPerElement) {
                    diagnostics.attributesSkippedByLimit += 1;
                    markPartial();
                    return;
                }
                const value = element.getAttribute('alt') || '';
                const normalized = value.trim();
                if (normalized && !seenTexts.has(`alt:${normalized}`)) {
                    const remaining = Math.max(0, limits.maxCharacters - diagnostics.charactersRead);
                    const boundedValue = value.slice(0, Math.min(remaining, limits.maxCharactersPerCandidate));
                    const truncated = boundedValue.length !== value.length;
                    if (truncated) {
                        diagnostics.charactersSkippedByLimit += value.length - boundedValue.length;
                        markPartial();
                    }
                    diagnostics.charactersRead += boundedValue.length;
                    addFragment(candidate, 'alt', boundedValue, truncated);
                }
            }
        };

        try {
            if (!(root instanceof Element) || !root.isConnected) {
                return this.createResult('complete', candidates, fragments, regions, diagnostics);
            }
            const pending = [{ type: 'enter', element: root, parentFrame: null, parentItemIndex: -1 }];
            while (pending.length > 0) {
                if (!isCurrent()) {
                    diagnostics.lifecycleCancelled = true;
                    markPartial();
                    break;
                }
                if (isElapsed()) break;
                const frame = pending.pop();
                if (frame.type === 'exit') {
                    const text = frame.items.map((item) => typeof item === 'string' ? item : '').join('');
                    const boundedText = text.slice(0, limits.maxCharactersPerCandidate);
                    const truncated = boundedText.length !== text.length || frame.textTruncated;
                    if (truncated) markPartial();
                    let candidate = null;
                    if (frame.boundaryType && boundedText.trim()) {
                        candidate = createCandidate(frame);
                        addFragment(candidate, 'text', boundedText, truncated);
                    }
                    if (frame.attributeValues.length > 0) {
                        candidate = candidate || createCandidate(frame);
                        addAttributeFragments(frame.element, candidate);
                    }
                    if (candidate && candidate.fragments.length === 0) {
                        candidates.pop();
                        diagnostics.candidatesCreated -= 1;
                        candidate = null;
                    }
                    if (frame.parentFrame && frame.parentItemIndex >= 0) {
                        frame.parentFrame.items[frame.parentItemIndex] = frame.boundaryType ? '' : boundedText;
                    }
                    continue;
                }

                const element = frame.element;
                if (!(element instanceof Element) || !element.isConnected) continue;
                if (diagnostics.elementsVisited >= limits.maxElements) {
                    diagnostics.elementsSkippedByLimit += pending.length + 1;
                    markPartial();
                    break;
                }
                const exclusion = getExclusionState(element);
                if (exclusion.technical) {
                    diagnostics.technicalSubtreesSkipped += 1;
                    continue;
                }
                if (exclusion.privacy) {
                    diagnostics.privacySubtreesSkipped += 1;
                    continue;
                }
                diagnostics.elementsVisited += 1;
                sliceElements += 1;
                const childNodes = Array.from(element.childNodes || []);
                const inspectedNodes = Math.min(childNodes.length, limits.maxChildNodesPerElement);
                if (childNodes.length > inspectedNodes) {
                    diagnostics.childNodesSkippedByLimit += childNodes.length - inspectedNodes;
                    markPartial();
                }
                const collectorFrame = {
                    type: 'exit',
                    element,
                    parentFrame: frame.parentFrame,
                    parentItemIndex: frame.parentItemIndex,
                    items: new Array(inspectedNodes).fill(''),
                    boundaryType: null,
                    attributeValues: [],
                    textTruncated: false
                };
                let hasDirectText = false;
                for (let index = 0; index < inspectedNodes; index += 1) {
                    const childNode = childNodes[index];
                    if (childNode?.nodeType === Node.TEXT_NODE) {
                        hasDirectText = hasDirectText || Boolean((childNode.textContent || '').trim());
                    }
                }
                collectorFrame.boundaryType = getBoundaryType(element, hasDirectText);
                for (const [attributeName] of ALLOWED_ATTRIBUTE_SOURCES) {
                    if (element.hasAttribute?.(attributeName) && (element.getAttribute(attributeName) || '').trim()) {
                        collectorFrame.attributeValues.push(attributeName);
                    }
                }
                if (['img', 'area'].includes(element.localName)
                    && element.hasAttribute?.('alt')
                    && (element.getAttribute('alt') || '').trim()) {
                    collectorFrame.attributeValues.push('alt');
                }
                pending.push(collectorFrame);
                for (let index = inspectedNodes - 1; index >= 0; index -= 1) {
                    const childNode = childNodes[index];
                    if (childNode?.nodeType === Node.TEXT_NODE) {
                        const rawText = childNode.textContent || '';
                        const remaining = Math.max(0, limits.maxCharacters - diagnostics.charactersRead);
                        const boundedText = rawText.slice(0, remaining);
                        if (boundedText.length !== rawText.length) {
                            diagnostics.charactersSkippedByLimit += rawText.length - boundedText.length;
                            collectorFrame.textTruncated = true;
                            markPartial();
                        }
                        diagnostics.charactersRead += boundedText.length;
                        collectorFrame.items[index] = boundedText;
                    } else if (childNode instanceof Element) {
                        pending.push({ type: 'enter', element: childNode, parentFrame: collectorFrame, parentItemIndex: index });
                    }
                }
                if (sliceElements >= limits.workSliceElements || performance.now() - startedAt >= limits.workSliceMs * (diagnostics.workSlices + 1)) {
                    diagnostics.workSlices += 1;
                    sliceElements = 0;
                    await yieldControl();
                }
            }
            this.buildRegions(candidates, regions, limits, diagnostics, getRegionId);
            return this.createResult(diagnostics.partial ? 'partial' : 'complete', candidates, fragments, regions, diagnostics);
        } catch {
            markPartial();
            this.dispose({ candidates, fragments, regions });
            return this.createResult('error', candidates, fragments, regions, diagnostics);
        } finally {
            exclusionCache.clear?.();
            contextCache.clear?.();
            primaryAncestorCache.clear?.();
        }
    }

    buildRegions(candidates, regions, limits, diagnostics, createRegionId) {
        let activeRegion = null;
        for (const candidate of candidates) {
            const candidateCharacters = candidate.fragments.reduce((sum, fragment) => sum + fragment.rawText.length, 0);
            const canAppend = activeRegion
                && activeRegion.regionKey === candidate.regionKey
                && activeRegion.candidateIds.length < limits.maxCandidatesPerRegion
                && activeRegion.fragmentCount + candidate.fragments.length <= limits.maxFragmentsPerRegion
                && activeRegion.characterCount + candidateCharacters <= limits.maxCharactersPerRegion;
            if (!canAppend) {
                if (regions.length >= limits.maxRegions) {
                    diagnostics.partial = true;
                    break;
                }
                activeRegion = {
                    id: createRegionId(candidate.regionAnchor),
                    regionKey: candidate.regionKey,
                    structuralContext: { ...candidate.structuralContext },
                    candidateIds: [],
                    fragmentCount: 0,
                    characterCount: 0,
                    partial: false
                };
                regions.push(activeRegion);
            }
            activeRegion.candidateIds.push(candidate.id);
            activeRegion.fragmentCount += candidate.fragments.length;
            activeRegion.characterCount += candidateCharacters;
            candidate.regionId = activeRegion.id;
        }
        diagnostics.regionsCreated = regions.length;
        for (const region of regions) delete region.regionKey;
        for (const candidate of candidates) {
            delete candidate.regionKey;
            delete candidate.regionAnchor;
        }
    }

    createResult(status, candidates, fragments, regions, diagnostics) {
        return {
            status,
            partial: status === 'partial' || status === 'error',
            candidates,
            fragments,
            regions,
            diagnostics,
            dispose: () => this.dispose({ candidates, fragments, regions })
        };
    }

    dispose(result) {
        for (const fragment of result.fragments || []) fragment.rawText = '';
        for (const candidate of result.candidates || []) {
            candidate.element = null;
            candidate.fragments.length = 0;
        }
        (result.fragments || []).length = 0;
        (result.candidates || []).length = 0;
        (result.regions || []).length = 0;
    }
}

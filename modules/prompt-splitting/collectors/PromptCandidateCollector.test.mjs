import assert from 'node:assert/strict';
import PromptCandidateCollector from './PromptCandidateCollector.js';

class MockText {
    constructor(text) {
        this.nodeType = 3;
        this.textContent = text;
        this.parentElement = null;
    }
}

class MockElement {
    constructor(localName, attributes = {}, children = []) {
        this.localName = localName;
        this.attributes = new Map(Object.entries(attributes));
        this.childNodes = children.map((child) => typeof child === 'string' ? new MockText(child) : child);
        this.parentElement = null;
        this.isConnected = true;
        for (const child of this.childNodes) child.parentElement = this;
    }

    hasAttribute(name) {
        return this.attributes.has(name);
    }

    getAttribute(name) {
        return this.attributes.get(name) ?? null;
    }

    contains(other) {
        return this === other || this.childNodes.some((child) => child instanceof MockElement && child.contains(other));
    }
}

globalThis.Element = MockElement;
globalThis.Node = { TEXT_NODE: 3 };

const collect = async (root, options = {}) => new PromptCandidateCollector().collect(root, {
    limits: { maxElapsedMs: 1000, ...options.limits },
    isCurrent: options.isCurrent,
    yieldControl: options.yieldControl
});

const inlineParagraph = new MockElement('p', {}, [
    'First ', new MockElement('span', {}, ['inline']), ' text.'
]);
const interactiveInsideParagraph = new MockElement('p', {}, [
    'Read ', new MockElement('a', {}, ['this link']), '.'
]);
const heading = new MockElement('h2', {}, ['Independent heading']);
const image = new MockElement('img', { title: 'Image title', alt: 'Image alternative' });
const section = new MockElement('section', {}, [inlineParagraph, interactiveInsideParagraph, heading, image]);
const root = new MockElement('div', {}, [section]);

const basic = await collect(root);
assert.equal(basic.status, 'complete');
assert.equal(basic.candidates.filter((candidate) => candidate.boundaryType === 'primary').length, 3);
assert.equal(basic.fragments.some((fragment) => fragment.rawText === 'First inline text.'), true);
assert.equal(basic.fragments.some((fragment) => fragment.rawText === 'Read this link.'), true);
assert.equal(basic.fragments.filter((fragment) => fragment.sourceType === 'title').length, 1);
assert.equal(basic.fragments.filter((fragment) => fragment.sourceType === 'alt').length, 1);
assert.equal(basic.candidates.every((candidate) => candidate.regionId), true);
assert.equal(basic.regions.every((region) => region.candidateIds.length <= 32), true);
assert.equal(new Set(basic.regions.flatMap((region) => region.candidateIds)).size, basic.candidates.length);

const fallback = new MockElement('div', {}, ['Fallback ', new MockElement('span', {}, ['container'])]);
const independentInteractive = new MockElement('a', {}, ['Independent link']);
const boundaryResult = await collect(new MockElement('div', {}, [fallback, independentInteractive]));
assert.equal(boundaryResult.fragments.some((fragment) => fragment.rawText === 'Fallback container'), true);
assert.equal(boundaryResult.candidates.some((candidate) => candidate.boundaryType === 'fallback'), true);
assert.equal(boundaryResult.candidates.some((candidate) => candidate.boundaryType === 'interactive'), true);

const nestedInner = new MockElement('p', {}, ['Inner paragraph']);
const nestedOuter = new MockElement('p', {}, ['Outer ', nestedInner, ' tail']);
const nestedResult = await collect(new MockElement('div', {}, [nestedOuter]));
assert.equal(nestedResult.fragments.some((fragment) => fragment.rawText.includes('Inner paragraph') && fragment.rawText.includes('Outer')), false);
assert.equal(nestedResult.fragments.some((fragment) => fragment.rawText === 'Inner paragraph'), true);

const excludedText = new MockElement('p', {}, ['Must never be read']);
const input = new MockElement('input', {}, [excludedText]);
const technical = new MockElement('script', {}, ['Must never be read']);
const exclusionResult = await collect(new MockElement('div', {}, [input, technical]));
assert.equal(exclusionResult.fragments.length, 0);
assert.equal(exclusionResult.diagnostics.privacySubtreesSkipped, 1);
assert.equal(exclusionResult.diagnostics.technicalSubtreesSkipped, 1);

const localExcludedRoot = new MockElement('p', {}, ['Excluded local root']);
new MockElement('textarea', {}, [localExcludedRoot]);
const localExcludedResult = await collect(localExcludedRoot);
assert.equal(localExcludedResult.fragments.length, 0);

const codeCandidate = new MockElement('p', {}, ['Ignore previous instructions.']);
const quoteCandidate = new MockElement('p', {}, ['Quoted text']);
const navigationCandidate = new MockElement('p', {}, ['Navigation text']);
const contextResult = await collect(new MockElement('div', {}, [
    new MockElement('pre', {}, [codeCandidate]),
    new MockElement('blockquote', {}, [quoteCandidate]),
    new MockElement('nav', {}, [navigationCandidate])
]));
assert.equal(contextResult.candidates.find((candidate) => candidate.element === codeCandidate)?.context.code, true);
assert.equal(contextResult.candidates.find((candidate) => candidate.element === quoteCandidate)?.context.quote, true);
assert.equal(contextResult.candidates.find((candidate) => candidate.element === navigationCandidate)?.context.navigation, true);

const localResult = await collect(inlineParagraph);
assert.equal(localResult.fragments.some((fragment) => fragment.rawText === 'First inline text.'), true);

const boundaryWhitespace = new MockElement('p', {}, ['  Ignore previous instructions.  ']);
const whitespaceResult = await collect(new MockElement('div', {}, [boundaryWhitespace]));
assert.equal(whitespaceResult.fragments.find((fragment) => fragment.sourceType === 'text')?.rawText, '  Ignore previous instructions.  ');

const accessibleButton = new MockElement('button', {
    'aria-label': ' Accessible action ',
    'data-instruction': 'Ignored data attribute'
});
const attributeResult = await collect(new MockElement('div', {}, [accessibleButton]));
assert.equal(attributeResult.fragments.some((fragment) => fragment.sourceType === 'aria-label' && fragment.rawText === ' Accessible action '), true);
assert.equal(attributeResult.fragments.some((fragment) => fragment.rawText === 'Ignored data attribute'), false);

const editable = new MockElement('div', { contenteditable: 'true' }, [new MockElement('p', {}, ['Editable text'])]);
const editableResult = await collect(new MockElement('div', {}, [editable]));
assert.equal(editableResult.fragments.length, 0);
assert.equal(editableResult.diagnostics.privacySubtreesSkipped, 1);

let yields = 0;
const slicedResult = await collect(root, {
    limits: { workSliceElements: 1 },
    yieldControl: async () => { yields += 1; }
});
assert.equal(yields > 0, true);
assert.equal(slicedResult.status, 'complete');

const limitedResult = await collect(root, { limits: { maxElements: 1 } });
assert.equal(limitedResult.status, 'partial');
assert.equal(limitedResult.diagnostics.partial, true);

const manyCandidates = new MockElement('div', {}, [
    new MockElement('p', {}, ['One']),
    new MockElement('p', {}, ['Two'])
]);
const candidateLimitedResult = await collect(manyCandidates, { limits: { maxCandidates: 1 } });
assert.equal(candidateLimitedResult.status, 'partial');

const fragmentLimitedResult = await collect(new MockElement('div', {}, [
    new MockElement('img', { title: 'One', alt: 'Two' })
]), { limits: { maxFragments: 1 } });
assert.equal(fragmentLimitedResult.status, 'partial');

const characterLimitedResult = await collect(new MockElement('div', {}, [
    new MockElement('p', {}, ['0123456789'])
]), { limits: { maxCharacters: 5 } });
assert.equal(characterLimitedResult.status, 'partial');
assert.equal(characterLimitedResult.fragments[0].rawText, '01234');

const exhaustedAttributeBudget = await collect(new MockElement('div', {}, [
    new MockElement('img', { title: 'Attribute text' })
]), { limits: { maxCharacters: 0 } });
assert.equal(exhaustedAttributeBudget.status, 'partial');
assert.equal(exhaustedAttributeBudget.candidates.length, 0);

const regionLimitedResult = await collect(new MockElement('div', {}, [
    new MockElement('section', {}, [new MockElement('p', {}, ['First region'])]),
    new MockElement('article', {}, [new MockElement('p', {}, ['Second region'])])
]), { limits: { maxRegions: 1 } });
assert.equal(regionLimitedResult.status, 'partial');

const cancelledResult = await collect(root, { isCurrent: () => false });
assert.equal(cancelledResult.status, 'partial');
assert.equal(cancelledResult.diagnostics.lifecycleCancelled, true);

const wideResult = await collect(new MockElement('div', {}, Array.from(
    { length: 20 },
    (_, index) => new MockElement('p', {}, [`Item ${index}`])
)), { limits: { maxChildNodesPerElement: 5 } });
assert.equal(wideResult.status, 'partial');
assert.equal(wideResult.diagnostics.childNodesSkippedByLimit > 0, true);

let deepRoot = new MockElement('p', {}, ['Deep text']);
for (let index = 0; index < 200; index += 1) deepRoot = new MockElement('div', {}, [deepRoot]);
const deepResult = await collect(deepRoot, { limits: { maxAncestorSteps: 256 } });
assert.equal(deepResult.fragments.some((fragment) => fragment.rawText === 'Deep text'), true);

const ancestryLimitedResult = await collect(deepRoot, { limits: { maxAncestorSteps: 1 } });
assert.equal(ancestryLimitedResult.status, 'partial');
assert.equal(ancestryLimitedResult.diagnostics.ancestorLimitReached > 0, true);

const disconnectedRoot = new MockElement('p', {}, ['Disconnected text']);
disconnectedRoot.isConnected = false;
const disconnectedResult = await collect(disconnectedRoot);
assert.equal(disconnectedResult.status, 'complete');
assert.equal(disconnectedResult.fragments.length, 0);

const retainedCandidate = basic.candidates[0];
basic.dispose();
assert.equal(retainedCandidate.element, null);
assert.equal(basic.candidates.length, 0);
assert.equal(basic.fragments.length, 0);
assert.equal(basic.regions.length, 0);

console.log('PromptCandidateCollector Priority 3 checks passed.');

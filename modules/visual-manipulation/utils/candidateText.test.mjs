// Shield test for TASKS 8.1: the cheap text probe must answer exactly what the old
// `getNormalizedText(element).length` comparisons answered.
// Run: node modules/visual-manipulation/utils/candidateText.test.mjs

import assert from 'node:assert/strict';
import { hasCandidateText, hasNonWhitespaceText } from './domUtils.js';

// Reference implementation: literally the code this replaced.
function referenceNormalizedText(node) {
    if (node.nodeType === 3) {
        return node.data || '';
    }
    return (node.childNodes || []).map(referenceNormalizedText).join('');
}

function referenceHasCandidateText(element) {
    const tagName = element.tagName?.toLowerCase();
    if (!tagName || ['script', 'style', 'noscript', 'template'].includes(tagName)) {
        return false;
    }
    const text = referenceNormalizedText(element).replace(/\s+/g, ' ').trim();
    return Boolean(text && text.length > 1);
}

function referenceHasAnyText(element) {
    return referenceNormalizedText(element).replace(/\s+/g, ' ').trim().length > 0;
}

function text(data) {
    return { nodeType: 3, data };
}

function element(tagName, childNodes = []) {
    return { nodeType: 1, tagName: tagName.toUpperCase(), childNodes };
}

// --- fixed cases --------------------------------------------------------------------------------

const cases = [
    element('div'),
    element('div', [text('')]),
    element('div', [text('   ')]),
    element('div', [text('\t\n  \r')]),
    element('div', [text('a')]),
    element('div', [text(' a ')]),
    element('div', [text('ab')]),
    element('div', [text('a b')]),
    // whitespace classes the /\s+/g normalizer collapses but a naive " " check would not
    element('div', [text(' ')]),
    element('div', [text(' a ')]),
    element('div', [text('﻿')]),
    element('div', [text('  　')]),
    element('div', [text(' a b ')]),
    // text split across nodes and depth
    element('div', [text('a'), text('b')]),
    element('div', [text(' a '), text(' ')]),
    element('div', [element('span', [text('a')]), element('span', [text('b')])]),
    element('div', [element('span', [element('em', [text('x')])])]),
    element('div', [element('span', [element('em', [text('xy')])])]),
    // excluded tags keep their old meaning: excluded as the element, counted as a descendant
    element('script', [text('var a = 1;')]),
    element('style', [text('.a{color:red}')]),
    element('noscript', [text('no js')]),
    element('template', [text('tpl')]),
    element('div', [element('script', [text('var a = 1;')])]),
    element('div', [element('style', [text('.a{color:red}')])])
];

for (const candidate of cases) {
    assert.equal(
        hasCandidateText(candidate),
        referenceHasCandidateText(candidate),
        `hasCandidateText mismatch for ${candidate.tagName}: ${JSON.stringify(referenceNormalizedText(candidate))}`
    );
    assert.equal(
        hasNonWhitespaceText(candidate, 1),
        referenceHasAnyText(candidate),
        `hasNonWhitespaceText(1) mismatch for ${candidate.tagName}: ${JSON.stringify(referenceNormalizedText(candidate))}`
    );
}

// --- randomized equivalence ---------------------------------------------------------------------

function mulberry32(seed) {
    let state = seed >>> 0;
    return function random() {
        state = (state + 0x6D2B79F5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const WHITESPACE_POOL = [' ', '\t', '\n', '\r', '\f', '\v', ' ', ' ', ' ', ' ', ' ', ' ', ' ', '　', '﻿'];
const GLYPH_POOL = ['a', 'b', 'я', '漢', '0', '-', '.'];
const TAG_POOL = ['div', 'span', 'p', 'script', 'style', 'noscript', 'template', 'svg'];

function randomText(random) {
    const length = Math.floor(random() * 5);
    let data = '';
    for (let index = 0; index < length; index += 1) {
        data += random() < 0.6
            ? WHITESPACE_POOL[Math.floor(random() * WHITESPACE_POOL.length)]
            : GLYPH_POOL[Math.floor(random() * GLYPH_POOL.length)];
    }
    return text(data);
}

function randomTree(random, depth = 0) {
    const childCount = depth >= 3 ? 0 : Math.floor(random() * 3);
    const childNodes = [];
    for (let index = 0; index < childCount; index += 1) {
        childNodes.push(random() < 0.5 ? randomText(random) : randomTree(random, depth + 1));
    }
    if (random() < 0.6) {
        childNodes.push(randomText(random));
    }
    return element(TAG_POOL[Math.floor(random() * TAG_POOL.length)], childNodes);
}

const random = mulberry32(20260906);
let candidateTrue = 0;
let anyTextTrue = 0;
const total = 30000;

for (let index = 0; index < total; index += 1) {
    const tree = randomTree(random);
    const expectedCandidate = referenceHasCandidateText(tree);
    const expectedAny = referenceHasAnyText(tree);

    assert.equal(
        hasCandidateText(tree),
        expectedCandidate,
        `hasCandidateText mismatch on random tree ${index}: ${JSON.stringify(referenceNormalizedText(tree))}`
    );
    assert.equal(
        hasNonWhitespaceText(tree, 1),
        expectedAny,
        `hasNonWhitespaceText(1) mismatch on random tree ${index}: ${JSON.stringify(referenceNormalizedText(tree))}`
    );

    // Произвольный порог (TASKS R4): обход обязан отвечать на вопрос «есть ли здесь минимум N
    // непробельных символов». Эталон здесь НЕ длина нормализованной строки: та считает ещё и
    // склеенные пробелы между текстовыми узлами, а обход - только непробельные символы. Расхождение
    // осознанное и записано в комментарии к hasNonWhitespaceText.
    const expectedNonWhitespaceCount = referenceNormalizedText(tree).replace(/\s+/g, '').length;
    for (const minChars of [3, 21]) {
        assert.equal(
            hasNonWhitespaceText(tree, minChars),
            expectedNonWhitespaceCount >= minChars,
            `hasNonWhitespaceText(${minChars}) mismatch on random tree ${index}: ${JSON.stringify(referenceNormalizedText(tree))}`
        );
    }

    if (expectedCandidate) candidateTrue += 1;
    if (expectedAny) anyTextTrue += 1;
}

// Coverage guard: "no mismatches" means nothing if the corpus only ever produced one answer.
assert.ok(candidateTrue > total * 0.1, `too few positive candidate-text trees: ${candidateTrue}`);
assert.ok(candidateTrue < total * 0.9, `too few negative candidate-text trees: ${total - candidateTrue}`);
assert.ok(anyTextTrue > candidateTrue, 'expected trees with exactly one non-whitespace character');

console.log(`candidateText.test.mjs: ok (${total} random trees, ${candidateTrue} candidate-text positives, ${anyTextTrue} any-text positives)`);

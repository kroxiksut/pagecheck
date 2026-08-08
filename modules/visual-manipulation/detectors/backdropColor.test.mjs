// Shield for the 6.2-B/B1 fix: what is painted behind the text, and the colour signals derived
// from it. Pure logic - `module` is a two-method stub, no DOM.
// Run: node modules/visual-manipulation/detectors/backdropColor.test.mjs
//
// Contract pinned here:
//  - The walk goes from the element upwards collecting semi-transparent layers until an opaque one
//    is found, then flattens them over that base with source-over compositing.
//  - No opaque layer up to the root => the browser canvas, which is WHITE. (Before the fix the walk
//    fell through to the root's own 'rgba(0, 0, 0, 0)' and read it as opaque BLACK, which fired on
//    every dark text run and missed white-on-white.)
//  - Zero alpha is skipped for ANY colour, not just the literal 'rgba(0, 0, 0, 0)' / 'transparent'
//    strings the old walk compared against.
//  - A background-image / gradient on any inspected node makes the backdrop unknown (null), because
//    it paints over that node's own background-color; unknown backdrop => hasParsedColorPair false
//    => the contrast strategy stays silent instead of guessing.

import assert from 'node:assert/strict';

import { resolveBackdropColor, resolveColorSignals } from './hiddenTextDetector.js';

const makeChain = (specs) => {
    const nodes = specs.map((spec) => ({
        computed: {
            color: spec.color ?? 'rgb(0, 0, 0)',
            backgroundColor: spec.backgroundColor ?? 'rgba(0, 0, 0, 0)',
            backgroundImage: spec.backgroundImage ?? 'none'
        },
        parentElement: null
    }));
    for (let index = 0; index < nodes.length - 1; index += 1) {
        nodes[index].parentElement = nodes[index + 1];
    }
    return nodes;
};

const stubModule = { getComputedStyle: (node) => node.computed, getColorParser: () => null };
const backdropOf = (specs) => {
    const chain = makeChain(specs);
    return resolveBackdropColor(chain[0], chain[0].computed, stubModule, null);
};
const signalsOf = (specs) => {
    const chain = makeChain(specs);
    return resolveColorSignals({ element: chain[0], style: chain[0].computed, module: stubModule });
};

// --- backdrop resolution ----------------------------------------------------

assert.deepEqual(
    backdropOf([{}, {}, {}]),
    [255, 255, 255],
    'nothing sets a background anywhere -> the white browser canvas'
);
assert.deepEqual(
    backdropOf([{ backgroundColor: 'rgb(20, 30, 40)' }, { backgroundColor: 'rgb(255, 255, 255)' }]),
    [20, 30, 40],
    'the element own opaque background wins'
);
assert.deepEqual(
    backdropOf([{}, { backgroundColor: 'rgb(10, 20, 30)' }, { backgroundColor: 'rgb(255, 255, 255)' }]),
    [10, 20, 30],
    'the nearest opaque ancestor wins'
);
assert.deepEqual(
    backdropOf([{ backgroundColor: 'transparent' }, { backgroundColor: 'rgb(10, 20, 30)' }]),
    [10, 20, 30],
    'the transparent keyword is skipped'
);
assert.deepEqual(
    backdropOf([{ backgroundColor: 'rgba(255, 255, 255, 0)' }, { backgroundColor: 'rgb(0, 0, 0)' }]),
    [0, 0, 0],
    'a zero-alpha WHITE is skipped too - the old walk stopped here and read it as opaque white'
);
assert.deepEqual(
    backdropOf([{ backgroundColor: '#ffffff00' }, { backgroundColor: 'rgb(0, 0, 0)' }]),
    [0, 0, 0],
    'the #rrggbbaa alpha byte is honoured'
);
assert.deepEqual(
    backdropOf([{ backgroundColor: 'rgba(0, 0, 0, 0.5)' }, { backgroundColor: 'rgb(255, 255, 255)' }]),
    [128, 128, 128],
    'a half-transparent black over white composites to grey'
);
assert.deepEqual(
    backdropOf([{ backgroundColor: 'rgba(0, 0, 0, 0.5)' }, {}, {}]),
    [128, 128, 128],
    'the same layer over the implicit white canvas'
);
assert.deepEqual(
    backdropOf([
        { backgroundColor: 'rgba(255, 255, 255, 0.5)' },
        { backgroundColor: 'rgba(255, 255, 255, 0.5)' },
        { backgroundColor: 'rgb(0, 0, 0)' }
    ]),
    [191, 191, 191],
    'two half-transparent layers stack (bottom-up compositing)'
);
assert.deepEqual(
    backdropOf([{ backgroundColor: 'rgba(0, 0, 0, 0.5)' }, { backgroundColor: 'hsl(0, 0%, 100%)' }]),
    [128, 128, 128],
    'hsl backgrounds are parsed like any other notation'
);

assert.equal(
    backdropOf([{}, { backgroundImage: 'linear-gradient(rgb(34, 34, 34), rgb(0, 0, 0))' }, {}]),
    null,
    'a gradient on an ancestor makes the backdrop unknown'
);
assert.equal(
    backdropOf([{ backgroundImage: 'url("hero.png")' }, { backgroundColor: 'rgb(255, 255, 255)' }]),
    null,
    'an image on the element itself makes the backdrop unknown'
);
assert.equal(
    backdropOf([{ backgroundColor: 'rgb(255, 255, 255)', backgroundImage: 'url("hero.png")' }]),
    null,
    'an image paints over the node own background-color, so that colour is not trustworthy either'
);
assert.deepEqual(
    backdropOf([{ backgroundColor: 'rgb(255, 255, 255)' }, { backgroundImage: 'url("hero.png")' }]),
    [255, 255, 255],
    'an image BELOW an opaque layer is irrelevant - the walk already stopped'
);

// --- colour signals: the scenarios that motivated the fix -------------------

const blackTextNoBackground = signalsOf([{ color: 'rgb(0, 0, 0)' }, {}, {}]);
assert.deepEqual(blackTextNoBackground.backgroundColorChannels, [255, 255, 255], 'default page backdrop is white');
assert.equal(
    blackTextNoBackground.hasLowContrastSignal,
    false,
    'ordinary black text on a page without any background is NOT low contrast (used to fire on every text run)'
);

const whiteTextNoBackground = signalsOf([{ color: 'rgb(255, 255, 255)' }, {}, {}]);
assert.equal(
    whiteTextNoBackground.hasNearMatchColorSignal,
    true,
    'white text on a page without any background IS near-match (white on white; used to be missed)'
);

const whiteOnWhiteExplicit = signalsOf([{ color: 'rgb(255, 255, 255)', backgroundColor: 'rgb(255, 255, 255)' }]);
assert.equal(whiteOnWhiteExplicit.hasNearMatchColorSignal, true, 'explicit white on white still fires');

const darkThemeGradient = signalsOf([{ color: 'rgb(255, 255, 255)' }, { backgroundImage: 'linear-gradient(#222, #000)' }, {}]);
assert.equal(darkThemeGradient.hasParsedColorPair, false, 'a gradient backdrop leaves the colour pair unparsed');
assert.equal(darkThemeGradient.hasLowContrastSignal, false, 'and therefore raises no contrast signal');
assert.equal(darkThemeGradient.hasNearMatchColorSignal, false, 'nor a near-match signal');

const readableBodyText = signalsOf([{ color: '#111', backgroundColor: '#fff' }]);
assert.equal(readableBodyText.hasLowContrastSignal, false, 'normal body text stays benign');

const semiTransparentOverlayText = signalsOf([
    { color: 'rgb(190, 190, 190)', backgroundColor: 'rgba(255, 255, 255, 0.5)' },
    { backgroundColor: 'rgb(255, 255, 255)' }
]);
assert.equal(
    semiTransparentOverlayText.hasLowContrastSignal,
    true,
    'grey text under a half-transparent white veil over white is still low contrast'
);

console.log('backdropColor.test.mjs: all assertions passed');

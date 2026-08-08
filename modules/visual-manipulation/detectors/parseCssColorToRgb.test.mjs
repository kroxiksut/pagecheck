// Refactor shield for 6.7: pins the CURRENT behavior of parseCssColorToRgb, extracted from the
// inline color block of scanHiddenText in 6.2 Step 2. Pure function (regex + Math), no DOM.
// Run: node modules/visual-manipulation/detectors/parseCssColorToRgb.test.mjs
//
// Contract pinned here (as implemented today):
//  - Input is trimmed and lowercased internally; empty input -> null.
//  - Order of recognition: rgb/rgba -> #hex (3/4/6/8) -> hsl/hsla -> lab/lch/oklab/oklch.
//    Anything else (named colors, 'transparent', 'inherit', ...) -> null.
//  - rgb/rgba channels are clamped to 0..255; the alpha channel is parsed but DISCARDED, so
//    'rgba(0, 0, 0, 0)' reads as opaque black. That is what makes a fully transparent background
//    look black downstream -- a known defect tracked as 6.2-B/B1, deliberately preserved here.
//  - #hex with 4 or 8 digits keeps only the RGB part (alpha ignored).
//  - hsl hue accepts deg/rad/turn and wraps into 0..360; saturation/lightness clamp to 0..100%.
//  - lab/lch/oklab/oklch collapse to a GRAY approximation from lightness alone (chroma/hue are
//    dropped): ok* with a bare number treats L as 0..1, everything else as 0..100. In a browser
//    this branch is rarely reached because the canvas parser normalizes these to rgb first.
//  - The literal keyword 'currentcolor' is replaced by the second argument before parsing.

import assert from 'node:assert/strict';

import { parseCssColorToRgb } from './hiddenTextDetector.js';

// --- rgb / rgba -------------------------------------------------------------

assert.deepEqual(parseCssColorToRgb('rgb(0, 0, 0)'), [0, 0, 0], 'black');
assert.deepEqual(parseCssColorToRgb('rgb(255,255,255)'), [255, 255, 255], 'white without spaces');
assert.deepEqual(parseCssColorToRgb('  RGB(12, 34, 56)  '), [12, 34, 56], 'trimmed and case-insensitive');
assert.deepEqual(parseCssColorToRgb('rgb(1 2 3)'), [1, 2, 3], 'space-separated syntax');
assert.deepEqual(parseCssColorToRgb('rgb(1 2 3 / 50%)'), [1, 2, 3], 'slash alpha is dropped');
assert.deepEqual(parseCssColorToRgb('rgba(12, 34, 56, 0.5)'), [12, 34, 56], 'comma alpha is dropped');
assert.deepEqual(
    parseCssColorToRgb('rgba(0, 0, 0, 0)'),
    [0, 0, 0],
    'fully transparent black parses as opaque black (defect 6.2-B/B1, pinned on purpose)'
);
assert.deepEqual(parseCssColorToRgb('rgb(300, 400, 500)'), [255, 255, 255], 'channels clamp to 255');
assert.deepEqual(parseCssColorToRgb('rgba(1.5, 2.5, 3.5, .2)'), [1.5, 2.5, 3.5], 'fractional channels are kept as-is');

// --- hex --------------------------------------------------------------------

assert.deepEqual(parseCssColorToRgb('#000'), [0, 0, 0], '3-digit hex expands');
assert.deepEqual(parseCssColorToRgb('#fff'), [255, 255, 255], '3-digit hex white');
assert.deepEqual(parseCssColorToRgb('#abc'), [170, 187, 204], '3-digit hex expands each digit');
assert.deepEqual(parseCssColorToRgb('#abcd'), [170, 187, 204], '4-digit hex drops the alpha nibble');
assert.deepEqual(parseCssColorToRgb('#123456'), [18, 52, 86], '6-digit hex');
assert.deepEqual(parseCssColorToRgb('#12345678'), [18, 52, 86], '8-digit hex drops the alpha byte');
assert.equal(parseCssColorToRgb('#12345'), null, '5-digit hex is not a valid color');
assert.equal(parseCssColorToRgb('#GGG'), null, 'non-hex digits are rejected');

// --- hsl / hsla -------------------------------------------------------------

assert.deepEqual(parseCssColorToRgb('hsl(0, 0%, 0%)'), [0, 0, 0], 'hsl black');
assert.deepEqual(parseCssColorToRgb('hsl(0, 0%, 100%)'), [255, 255, 255], 'hsl white');
assert.deepEqual(parseCssColorToRgb('hsl(120, 100%, 50%)'), [0, 255, 0], 'hsl pure green');
assert.deepEqual(parseCssColorToRgb('hsl(240, 100%, 50%)'), [0, 0, 255], 'hsl pure blue');
assert.deepEqual(parseCssColorToRgb('hsla(0, 100%, 50%, 0.5)'), [255, 0, 0], 'hsla alpha is ignored');
assert.deepEqual(parseCssColorToRgb('hsl(0.5turn, 100%, 50%)'), [0, 255, 255], 'turn units convert to degrees');
assert.deepEqual(parseCssColorToRgb('hsl(-60, 100%, 50%)'), [255, 0, 255], 'negative hue wraps into 0..360');
assert.deepEqual(parseCssColorToRgb('hsl(400, 120%, 60%)'), parseCssColorToRgb('hsl(40, 100%, 60%)'), 'hue wraps and saturation clamps');
assert.deepEqual(parseCssColorToRgb('hsl(120 100% 50%)'), [0, 255, 0], 'space-separated hsl');

// --- lab / lch / oklab / oklch (gray approximation) --------------------------

assert.deepEqual(parseCssColorToRgb('lab(50 20 30)'), [128, 128, 128], 'lab L is treated as 0..100');
assert.deepEqual(parseCssColorToRgb('lab(50% 20 30)'), [128, 128, 128], 'lab percent L behaves the same');
assert.deepEqual(parseCssColorToRgb('lch(70 45 30)'), [179, 179, 179], 'lch L is treated as 0..100');
assert.deepEqual(parseCssColorToRgb('oklab(0.5 0.1 0.1)'), [128, 128, 128], 'oklab bare L is treated as 0..1');
assert.deepEqual(parseCssColorToRgb('oklch(50% 0.1 20)'), [128, 128, 128], 'oklch percent L is treated as 0..100');
assert.deepEqual(parseCssColorToRgb('oklch(1 0.1 20)'), [255, 255, 255], 'oklab/oklch L = 1 is white');
assert.deepEqual(parseCssColorToRgb('lab(200 0 0)'), [255, 255, 255], 'lightness clamps to 255');

// --- currentcolor and misses -------------------------------------------------

assert.deepEqual(
    parseCssColorToRgb('currentcolor', 'rgb(10, 20, 30)'),
    [10, 20, 30],
    'currentcolor resolves through the fallback argument'
);
assert.deepEqual(
    parseCssColorToRgb('CurrentColor', '#abc'),
    [170, 187, 204],
    'currentcolor is matched case-insensitively and the fallback is parsed normally'
);
assert.equal(parseCssColorToRgb('currentcolor'), null, 'currentcolor without a fallback is unparseable');
assert.equal(parseCssColorToRgb('currentcolor', 'currentcolor'), null, 'a currentcolor fallback does not recurse');

assert.equal(parseCssColorToRgb(''), null, 'empty string');
assert.equal(parseCssColorToRgb('   '), null, 'whitespace only');
assert.equal(parseCssColorToRgb(undefined), null, 'missing value');
assert.equal(parseCssColorToRgb(null), null, 'null value');
assert.equal(parseCssColorToRgb('transparent'), null, 'the transparent keyword is not parsed');
assert.equal(parseCssColorToRgb('red'), null, 'named colors are not parsed (the canvas parser handles them upstream)');
assert.equal(parseCssColorToRgb('inherit'), null, 'inherit is not a color');
assert.equal(parseCssColorToRgb('rgb(a, b, c)'), null, 'non-numeric rgb arguments do not match');

console.log('parseCssColorToRgb.test.mjs: all assertions passed');

// Refactor shield for 6.7: pins the CURRENT behavior of the pure parsers extracted in 6.2 Step 3
// (hasExtremeTranslateFunction, hasExtremeMatrixTranslate, parseLengthToPx) and of the shared
// self/ancestor walk findHidingSource. All of them are DOM-free (findHidingSource only follows
// parentElement links and delegates every lookup to the caller's predicate), so a plain node run
// is enough - no jsdom, no browser.
// Run: node modules/visual-manipulation/utils/domUtilsParsers.test.mjs
//
// Contract pinned here (as implemented today):
//  - hasExtremeTranslateFunction inspects the given transform values IN ORDER and reports true on
//    the first token beyond a threshold: px-like >= 0.75 * max(vw, vh), vw/vh >= 75, % >= 120.
//    Values that are empty / 'none' / free of 'translate' are skipped. Only the first 3 arguments
//    of each translate function are considered, '/' separators are dropped, and both comma- and
//    space-separated argument lists are supported.
//  - hasExtremeMatrixTranslate reads matrix() at indices 4/5 and matrix3d() at 12/13 and compares
//    |tx| against 0.75 * viewport width, |ty| against 0.75 * viewport height.
//  - parseLengthToPx supports px / rem / em / ch / % / vw / vh and bare numbers; anything
//    unparseable is NaN. rem is checked BEFORE em. rootFontSizePx / viewport / fontSizePx /
//    containerWidth accept a value or a thunk, and thunks must not run for unrelated units.
//  - findHidingSource walks self (opt-in) then ancestors to the root, returns the first predicate
//    match with source 'self' | 'ancestor', and never calls getComputedStyle on its own.
//  - The geometry helpers made pure in 6.3 (isOffscreen, resolveViewportGeometry, isVisuallyHidden,
//    isInputHidden, isLikelyOverlay) take a rect plus a size pair instead of an element, so the
//    module facade can feed them cached rects. isOffscreen compares against the RAW window inner
//    size, resolveViewportGeometry against max(inner, clientWidth) - they differ on horizontally
//    overflowing pages, and that difference is intentional.

import assert from 'node:assert/strict';

import {
    describeElement,
    findHidingSource,
    getElementMarker,
    hasExtremeMatrixTranslate,
    hasExtremeTranslateFunction,
    isInputHidden,
    isLikelyOverlay,
    isOffscreen,
    isVisuallyHidden,
    parseLengthToPx,
    resolveViewportGeometry
} from './domUtils.js';

const VIEWPORT = { width: 1280, height: 900 };
// 0.75 * max(1280, 900) = 960 -> the px-like translate threshold.

// --- hasExtremeTranslateFunction: matches ------------------------------------

assert.equal(
    hasExtremeTranslateFunction(['translate(-9999px, 0)'], VIEWPORT),
    true,
    'classic off-screen translate is extreme'
);
assert.equal(
    hasExtremeTranslateFunction(['translateX(-960px)'], VIEWPORT),
    true,
    'exactly 0.75 * max(vw, vh) is extreme (inclusive)'
);
assert.equal(
    hasExtremeTranslateFunction(['translateY(2000px)'], VIEWPORT),
    true,
    'vertical translate uses the same max(vw, vh) threshold'
);
assert.equal(
    hasExtremeTranslateFunction(['translate3d(-9999px, 0, 0)'], VIEWPORT),
    true,
    'translate3d is covered'
);
assert.equal(
    hasExtremeTranslateFunction(['translate(-75vw, 0)'], VIEWPORT),
    true,
    'viewport units are extreme from 75 on'
);
assert.equal(
    hasExtremeTranslateFunction(['translate(-120%, 0)'], VIEWPORT),
    true,
    'percent units are extreme from 120 on'
);
assert.equal(
    hasExtremeTranslateFunction(['translate(960px 0px)'], VIEWPORT),
    true,
    'space-separated arguments are parsed'
);
assert.equal(
    hasExtremeTranslateFunction(['TranslateX(-9999PX)'], VIEWPORT),
    true,
    'input is lowercased internally'
);
assert.equal(
    hasExtremeTranslateFunction(['translate( -9999px , 0 )'], VIEWPORT),
    true,
    'surrounding whitespace is trimmed'
);
assert.equal(
    hasExtremeTranslateFunction(['none', 'translate(-9999px, 0)'], VIEWPORT),
    true,
    'later values are inspected when earlier ones are none'
);
assert.equal(
    hasExtremeTranslateFunction(['rotate(45deg) translate(-9999px, 0)'], VIEWPORT),
    true,
    'translate inside a multi-function transform is found'
);

// --- hasExtremeTranslateFunction: non-matches --------------------------------

assert.equal(hasExtremeTranslateFunction([''], VIEWPORT), false, 'empty value is not extreme');
assert.equal(hasExtremeTranslateFunction(['none'], VIEWPORT), false, 'none is not extreme');
assert.equal(hasExtremeTranslateFunction(['rotate(45deg)'], VIEWPORT), false, 'non-translate transform is not extreme');
assert.equal(
    hasExtremeTranslateFunction(['translate(-959px, 0)'], VIEWPORT),
    false,
    'just below the px threshold is not extreme'
);
assert.equal(
    hasExtremeTranslateFunction(['translate(-74vw, 0)'], VIEWPORT),
    false,
    'just below the viewport-unit threshold is not extreme'
);
assert.equal(
    hasExtremeTranslateFunction(['translate(-119%, 0)'], VIEWPORT),
    false,
    'just below the percent threshold is not extreme'
);
assert.equal(
    hasExtremeTranslateFunction(['translate(abc, 0)'], VIEWPORT),
    false,
    'unparseable arguments are skipped'
);
assert.equal(
    hasExtremeTranslateFunction(['translate(10px, 20px)'], VIEWPORT),
    false,
    'ordinary layout translate is not extreme'
);

// --- hasExtremeMatrixTranslate ----------------------------------------------

assert.equal(
    hasExtremeMatrixTranslate('matrix(1, 0, 0, 1, -9999, 0)', VIEWPORT),
    true,
    'matrix tx at index 4 is read'
);
assert.equal(
    hasExtremeMatrixTranslate('matrix(1, 0, 0, 1, 0, -9999)', VIEWPORT),
    true,
    'matrix ty at index 5 is read'
);
assert.equal(
    hasExtremeMatrixTranslate('matrix(1, 0, 0, 1, -960, 0)', VIEWPORT),
    true,
    'matrix tx uses 0.75 * viewport WIDTH (960), inclusive'
);
assert.equal(
    hasExtremeMatrixTranslate('matrix(1, 0, 0, 1, -959, 0)', VIEWPORT),
    false,
    'just below 0.75 * viewport width is not extreme'
);
assert.equal(
    hasExtremeMatrixTranslate('matrix(1, 0, 0, 1, 0, -675)', VIEWPORT),
    true,
    'matrix ty uses 0.75 * viewport HEIGHT (675), inclusive'
);
assert.equal(
    hasExtremeMatrixTranslate('matrix3d(1,0,0,0, 0,1,0,0, 0,0,1,0, -9999,0,0,1)', VIEWPORT),
    true,
    'matrix3d tx at index 12 is read'
);
assert.equal(
    hasExtremeMatrixTranslate('matrix3d(1,0,0,0, 0,1,0,0, 0,0,1,0, 0,-9999,0,1)', VIEWPORT),
    true,
    'matrix3d ty at index 13 is read'
);
assert.equal(
    hasExtremeMatrixTranslate('matrix(1, 0, 0, 1)', VIEWPORT),
    false,
    'short matrix argument lists are ignored'
);
assert.equal(
    hasExtremeMatrixTranslate('matrix3d(1,2,3)', VIEWPORT),
    false,
    'short matrix3d argument lists are ignored'
);
assert.equal(hasExtremeMatrixTranslate('none', VIEWPORT), false, 'none has no matrix translation');
assert.equal(
    hasExtremeMatrixTranslate('translate(-9999px, 0)', VIEWPORT),
    false,
    'translate functions are not this parser -- it only reads matrices'
);

// --- parseLengthToPx --------------------------------------------------------

const lengthOptions = {
    fontSizePx: 20,
    containerWidth: 400,
    rootFontSizePx: 18,
    viewport: VIEWPORT
};

assert.equal(parseLengthToPx('-9999px', lengthOptions), -9999, 'px passes through');
assert.equal(parseLengthToPx('  -9999px  ', lengthOptions), -9999, 'value is trimmed');
assert.equal(parseLengthToPx('-9999PX', lengthOptions), -9999, 'unit case is ignored');
assert.equal(parseLengthToPx('-2rem', lengthOptions), -36, 'rem uses the root font size, not the element font size');
assert.equal(parseLengthToPx('-2.5em', lengthOptions), -50, 'em uses the element font size');
assert.equal(parseLengthToPx('-10ch', lengthOptions), -100, 'ch approximates half the element font size');
assert.equal(parseLengthToPx('-50%', lengthOptions), -200, 'percent resolves against the container width');
assert.equal(parseLengthToPx('-100vw', lengthOptions), -1280, 'vw resolves against the viewport width');
assert.equal(parseLengthToPx('-50vh', lengthOptions), -450, 'vh resolves against the viewport height');
assert.equal(parseLengthToPx('-42', lengthOptions), -42, 'bare numbers are taken as px');
assert.ok(Number.isNaN(parseLengthToPx('', lengthOptions)), 'empty value is NaN');
assert.ok(Number.isNaN(parseLengthToPx('auto', lengthOptions)), 'auto is NaN');
assert.ok(Number.isNaN(parseLengthToPx('abc', lengthOptions)), 'unparseable value is NaN');
assert.ok(Number.isNaN(parseLengthToPx(undefined, lengthOptions)), 'missing value is NaN');
assert.equal(
    parseLengthToPx('-1rem', { ...lengthOptions, rootFontSizePx: Number.NaN }),
    -16,
    'a non-finite root font size falls back to 16'
);

// Thunks: accepted for every context value, and evaluated only when the unit needs them.
let rootFontSizeCalls = 0;
let viewportCalls = 0;
const thunkOptions = {
    fontSizePx: () => 20,
    containerWidth: () => 400,
    rootFontSizePx: () => { rootFontSizeCalls += 1; return 18; },
    viewport: () => { viewportCalls += 1; return VIEWPORT; }
};

assert.equal(parseLengthToPx('-9999px', thunkOptions), -9999, 'px ignores every thunk');
assert.equal(rootFontSizeCalls, 0, 'root font size thunk stays lazy for px');
assert.equal(viewportCalls, 0, 'viewport thunk stays lazy for px');
assert.equal(parseLengthToPx('-2rem', thunkOptions), -36, 'rem thunk resolves');
assert.equal(rootFontSizeCalls, 1, 'root font size thunk runs exactly once for rem');
assert.equal(parseLengthToPx('-100vw', thunkOptions), -1280, 'vw thunk resolves');
assert.equal(viewportCalls, 1, 'viewport thunk runs for vw');
assert.equal(parseLengthToPx('-2.5em', thunkOptions), -50, 'em accepts a font-size thunk');
assert.equal(parseLengthToPx('-50%', thunkOptions), -200, 'percent accepts a container-width thunk');

// --- findHidingSource -------------------------------------------------------

const makeChain = (count) => {
    const nodes = Array.from({ length: count }, (unused, index) => ({ marker: `node${index}`, parentElement: null }));
    for (let index = 0; index < count - 1; index += 1) {
        nodes[index].parentElement = nodes[index + 1];
    }
    return nodes;
};

const chain = makeChain(4);

assert.deepEqual(
    findHidingSource(chain[0], (node) => (node === chain[0] ? { matched: true, matchType: 'inline' } : null), { includeSelf: true }),
    { matched: true, source: 'self', sourceElement: chain[0], matchType: 'inline', details: null },
    'includeSelf reports the element itself as source self'
);

assert.deepEqual(
    findHidingSource(chain[0], (node) => (node === chain[0] ? { matched: true } : null)),
    { matched: false, source: '', sourceElement: null, matchType: '', details: null },
    'without includeSelf the element itself is never inspected'
);

assert.deepEqual(
    findHidingSource(chain[0], (node) => (node === chain[2] ? { matched: true, matchType: 'computed' } : null)),
    { matched: true, source: 'ancestor', sourceElement: chain[2], matchType: 'computed', details: null },
    'a deeper ancestor match reports source ancestor and the matching element'
);

assert.deepEqual(
    findHidingSource(chain[0], () => null, { includeSelf: true }),
    { matched: false, source: '', sourceElement: null, matchType: '', details: null },
    'no match walks to the root and reports an empty result'
);

assert.deepEqual(
    findHidingSource(chain[0], (node) => (node === chain[1] ? { matched: true, details: { position: 'fixed' } } : null)).details,
    { position: 'fixed' },
    'predicate details are passed through unchanged'
);

const visitOrder = [];
findHidingSource(chain[0], (node, isSelf) => {
    visitOrder.push(`${node.marker}:${isSelf}`);
    return node === chain[2] ? { matched: true } : null;
}, { includeSelf: true });
assert.deepEqual(
    visitOrder,
    ['node0:true', 'node1:false', 'node2:false'],
    'the walk goes self -> ancestors in order and stops at the first match'
);

assert.equal(
    findHidingSource(chain[0], (node) => (node === chain[0] ? { matched: true } : null), { includeSelf: true }).matchType,
    '',
    'a predicate without matchType yields an empty matchType'
);

// --- geometry helpers made pure in 6.3 --------------------------------------
// They now take data (rect + sizes) instead of an element, so the module facade can feed them
// cached rects. `isOffscreen` uses the RAW window inner size; `resolveViewportGeometry` uses the
// max(inner, clientWidth) viewport size. The two differ on horizontally overflowing pages.

const onScreenRect = { left: 10, top: 10, right: 210, bottom: 50, width: 200, height: 40 };
const offLeftRect = { left: -300, top: 10, right: -100, bottom: 50, width: 200, height: 40 };
const offTopRect = { left: 10, top: -100, right: 210, bottom: -60, width: 200, height: 40 };
const offRightRect = { left: 1400, top: 10, right: 1600, bottom: 50, width: 200, height: 40 };
const offBottomRect = { left: 10, top: 1000, right: 210, bottom: 1040, width: 200, height: 40 };

assert.equal(isOffscreen(onScreenRect, VIEWPORT), false, 'a visible rect is not off-screen');
assert.equal(isOffscreen(offLeftRect, VIEWPORT), true, 'rect fully left of the viewport');
assert.equal(isOffscreen(offTopRect, VIEWPORT), true, 'rect fully above the viewport');
assert.equal(isOffscreen(offRightRect, VIEWPORT), true, 'rect fully right of the viewport');
assert.equal(isOffscreen(offBottomRect, VIEWPORT), true, 'rect fully below the viewport');
assert.equal(
    isOffscreen({ left: 10, top: 10, right: 0, bottom: 50, width: 0, height: 40 }, VIEWPORT),
    false,
    'right exactly at 0 is not off-screen (strict <)'
);
assert.equal(
    isOffscreen({ left: 1280, top: 10, right: 1480, bottom: 50, width: 200, height: 40 }, VIEWPORT),
    false,
    'left exactly at the viewport edge is not off-screen (strict >)'
);

const geometry = resolveViewportGeometry({ left: -100, top: -50, right: 500, bottom: 450, width: 600, height: 500 }, VIEWPORT);
assert.deepEqual(
    { visibleWidth: geometry.visibleWidth, visibleHeight: geometry.visibleHeight, visibleLeft: geometry.visibleLeft, visibleTop: geometry.visibleTop },
    { visibleWidth: 500, visibleHeight: 450, visibleLeft: 0, visibleTop: 0 },
    'the visible box is clipped to the viewport'
);
assert.equal(geometry.coverageRatio, (500 * 450) / (1280 * 900), 'coverage ratio is visible area over viewport area');
assert.equal(geometry.widthRatio, 500 / 1280, 'width ratio uses the visible width');
assert.equal(
    resolveViewportGeometry(onScreenRect, { width: 0, height: 900 }),
    null,
    'a degenerate viewport yields null'
);
assert.deepEqual(
    [resolveViewportGeometry(offLeftRect, VIEWPORT).visibleWidth, resolveViewportGeometry(offLeftRect, VIEWPORT).visibleHeight],
    [0, 40],
    'a rect outside the viewport has zero visible width'
);

const visibleStyle = {
    display: 'block',
    visibility: 'visible',
    opacity: '1',
    fontSize: '16px',
    textIndent: '0px',
    pointerEvents: 'auto',
    position: 'static'
};

assert.equal(isVisuallyHidden(visibleStyle, onScreenRect, VIEWPORT), false, 'a plain visible element is not hidden');
assert.equal(isVisuallyHidden({ ...visibleStyle, display: 'none' }, onScreenRect, VIEWPORT), true, 'display:none');
assert.equal(isVisuallyHidden({ ...visibleStyle, visibility: 'hidden' }, onScreenRect, VIEWPORT), true, 'visibility:hidden');
assert.equal(isVisuallyHidden({ ...visibleStyle, opacity: '0' }, onScreenRect, VIEWPORT), true, 'opacity:0 as an exact string');
assert.equal(isVisuallyHidden({ ...visibleStyle, opacity: '0.0' }, onScreenRect, VIEWPORT), false, 'opacity 0.0 is NOT matched (string compare)');
assert.equal(isVisuallyHidden({ ...visibleStyle, fontSize: '0px' }, onScreenRect, VIEWPORT), true, 'font-size:0px as an exact string');
assert.equal(isVisuallyHidden({ ...visibleStyle, textIndent: '-9999px' }, onScreenRect, VIEWPORT), true, 'any negative text-indent');
assert.equal(isVisuallyHidden(visibleStyle, offLeftRect, VIEWPORT), true, 'off-screen geometry alone counts as hidden');

const elementWithoutHidden = { hasAttribute: () => false };
const elementWithHidden = { hasAttribute: (name) => name === 'hidden' };

assert.equal(isInputHidden(visibleStyle, elementWithoutHidden, onScreenRect, VIEWPORT), false, 'a visible input is not hidden');
assert.equal(isInputHidden(visibleStyle, elementWithHidden, onScreenRect, VIEWPORT), true, 'the hidden attribute counts');
assert.equal(
    isInputHidden({ ...visibleStyle, pointerEvents: 'none' }, elementWithoutHidden, onScreenRect, VIEWPORT),
    false,
    'pointer-events:none alone is NOT hidden (7.2): a visible but inert control stays visible'
);
assert.equal(
    isInputHidden({ ...visibleStyle, pointerEvents: 'none', display: 'none' }, elementWithoutHidden, onScreenRect, VIEWPORT),
    true,
    'but a genuinely hidden control is still hidden regardless of pointer-events'
);

const overlayStyle = { ...visibleStyle, position: 'fixed', zIndex: '100' };
const plainElement = {
    id: '',
    className: '',
    getAttribute: () => null,
    hasAttribute: () => false
};
const namedOverlayElement = {
    id: 'cookie-backdrop',
    className: '',
    getAttribute: () => null,
    hasAttribute: () => false
};
const bigRect = { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 };
const smallRect = { left: 0, top: 0, right: 100, bottom: 40, width: 100, height: 40 };

assert.equal(isLikelyOverlay(overlayStyle, plainElement, bigRect, VIEWPORT), true, 'large fixed layer with z-index 100');
assert.equal(
    isLikelyOverlay({ ...overlayStyle, position: 'static' }, plainElement, bigRect, VIEWPORT),
    false,
    'static position is never an overlay'
);
assert.equal(isLikelyOverlay(overlayStyle, plainElement, smallRect, VIEWPORT), false, 'a small layer is not an overlay');
assert.equal(
    isLikelyOverlay({ ...overlayStyle, pointerEvents: 'none' }, plainElement, bigRect, VIEWPORT),
    false,
    'pointer-events:none disqualifies an overlay'
);
assert.equal(
    isLikelyOverlay({ ...overlayStyle, zIndex: '1' }, plainElement, bigRect, VIEWPORT),
    false,
    'a low z-index without an overlay-ish name is not enough'
);
assert.equal(
    isLikelyOverlay({ ...overlayStyle, zIndex: '1' }, namedOverlayElement, bigRect, VIEWPORT),
    true,
    'an overlay-ish marker substitutes for the stacking signal'
);

// --- getElementMarker: the SVG case unified in 6.2-B/B2 ---------------------
// On SVG elements className is an SVGAnimatedString, so a `typeof === 'string'` check yields an
// empty marker and every benign gate (sr-only, icon, carousel, container, ...) silently stops
// matching there. The helper falls back to getAttribute('class'), and all detectors now use it.

const htmlElement = { id: 'Main', className: 'Sr-Only Note', getAttribute: () => null };
const svgElement = { id: '', className: { baseVal: 'sr-only' }, getAttribute: (name) => (name === 'class' ? 'sr-only note' : null) };
const bareElement = { id: '', className: '', getAttribute: () => null };

assert.equal(getElementMarker(htmlElement), 'main sr-only note', 'id and class are joined and lowercased');
assert.equal(getElementMarker(svgElement), ' sr-only note', 'SVG class is read through getAttribute');
assert.ok(getElementMarker(svgElement).includes('sr-only'), 'so benign gates match on SVG too');
assert.equal(getElementMarker(bareElement), ' ', 'an element without id or class yields just the separator');

// --- describeElement: the human-readable descriptor (6.2-B/B5) --------------
// Shares the class resolution with getElementMarker, so SVG elements no longer lose their classes
// in finding details. The descriptor never feeds a dedupe key - only `details` text.

assert.equal(
    describeElement({ tagName: 'DIV', id: 'main', className: 'card wide extra', getAttribute: () => null }),
    'div#main.card.wide',
    'tag, id and the first two classes'
);
assert.equal(
    describeElement({ tagName: 'SPAN', id: '', className: '', getAttribute: () => null }),
    'span',
    'no id and no class leaves just the tag'
);
assert.equal(
    describeElement({ tagName: 'P', id: '', className: '   spaced   out   ', getAttribute: () => null }),
    'p.spaced.out',
    'surrounding and repeated whitespace is normalized'
);
assert.equal(
    describeElement({ tagName: 'text', id: 'label', className: { baseVal: 'note' }, getAttribute: (name) => (name === 'class' ? 'note bold' : null) }),
    'text#label.note.bold',
    'SVG classes are read through getAttribute instead of being dropped'
);
assert.equal(
    describeElement({ id: '', className: '', getAttribute: () => null }),
    'element',
    'a node without tagName degrades to "element" instead of throwing'
);
assert.equal(
    describeElement({ tagName: 'DIV', id: '', className: { baseVal: 'x' } }),
    'div',
    'a node without getAttribute still yields a descriptor'
);

console.log('domUtilsParsers.test.mjs: all assertions passed');

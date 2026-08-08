// Refactor shield for 6.7: pins the CURRENT behavior of parseSuppressedScale.
// 6.2 (Step 3) moved it from detectors/styleObfuscationDetector.js to utils/domUtils.js,
// next to the other transform parsers. Pure function (regex + Math), no DOM.
// Run: node modules/visual-manipulation/detectors/parseSuppressedScale.test.mjs
//
// Contract pinned here (as implemented today):
//  - Input is expected lowercase + trimmed (callers pass value.trim().toLowerCase()).
//  - Matches scale()/scaleX()/scaleY()/matrix()/matrix3d() only.
//  - Returns a match ONLY when min(|scaleX|, |scaleY|) <= 0.05 (0.05 inclusive); else null.
//  - translate*/none/unrelated transforms are not handled -> null.
//  - scaleLabel = `${scaleX.toFixed(3)}x${scaleY.toFixed(3)}` using the values passed to
//    createScaleMatch (abs for scale*, hypot for matrix*).

import assert from 'node:assert/strict';
import { parseSuppressedScale } from '../utils/domUtils.js';

// --- Matches: near-zero scale() ---
assert.deepEqual(
    parseSuppressedScale('scale(0)'),
    { transformSource: 'scale', minimumScale: 0, scaleLabel: '0.000x0.000' },
    'scale(0) is a full suppression'
);
assert.deepEqual(
    parseSuppressedScale('scale(0.01)'),
    { transformSource: 'scale', minimumScale: 0.01, scaleLabel: '0.010x0.010' },
    'scale(0.01) below threshold'
);
// 0.05 is inclusive (condition is `> 0.05` -> false at exactly 0.05)
assert.deepEqual(
    parseSuppressedScale('scale(0.05)'),
    { transformSource: 'scale', minimumScale: 0.05, scaleLabel: '0.050x0.050' },
    'scale(0.05) matches at the inclusive boundary'
);

// --- scale() two-arg, comma OR whitespace separator; min of the two axes ---
assert.deepEqual(
    parseSuppressedScale('scale(0, 1)'),
    { transformSource: 'scale', minimumScale: 0, scaleLabel: '0.000x1.000' },
    'scale(0,1): one collapsed axis is enough'
);
assert.deepEqual(
    parseSuppressedScale('scale(0.03 0.04)'),
    { transformSource: 'scale', minimumScale: 0.03, scaleLabel: '0.030x0.040' },
    'scale() accepts whitespace-separated args'
);

// --- Negative values are abs()'d ---
assert.deepEqual(
    parseSuppressedScale('scale(-0.01)'),
    { transformSource: 'scale', minimumScale: 0.01, scaleLabel: '0.010x0.010' },
    'negative scale is treated by magnitude'
);

// --- scaleX / scaleY fix the other axis at 1 ---
assert.deepEqual(
    parseSuppressedScale('scalex(0)'),
    { transformSource: 'scaleX', minimumScale: 0, scaleLabel: '0.000x1.000' },
    'scaleX(0)'
);
assert.deepEqual(
    parseSuppressedScale('scaley(0.02)'),
    { transformSource: 'scaleY', minimumScale: 0.02, scaleLabel: '1.000x0.020' },
    'scaleY(0.02)'
);

// --- matrix(): scaleX = hypot(a,b), scaleY = hypot(c,d) ---
assert.deepEqual(
    parseSuppressedScale('matrix(0, 0, 0, 0, 0, 0)'),
    { transformSource: 'matrix', minimumScale: 0, scaleLabel: '0.000x0.000' },
    'matrix all-zero'
);
assert.deepEqual(
    parseSuppressedScale('matrix(0.01, 0, 0, 0.01, 0, 0)'),
    { transformSource: 'matrix', minimumScale: 0.01, scaleLabel: '0.010x0.010' },
    'matrix near-zero uniform scale'
);

// --- matrix3d(): scaleX = hypot(v0,v1,v2), scaleY = hypot(v4,v5,v6) ---
{
    const m3d = 'matrix3d(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)';
    assert.deepEqual(
        parseSuppressedScale(m3d),
        { transformSource: 'matrix3d', minimumScale: 0, scaleLabel: '0.000x0.000' },
        'matrix3d collapsed x/y scale'
    );
}

// --- Non-matches -> null ---
assert.equal(parseSuppressedScale('scale(1)'), null, 'identity scale');
assert.equal(parseSuppressedScale('scale(0.5)'), null, 'half scale is not suppression');
assert.equal(parseSuppressedScale('scale(0.06)'), null, 'just above the 0.05 boundary');
assert.equal(parseSuppressedScale('scale(-1)'), null, 'negative identity magnitude');
assert.equal(parseSuppressedScale('none'), null, 'no transform');
assert.equal(parseSuppressedScale('translatex(-9999px)'), null, 'translate is out of scope (off-screen parser owns it)');
assert.equal(parseSuppressedScale('matrix(1, 0, 0, 1, 0, 0)'), null, 'identity matrix');
assert.equal(parseSuppressedScale('matrix(0, 0, 0)'), null, 'matrix needs >= 6 finite values');

// --- Anchoring: matrix/matrix3d must be the whole string; scale() may co-occur ---
assert.equal(
    parseSuppressedScale('matrix(0,0,0,0,0,0) translatex(10px)'),
    null,
    'matrix regex is anchored ^...$'
);
assert.deepEqual(
    parseSuppressedScale('translatex(-10px) scale(0)'),
    { transformSource: 'scale', minimumScale: 0, scaleLabel: '0.000x0.000' },
    'scale() is detected even alongside other transforms'
);

console.log('parseSuppressedScale.test.mjs: all assertions passed');

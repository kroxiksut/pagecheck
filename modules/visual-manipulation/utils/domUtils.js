const NON_TEXT_CANDIDATE_TAGS = ['script', 'style', 'noscript', 'template'];

export function hasCandidateText(element) {
    const tagName = element.tagName?.toLowerCase();
    if (!tagName || NON_TEXT_CANDIDATE_TAGS.includes(tagName)) {
        return false;
    }

    return hasNonWhitespaceText(element, 2);
}

// Answers "does this subtree hold at least `minChars` non-whitespace characters" without ever
// materialising the text. It replaces getNormalizedText(element).length comparisons on the hot
// candidate path: textContent is O(subtree text) and the traversal runs top-down, so asking it on
// every element made the cost quadratic in page text (TASKS 8.1).
// Equivalence with the normalizer it replaces: collapsing whitespace runs and trimming yields a
// string of length 0 for zero non-whitespace characters, exactly 1 for one, and >= 2 for two or
// more - so `normalized.length > 1` is the same predicate as `minChars = 2`, and `length === 0` is
// the negation of `minChars = 1`. String.prototype.trim() strips the same character class the
// /\s+/g normalizer does (NBSP and U+FEFF included), which is why a trimmed text node can be
// scored without inspecting characters one by one.
// `minChars` is honoured for any value: the walk stops as soon as the quota is met, so the cost is
// bounded by the quota rather than by the size of the subtree. What it counts is non-whitespace
// characters, which is NOT the same number as a normalized-string length - the latter also counts
// the single spaces a normalizer leaves between words. Deliberate where the question is "is there
// enough content here to matter": spaces are not content (TASKS 9.5).
export function hasNonWhitespaceText(element, minChars = 1) {
    const required = Math.max(1, minChars);
    // The candidate probe (`required <= 2`) is the hot path - it runs on every element of the page,
    // so it stays on the coarse credit: a trimmed node of length >= 2 fills the quota outright and
    // its characters are never inspected. Larger quotas do count the characters, because there the
    // whitespace inside a single text node would otherwise inflate the answer.
    const countsExactly = required > 2;
    let found = 0;
    const pending = [element];

    while (pending.length > 0) {
        const node = pending.pop();
        const childNodes = node.childNodes;
        if (!childNodes) {
            continue;
        }

        for (let index = childNodes.length - 1; index >= 0; index -= 1) {
            const child = childNodes[index];
            if (child.nodeType === 3) {
                const trimmed = (child.data || '').trim();
                if (trimmed.length > 0) {
                    found += countsExactly ? trimmed.replace(/\s+/g, '').length : Math.min(trimmed.length, 2);
                    if (found >= required) {
                        return true;
                    }
                }
            } else if (child.nodeType === 1) {
                pending.push(child);
            }
        }
    }

    return found >= required;
}

export function isInputSurface(element) {
    const tagName = element.tagName.toLowerCase();
    if (tagName === 'input') {
        return !isPasswordInput(element);
    }

    return ['textarea', 'select'].includes(tagName) || element.isContentEditable;
}

export function getNormalizedText(element) {
    return (element.textContent || '').replace(/\s+/g, ' ').trim();
}

export function isPasswordInput(element) {
    return element instanceof HTMLInputElement
        && (element.getAttribute('type') || element.type || '').toLowerCase() === 'password';
}

export function isOverlayNamed(element) {
    const marker = getElementMarker(element);
    const role = (element.getAttribute('role') || '').toLowerCase();
    return marker.includes('overlay')
        || marker.includes('modal')
        || marker.includes('backdrop')
        || marker.includes('dialog')
        || marker.includes('popup')
        || marker.includes('lightbox')
        || marker.includes('interstitial')
        || marker.includes('consent')
        || marker.includes('cookie')
        || marker.includes('shield')
        || marker.includes('blocker')
        || marker.includes('interceptor')
        || marker.includes('mask')
        || marker.includes('loading')
        || role === 'dialog'
        || role === 'alertdialog'
        || element.hasAttribute('aria-modal')
        || element.hasAttribute('popover');
}

// Geometry-dependent helpers take the rect and the viewport size as plain data instead of reading
// them from the element: that keeps them pure and forces every caller through the module facade,
// which serves rects from the scan-local cache (see VisualManipulationDetector). `windowInnerSize`
// is deliberately the RAW window.innerWidth/innerHeight pair, not the max(inner, clientWidth) one
// used for viewport geometry - the two differ on horizontally overflowing pages and the off-screen
// checks have always used the raw values.
export function isVisuallyHidden(style, rect, windowInnerSize) {
    return style.display === 'none'
        || style.visibility === 'hidden'
        || style.opacity === '0'
        || style.fontSize === '0px'
        || style.textIndent.startsWith('-')
        || isOffscreen(rect, windowInnerSize);
}

// `pointer-events: none` is deliberately NOT part of this (TASKS 7.2): a control that is plainly
// visible but non-interactive is not hidden, and treating it as such reported ordinary disabled-
// looking UI as a hidden input. It stays a supporting context signal where it belongs - the
// hidden-input detector already reports it as `clickable`, and callers that genuinely mean
// "unreachable, hidden or not" spell that out at the call site.
export function isInputHidden(style, element, rect, windowInnerSize) {
    return isVisuallyHidden(style, rect, windowInnerSize)
        || element.hasAttribute('hidden');
}

export function isLikelyOverlay(style, element, rect, viewport) {
    if (!['fixed', 'absolute', 'sticky'].includes(style.position)) {
        return false;
    }

    const geometry = resolveViewportGeometry(rect, viewport);
    if (!geometry) {
        return false;
    }

    const zIndex = resolveZIndex(style);
    const hasStackingSignal = zIndex >= 10 || isOverlayNamed(element);

    return geometry.visibleWidth >= 120
        && geometry.visibleHeight >= 60
        && geometry.coverageRatio >= 0.08
        && hasStackingSignal
        && style.pointerEvents !== 'none';
}

// Scale suppression is NOT part of this signal set (TASKS 8.9). The `transform.includes('scale(0')`
// test that used to be here could never fire - computed transforms serialise as matrix(...) - and
// the specialised scanTransformSuppression path already covers scale suppression properly, with
// context, benign signals and severity of its own.
export function hasStyleObfuscationSignals(style, element) {
    const hasBlendOrFilter = style.mixBlendMode !== 'normal'
        || (style.filter && style.filter !== 'none');
    const hasClipping = style.clip !== 'auto'
        || style.clipPath !== 'none';

    return hasBlendOrFilter
        || hasClipping
        || (element.hasAttribute('aria-hidden') && hasCandidateText(element));
}

// Shared self/ancestor walk for hiding attribution (Layer 2 deduplication).
// The walk itself owns only traversal and source labelling; every style, rect or attribute lookup
// stays inside `predicate`, which is a closure over the caller's `module` facade and thresholds.
// That keeps attribute- and geometry-only walks free of computed-style calls they never needed.
// `predicate(node, isSelf)` returns null (no match) or `{ matched: true, matchType?, details? }`.
// The walk is intentionally unbounded in depth: every migrated call-site walked up to the root,
// and a depth limit would change findings.
// `outermost` keeps walking past the first match and reports the LAST (highest) one instead. Only
// the display:none strategy asks for it, to collapse a whole hidden region - including hidden
// blocks nested inside it - onto one attribution point (TASKS B7.3). It costs nothing in the
// no-match case, which already walked to the root; the extra steps happen only inside a subtree
// that is already known to be hidden, and every style lookup comes from the scan cache.
export function findHidingSource(element, predicate, { includeSelf = false, outermost = false } = {}) {
    let current = includeSelf ? element : element.parentElement;
    let outermostMatch = null;

    while (current) {
        const isSelf = current === element;
        const result = predicate(current, isSelf);
        if (result?.matched) {
            const match = {
                matched: true,
                source: isSelf ? 'self' : 'ancestor',
                sourceElement: current,
                matchType: result.matchType || '',
                details: result.details ?? null
            };

            if (!outermost) {
                return match;
            }
            outermostMatch = match;
        }

        current = current.parentElement;
    }

    return outermostMatch || { matched: false, source: '', sourceElement: null, matchType: '', details: null };
}

// Transform parsers shared by the hidden-text off-screen strategy and (via parseSuppressedScale)
// the style-obfuscation detector. All of them are pure: values in, verdict out, no DOM access.

// True when any translate()/translateX()/translateY()/translate3d() argument pushes the element
// roughly out of the viewport. `transformValues` is inspected in order (inline first, then computed),
// short-circuiting on the first extreme token, exactly as the inlined loop did.
export function hasExtremeTranslateFunction(transformValues, { width: viewportWidth, height: viewportHeight }) {
    for (const transformValueRaw of transformValues) {
        const transformValue = (transformValueRaw || '').toLowerCase();
        if (!transformValue || transformValue === 'none' || !transformValue.includes('translate')) {
            continue;
        }

        const translateMatches = transformValue.matchAll(/translate(?:3d|x|y)?\(([^)]+)\)/g);
        for (const translateMatch of translateMatches) {
            const translateArgsRaw = translateMatch[1] || '';
            const commaSeparatedTokens = translateArgsRaw
                .split(',')
                .map((token) => token.trim())
                .filter(Boolean);
            const translateTokens = (commaSeparatedTokens.length > 1
                ? commaSeparatedTokens
                : translateArgsRaw.split(/\s+/).map((token) => token.trim()).filter(Boolean))
                .filter((token) => token !== '/')
                .slice(0, 3);

            for (const tokenRaw of translateTokens) {
                const token = tokenRaw.toLowerCase();
                const numeric = Number.parseFloat(token);
                if (!Number.isFinite(numeric)) {
                    continue;
                }

                const isPxLike = token.endsWith('px') || /^-?[0-9]*\.?[0-9]+$/.test(token);
                const isViewportUnit = token.endsWith('vw') || token.endsWith('vh');
                const isPercentUnit = token.endsWith('%');

                const isExtremePxLike = isPxLike
                    && Math.abs(numeric) >= Math.max(viewportWidth, viewportHeight) * 0.75;
                const isExtremeViewport = isViewportUnit && Math.abs(numeric) >= 75;
                const isExtremePercent = isPercentUnit && Math.abs(numeric) >= 120;

                if (isExtremePxLike || isExtremeViewport || isExtremePercent) {
                    return true;
                }
            }
        }
    }

    return false;
}

// True when the translation components of matrix()/matrix3d() push the element roughly out of the
// viewport. matrix() carries them at indices 4/5, matrix3d() at 12/13.
export function hasExtremeMatrixTranslate(computedTransform, { width: viewportWidth, height: viewportHeight }) {
    const matrixMatch = computedTransform.match(/matrix\(([^)]+)\)/);
    if (matrixMatch?.[1]) {
        const matrixValues = matrixMatch[1].split(',').map((value) => Number.parseFloat(value.trim()));
        if (matrixValues.length >= 6) {
            const translateX = matrixValues[4];
            const translateY = matrixValues[5];
            if (Number.isFinite(translateX) && Math.abs(translateX) >= viewportWidth * 0.75) {
                return true;
            }
            if (Number.isFinite(translateY) && Math.abs(translateY) >= viewportHeight * 0.75) {
                return true;
            }
        }
    }

    const matrix3dMatch = computedTransform.match(/matrix3d\(([^)]+)\)/);
    if (matrix3dMatch?.[1]) {
        const matrix3dValues = matrix3dMatch[1].split(',').map((value) => Number.parseFloat(value.trim()));
        if (matrix3dValues.length >= 16) {
            const translateX = matrix3dValues[12];
            const translateY = matrix3dValues[13];
            if (Number.isFinite(translateX) && Math.abs(translateX) >= viewportWidth * 0.75) {
                return true;
            }
            if (Number.isFinite(translateY) && Math.abs(translateY) >= viewportHeight * 0.75) {
                return true;
            }
        }
    }

    return false;
}

// Near-zero scale detection for transform suppression: scale()/scaleX()/scaleY()/matrix()/matrix3d().
// Expects an already lowercased, trimmed value. Returns a match descriptor or null when the smallest
// axis stays above the 0.05 suppression threshold. Pinned by parseSuppressedScale.test.mjs.
export function parseSuppressedScale(value) {
    const scaleFunctionMatch = value.match(/scale\(\s*(-?\d*\.?\d+)(?:\s*(?:,|\s)\s*(-?\d*\.?\d+))?\s*\)/);
    if (scaleFunctionMatch) {
        const scaleX = Math.abs(Number.parseFloat(scaleFunctionMatch[1]));
        const scaleY = Math.abs(Number.parseFloat(scaleFunctionMatch[2] ?? scaleFunctionMatch[1]));
        return createScaleMatch('scale', scaleX, scaleY);
    }

    const scaleXMatch = value.match(/scalex\(\s*(-?\d*\.?\d+)\s*\)/);
    if (scaleXMatch) {
        return createScaleMatch('scaleX', Math.abs(Number.parseFloat(scaleXMatch[1])), 1);
    }

    const scaleYMatch = value.match(/scaley\(\s*(-?\d*\.?\d+)\s*\)/);
    if (scaleYMatch) {
        return createScaleMatch('scaleY', 1, Math.abs(Number.parseFloat(scaleYMatch[1])));
    }

    const matrixMatch = value.match(/^matrix\(([^)]+)\)$/);
    if (matrixMatch?.[1]) {
        const values = matrixMatch[1].split(',').map((entry) => Number.parseFloat(entry.trim()));
        if (values.length >= 6 && values.every(Number.isFinite)) {
            const scaleX = Math.hypot(values[0], values[1]);
            const scaleY = Math.hypot(values[2], values[3]);
            return createScaleMatch('matrix', scaleX, scaleY);
        }
    }

    const matrix3dMatch = value.match(/^matrix3d\(([^)]+)\)$/);
    if (matrix3dMatch?.[1]) {
        const values = matrix3dMatch[1].split(',').map((entry) => Number.parseFloat(entry.trim()));
        if (values.length >= 16 && values.every(Number.isFinite)) {
            const scaleX = Math.hypot(values[0], values[1], values[2]);
            const scaleY = Math.hypot(values[4], values[5], values[6]);
            return createScaleMatch('matrix3d', scaleX, scaleY);
        }
    }

    return null;
}

function createScaleMatch(transformSource, scaleX, scaleY) {
    if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY)) {
        return null;
    }

    const minimumScale = Math.min(scaleX, scaleY);
    if (minimumScale > 0.05) {
        return null;
    }

    return {
        transformSource,
        minimumScale,
        scaleLabel: `${scaleX.toFixed(3)}x${scaleY.toFixed(3)}`
    };
}

// CSS length -> px for the units the detectors actually meet. `fontSizePx`, `containerWidth`,
// `rootFontSizePx` and `viewport` may each be a value or a thunk, so callers keep the original
// laziness (the root font size costs a getComputedStyle and is only needed for rem).
export function parseLengthToPx(rawValue, { fontSizePx = 16, containerWidth = 0, rootFontSizePx = 16, viewport = null } = {}) {
    if (!rawValue) {
        return Number.NaN;
    }

    const normalizedValue = rawValue.trim().toLowerCase();
    const numericValue = Number.parseFloat(normalizedValue);
    if (!Number.isFinite(numericValue)) {
        return Number.NaN;
    }

    const resolve = (candidate) => (typeof candidate === 'function' ? candidate() : candidate);

    if (normalizedValue.endsWith('px')) {
        return numericValue;
    }
    if (normalizedValue.endsWith('rem')) {
        const resolvedRootFontSize = Number.parseFloat(resolve(rootFontSizePx));
        return numericValue * (Number.isFinite(resolvedRootFontSize) ? resolvedRootFontSize : 16);
    }
    if (normalizedValue.endsWith('em')) {
        return numericValue * resolve(fontSizePx);
    }
    if (normalizedValue.endsWith('ch')) {
        return numericValue * (resolve(fontSizePx) * 0.5);
    }
    if (normalizedValue.endsWith('%')) {
        return numericValue * (resolve(containerWidth) / 100);
    }
    if (normalizedValue.endsWith('vw')) {
        return numericValue * ((resolve(viewport)?.width || 0) / 100);
    }
    if (normalizedValue.endsWith('vh')) {
        return numericValue * ((resolve(viewport)?.height || 0) / 100);
    }

    return numericValue;
}

export function resolveViewportSize() {
    return {
        width: Math.max(window.innerWidth || 0, document.documentElement?.clientWidth || 0),
        height: Math.max(window.innerHeight || 0, document.documentElement?.clientHeight || 0)
    };
}

export function isOffscreen(rect, windowInnerSize) {
    return rect.right < 0
        || rect.bottom < 0
        || rect.left > windowInnerSize.width
        || rect.top > windowInnerSize.height;
}

export function resolveWindowInnerSize() {
    return { width: window.innerWidth, height: window.innerHeight };
}

// On SVG elements className is an SVGAnimatedString, not a string, so the class attribute has to be
// read explicitly. Both the matching marker and the human-readable descriptor go through here so
// they cannot drift apart again (see TASKS 6.2-B/B2 and B5).
function resolveClassName(element) {
    if (typeof element.className === 'string') {
        return element.className;
    }

    return element.getAttribute?.('class') || '';
}

export function describeElement(element) {
    const tag = element.tagName?.toLowerCase() || 'element';
    const idPart = element.id ? `#${element.id}` : '';
    const className = resolveClassName(element).trim();
    const classPart = className
        ? `.${className.split(/\s+/).slice(0, 2).join('.')}`
        : '';
    return `${tag}${idPart}${classPart}`;
}

export function getElementMarker(element) {
    return `${element.id || ''} ${resolveClassName(element)}`.toLowerCase();
}

export function getElementPath(element) {
    const segments = [];
    let current = element;
    let depth = 0;

    while (current instanceof Element && depth < 6) {
        const tagName = current.tagName?.toLowerCase();
        if (!tagName) {
            break;
        }

        let siblingIndex = 1;
        let sibling = current.previousElementSibling;
        while (sibling) {
            if (sibling.tagName === current.tagName) {
                siblingIndex += 1;
            }
            sibling = sibling.previousElementSibling;
        }

        segments.unshift(`${tagName}:nth-of-type(${siblingIndex})`);
        current = current.parentElement;
        depth += 1;
    }

    return segments.join('>');
}

export function resolveViewportGeometry(rect, { width: viewportWidth, height: viewportHeight }) {
    if (viewportWidth <= 0 || viewportHeight <= 0) {
        return null;
    }

    const visibleLeft = Math.max(rect.left, 0);
    const visibleTop = Math.max(rect.top, 0);
    const visibleRight = Math.min(rect.right, viewportWidth);
    const visibleBottom = Math.min(rect.bottom, viewportHeight);
    const visibleWidth = Math.max(0, visibleRight - visibleLeft);
    const visibleHeight = Math.max(0, visibleBottom - visibleTop);
    const viewportArea = Math.max(1, viewportWidth * viewportHeight);

    return {
        visibleWidth,
        visibleHeight,
        visibleLeft,
        visibleTop,
        visibleRight,
        visibleBottom,
        viewportWidth,
        viewportHeight,
        coverageRatio: (visibleWidth * visibleHeight) / viewportArea,
        widthRatio: visibleWidth / viewportWidth,
        heightRatio: visibleHeight / viewportHeight
    };
}

export function resolveZIndex(style) {
    const zIndexRaw = Number.parseInt(style.zIndex || '', 10);
    return Number.isFinite(zIndexRaw) ? zIndexRaw : 0;
}

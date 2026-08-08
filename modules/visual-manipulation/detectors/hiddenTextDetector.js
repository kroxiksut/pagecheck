import { createFinding, getMessage } from '../utils/findingFactory.js';
import {
    findHidingSource,
    getElementMarker,
    getNormalizedText,
    hasExtremeMatrixTranslate,
    hasExtremeTranslateFunction,
    parseLengthToPx
} from '../utils/domUtils.js';

const OVERLAY_POSITIONS = ['fixed', 'absolute', 'sticky'];
const OFFSCREEN_THRESHOLD_PX = 24;
// Alpha at or below this counts as "the glyphs are not really painted". 0 is the outright trick;
// the band above it catches `rgba(0, 0, 0, 0.01)`, which is visually identical but would slip past
// an equality check. The band demands supporting context, exactly like anomalously small font-size.
const TRANSPARENT_TEXT_ALPHA_THRESHOLD = 0.05;

// Hiding strategies in evaluation order. The first one to produce a finding wins; a strategy that
// matched its condition but was then cleared by its own benign gate returns [] and the next one
// gets its turn, which is exactly how the original single-function fall-through behaved.
const HIDDEN_TEXT_STRATEGIES = [
    detectDisplayNone,
    detectVisibilityHidden,
    detectOpacityZero,
    detectTransparentText,
    detectFontSizeSuppression,
    detectContrastCamouflage,
    detectNegativeTextIndent,
    detectOffscreen,
    detectGeneric
];

export function scanHiddenText({ element, style, module }) {
    if (!module.hasCandidateText(element)) {
        return [];
    }

    const context = createHiddenTextScanContext({ element, style, module });

    // Weak benign evidence is a statement about the ELEMENT ("a small piece of revealable UI
    // machinery"), not about one hiding mechanism, so it is decided once for the whole scan.
    // Deciding it per strategy measurably backfired: a branch would decline, the next one would
    // claim the very same element anyway - sometimes at a higher severity - and the element ended
    // up reported through a less precise reason than the one that had just cleared it.
    if (isWeakBenignCase(context, style)) {
        return [];
    }

    for (const detectStrategy of HIDDEN_TEXT_STRATEGIES) {
        const findings = detectStrategy(context);
        if (findings.length > 0) {
            return findings;
        }
    }

    return [];
}

// Per-element scan context. Everything derived is lazy and memoized: colors cost an ancestor walk
// plus canvas parsing, normalized text costs a full textContent read, and neither is needed unless
// a strategy actually asks. Values are stable for the duration of one element scan (detectors are
// read-only, see the cache invariants in VisualManipulationDetector.js).
function createHiddenTextScanContext({ element, style, module }) {
    const configuredDisplayMode = module?.config?.hiddenTextDisplayMode;
    const hiddenTextDisplayMode = configuredDisplayMode === 'self' || configuredDisplayMode === 'ancestors'
        ? configuredDisplayMode
        : 'ancestors';

    let colorSignals;
    let textLength;
    let marker;
    let viewport;

    return {
        element,
        style,
        module,
        hiddenTextDisplayMode,
        tagName: element.tagName?.toLowerCase() || '',
        getColorSignals() {
            if (colorSignals === undefined) {
                colorSignals = resolveColorSignals({ element, style, module });
            }
            return colorSignals;
        },
        getTextLength() {
            if (textLength === undefined) {
                textLength = getNormalizedText(element).length;
            }
            return textLength;
        },
        // getElementMarker also reads getAttribute('class'), so the benign gates (sr-only, icon,
        // carousel, container, ...) work on SVG elements too, where className is an SVGAnimatedString
        // rather than a string. Unified in 6.2-B/B2.
        getMarker() {
            if (marker === undefined) {
                marker = getElementMarker(element);
            }
            return marker;
        },
        getViewport() {
            if (viewport === undefined) {
                viewport = module.getViewportSize();
            }
            return viewport;
        }
    };
}

// --- shared context signals -------------------------------------------------------------------
// Thresholds stay per-strategy on purpose: font-size treats opacity < 0.45 as a signal while
// contrast and text-indent use < 0.6, and text-indent counts only clip/clip-path while the other
// two also count overflow. Aligning them would change findings.

function hasOverlayContextSignal(style) {
    const zIndexValue = Number.parseFloat(style.zIndex);
    return OVERLAY_POSITIONS.includes(style.position)
        && Number.isFinite(zIndexValue)
        && zIndexValue >= 100
        && style.pointerEvents !== 'none';
}

function hasClippingContextSignal(style, { includeOverflow = false } = {}) {
    if (style.clip !== 'auto' || style.clipPath !== 'none') {
        return true;
    }

    return includeOverflow
        && (style.overflow === 'hidden' || style.overflowX === 'hidden' || style.overflowY === 'hidden');
}

function hasOpacityContextSignal(style, threshold) {
    const opacityValue = Number.parseFloat(style.opacity);
    return Number.isFinite(opacityValue) && opacityValue > 0 && opacityValue < threshold;
}

// --- weak benign context (TASKS 6.2-B/B6) -------------------------------------------------------
// Two kinds of benign evidence are NOT the same thing and must not be treated alike:
//  - STRONG: the text is provably still painted (background-clip: text, text-shadow, text-stroke).
//    Those suppress unconditionally - there is nothing hidden.
//  - WEAK: the element merely looks like ordinary UI machinery - an declared transition/animation,
//    or a revealable-component marker. Neither proves the text is readable right now, and both are
//    trivially added by whoever authored the page. Taken alone they would hand out a one-line
//    bypass (`transition: opacity .3s` and the detector goes quiet).
// So weak evidence only suppresses when there is little text to hide. An instruction payload needs
// room: the shortest realistic one ("ignore all previous instructions") is already over 30 chars,
// while the UI labels this is meant to silence - tooltips, menu items, badges - sit well below.
const WEAK_BENIGN_MAX_TEXT_LENGTH = 20;

const REVEALABLE_UI_MARKERS = [
    'tooltip', 'dropdown', 'popover', 'popup', 'flyout', 'submenu', 'menu',
    'modal', 'dialog', 'accordion', 'collapse', 'tab', 'panel',
    'skeleton', 'shimmer', 'placeholder', 'loading'
];

function hasRevealableUiMarker(marker) {
    return REVEALABLE_UI_MARKERS.some((uiMarker) => marker.includes(uiMarker));
}

// A scan can also land in the middle of a colour/opacity transition or a fade-in keyframe. Same
// benign signal the style-obfuscation detector already uses for transform suppression.
function hasActiveVisualAnimation(style) {
    return (style.transitionDuration && style.transitionDuration !== '0s')
        || (style.animationName && style.animationName !== 'none');
}

function isWeakBenignCase(context, style) {
    if (context.getTextLength() > WEAK_BENIGN_MAX_TEXT_LENGTH) {
        return false;
    }

    return hasActiveVisualAnimation(style) || hasRevealableUiMarker(context.getMarker());
}

// --- revealable container evidence (TASKS 6.2-B/B7) ---------------------------------------------
// The dominant benign case for `display: none` is a tab panel or an accordion section holding a lot
// of text - exactly what the short-payload rule above cannot silence. Structure is better evidence
// here than a class name, but it is still evidence the page author controls, so it LOWERS severity
// rather than suppressing: whoever adds `role="tabpanel"` to a payload container gets a low-severity
// finding, not silence. Read on the hiding container, never on the text candidate.
const REVEALABLE_CONTAINER_ROLES = ['tabpanel', 'tab', 'menu', 'menuitem', 'dialog', 'tooltip', 'listbox'];

function hasRevealableContainerSignal(element) {
    if (typeof element?.getAttribute !== 'function') {
        return false;
    }

    const role = (element.getAttribute('role') || '').toLowerCase().trim();
    if (REVEALABLE_CONTAINER_ROLES.includes(role)) {
        return true;
    }

    if (typeof element.hasAttribute === 'function'
        && (element.hasAttribute('aria-expanded') || element.hasAttribute('aria-controls'))) {
        return true;
    }

    // A closed <details> hides its own content; the section markup around it is the same widget.
    if (typeof element.closest === 'function' && element.closest('details:not([open])')) {
        return true;
    }

    return hasRevealableUiMarker(getElementMarker(element));
}

function resolveSourceLabel(source) {
    const sourceMessageKey = source === 'ancestor'
        ? 'findingDisplayNoneSourceAncestor'
        : 'findingDisplayNoneSourceSelf';
    return getMessage(sourceMessageKey, undefined, source);
}

function resolveMatchTypeLabel(matchType) {
    const matchTypeMessageKey = matchType === 'inline'
        ? 'findingDisplayNoneMatchTypeInline'
        : 'findingDisplayNoneMatchTypeComputed';
    return getMessage(matchTypeMessageKey, undefined, matchType);
}

function resolveContextLabels(contextSignalKeys, messageKeyBySignal, noneMessageKey, noneFallback) {
    const contextLabels = [];
    for (const contextSignalKey of contextSignalKeys) {
        const contextMessageKey = messageKeyBySignal[contextSignalKey];
        contextLabels.push(getMessage(contextMessageKey, undefined, contextSignalKey));
    }

    if (contextLabels.length === 0) {
        contextLabels.push(getMessage(noneMessageKey, undefined, noneFallback));
    }

    return contextLabels;
}

// --- strategy 1: display: none ----------------------------------------------------------------

function detectDisplayNone(context) {
    const { element, style, module, hiddenTextDisplayMode } = context;

    const matchDisplayNone = (node, nodeStyle) => {
        const displayNoneInline = node.style?.display === 'none';
        const displayNoneComputed = nodeStyle.display === 'none';
        if (!displayNoneInline && !displayNoneComputed) {
            return null;
        }

        return { matched: true, matchType: displayNoneInline ? 'inline' : 'computed' };
    };

    let displayNoneMatched = false;
    let displayNoneSource = '';
    let displayNoneMatchType = '';
    let displayNoneSourceElement = null;

    if (hiddenTextDisplayMode === 'ancestors') {
        // `outermost` on purpose: attribution goes to the topmost display:none node above this text,
        // so a hidden region and every hidden block nested inside it collapse onto one dedupe key
        // instead of producing one finding per hiding level (TASKS B7.3).
        const hidingSource = findHidingSource(
            element,
            (node, isSelf) => matchDisplayNone(node, isSelf ? style : module.getComputedStyle(node)),
            { includeSelf: true, outermost: true }
        );

        if (hidingSource.matched) {
            displayNoneMatched = true;
            displayNoneSource = hidingSource.source;
            displayNoneMatchType = hidingSource.matchType;
            displayNoneSourceElement = hidingSource.sourceElement;
        }
    } else {
        const ownMatch = matchDisplayNone(element, style);
        if (ownMatch) {
            displayNoneMatched = true;
            displayNoneSource = 'self';
            displayNoneMatchType = ownMatch.matchType;
            displayNoneSourceElement = element;
        }
    }

    if (!displayNoneMatched) {
        return [];
    }

    const displayNoneContainer = displayNoneSourceElement || element;
    // The reported element is the hiding CONTAINER, not whichever descendant happened to be scanned
    // first. Candidates are processed in priority buckets, not document order, so a text leaf or a
    // link inside the container is normally scanned before the container itself - describing that
    // node made the one surviving finding point at an arbitrary place in the region (TASKS B7.5).
    const isCollapsedToContainer = displayNoneContainer !== element;
    const displayNoneMatchTypeLabel = resolveMatchTypeLabel(displayNoneMatchType);
    const displayNoneContainerDescriptor = module.describeElement(displayNoneContainer);
    const displayNoneElementDescriptor = module.describeElement(element);

    const hiddenTextDisplayNoneSummary = getMessage('findingHiddenTextDisplayNoneSummary', undefined, 'Potential hidden text via display: none');

    let hiddenTextDisplayNoneDetails;
    if (isCollapsedToContainer) {
        const hiddenTextDisplayNoneCollapsedFallback = `${displayNoneContainerDescriptor} [display:none on container (${displayNoneMatchTypeLabel}); hidden text sample: ${displayNoneElementDescriptor}; mode=${hiddenTextDisplayMode}]`;
        hiddenTextDisplayNoneDetails = getMessage(
            'findingHiddenTextDisplayNoneDetailsCollapsed',
            [displayNoneContainerDescriptor, displayNoneElementDescriptor, displayNoneMatchTypeLabel, hiddenTextDisplayMode],
            hiddenTextDisplayNoneCollapsedFallback
        );
    } else {
        // Container and candidate are the same node: keep the original wording (and its translations).
        const displayNoneSourceToken = `${resolveSourceLabel(displayNoneSource)} ${displayNoneContainerDescriptor}`;
        const hiddenTextDisplayNoneDetailsFallback = `${displayNoneElementDescriptor} [display:none ${displayNoneSourceToken} (${displayNoneMatchTypeLabel}); mode=${hiddenTextDisplayMode}]`;
        hiddenTextDisplayNoneDetails = getMessage(
            'findingHiddenTextDisplayNoneDetails',
            [displayNoneElementDescriptor, displayNoneSourceToken, displayNoneMatchTypeLabel, hiddenTextDisplayMode],
            hiddenTextDisplayNoneDetailsFallback
        );
    }

    // Own path builder, keyed on the SOURCE element and using child indexes (not getElementPath):
    // the dedupe key must collapse every descendant hidden by the same container. `self`/`ancestor`
    // is deliberately NOT part of the key - the container reports it as `self` while its descendants
    // report the same container as `ancestor`, which used to split one hidden region in two.
    // An `id` ends the walk: it is document-unique, so anything above it adds nothing to identity
    // (and keeps the common case short). The depth cap is only a guard against pathological trees;
    // it is high enough that it no longer merges distinct deep containers, which the old cap of 8 did.
    const displayNoneSourcePathSegments = [];
    let displayNoneSourcePathNode = displayNoneContainer;
    let displayNoneSourceDepth = 0;
    while (displayNoneSourcePathNode && displayNoneSourceDepth < 32) {
        const nodeTagName = displayNoneSourcePathNode.tagName?.toLowerCase() || 'node';
        const nodeId = typeof displayNoneSourcePathNode.id === 'string' ? displayNoneSourcePathNode.id.trim() : '';
        if (nodeId) {
            displayNoneSourcePathSegments.unshift(`${nodeTagName}#${nodeId}`);
            break;
        }

        const parent = displayNoneSourcePathNode.parentElement;
        let siblingIndex = 0;
        if (parent) {
            const siblings = parent.children;
            for (let index = 0; index < siblings.length; index += 1) {
                if (siblings[index] === displayNoneSourcePathNode) {
                    siblingIndex = index;
                    break;
                }
            }
        }
        displayNoneSourcePathSegments.unshift(`${nodeTagName}:${siblingIndex}`);
        displayNoneSourcePathNode = parent;
        displayNoneSourceDepth += 1;
    }
    const displayNoneDedupeKey = `hidden-text|display-none|${hiddenTextDisplayMode}|${displayNoneSourcePathSegments.join('/')}`;

    return [
        createFinding({
            type: 'hidden-text',
            summary: hiddenTextDisplayNoneSummary,
            details: hiddenTextDisplayNoneDetails,
            severity: hasRevealableContainerSignal(displayNoneContainer) ? 'low' : 'medium',
            detector: 'hiddenTextDetector',
            dedupeKey: displayNoneDedupeKey
        })
    ];
}

// --- strategy 2: visibility: hidden ------------------------------------------------------------

function detectVisibilityHidden(context) {
    const { element, style, module } = context;

    const visibilityHiddenInline = element.style?.visibility === 'hidden';
    const visibilityHiddenComputed = style.visibility === 'hidden';

    if (!visibilityHiddenInline && !visibilityHiddenComputed) {
        return [];
    }

    // The walk only REFINES the source label: an ancestor alone never makes this strategy fire,
    // because computed visibility is inherited and the element's own value already reflects it.
    let visibilityHiddenSource = 'self';
    if (!visibilityHiddenInline) {
        const hidingSource = findHidingSource(element, (node) => (
            module.getComputedStyle(node).visibility === 'hidden' ? { matched: true } : null
        ));
        if (hidingSource.matched) {
            visibilityHiddenSource = 'ancestor';
        }
    }

    const visibilitySourceLabel = resolveSourceLabel(visibilityHiddenSource);
    const visibilityMatchTypeLabel = getMessage(
        visibilityHiddenInline ? 'findingDisplayNoneMatchTypeInline' : 'findingDisplayNoneMatchTypeComputed',
        undefined,
        (visibilityHiddenInline ? 'inline' : 'computed')
    );

    const hiddenTextVisibilitySummary = getMessage('findingHiddenTextVisibilitySummary', undefined, 'Potential hidden text via visibility: hidden');

    const hiddenTextVisibilityDetailsFallback = `${module.describeElement(element)} [visibility:hidden ${visibilitySourceLabel} (${visibilityMatchTypeLabel})]`;
    const hiddenTextVisibilityDetails = getMessage('findingHiddenTextVisibilityDetails', [module.describeElement(element), visibilitySourceLabel, visibilityMatchTypeLabel], hiddenTextVisibilityDetailsFallback);

    return [
        createFinding({
            type: 'hidden-text',
            summary: hiddenTextVisibilitySummary,
            details: hiddenTextVisibilityDetails,
            severity: 'medium',
            detector: 'hiddenTextDetector',
            dedupeKey: `hidden-text|visibility-hidden|${module.getElementPath(element)}`
        })
    ];
}

// --- strategy 3: opacity: 0 --------------------------------------------------------------------

function detectOpacityZero(context) {
    const { element, style, module } = context;

    const ownOpacityInlineRaw = element.style?.opacity;
    const ownOpacityInline = ownOpacityInlineRaw !== '' && ownOpacityInlineRaw != null
        && Number.parseFloat(ownOpacityInlineRaw) === 0;
    const ownOpacityComputed = Number.parseFloat(style.opacity) === 0;

    let opacityMatched = ownOpacityInline || ownOpacityComputed;
    let opacitySource = opacityMatched ? 'self' : '';
    let opacityMatchType = ownOpacityInline ? 'inline' : (ownOpacityComputed ? 'computed' : '');

    if (!opacityMatched) {
        const hidingSource = findHidingSource(element, (node) => {
            const parentOpacityInlineRaw = node.style?.opacity;
            const parentOpacityInline = parentOpacityInlineRaw !== '' && parentOpacityInlineRaw != null
                && Number.parseFloat(parentOpacityInlineRaw) === 0;
            const parentOpacityComputed = Number.parseFloat(module.getComputedStyle(node).opacity) === 0;
            if (!parentOpacityInline && !parentOpacityComputed) {
                return null;
            }

            return { matched: true, matchType: parentOpacityInline ? 'inline' : 'computed' };
        });

        if (hidingSource.matched) {
            opacityMatched = true;
            opacitySource = hidingSource.source;
            opacityMatchType = hidingSource.matchType;
        }
    }

    if (!opacityMatched) {
        return [];
    }

    const opacitySourceLabel = resolveSourceLabel(opacitySource);
    const opacityMatchTypeLabel = resolveMatchTypeLabel(opacityMatchType);

    const hiddenTextOpacitySummary = getMessage('findingHiddenTextOpacitySummary', undefined, 'Potential hidden text via opacity: 0');

    const hiddenTextOpacityDetailsFallback = `${module.describeElement(element)} [opacity:0 ${opacitySourceLabel} (${opacityMatchTypeLabel})]`;
    const hiddenTextOpacityDetails = getMessage('findingHiddenTextOpacityDetails', [module.describeElement(element), opacitySourceLabel, opacityMatchTypeLabel], hiddenTextOpacityDetailsFallback);

    return [
        createFinding({
            type: 'hidden-text',
            summary: hiddenTextOpacitySummary,
            details: hiddenTextOpacityDetails,
            severity: 'low',
            detector: 'hiddenTextDetector',
            dedupeKey: `hidden-text|opacity-zero|${module.getElementPath(element)}`
        })
    ];
}

// --- strategy 4: transparent glyphs -------------------------------------------------------------

const TRANSPARENT_TEXT_CONTEXT_MESSAGE_KEYS = {
    'text-volume': 'findingTransparentTextContextTextVolume',
    offscreen: 'findingTransparentTextContextOffscreen',
    clipping: 'findingTransparentTextContextClipping',
    overlay: 'findingTransparentTextContextOverlay'
};

// The glyphs are painted with -webkit-text-fill-color when it is set; `color` only acts as its
// default. Reading `color` alone would miss `color: black; -webkit-text-fill-color: transparent`.
function resolveGlyphColorValue(style) {
    const fillColor = (style.webkitTextFillColor || '').trim();
    if (fillColor && fillColor.toLowerCase() !== 'currentcolor') {
        return fillColor;
    }

    return (style.color || '').trim();
}

// Returns { rgb, alpha } for the colour the glyphs are actually filled with, or null when the value
// cannot be parsed. Unparseable stays null and callers treat it as opaque - never as hidden.
function resolveGlyphColor(style, colorParserContext) {
    const rawGlyphColor = normalizeAdvancedColor(resolveGlyphColorValue(style), colorParserContext);
    return parseCssColorWithAlpha(rawGlyphColor, rawGlyphColor);
}

function resolveGlyphAlpha(style, colorParserContext) {
    const glyphColor = resolveGlyphColor(style, colorParserContext);
    return glyphColor ? glyphColor.alpha : 1;
}

// Techniques where transparent glyph fill is exactly how VISIBLE text is produced. Missing any of
// these turns the strategy into a false-positive machine on ordinary sites.
function hasVisibleTransparentTextTechnique(style) {
    // Gradient/clipped-image text: the background is painted through the glyph shapes.
    if (style.backgroundClip === 'text' || style.webkitBackgroundClip === 'text') {
        return true;
    }

    // `color: transparent; text-shadow: 0 0 0 red` - the shadow draws the glyphs.
    if (style.textShadow && style.textShadow !== 'none') {
        return true;
    }

    // An outline still renders the glyph shapes.
    const strokeWidth = Number.parseFloat(style.webkitTextStrokeWidth);
    if (Number.isFinite(strokeWidth) && strokeWidth > 0) {
        return true;
    }

    return false;
}

function detectTransparentText(context) {
    const { element, style, module } = context;

    const colorParserContext = module.getColorParser();
    const glyphColor = resolveGlyphColor(style, colorParserContext);
    if (!glyphColor || glyphColor.alpha > TRANSPARENT_TEXT_ALPHA_THRESHOLD) {
        return [];
    }

    // Strong evidence: the glyphs are provably still painted, so nothing is hidden - suppress
    // regardless of how much text there is.
    if (hasVisibleTransparentTextTechnique(style)) {
        return [];
    }

    const textLength = context.getTextLength();
    const isFullyTransparent = glyphColor.alpha === 0;

    const contextSignalKeys = [];
    if (textLength >= 80) {
        contextSignalKeys.push('text-volume');
    }
    if (module.isOffscreen(element)) {
        contextSignalKeys.push('offscreen');
    }
    if (hasClippingContextSignal(style, { includeOverflow: true })) {
        contextSignalKeys.push('clipping');
    }
    if (hasOverlayContextSignal(style)) {
        contextSignalKeys.push('overlay');
    }

    // Fully transparent is self-evident; the near-transparent band needs corroboration.
    if (!isFullyTransparent && contextSignalKeys.length === 0) {
        return [];
    }

    // `color` is inherited, so the element's own computed value already reflects an ancestor that
    // set it. The walk therefore only REFINES the source label and never makes the strategy fire
    // on its own - the same contract as detectVisibilityHidden.
    const inlineGlyphColor = resolveGlyphColor(
        { color: element.style?.color || '', webkitTextFillColor: element.style?.webkitTextFillColor || '' },
        colorParserContext
    );
    const ownInlineTransparent = Boolean(inlineGlyphColor)
        && inlineGlyphColor.alpha <= TRANSPARENT_TEXT_ALPHA_THRESHOLD;

    let transparentSource = 'self';
    let transparentMatchType = ownInlineTransparent ? 'inline' : 'computed';

    if (!ownInlineTransparent) {
        const hidingSource = findHidingSource(element, (node) => {
            const ancestorAlpha = resolveGlyphAlpha(module.getComputedStyle(node), colorParserContext);
            return ancestorAlpha <= TRANSPARENT_TEXT_ALPHA_THRESHOLD ? { matched: true } : null;
        });

        if (hidingSource.matched) {
            transparentSource = 'ancestor';
            const ancestorInline = resolveGlyphColor(
                {
                    color: hidingSource.sourceElement.style?.color || '',
                    webkitTextFillColor: hidingSource.sourceElement.style?.webkitTextFillColor || ''
                },
                colorParserContext
            );
            transparentMatchType = (ancestorInline && ancestorInline.alpha <= TRANSPARENT_TEXT_ALPHA_THRESHOLD)
                ? 'inline'
                : 'computed';
        }
    }

    const transparentModeKey = isFullyTransparent
        ? 'findingTransparentTextModeFull'
        : 'findingTransparentTextModeNear';
    const transparentModeLabel = getMessage(
        transparentModeKey,
        undefined,
        (isFullyTransparent ? 'fully transparent text' : 'near-transparent text')
    );

    const transparentSourceLabel = resolveSourceLabel(transparentSource);
    const transparentMatchTypeLabel = resolveMatchTypeLabel(transparentMatchType);
    const transparentContextLabels = resolveContextLabels(
        contextSignalKeys,
        TRANSPARENT_TEXT_CONTEXT_MESSAGE_KEYS,
        'findingTransparentTextContextNone',
        'none'
    );

    const hiddenTextTransparentSummary = getMessage(
        'findingHiddenTextTransparentSummary',
        undefined,
        'Potential hidden text via transparent text colour'
    );

    const alphaLabel = glyphColor.alpha.toFixed(3);
    const hiddenTextTransparentDetailsFallback = `${module.describeElement(element)} [transparent text ${transparentModeLabel}; alpha=${alphaLabel}; source=${transparentSourceLabel} (${transparentMatchTypeLabel}); context=${transparentContextLabels.join(', ')}; textLen=${textLength}]`;
    const hiddenTextTransparentDetails = getMessage('findingHiddenTextTransparentDetails', [
                module.describeElement(element),
                transparentModeLabel,
                alphaLabel,
                transparentSourceLabel,
                transparentMatchTypeLabel,
                transparentContextLabels.join(', '),
                String(textLength)
            ], hiddenTextTransparentDetailsFallback);

    return [
        createFinding({
            type: 'hidden-text',
            summary: hiddenTextTransparentSummary,
            details: hiddenTextTransparentDetails,
            severity: isFullyTransparent ? 'medium' : 'low',
            detector: 'hiddenTextDetector',
            dedupeKey: `hidden-text|transparent-text|${module.getElementPath(element)}|${transparentModeKey}`
        })
    ];
}

// --- strategy 5: font-size suppression ---------------------------------------------------------

const FONT_SIZE_CONTEXT_MESSAGE_KEYS = {
    offscreen: 'findingFontSizeContextOffscreen',
    opacity: 'findingFontSizeContextOpacity',
    clipping: 'findingFontSizeContextClipping',
    'low-contrast': 'findingFontSizeContextLowContrast',
    overlay: 'findingFontSizeContextOverlay'
};

function detectFontSizeSuppression(context) {
    const { element, style, module } = context;

    const computedFontSizePx = Number.parseFloat(style.fontSize);
    const hasComputedFontSize = Number.isFinite(computedFontSizePx);
    const fontSizeIsZero = hasComputedFontSize && computedFontSizePx <= 0.01;
    const fontSizeIsNearZero = hasComputedFontSize && computedFontSizePx > 0.01 && computedFontSizePx <= 1;
    const fontSizeIsAnomalouslySmall = hasComputedFontSize && computedFontSizePx > 1 && computedFontSizePx <= 2.5;

    if (!fontSizeIsZero && !fontSizeIsNearZero && !fontSizeIsAnomalouslySmall) {
        return [];
    }

    const textLength = context.getTextLength();
    const elementMarker = context.getMarker();
    const isDecorativeSmallTextTag = context.tagName === 'sup' || context.tagName === 'sub';
    const isCompactUiPattern = elementMarker.includes('icon')
        || elementMarker.includes('badge')
        || elementMarker.includes('counter')
        || elementMarker.includes('chip')
        || elementMarker.includes('pill')
        || elementMarker.includes('tag')
        || elementMarker.includes('label');
    const isLikelyBenignSmallText = (isDecorativeSmallTextTag && textLength <= 12)
        || (isCompactUiPattern && textLength <= 10)
        || (textLength <= 4 && !fontSizeIsZero);

    if (isLikelyBenignSmallText) {
        return [];
    }

    const fontSizeThreshold = fontSizeIsZero ? 0.01 : (fontSizeIsNearZero ? 1 : 2.5);
    const ownFontSizeInlineRaw = element.style?.fontSize || '';
    const ownFontSizeInlinePx = Number.parseFloat(ownFontSizeInlineRaw);
    const ownInlineFontSizeMatched = ownFontSizeInlineRaw !== ''
        && Number.isFinite(ownFontSizeInlinePx)
        && ownFontSizeInlinePx <= fontSizeThreshold;

    let fontSizeSource = 'self';
    let fontSizeMatchType = ownInlineFontSizeMatched ? 'inline' : 'computed';

    if (!ownInlineFontSizeMatched) {
        const hidingSource = findHidingSource(element, (node) => {
            const parentFontSizePx = Number.parseFloat(module.getComputedStyle(node).fontSize);
            if (!Number.isFinite(parentFontSizePx) || parentFontSizePx > fontSizeThreshold) {
                return null;
            }

            const parentInlineFontSizeRaw = node.style?.fontSize || '';
            const parentInlineFontSizePx = Number.parseFloat(parentInlineFontSizeRaw);
            const parentInlineFontSizeMatched = parentInlineFontSizeRaw !== ''
                && Number.isFinite(parentInlineFontSizePx)
                && parentInlineFontSizePx <= fontSizeThreshold;

            return { matched: true, matchType: parentInlineFontSizeMatched ? 'inline' : 'computed' };
        });

        if (hidingSource.matched) {
            fontSizeSource = 'ancestor';
            fontSizeMatchType = hidingSource.matchType;
        }
    }

    const fontSizeContextSignalKeys = [];
    if (module.isOffscreen(element)) {
        fontSizeContextSignalKeys.push('offscreen');
    }
    if (hasOpacityContextSignal(style, 0.45)) {
        fontSizeContextSignalKeys.push('opacity');
    }
    if (hasClippingContextSignal(style, { includeOverflow: true })) {
        fontSizeContextSignalKeys.push('clipping');
    }
    if (hasOverlayContextSignal(style)) {
        fontSizeContextSignalKeys.push('overlay');
    }
    if (context.getColorSignals().hasLowContrastSignal) {
        fontSizeContextSignalKeys.push('low-contrast');
    }

    const contextSignalCount = fontSizeContextSignalKeys.length;
    if (fontSizeIsAnomalouslySmall && contextSignalCount < 2) {
        return [];
    }

    const fontSizeSourceLabel = resolveSourceLabel(fontSizeSource);
    const fontSizeMatchTypeLabel = resolveMatchTypeLabel(fontSizeMatchType);

    const fontSizeModeMessageKey = fontSizeIsZero
        ? 'findingFontSizeModeZero'
        : (fontSizeIsNearZero ? 'findingFontSizeModeNearZero' : 'findingFontSizeModeAnomalous');
    const fontSizeModeLabel = getMessage(fontSizeModeMessageKey, undefined, (fontSizeIsZero ? 'font-size: 0' : (fontSizeIsNearZero ? 'near-zero font-size' : 'anomalously small font-size')));

    const fontSizeContextLabels = resolveContextLabels(
        fontSizeContextSignalKeys,
        FONT_SIZE_CONTEXT_MESSAGE_KEYS,
        'findingFontSizeContextNone',
        'none'
    );

    const hiddenTextFontSizeSummary = getMessage('findingHiddenTextFontSizeSummary', undefined, 'Potential hidden text via font-size suppression');

    const fontSizeValueLabel = hasComputedFontSize ? computedFontSizePx.toFixed(2) : 'n/a';
    const hiddenTextFontSizeDetailsFallback = `${module.describeElement(element)} [font-size ${fontSizeModeLabel}; value=${fontSizeValueLabel}px; source=${fontSizeSourceLabel} (${fontSizeMatchTypeLabel}); context=${fontSizeContextLabels.join(', ')}; textLen=${textLength}]`;
    const hiddenTextFontSizeDetails = getMessage('findingHiddenTextFontSizeDetails', [
                module.describeElement(element),
                fontSizeModeLabel,
                fontSizeValueLabel,
                fontSizeSourceLabel,
                fontSizeMatchTypeLabel,
                fontSizeContextLabels.join(', '),
                String(textLength)
            ], hiddenTextFontSizeDetailsFallback);

    const fontSizeSeverity = fontSizeIsAnomalouslySmall
        ? ((contextSignalCount >= 3 || textLength >= 80) ? 'medium' : 'low')
        : 'medium';

    return [
        createFinding({
            type: 'hidden-text',
            summary: hiddenTextFontSizeSummary,
            details: hiddenTextFontSizeDetails,
            severity: fontSizeSeverity,
            detector: 'hiddenTextDetector',
            dedupeKey: `hidden-text|font-size|${module.getElementPath(element)}|${fontSizeModeMessageKey}`
        })
    ];
}

// --- strategy 5: text/background contrast camouflage -------------------------------------------

const CONTRAST_CONTEXT_MESSAGE_KEYS = {
    'small-font': 'findingContrastContextSmallFont',
    opacity: 'findingContrastContextOpacity',
    offscreen: 'findingContrastContextOffscreen',
    clipping: 'findingContrastContextClipping',
    overlay: 'findingContrastContextOverlay'
};

function detectContrastCamouflage(context) {
    const { element, style, module } = context;
    const {
        glyphAlpha,
        hasParsedColorPair,
        colorDistance,
        contrastRatio,
        hasLowContrastSignal,
        hasNearMatchColorSignal
    } = context.getColorSignals();

    // Transparent glyphs belong to detectTransparentText, which ran earlier and owns the verdict -
    // including its benign gates. Without this hand-off a case that strategy deliberately cleared
    // (gradient text, shadow-drawn glyphs) would immediately reappear here as a near-match, since
    // compositing fully transparent text onto its backdrop yields exactly the backdrop colour.
    if (glyphAlpha <= TRANSPARENT_TEXT_ALPHA_THRESHOLD) {
        return [];
    }

    const hasFilterOrBlendSignal = (style.mixBlendMode && style.mixBlendMode !== 'normal')
        || (style.filter && style.filter !== 'none');
    const hasContrastCamouflageSignal = hasParsedColorPair && (hasNearMatchColorSignal || hasLowContrastSignal);

    if (!hasContrastCamouflageSignal || hasFilterOrBlendSignal) {
        return [];
    }

    const textLength = context.getTextLength();
    const marker = context.getMarker();
    const isLikelySecondaryText = marker.includes('secondary')
        || marker.includes('muted')
        || marker.includes('caption')
        || marker.includes('hint')
        || marker.includes('helper')
        || marker.includes('subtitle')
        || context.tagName === 'small';

    const computedFontSizePxForContrast = Number.parseFloat(style.fontSize);
    const hasSmallFontContext = Number.isFinite(computedFontSizePxForContrast) && computedFontSizePxForContrast <= 2.5;

    const contrastContextSignalKeys = [];
    if (hasSmallFontContext) {
        contrastContextSignalKeys.push('small-font');
    }
    if (hasOpacityContextSignal(style, 0.6)) {
        contrastContextSignalKeys.push('opacity');
    }
    if (module.isOffscreen(element)) {
        contrastContextSignalKeys.push('offscreen');
    }
    if (hasClippingContextSignal(style, { includeOverflow: true })) {
        contrastContextSignalKeys.push('clipping');
    }
    if (hasOverlayContextSignal(style)) {
        contrastContextSignalKeys.push('overlay');
    }

    const requiresAdditionalContext = !hasNearMatchColorSignal;
    const hasRequiredContext = !requiresAdditionalContext || contrastContextSignalKeys.length >= 1;
    const benignLowContrastCase = isLikelySecondaryText
        && !hasNearMatchColorSignal
        && contrastRatio > 1.55
        && contrastContextSignalKeys.length === 0
        && textLength <= 120;

    if (!hasRequiredContext || benignLowContrastCase) {
        return [];
    }

    const contrastModeKey = hasNearMatchColorSignal
        ? 'findingContrastModeNearMatch'
        : 'findingContrastModeLowContrast';
    const contrastModeLabel = getMessage(contrastModeKey, undefined, (hasNearMatchColorSignal ? 'near-match colors' : 'low contrast'));

    const contrastContextLabels = resolveContextLabels(
        contrastContextSignalKeys,
        CONTRAST_CONTEXT_MESSAGE_KEYS,
        'findingContrastContextNone',
        'none'
    );

    const contrastRatioLabel = Number.isFinite(contrastRatio) ? contrastRatio.toFixed(2) : 'n/a';
    const colorDistanceLabel = Number.isFinite(colorDistance) ? String(Math.round(colorDistance)) : 'n/a';
    const hiddenTextContrastSummary = getMessage('findingHiddenTextContrastSummary', undefined, 'Potential hidden text via text/background contrast camouflage');

    const hiddenTextContrastDetailsFallback = `${module.describeElement(element)} [contrast ${contrastModeLabel}; ratio=${contrastRatioLabel}; colorDistance=${colorDistanceLabel}; context=${contrastContextLabels.join(', ')}; textLen=${textLength}]`;
    const hiddenTextContrastDetails = getMessage('findingHiddenTextContrastDetails', [
                module.describeElement(element),
                contrastModeLabel,
                contrastRatioLabel,
                colorDistanceLabel,
                contrastContextLabels.join(', '),
                String(textLength)
            ], hiddenTextContrastDetailsFallback);

    // Both camouflage modes share the same severity rule; the split exists only for readability.
    const contrastSeverity = contrastContextSignalKeys.length >= 2 ? 'medium' : 'low';

    return [
        createFinding({
            type: 'hidden-text',
            summary: hiddenTextContrastSummary,
            details: hiddenTextContrastDetails,
            severity: contrastSeverity,
            detector: 'hiddenTextDetector',
            dedupeKey: `hidden-text|low-contrast|${module.getElementPath(element)}`
        })
    ];
}

// --- strategy 6: negative text-indent -----------------------------------------------------------

const TEXT_INDENT_CONTEXT_MESSAGE_KEYS = {
    'overflow-hidden': 'findingTextIndentContextOverflowHidden',
    nowrap: 'findingTextIndentContextNoWrap',
    'small-container': 'findingTextIndentContextSmallContainer',
    opacity: 'findingTextIndentContextOpacity',
    'low-contrast': 'findingTextIndentContextLowContrast',
    clipping: 'findingTextIndentContextClipping',
    overlay: 'findingTextIndentContextOverlay'
};

function detectNegativeTextIndent(context) {
    const { element, style, module } = context;

    const computedTextIndentRaw = (style.textIndent || '').trim();
    const computedTextIndentPxParsed = Number.parseFloat(computedTextIndentRaw);
    const hasComputedNegativeTextIndent = computedTextIndentRaw.startsWith('-')
        && Number.isFinite(computedTextIndentPxParsed)
        && computedTextIndentPxParsed < -0.5;
    const hasComputedNegativeTextIndentByPattern = computedTextIndentRaw.startsWith('-')
        && /-\s*(?:9{3,}|[1-9]\d{3,})/i.test(computedTextIndentRaw.replace(/\s+/g, ''));

    if (!hasComputedNegativeTextIndent && !hasComputedNegativeTextIndentByPattern) {
        return [];
    }

    const elementRect = module.getRect(element);
    const containerWidth = Math.max(elementRect.width || 0, element.clientWidth || 0);
    const computedFontSizePxForIndent = Number.parseFloat(style.fontSize);
    const fontSizeForIndent = Number.isFinite(computedFontSizePxForIndent) ? computedFontSizePxForIndent : 16;

    // Root font size and viewport stay lazy (thunks): rem costs a getComputedStyle, and both
    // are only needed for the units that actually appear in the value.
    const parseIndentToPx = (valueRaw) => parseLengthToPx(valueRaw, {
        fontSizePx: fontSizeForIndent,
        containerWidth,
        rootFontSizePx: () => module.getRootFontSizePx(),
        viewport: context.getViewport
    });

    const computedTextIndentPx = parseIndentToPx(computedTextIndentRaw);
    const computedTextIndentAbsPx = Number.isFinite(computedTextIndentPx) ? Math.abs(computedTextIndentPx) : Number.NaN;
    const significantIndentThresholdPx = Math.max(24, fontSizeForIndent * 1.5, containerWidth * 0.35);
    const significantNegativeIndent = Number.isFinite(computedTextIndentAbsPx) && computedTextIndentAbsPx >= significantIndentThresholdPx;
    const fullHideThresholdPx = Math.max(significantIndentThresholdPx, containerWidth * 0.95);
    const likelyFullTextHideByIndent = Number.isFinite(computedTextIndentAbsPx) && computedTextIndentAbsPx >= fullHideThresholdPx;
    const extremeNegativeIndent = hasComputedNegativeTextIndentByPattern
        || (Number.isFinite(computedTextIndentAbsPx) && computedTextIndentAbsPx >= 3000);

    const overflowHidden = style.overflow === 'hidden' || style.overflowX === 'hidden' || style.overflowY === 'hidden';
    const nowrapText = style.whiteSpace === 'nowrap';
    const lineModelLikelyFirstLineOnly = !nowrapText && !overflowHidden && !extremeNegativeIndent;
    const lineModelNeedsRestriction = lineModelLikelyFirstLineOnly && !likelyFullTextHideByIndent;
    const hasRequiredIndentStrength = extremeNegativeIndent || significantNegativeIndent;

    const textLength = context.getTextLength();
    const marker = context.getMarker();
    const compactUiPattern = marker.includes('icon')
        || marker.includes('launcher')
        || marker.includes('toggle')
        || marker.includes('chat')
        || marker.includes('menu')
        || marker.includes('social')
        || marker.includes('share')
        || marker.includes('button')
        || context.tagName === 'button';
    const accessibilityPattern = marker.includes('sr-only')
        || marker.includes('screen-reader')
        || marker.includes('visually-hidden')
        || marker.includes('a11y');
    const benignCompactCase = compactUiPattern && textLength <= 20 && !extremeNegativeIndent;
    const benignAccessibilityCase = accessibilityPattern && textLength <= 40 && !extremeNegativeIndent;

    if (!hasRequiredIndentStrength || lineModelNeedsRestriction || benignCompactCase || benignAccessibilityCase) {
        return [];
    }

    const ownTextIndentInlineRaw = (element.style?.textIndent || '').trim();
    const ownTextIndentInlinePx = parseIndentToPx(ownTextIndentInlineRaw);
    const ownInlineNegativeIndent = ownTextIndentInlineRaw.startsWith('-')
        && Number.isFinite(ownTextIndentInlinePx)
        && ownTextIndentInlinePx < -0.5;

    let textIndentSource = 'self';
    let textIndentMatchType = ownInlineNegativeIndent ? 'inline' : 'computed';

    if (!ownInlineNegativeIndent) {
        const hidingSource = findHidingSource(element, (node) => {
            const parentTextIndentRaw = (module.getComputedStyle(node).textIndent || '').trim();
            const parentTextIndentPx = parseIndentToPx(parentTextIndentRaw);
            const parentNegativeIndent = parentTextIndentRaw.startsWith('-')
                && Number.isFinite(parentTextIndentPx)
                && parentTextIndentPx < -0.5;
            if (!parentNegativeIndent) {
                return null;
            }

            const parentInlineTextIndentRaw = (node.style?.textIndent || '').trim();
            const parentInlineTextIndentPx = parseIndentToPx(parentInlineTextIndentRaw);
            const parentInlineNegativeIndent = parentInlineTextIndentRaw.startsWith('-')
                && Number.isFinite(parentInlineTextIndentPx)
                && parentInlineTextIndentPx < -0.5;

            return { matched: true, matchType: parentInlineNegativeIndent ? 'inline' : 'computed' };
        });

        if (hidingSource.matched) {
            textIndentSource = 'ancestor';
            textIndentMatchType = hidingSource.matchType;
        }
    }

    const contextSignalKeys = [];
    if (overflowHidden) {
        contextSignalKeys.push('overflow-hidden');
    }
    if (nowrapText) {
        contextSignalKeys.push('nowrap');
    }
    if (containerWidth > 0 && containerWidth <= 220) {
        contextSignalKeys.push('small-container');
    }
    if (hasOpacityContextSignal(style, 0.6)) {
        contextSignalKeys.push('opacity');
    }
    if (context.getColorSignals().hasLowContrastSignal) {
        contextSignalKeys.push('low-contrast');
    }
    if (hasClippingContextSignal(style)) {
        contextSignalKeys.push('clipping');
    }
    if (hasOverlayContextSignal(style)) {
        contextSignalKeys.push('overlay');
    }

    const textIndentSourceLabel = resolveSourceLabel(textIndentSource);
    const textIndentMatchTypeLabel = resolveMatchTypeLabel(textIndentMatchType);

    const textIndentModeKey = extremeNegativeIndent
        ? 'findingTextIndentModeExtreme'
        : 'findingTextIndentModeSignificant';
    const textIndentModeLabel = getMessage(textIndentModeKey, undefined, (extremeNegativeIndent ? 'extreme negative text-indent' : 'significant negative text-indent'));

    const textIndentContextLabels = resolveContextLabels(
        contextSignalKeys,
        TEXT_INDENT_CONTEXT_MESSAGE_KEYS,
        'findingTextIndentContextNone',
        'none'
    );

    const lineModelKey = lineModelLikelyFirstLineOnly
        ? 'findingTextIndentLineModelFirstLineOnlyRisk'
        : 'findingTextIndentLineModelLikelyFullHide';
    const lineModelLabel = getMessage(lineModelKey, undefined, (lineModelLikelyFirstLineOnly ? 'first-line-only risk' : 'likely full text hide'));

    const hiddenTextTextIndentSummary = getMessage('findingHiddenTextTextIndentSummary', undefined, 'Potential hidden text via negative text-indent');

    const textIndentValueLabel = Number.isFinite(computedTextIndentPx)
        ? `${computedTextIndentPx.toFixed(2)}px`
        : computedTextIndentRaw;
    const hiddenTextTextIndentDetailsFallback = `${module.describeElement(element)} [text-indent ${textIndentModeLabel}; value=${textIndentValueLabel}; source=${textIndentSourceLabel} (${textIndentMatchTypeLabel}); context=${textIndentContextLabels.join(', ')}; lineModel=${lineModelLabel}; textLen=${textLength}]`;
    const hiddenTextTextIndentDetails = getMessage('findingHiddenTextTextIndentDetails', [
                module.describeElement(element),
                textIndentModeLabel,
                textIndentValueLabel,
                textIndentSourceLabel,
                textIndentMatchTypeLabel,
                textIndentContextLabels.join(', '),
                lineModelLabel,
                String(textLength)
            ], hiddenTextTextIndentDetailsFallback);

    const textIndentSeverity = extremeNegativeIndent
        ? ((contextSignalKeys.length >= 2 || textLength >= 80) ? 'medium' : 'low')
        : (contextSignalKeys.length >= 2 ? 'medium' : 'low');

    return [
        createFinding({
            type: 'hidden-text',
            summary: hiddenTextTextIndentSummary,
            details: hiddenTextTextIndentDetails,
            severity: textIndentSeverity,
            detector: 'hiddenTextDetector',
            dedupeKey: `hidden-text|text-indent|${module.getElementPath(element)}|${textIndentModeKey}`
        })
    ];
}

// --- strategy 7: deliberate off-screen positioning ----------------------------------------------

// True when any of the four inset values alone pushes the box far outside the viewport.
function hasExtremeInsetValue(insetValues, { width: viewportWidth, height: viewportHeight }) {
    for (const insetValueRaw of insetValues) {
        if (!insetValueRaw || insetValueRaw === 'auto') {
            continue;
        }

        const insetValue = insetValueRaw.trim().toLowerCase();
        const insetNumeric = Number.parseFloat(insetValue);
        if (!Number.isFinite(insetNumeric)) {
            continue;
        }

        const isPercentUnit = insetValue.endsWith('%');
        const isViewportUnit = insetValue.endsWith('vw') || insetValue.endsWith('vh');
        const isPxLikeUnit = insetValue.endsWith('px') || (!isPercentUnit && !isViewportUnit);

        const isExtremePxLike = isPxLikeUnit && (
            insetNumeric <= -OFFSCREEN_THRESHOLD_PX * 2
            || insetNumeric >= Math.max(viewportWidth, viewportHeight) + OFFSCREEN_THRESHOLD_PX
        );
        const isExtremeViewport = isViewportUnit && Math.abs(insetNumeric) >= 100;
        const isExtremePercent = isPercentUnit && Math.abs(insetNumeric) >= 150;

        if (isExtremePxLike || isExtremeViewport || isExtremePercent) {
            return true;
        }
    }

    return false;
}

function isFullyOffscreenRect(rect, { width: viewportWidth, height: viewportHeight }) {
    const horizontally = rect.right <= -OFFSCREEN_THRESHOLD_PX
        || rect.left >= viewportWidth + OFFSCREEN_THRESHOLD_PX;
    const vertically = rect.bottom <= -OFFSCREEN_THRESHOLD_PX
        || rect.top >= viewportHeight + OFFSCREEN_THRESHOLD_PX;

    return { horizontally, vertically, offscreen: horizontally || vertically };
}

function detectOffscreen(context) {
    const { element, style, module } = context;

    const viewport = context.getViewport();
    const elementRect = module.getRect(element);
    const elementOffscreen = isFullyOffscreenRect(elementRect, viewport);

    if (!elementOffscreen.offscreen) {
        return [];
    }

    // Walks from the element upwards for the node that is both off-screen AND positioned with an
    // explicit off-screen signal (extreme inset or translate) - that node is the attributed source.
    const hidingSource = findHidingSource(element, (node, isSelf) => {
        const currentStyle = isSelf ? style : module.getComputedStyle(node);
        const currentRect = isSelf ? elementRect : module.getRect(node);

        const currentFullyOffscreen = isFullyOffscreenRect(currentRect, viewport).offscreen;
        const currentPosition = currentStyle.position || 'static';
        const hasPositionContext = ['absolute', 'fixed', 'sticky', 'relative'].includes(currentPosition);

        const hasExtremeInset = hasExtremeInsetValue(
            [currentStyle.left, currentStyle.top, currentStyle.right, currentStyle.bottom],
            viewport
        );

        const inlineTransform = node.style?.transform || '';
        const computedTransform = currentStyle.transform || 'none';
        const hasScaleZeroTransform = inlineTransform.includes('scale(0') || computedTransform.includes('scale(0');

        let hasTransformTranslate = inlineTransform.includes('translate')
            || hasExtremeTranslateFunction([inlineTransform, computedTransform], viewport);

        if (!hasTransformTranslate && computedTransform !== 'none' && !hasScaleZeroTransform) {
            hasTransformTranslate = hasExtremeMatrixTranslate(computedTransform, viewport);
        }

        const hasOffscreenSignal = hasExtremeInset || hasTransformTranslate;
        if (!currentFullyOffscreen || !hasPositionContext || !hasOffscreenSignal) {
            return null;
        }

        return {
            matched: true,
            details: {
                position: currentPosition,
                signalType: hasExtremeInset && hasTransformTranslate
                    ? 'coordinates+transform'
                    : (hasExtremeInset ? 'coordinates' : 'transform'),
                rect: currentRect
            }
        };
    }, { includeSelf: true });

    if (!hidingSource.matched) {
        return [];
    }

    const offscreenSource = hidingSource.source;
    const { position: offscreenPosition, signalType: offscreenSignalType, rect: offscreenRectForDetails } = hidingSource.details;

    const scrollableAncestor = findHidingSource(element, (node) => {
        const parentStyle = module.getComputedStyle(node);
        const isScrollableX = (parentStyle.overflowX === 'auto' || parentStyle.overflowX === 'scroll')
            && node.scrollWidth > node.clientWidth + 4;
        return isScrollableX ? { matched: true } : null;
    });

    const elementMarker = context.getMarker();
    const elementTextLength = context.getTextLength();
    const isAccessibilityPattern = elementMarker.includes('sr-only')
        || elementMarker.includes('screen-reader')
        || elementMarker.includes('visually-hidden')
        || elementMarker.includes('a11y');
    const isOffCanvasPattern = elementMarker.includes('off-canvas')
        || elementMarker.includes('offcanvas')
        || elementMarker.includes('drawer')
        || elementMarker.includes('sidebar')
        || elementMarker.includes('menu');
    const isCarouselPattern = elementMarker.includes('carousel')
        || elementMarker.includes('slider')
        || elementMarker.includes('swiper');
    const isFrameworkContainer = elementMarker.includes('container') || elementMarker.includes('wrapper');
    const hasExtendedTextPayload = elementTextLength >= 80;

    const skipAsBenignPattern = isAccessibilityPattern
        || (scrollableAncestor.matched && elementOffscreen.horizontally && !elementOffscreen.vertically)
        || ((isOffCanvasPattern || isCarouselPattern) && !hasExtendedTextPayload)
        || (isFrameworkContainer && elementTextLength < 12);

    if (skipAsBenignPattern) {
        return [];
    }

    const offscreenSourceLabel = resolveSourceLabel(offscreenSource);

    const offscreenSignalLabelMessageKey = offscreenSignalType === 'coordinates+transform'
        ? 'findingOffscreenSignalCoordinatesAndTransform'
        : (offscreenSignalType === 'transform'
            ? 'findingOffscreenSignalTransform'
            : 'findingOffscreenSignalCoordinates');
    const offscreenSignalLabel = getMessage(offscreenSignalLabelMessageKey, undefined, offscreenSignalType);

    const hiddenTextOffscreenSummary = getMessage('findingHiddenTextOffscreenSummary', undefined, 'Potential hidden text via deliberate off-screen positioning');

    const offscreenRectLabel = `l=${Math.round(offscreenRectForDetails.left)}, t=${Math.round(offscreenRectForDetails.top)}, r=${Math.round(offscreenRectForDetails.right)}, b=${Math.round(offscreenRectForDetails.bottom)}`;
    const hiddenTextOffscreenDetailsFallback = `${module.describeElement(element)} [off-screen ${offscreenSourceLabel}; signals=${offscreenSignalLabel}; position=${offscreenPosition}; rect=${offscreenRectLabel}]`;
    const hiddenTextOffscreenDetails = getMessage('findingHiddenTextOffscreenDetails', [
                module.describeElement(element),
                offscreenSourceLabel,
                offscreenSignalLabel,
                offscreenPosition,
                offscreenRectLabel
            ], hiddenTextOffscreenDetailsFallback);

    return [
        createFinding({
            type: 'hidden-text',
            summary: hiddenTextOffscreenSummary,
            details: hiddenTextOffscreenDetails,
            severity: 'low',
            detector: 'hiddenTextDetector',
            dedupeKey: `hidden-text|off-screen|${module.getElementPath(element)}|${offscreenSignalType}`
        })
    ];
}

// --- strategy 8: generic fallback ----------------------------------------------------------------

function detectGeneric(context) {
    const { element, style, module } = context;

    // Last-resort branch, deliberately narrowed (TASKS 7.2, variant A). It used to gate on
    // isVisuallyHidden(), which also counts font-size: 0, a negative text-indent and bare
    // off-screen geometry - the very signals the explainable strategies above had already weighed
    // WITH their benign rules. Re-testing them here resurrected exactly the false positives those
    // rules rejected (<sup>/<sub>, icon/badge, inherited small indents, off-canvas, carousels), and
    // reported them without any explanation. Only the three unconditional forms of hiding remain.
    //
    // utils/domUtils.isVisuallyHidden() itself is unchanged: it stays a deliberately coarse helper
    // for candidate selection, where coarseness is fine. What changed is its role as a verdict.
    //
    // Reachability: in practice this branch no longer fires. display:none is claimed by
    // detectDisplayNone (in `self` mode a descendant of a display:none subtree keeps its own
    // computed display, so there is nothing to claim), while visibility:hidden and opacity:0 are
    // inherited/own values that detectVisibilityHidden and detectOpacityZero always claim first.
    // It is kept as a safety net so that a future strategy suppressing its own case cannot silently
    // drop an outright hidden element.
    const isUnconditionallyHidden = style.display === 'none'
        || style.visibility === 'hidden'
        || style.opacity === '0';
    if (!isUnconditionallyHidden) {
        return [];
    }

    return [
        createFinding({
            type: 'hidden-text',
            summary: getMessage('findingHiddenTextGenericSummary', undefined, 'Potential hidden or visually suppressed text'),
            details: module.describeElement(element),
            severity: 'medium',
            detector: 'hiddenTextDetector',
            dedupeKey: `hidden-text|generic|${module.getElementPath(element)}`
        })
    ];
}

const PARSE_RGB_LIKE_PATTERN = /rgba?\(\s*([0-9.]+)(?:\s*,\s*|\s+)([0-9.]+)(?:\s*,\s*|\s+)([0-9.]+)(?:\s*(?:,|\/)\s*([0-9.]+%?)\s*)?\)/i;
const PARSE_HEX_PATTERN = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const PARSE_HSL_PATTERN = /^hsla?\(\s*([+-]?[0-9]*\.?[0-9]+)(deg|rad|turn)?(?:\s*,\s*|\s+)([0-9]*\.?[0-9]+)%(?:\s*,\s*|\s+)([0-9]*\.?[0-9]+)%(?:\s*(?:,|\/)\s*([0-9.]+%?)\s*)?/i;
const PARSE_LAB_LIKE_PATTERN = /^(oklab|lab|oklch|lch)\(\s*([+-]?[0-9]*\.?[0-9]+)(%?)/i;
const SUPPORTS_ADVANCED_COLOR_PATTERN = /(hsl|hsla|lab|lch|oklab|oklch|currentcolor)/i;

// What a browser paints under a page that never sets a background: the canvas is white, not black.
const WHITE_CANVAS_RGB = [255, 255, 255];

// Resolves what is actually painted behind the element's text, as [r, g, b], or null when it cannot
// be known. Replaces the pre-6.2-B walk, which stopped at the first non-transparent-LOOKING string
// and, on a page without any background, ended up reading the root's 'rgba(0, 0, 0, 0)' as opaque
// black - firing on every dark text run while missing white-on-white (TASKS 6.2-B/B1).
//
// Model: walk from the element upwards collecting semi-transparent layers until an opaque one is
// found, then flatten them over that base (or over the white canvas when no opaque layer exists).
// A background-image / gradient anywhere on the way makes the backdrop unknown: it paints over the
// element's own background-color, so no colour underneath can be trusted.
export function resolveBackdropColor(element, style, module, colorParserContext) {
    const layers = [];
    let currentNode = element;
    let currentStyle = style;
    let opaqueBase = null;

    while (currentNode) {
        if ((currentStyle.backgroundImage || 'none') !== 'none') {
            return null;
        }

        const layer = parseCssColorWithAlpha(
            normalizeAdvancedColor((currentStyle.backgroundColor || '').trim(), colorParserContext)
        );
        if (layer) {
            if (layer.alpha >= 1) {
                opaqueBase = layer.rgb;
                break;
            }
            if (layer.alpha > 0) {
                layers.push(layer);
            }
        }

        currentNode = currentNode.parentElement;
        currentStyle = currentNode ? module.getComputedStyle(currentNode) : null;
    }

    // Composited in floating point and rounded once at the end: rounding every layer would
    // accumulate error on deep stacks of translucent overlays.
    let backdrop = opaqueBase || WHITE_CANVAS_RGB;
    for (let index = layers.length - 1; index >= 0; index -= 1) {
        backdrop = compositeOver(layers[index], backdrop);
    }

    return backdrop.map((channel) => Math.round(channel));
}

// Standard source-over alpha compositing of one layer onto an opaque backdrop.
function compositeOver({ rgb, alpha }, backdropRgb) {
    return [
        (rgb[0] * alpha) + (backdropRgb[0] * (1 - alpha)),
        (rgb[1] * alpha) + (backdropRgb[1] * (1 - alpha)),
        (rgb[2] * alpha) + (backdropRgb[2] * (1 - alpha))
    ];
}

function parseAlphaComponent(rawAlpha) {
    if (rawAlpha === undefined || rawAlpha === null || rawAlpha === '') {
        return 1;
    }

    const numeric = Number.parseFloat(rawAlpha);
    if (!Number.isFinite(numeric)) {
        return 1;
    }

    const normalized = String(rawAlpha).trim().endsWith('%') ? numeric / 100 : numeric;
    return Math.max(0, Math.min(1, normalized));
}

// Pure CSS-color parser used for the TEXT colour: rgb/rgba, #hex (3/4/6/8), hsl/hsla, and the
// lightness-only approximation for lab/lch/oklab/oklch. `currentColorFallback` mirrors the original
// substitution for the literal 'currentcolor' keyword. Returns [r, g, b] or null.
// Alpha is intentionally NOT considered here: this path answers "what colour are the glyphs", and
// the transparent-text case is tracked separately as TASKS 6.2-B/B4. The backdrop path uses
// parseCssColorWithAlpha instead. Covered by a *.test.mjs shield.
export function parseCssColorToRgb(rawColor, currentColorFallback = '') {
    const parsed = parseCssColorWithAlpha(rawColor, currentColorFallback);
    if (!parsed || parsed.keyword === 'transparent') {
        return null;
    }

    return parsed.rgb;
}

// Same parser, but keeping the alpha channel: rgb()/rgba() 4th component (including the `/ 50%`
// syntax), the #rgba nibble and #rrggbbaa byte, the hsl()/hsla() 4th component, and the
// 'transparent' keyword (alpha 0). lab/lch/oklab/oklch report alpha 1 - that branch is nearly
// unreachable anyway, the canvas parser normalizes those to rgb first.
// Returns { rgb: [r, g, b], alpha, keyword } or null. No DOM access.
export function parseCssColorWithAlpha(rawColor, currentColorFallback = '') {
    let colorValue = (rawColor || '').trim().toLowerCase();
    if (!colorValue) {
        return null;
    }

    if (colorValue === 'currentcolor') {
        colorValue = (currentColorFallback || '').trim().toLowerCase();
    }

    if (colorValue === 'transparent') {
        return { rgb: [0, 0, 0], alpha: 0, keyword: 'transparent' };
    }

    const rgbMatch = colorValue.match(PARSE_RGB_LIKE_PATTERN);
    if (rgbMatch) {
        return {
            rgb: [
                Math.max(0, Math.min(255, Number.parseFloat(rgbMatch[1]))),
                Math.max(0, Math.min(255, Number.parseFloat(rgbMatch[2]))),
                Math.max(0, Math.min(255, Number.parseFloat(rgbMatch[3])))
            ],
            alpha: parseAlphaComponent(rgbMatch[4]),
            keyword: ''
        };
    }

    const hexMatch = colorValue.match(PARSE_HEX_PATTERN);
    if (hexMatch) {
        const hexRaw = hexMatch[1];
        let hexExpanded = hexRaw;
        if (hexRaw.length === 3 || hexRaw.length === 4) {
            hexExpanded = hexRaw.split('').map((char) => char + char).join('');
        }

        const hexRgb = hexExpanded.length >= 6 ? hexExpanded.slice(0, 6) : hexExpanded;
        const r = Number.parseInt(hexRgb.slice(0, 2), 16);
        const g = Number.parseInt(hexRgb.slice(2, 4), 16);
        const b = Number.parseInt(hexRgb.slice(4, 6), 16);
        if (![r, g, b].every((channel) => Number.isFinite(channel))) {
            return null;
        }

        const hexAlphaByte = hexExpanded.length === 8 ? Number.parseInt(hexExpanded.slice(6, 8), 16) : Number.NaN;
        return {
            rgb: [r, g, b],
            alpha: Number.isFinite(hexAlphaByte) ? hexAlphaByte / 255 : 1,
            keyword: ''
        };
    }

    const hslMatch = colorValue.match(PARSE_HSL_PATTERN);
    if (hslMatch) {
        let hue = Number.parseFloat(hslMatch[1]);
        const hueUnit = (hslMatch[2] || 'deg').toLowerCase();
        if (hueUnit === 'rad') {
            hue = hue * (180 / Math.PI);
        } else if (hueUnit === 'turn') {
            hue = hue * 360;
        }
        hue = ((hue % 360) + 360) % 360;
        const saturation = Math.max(0, Math.min(100, Number.parseFloat(hslMatch[3]))) / 100;
        const lightness = Math.max(0, Math.min(100, Number.parseFloat(hslMatch[4]))) / 100;

        const chroma = (1 - Math.abs((2 * lightness) - 1)) * saturation;
        const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
        const m = lightness - (chroma / 2);

        let r1 = 0;
        let g1 = 0;
        let b1 = 0;
        if (hue < 60) {
            r1 = chroma; g1 = x; b1 = 0;
        } else if (hue < 120) {
            r1 = x; g1 = chroma; b1 = 0;
        } else if (hue < 180) {
            r1 = 0; g1 = chroma; b1 = x;
        } else if (hue < 240) {
            r1 = 0; g1 = x; b1 = chroma;
        } else if (hue < 300) {
            r1 = x; g1 = 0; b1 = chroma;
        } else {
            r1 = chroma; g1 = 0; b1 = x;
        }

        return {
            rgb: [
                Math.round((r1 + m) * 255),
                Math.round((g1 + m) * 255),
                Math.round((b1 + m) * 255)
            ],
            alpha: parseAlphaComponent(hslMatch[5]),
            keyword: ''
        };
    }

    // Lightness-only approximation (chroma/hue dropped). Rarely reached in a browser: the canvas
    // parser above normalizes lab/lch/oklab/oklch to rgb first. The percent/number split differs
    // per model: ok* carries L in 0..1, lab/lch in 0..100.
    const labLikeMatch = colorValue.match(PARSE_LAB_LIKE_PATTERN);
    if (labLikeMatch) {
        const labModel = labLikeMatch[1];
        const lValue = Number.parseFloat(labLikeMatch[2]);
        const isPercent = labLikeMatch[3] === '%';
        const lightnessChannel = (labModel.startsWith('ok') && !isPercent)
            ? Math.max(0, Math.min(255, lValue * 255))
            : Math.max(0, Math.min(255, (lValue / 100) * 255));

        return {
            rgb: [
                Math.round(lightnessChannel),
                Math.round(lightnessChannel),
                Math.round(lightnessChannel)
            ],
            alpha: 1,
            keyword: ''
        };
    }

    return null;
}

// Normalizes advanced color notations through a cached canvas 2d context, exactly as before.
// The context still lives on the module as a dynamic field; 6.3 replaces it with getColorParser().
function normalizeAdvancedColor(colorValue, colorParserContext) {
    if (!colorParserContext || !SUPPORTS_ADVANCED_COLOR_PATTERN.test(colorValue)) {
        return colorValue;
    }

    const fallbackFillStyle = '#010203';
    colorParserContext.fillStyle = fallbackFillStyle;
    colorParserContext.fillStyle = colorValue;
    const parsedColor = colorParserContext.fillStyle;

    return (parsedColor && parsedColor !== fallbackFillStyle) ? parsedColor : colorValue;
}

// Text/background color comparison shared by the font-size, contrast and text-indent strategies.
// Computed at most once per element (memoized by the caller), and only when a strategy asks for it.
export function resolveColorSignals({ element, style, module }) {
    const colorParserContext = module.getColorParser();

    // The glyph fill, not plain `color`: -webkit-text-fill-color overrides it when set.
    const glyphColor = resolveGlyphColor(style, colorParserContext);
    const glyphAlpha = glyphColor ? glyphColor.alpha : 1;

    // null means "the backdrop cannot be known" (a background image or gradient paints it): the
    // colour pair stays unparsed so the contrast strategy and the low-contrast context signal
    // simply do not fire, instead of guessing.
    const backgroundColorChannels = resolveBackdropColor(element, style, module, colorParserContext);

    // Translucent glyphs are literally blended with what is behind them, so the colour a reader
    // perceives is the composite - comparing the raw declared colour would overstate the contrast.
    let textColorChannels = glyphColor ? glyphColor.rgb : null;
    if (textColorChannels && backgroundColorChannels && glyphAlpha < 1) {
        textColorChannels = compositeOver({ rgb: textColorChannels, alpha: glyphAlpha }, backgroundColorChannels)
            .map((channel) => Math.round(channel));
    }

    const hasParsedColorPair = Boolean(textColorChannels && backgroundColorChannels);
    let colorDistance = Number.POSITIVE_INFINITY;
    let contrastRatio = Number.POSITIVE_INFINITY;

    if (hasParsedColorPair) {
        colorDistance = Math.abs(textColorChannels[0] - backgroundColorChannels[0])
            + Math.abs(textColorChannels[1] - backgroundColorChannels[1])
            + Math.abs(textColorChannels[2] - backgroundColorChannels[2]);

        const relativeLuminance = (channel) => {
            const normalized = Math.max(0, Math.min(255, channel)) / 255;
            return normalized <= 0.03928
                ? normalized / 12.92
                : Math.pow((normalized + 0.055) / 1.055, 2.4);
        };
        const textLuminance = (0.2126 * relativeLuminance(textColorChannels[0]))
            + (0.7152 * relativeLuminance(textColorChannels[1]))
            + (0.0722 * relativeLuminance(textColorChannels[2]));
        const backgroundLuminance = (0.2126 * relativeLuminance(backgroundColorChannels[0]))
            + (0.7152 * relativeLuminance(backgroundColorChannels[1]))
            + (0.0722 * relativeLuminance(backgroundColorChannels[2]));
        const lighter = Math.max(textLuminance, backgroundLuminance);
        const darker = Math.min(textLuminance, backgroundLuminance);
        contrastRatio = (lighter + 0.05) / (darker + 0.05);
    }

    return {
        textColorChannels,
        backgroundColorChannels,
        glyphAlpha,
        hasParsedColorPair,
        colorDistance,
        contrastRatio,
        hasLowContrastSignal: hasParsedColorPair && (colorDistance <= 36 || contrastRatio <= 2.2),
        hasNearMatchColorSignal: hasParsedColorPair && (colorDistance <= 18 || contrastRatio <= 1.15)
    };
}

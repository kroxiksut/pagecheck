import { createFinding, getMessage } from '../utils/findingFactory.js';
import { getElementMarker, getNormalizedText, hasNonWhitespaceText, isPasswordInput, parseSuppressedScale } from '../utils/domUtils.js';

export function scanStyleObfuscation({ element, style, module, supportingFindings = [], getNormalizedText: getContextText, getPseudoStyle }) {
    const baseFindings = [];
    // One content-context probe per element instead of one per branch (TASKS 8.4). It walks the
    // subtree with up to three querySelector passes, so it is built lazily - only after a branch
    // has an actual style match - and handed out as a COPY: scanFilterBlendManipulation pushes
    // 'overlay' into its context, and that must not leak into the transform and clipping branches.
    let clippingContextBase;
    const getClippingContext = () => {
        if (clippingContextBase === undefined) {
            clippingContextBase = resolveClippingContext(element, module);
        }
        return {
            types: [...clippingContextBase.types],
            hasRelevantContent: clippingContextBase.hasRelevantContent
        };
    };

    const semanticMismatchFinding = scanSemanticVisibilityMismatch({ element, style, module, getClippingContext });
    if (semanticMismatchFinding) {
        baseFindings.push(semanticMismatchFinding);
    } else {
        const filterBlendFinding = scanFilterBlendManipulation({ element, style, module, getClippingContext });
        if (filterBlendFinding) {
            baseFindings.push(filterBlendFinding);
        } else {
            const transformFinding = scanTransformSuppression({ element, style, module, getClippingContext });
            if (transformFinding) {
                baseFindings.push(transformFinding);
            } else {
                const clippingFinding = scanClippingHiding({ element, style, module, getClippingContext });
                if (clippingFinding) {
                    baseFindings.push(clippingFinding);
                } else if (
                    !hasUnexplainedTransformSuppressionOnly(style, element, module)
                    && !hasUnexplainedClippingOnly(style, element, module)
                    && !hasUnexplainedFilterBlendOnly(style, element, module)
                    && !hasUnexplainedSemanticMismatchOnly(style, element)
                    && module.hasStyleObfuscationSignals(style, element)
                ) {
                    baseFindings.push(
                        createFinding({
                            type: 'style-obfuscation',
                            summary: getMessage('findingStyleObfuscationSummary', undefined, 'Potential CSS-based visual obfuscation'),
                            details: module.describeElement(element),
                            severity: 'low',
                            detector: 'styleObfuscationDetector',
                            dedupeKey: `style-obfuscation|${module.getElementPath(element)}`
                        })
                    );
                }
            }
        }
    }

    const visualContext = {
        element,
        style,
        module,
        findings: [...supportingFindings, ...baseFindings],
        getText: typeof getContextText === 'function' ? getContextText : () => getNormalizedText(element),
        getPseudoStyle
    };
    const presentationFindings = scanCssTextPresentation(visualContext);
    return [...baseFindings, ...presentationFindings];
}

function scanSemanticVisibilityMismatch({ element, style, module, getClippingContext }) {
    if (!(element instanceof Element) || !element.isConnected) {
        return null;
    }

    if (isPasswordInput(element)) {
        return null;
    }

    if (!isVisuallyPresentForSemanticAnalysis(element, style, module)) {
        return null;
    }

    const semanticMatch = resolveSemanticMismatchMatch(element);
    if (!semanticMatch) {
        return null;
    }

    const context = resolveSemanticContext(element, module, getClippingContext);
    if (!context.hasRelevantContent) {
        return null;
    }

    const benignContextSignals = resolveSemanticBenignContext(element, context, semanticMatch);
    if (context.types.length === 1 && context.types.includes('decorative')) {
        return null;
    }

    const escalationSignals = resolveSemanticEscalationSignals(element, style, context, semanticMatch);
    const hasInteractiveContext = context.types.some((type) => ['input', 'editable', 'clickable', 'focusable'].includes(type));
    const strongEscalation = escalationSignals.some((signal) => [
        'hidden-input',
        'consent-or-upload',
        'prompt-or-action',
        'prompt-like-context',
        'deceptive-capture-context'
    ].includes(signal));

    let severity = hasInteractiveContext || context.types.includes('text') ? 'medium' : 'low';
    if (benignContextSignals.length > 0 && !strongEscalation) {
        severity = 'low';
    }
    if (strongEscalation && hasInteractiveContext) {
        severity = 'high';
    }

    const sourceLabel = semanticMatch.source === element ? 'self' : 'ancestor';
    const contextLabel = context.types.join(', ');
    const interactionLabel = context.interactionSignals.length > 0 ? context.interactionSignals.join(', ') : 'none';
    const benignContext = benignContextSignals.length > 0 ? benignContextSignals.join(', ') : 'none';
    const escalation = escalationSignals.length > 0 ? escalationSignals.join(', ') : 'none';
    const detailsFallback = `${module.describeElement(element)} [source=${sourceLabel}; sourceElement=${module.describeElement(semanticMatch.source)}; semanticSignal=${semanticMatch.signal}; context=${contextLabel}; visible=true; interaction=${interactionLabel}; benign=${benignContext}; escalation=${escalation}]`;
    const details = getMessage(
        'findingSemanticVisibilityMismatchDetails',
        [
            module.describeElement(element),
            sourceLabel,
            module.describeElement(semanticMatch.source),
            semanticMatch.signal,
            contextLabel,
            interactionLabel,
            benignContext,
            escalation
        ],
        detailsFallback
    );

    return createFinding({
        type: 'semantic-visibility-mismatch',
        summary: getMessage('findingSemanticVisibilityMismatchSummary', [], 'Visible content is hidden or neutralized in semantic accessibility state'),
        details,
        severity,
        detector: 'styleObfuscationDetector',
        dedupeKey: `semantic-visibility-mismatch|${module.getElementPath(element)}|${module.getElementPath(semanticMatch.source)}|${semanticMatch.signal}|${contextLabel}`
    });
}

function isVisuallyPresentForSemanticAnalysis(element, style, module) {
    let current = element;
    let currentStyle = style;
    let depth = 0;

    while (current instanceof Element && depth <= 4) {
        if (
            currentStyle.display === 'none'
            || currentStyle.visibility === 'hidden'
            || Number.parseFloat(currentStyle.opacity) === 0
            || current.hasAttribute('hidden')
        ) {
            return false;
        }

        current = current.parentElement;
        currentStyle = current ? module.getComputedStyle(current) : null;
        depth += 1;
    }

    const rect = module.getRect(element);
    return Math.max(0, rect.width || 0) > 1 && Math.max(0, rect.height || 0) > 1;
}

function resolveSemanticMismatchMatch(element) {
    let current = element;
    let depth = 0;

    while (current instanceof Element && depth <= 4) {
        if (current.getAttribute('aria-hidden') === 'true') {
            return {
                source: current,
                signal: 'aria-hidden'
            };
        }

        current = current.parentElement;
        depth += 1;
    }

    const role = (element.getAttribute('role') || '').toLowerCase();
    if (role === 'presentation' || role === 'none') {
        return {
            source: element,
            signal: `role=${role}`
        };
    }

    return null;
}

function resolveSemanticContext(element, module, getClippingContext) {
    const baseContext = getClippingContext();
    const tagName = element.tagName?.toLowerCase() || '';
    const tabindexRaw = element.getAttribute('tabindex');
    const tabindex = tabindexRaw === null ? Number.NaN : Number.parseInt(tabindexRaw, 10);
    const nativeFocusable = ['a', 'button', 'input', 'select', 'textarea', 'iframe'].includes(tagName);
    const focusable = !element.hasAttribute('disabled')
        && element.getAttribute('aria-disabled') !== 'true'
        && (nativeFocusable || (Number.isFinite(tabindex) && tabindex >= 0) || element.isContentEditable);
    const interactionSignals = [];

    if (focusable) {
        baseContext.types.push('focusable');
        interactionSignals.push('focusable');
    }
    if (stylePointerEventsActive(element, module)) interactionSignals.push('pointer-events');
    if (Number.isFinite(tabindex)) interactionSignals.push(`tabindex:${tabindex}`);
    if (element.hasAttribute('aria-disabled')) interactionSignals.push(`aria-disabled:${element.getAttribute('aria-disabled')}`);
    if (element.hasAttribute('aria-readonly')) interactionSignals.push(`aria-readonly:${element.getAttribute('aria-readonly')}`);
    if (element.hasAttribute('aria-required')) interactionSignals.push(`aria-required:${element.getAttribute('aria-required')}`);

    return {
        types: [...new Set(baseContext.types)],
        hasRelevantContent: baseContext.hasRelevantContent || focusable,
        interactionSignals
    };
}

function stylePointerEventsActive(element, module) {
    return module.getComputedStyle(element).pointerEvents !== 'none';
}

function resolveSemanticBenignContext(element, context, semanticMatch) {
    const marker = getElementMarker(element);
    const signals = [];

    if (context.types.includes('decorative')) signals.push('decorative-element');
    if (marker.includes('icon') || marker.includes('svg') || marker.includes('decoration') || marker.includes('ornament')) {
        signals.push('decorative-ui');
    }
    if (marker.includes('duplicate') || marker.includes('clone') || marker.includes('mirror')) {
        signals.push('possible-duplicate');
    }
    if (semanticMatch.signal === 'aria-hidden' && (marker.includes('modal') || marker.includes('dialog')) && !context.types.includes('focusable')) {
        signals.push('closed-modal-context');
    }

    return [...new Set(signals)];
}

function resolveSemanticEscalationSignals(element, style, context, semanticMatch) {
    const signals = resolveClippingEscalationSignals(element, style, context);
    const text = getNormalizedText(element).toLowerCase();
    const marker = `${getElementMarker(element)} ${text.slice(0, 160)}`;

    if (semanticMatch.signal.startsWith('role=') && context.types.some((type) => ['clickable', 'focusable', 'input', 'editable'].includes(type))) {
        signals.push('interactive-role-mismatch');
    }
    if (marker.includes('prompt') || marker.includes('instruction') || marker.includes('assistant') || marker.includes('system message')) {
        signals.push('prompt-like-context');
    }
    if (marker.includes('warning') || marker.includes('alert') || marker.includes('security')) {
        signals.push('warning-context');
    }

    return [...new Set(signals)];
}

function scanFilterBlendManipulation({ element, style, module, getClippingContext }) {
    if (!(element instanceof Element) || !element.isConnected) {
        return null;
    }

    if (isPasswordInput(element)) {
        return null;
    }

    const filterBlendMatch = resolveFilterBlendMatch(element, style, module);
    if (!filterBlendMatch) {
        return null;
    }

    const context = getClippingContext();

    const sourceStyle = module.getComputedStyle(filterBlendMatch.source);
    const overlayContext = isOverlayStyleContext(sourceStyle, filterBlendMatch.source);
    if (overlayContext && !context.types.includes('overlay')) {
        context.types.push('overlay');
        context.hasRelevantContent = true;
    }

    if (!context.hasRelevantContent) {
        return null;
    }

    const benignContextSignals = resolveFilterBlendBenignContext(element, context, filterBlendMatch);
    if (context.types.length === 1 && context.types.includes('decorative') && !context.types.includes('overlay')) {
        return null;
    }

    const escalationSignals = resolveFilterBlendEscalationSignals(element, sourceStyle, context, filterBlendMatch);
    const hasRiskContext = context.types.some((type) => ['text', 'input', 'editable', 'clickable', 'overlay'].includes(type));
    const strongSuppression = ['low-brightness', 'low-contrast', 'filter-opacity', 'strong-blur'].includes(filterBlendMatch.reason);
    const strongEscalation = escalationSignals.some((signal) => ['hidden-input', 'consent-or-upload', 'overlay-context', 'deceptive-capture-context'].includes(signal));

    let severity = hasRiskContext ? 'medium' : 'low';
    if (!strongSuppression && !strongEscalation) {
        severity = 'low';
    }
    if (benignContextSignals.length > 0 && !strongEscalation) {
        severity = 'low';
    }
    if (strongSuppression && strongEscalation && hasRiskContext) {
        severity = 'high';
    }

    const sourceLabel = filterBlendMatch.source === element ? 'self' : 'ancestor';
    const contextLabel = context.types.join(', ');
    const benignContext = benignContextSignals.length > 0 ? benignContextSignals.join(', ') : 'none';
    const escalation = escalationSignals.length > 0 ? escalationSignals.join(', ') : 'none';
    const detailsFallback = `${module.describeElement(element)} [source=${sourceLabel}; sourceElement=${module.describeElement(filterBlendMatch.source)}; effectSource=${filterBlendMatch.effectSource}; value=${filterBlendMatch.value}; reason=${filterBlendMatch.reason}; context=${contextLabel}; benign=${benignContext}; escalation=${escalation}]`;
    const details = getMessage(
        'findingFilterBlendManipulationDetails',
        [
            module.describeElement(element),
            sourceLabel,
            module.describeElement(filterBlendMatch.source),
            filterBlendMatch.effectSource,
            filterBlendMatch.value,
            filterBlendMatch.reason,
            contextLabel,
            benignContext,
            escalation
        ],
        detailsFallback
    );

    return createFinding({
        type: 'filter-blend-manipulation',
        summary: getMessage('findingFilterBlendManipulationSummary', [], 'Potential visibility manipulation through CSS filter or blend mode'),
        details,
        severity,
        detector: 'styleObfuscationDetector',
        dedupeKey: `filter-blend-manipulation|${module.getElementPath(element)}|${module.getElementPath(filterBlendMatch.source)}|${filterBlendMatch.effectSource}|${filterBlendMatch.reason}|${contextLabel}`
    });
}

function resolveFilterBlendMatch(element, style, module) {
    let current = element;
    let currentStyle = style;
    let depth = 0;

    while (current instanceof Element && depth <= 3) {
        const filterValue = (currentStyle.filter || 'none').trim().toLowerCase();
        const backdropFilterValue = (
            currentStyle.backdropFilter
            || currentStyle.webkitBackdropFilter
            || 'none'
        ).trim().toLowerCase();
        const mixBlendMode = (currentStyle.mixBlendMode || 'normal').trim().toLowerCase();
        const backgroundBlendMode = (currentStyle.backgroundBlendMode || 'normal').trim().toLowerCase();

        const filterReason = resolveFilterReason(filterValue);
        if (filterReason) {
            return {
                source: current,
                effectSource: 'filter',
                value: filterValue,
                reason: filterReason
            };
        }

        const backdropReason = resolveFilterReason(backdropFilterValue);
        if (backdropReason) {
            return {
                source: current,
                effectSource: 'backdrop-filter',
                value: backdropFilterValue,
                reason: backdropReason
            };
        }

        if (mixBlendMode !== 'normal') {
            return {
                source: current,
                effectSource: 'mix-blend-mode',
                value: mixBlendMode,
                reason: 'blend-mode'
            };
        }

        if (backgroundBlendMode !== 'normal') {
            return {
                source: current,
                effectSource: 'background-blend-mode',
                value: backgroundBlendMode,
                reason: 'blend-mode'
            };
        }

        current = current.parentElement;
        currentStyle = current ? module.getComputedStyle(current) : null;
        depth += 1;
    }

    return null;
}

function resolveFilterReason(value) {
    if (!value || value === 'none') {
        return '';
    }

    const blurMatch = value.match(/blur\(\s*(-?\d*\.?\d+)(px|rem|em)?\s*\)/);
    if (blurMatch) {
        const blurValue = Math.abs(Number.parseFloat(blurMatch[1]));
        if (Number.isFinite(blurValue) && blurValue >= 1) {
            return blurValue >= 4 ? 'strong-blur' : 'blur';
        }
    }

    const brightness = resolveFilterNumericValue(value, 'brightness');
    if (brightness !== null && brightness <= 0.15) {
        return 'low-brightness';
    }

    const contrast = resolveFilterNumericValue(value, 'contrast');
    if (contrast !== null && contrast <= 0.15) {
        return 'low-contrast';
    }

    const opacity = resolveFilterNumericValue(value, 'opacity');
    if (opacity !== null && opacity <= 0.15) {
        return 'filter-opacity';
    }

    if (/\bgrayscale\(\s*(?:1|100%)\s*\)/.test(value) || /\binvert\(\s*(?:1|100%)\s*\)/.test(value)) {
        return 'color-shift';
    }

    return '';
}

function resolveFilterNumericValue(value, functionName) {
    const match = value.match(new RegExp(`${functionName}\\(\\s*(-?\\d*\\.?\\d+)(%)?\\s*\\)`));
    if (!match) {
        return null;
    }

    const numericValue = Number.parseFloat(match[1]);
    if (!Number.isFinite(numericValue)) {
        return null;
    }

    return match[2] === '%' ? numericValue / 100 : numericValue;
}

function isOverlayStyleContext(style, element) {
    const zIndex = Number.parseInt(style.zIndex || '', 10);
    return ['fixed', 'absolute', 'sticky'].includes(style.position)
        && style.pointerEvents !== 'none'
        && (Number.isFinite(zIndex) && zIndex >= 20 || element.hasAttribute('aria-modal'));
}

function resolveFilterBlendBenignContext(element, context, filterBlendMatch) {
    const marker = getElementMarker(element);
    const signals = [];

    if (context.types.includes('decorative')) signals.push('decorative-effect');
    if (marker.includes('hero') || marker.includes('media') || marker.includes('background') || marker.includes('image') || marker.includes('photo')) {
        signals.push('media-effect');
    }
    if (marker.includes('icon') || marker.includes('svg') || marker.includes('logo') || marker.includes('brand')) {
        signals.push('decorative-ui');
    }
    if (filterBlendMatch.effectSource === 'backdrop-filter' && (marker.includes('modal') || marker.includes('dialog') || marker.includes('backdrop'))) {
        signals.push('modal-backdrop');
    }

    return [...new Set(signals)];
}

function resolveFilterBlendEscalationSignals(element, style, context, filterBlendMatch) {
    const signals = resolveClippingEscalationSignals(element, style, context);

    if (context.types.includes('text') && ['blur', 'strong-blur', 'low-brightness', 'low-contrast', 'filter-opacity', 'blend-mode'].includes(filterBlendMatch.reason)) {
        signals.push('readability-risk');
    }
    if (style.fontSize && Number.parseFloat(style.fontSize) <= 10) signals.push('small-font');
    if (style.clip !== 'auto' || style.clipPath !== 'none') signals.push('clipping-context');
    if (parseSuppressedScale((style.transform || 'none').trim().toLowerCase())) signals.push('transform-context');

    return [...new Set(signals)];
}

function scanTransformSuppression({ element, style, module, getClippingContext }) {
    if (!(element instanceof Element) || !element.isConnected) {
        return null;
    }

    if (isPasswordInput(element)) {
        return null;
    }

    const transformMatch = resolveTransformSuppressionMatch(element, style, module);
    if (!transformMatch) {
        return null;
    }

    const context = getClippingContext();
    if (!context.hasRelevantContent) {
        return null;
    }

    const benignContextSignals = resolveTransformBenignContext(element, context, transformMatch, module);
    const escalationSignals = resolveClippingEscalationSignals(element, module.getComputedStyle(transformMatch.source), context);
    const hasRiskContext = context.types.some((type) => ['text', 'input', 'editable', 'clickable'].includes(type));

    let severity = hasRiskContext ? 'medium' : 'low';
    const strongEscalation = escalationSignals.some((signal) => ['hidden-input', 'consent-or-upload', 'overlay-context'].includes(signal));
    if (benignContextSignals.length > 0 && !strongEscalation) {
        severity = 'low';
    }
    if (strongEscalation && hasRiskContext) {
        severity = 'high';
    }

    const sourceLabel = transformMatch.source === element ? 'self' : 'ancestor';
    const contextLabel = context.types.join(', ');
    const benignContext = benignContextSignals.length > 0 ? benignContextSignals.join(', ') : 'none';
    const escalation = escalationSignals.length > 0 ? escalationSignals.join(', ') : 'none';
    const detailsFallback = `${module.describeElement(element)} [source=${sourceLabel}; sourceElement=${module.describeElement(transformMatch.source)}; transformSource=${transformMatch.transformSource}; value=${transformMatch.value}; reason=${transformMatch.reason}; scale=${transformMatch.scaleLabel}; context=${contextLabel}; benign=${benignContext}; escalation=${escalation}]`;
    const details = getMessage(
        'findingTransformSuppressionDetails',
        [
            module.describeElement(element),
            sourceLabel,
            module.describeElement(transformMatch.source),
            transformMatch.transformSource,
            transformMatch.value,
            transformMatch.reason,
            transformMatch.scaleLabel,
            contextLabel,
            benignContext,
            escalation
        ],
        detailsFallback
    );

    return createFinding({
        type: 'transform-suppression',
        summary: getMessage('findingTransformSuppressionSummary', [], 'Potential content hiding through transform scale suppression'),
        details,
        severity,
        detector: 'styleObfuscationDetector',
        dedupeKey: `transform-suppression|${module.getElementPath(element)}|${module.getElementPath(transformMatch.source)}|${transformMatch.transformSource}|${transformMatch.reason}|${contextLabel}`
    });
}

function resolveTransformSuppressionMatch(element, style, module) {
    let current = element;
    let currentStyle = style;
    let depth = 0;

    while (current instanceof Element && depth <= 3) {
        const computedTransform = (currentStyle.transform || 'none').trim().toLowerCase();
        const inlineTransform = (current.style?.transform || '').trim().toLowerCase();
        const transformValues = [...new Set([inlineTransform, computedTransform].filter((value) => value && value !== 'none'))];

        for (const transformValue of transformValues) {
            const scaleMatch = parseSuppressedScale(transformValue);
            if (scaleMatch) {
                const rect = module.getRect(current);
                const collapsedGeometry = Math.max(0, rect.width || 0) <= 2 || Math.max(0, rect.height || 0) <= 2;
                const hasStableSuppression = scaleMatch.minimumScale <= 0.02 || collapsedGeometry;
                if (hasStableSuppression) {
                    return {
                        source: current,
                        transformSource: scaleMatch.transformSource,
                        value: transformValue,
                        reason: scaleMatch.minimumScale === 0 ? 'zero-scale' : (collapsedGeometry ? 'collapsed-transform' : 'near-zero-scale'),
                        scaleLabel: scaleMatch.scaleLabel
                    };
                }
            }
        }

        current = current.parentElement;
        currentStyle = current ? module.getComputedStyle(current) : null;
        depth += 1;
    }

    return null;
}


function resolveTransformBenignContext(element, context, transformMatch, module) {
    const marker = getElementMarker(element);
    const signals = [];
    const style = module.getComputedStyle(transformMatch.source);
    const hasTransitionOrAnimation = (style.transitionDuration && style.transitionDuration !== '0s')
        || (style.animationName && style.animationName !== 'none');

    if (hasTransitionOrAnimation) signals.push('animated-state');
    if (marker.includes('menu') || marker.includes('dropdown') || marker.includes('accordion') || marker.includes('drawer') || marker.includes('collapsed')) {
        signals.push('collapsed-ui');
    }
    if (context.types.includes('decorative') || marker.includes('icon') || marker.includes('svg')) {
        signals.push('decorative-transform');
    }

    return [...new Set(signals)];
}

function scanClippingHiding({ element, style, module, getClippingContext }) {
    if (!(element instanceof Element) || !element.isConnected) {
        return null;
    }

    if (isPasswordInput(element)) {
        return null;
    }

    const clippingMatch = resolveClippingMatch(element, style, module);
    if (!clippingMatch) {
        return null;
    }

    const context = getClippingContext();
    if (!context.hasRelevantContent) {
        return null;
    }

    const benignContextSignals = resolveClippingBenignContext(element, context, clippingMatch);
    const escalationSignals = resolveClippingEscalationSignals(element, module.getComputedStyle(clippingMatch.source), context);
    const hasRiskContext = context.types.some((type) => ['text', 'input', 'editable', 'clickable'].includes(type));

    let severity = hasRiskContext ? 'medium' : 'low';
    if (benignContextSignals.length > 0 && escalationSignals.length === 0) {
        severity = 'low';
    }
    if (
        escalationSignals.some((signal) => ['hidden-input', 'consent-or-upload', 'overlay-context', 'deceptive-capture-context'].includes(signal))
        && hasRiskContext
    ) {
        severity = 'high';
    }

    const sourceLabel = clippingMatch.source === element ? 'self' : 'ancestor';
    const contextLabel = context.types.join(', ');
    const benignContext = benignContextSignals.length > 0 ? benignContextSignals.join(', ') : 'none';
    const escalation = escalationSignals.length > 0 ? escalationSignals.join(', ') : 'none';
    const detailsFallback = `${module.describeElement(element)} [source=${sourceLabel}; sourceElement=${module.describeElement(clippingMatch.source)}; clipSource=${clippingMatch.clipSource}; value=${clippingMatch.value}; reason=${clippingMatch.reason}; context=${contextLabel}; benign=${benignContext}; escalation=${escalation}]`;
    const details = getMessage(
        'findingClippingHidingDetails',
        [
            module.describeElement(element),
            sourceLabel,
            module.describeElement(clippingMatch.source),
            clippingMatch.clipSource,
            clippingMatch.value,
            clippingMatch.reason,
            contextLabel,
            benignContext,
            escalation
        ],
        detailsFallback
    );

    return createFinding({
        type: 'clipping-hiding',
        summary: getMessage('findingClippingHidingSummary', [], 'Potential content hiding through CSS clipping'),
        details,
        severity,
        detector: 'styleObfuscationDetector',
        dedupeKey: `clipping-hiding|${module.getElementPath(element)}|${module.getElementPath(clippingMatch.source)}|${clippingMatch.clipSource}|${clippingMatch.reason}|${contextLabel}`
    });
}

function resolveClippingMatch(element, style, module) {
    let current = element;
    let currentStyle = style;
    let depth = 0;

    while (current instanceof Element && depth <= 3) {
        const clipValue = (currentStyle.clip || 'auto').trim().toLowerCase();
        const clipPathValue = (currentStyle.clipPath || 'none').trim().toLowerCase();
        const rect = module.getRect(current);
        const width = Math.max(0, rect.width || 0);
        const height = Math.max(0, rect.height || 0);
        const overflowClipped = ['hidden', 'clip'].includes(currentStyle.overflow)
            || ['hidden', 'clip'].includes(currentStyle.overflowX)
            || ['hidden', 'clip'].includes(currentStyle.overflowY);

        if (clipValue !== 'auto' && (isZeroAreaLegacyClip(clipValue) || width <= 2 || height <= 2)) {
            return {
                source: current,
                clipSource: 'clip',
                value: clipValue,
                reason: isZeroAreaLegacyClip(clipValue) ? 'zero-area' : 'near-zero-area'
            };
        }

        if (clipPathValue !== 'none') {
            const clipPathReason = resolveClipPathReason(clipPathValue);
            if (clipPathReason) {
                return {
                    source: current,
                    clipSource: 'clip-path',
                    value: clipPathValue,
                    reason: clipPathReason
                };
            }
        }

        if (overflowClipped && (width <= 2 || height <= 2)) {
            return {
                source: current,
                clipSource: 'overflow+size',
                value: `${currentStyle.overflow}/${width.toFixed(1)}x${height.toFixed(1)}`,
                reason: width === 0 || height === 0 ? 'zero-area' : 'overflow-clipped'
            };
        }

        current = current.parentElement;
        currentStyle = current ? module.getComputedStyle(current) : null;
        depth += 1;
    }

    return null;
}

function isZeroAreaLegacyClip(value) {
    if (!value.startsWith('rect(')) {
        return false;
    }

    const values = value.match(/-?\d*\.?\d+/g) || [];
    return values.length >= 4 && values.every((entry) => Math.abs(Number.parseFloat(entry)) <= 0.5);
}

function resolveClipPathReason(value) {
    if (/^inset\(\s*(50|100)%/.test(value)) {
        return 'zero-area';
    }
    if (/^(circle|ellipse)\(\s*0(?:px|%|em|rem)?/.test(value)) {
        return 'zero-area';
    }
    if (value.startsWith('polygon(')) {
        const points = value.match(/-?\d*\.?\d+%?/g) || [];
        const uniquePoints = new Set(points.map((point) => point.replace(/\.0+(?=%|$)/, '')));
        if (points.length >= 4 && uniquePoints.size <= 2) {
            return 'near-zero-area';
        }
    }

    return null;
}

function resolveClippingContext(element, module) {
    const tagName = element.tagName?.toLowerCase() || '';
    const types = [];
    const inputSelector = 'input:not([type="password"]), textarea, select';
    const hasInput = ['input', 'textarea', 'select'].includes(tagName)
        || Boolean(element.querySelector(inputSelector));
    const hasEditable = element.isContentEditable || Boolean(element.querySelector('[contenteditable]:not([contenteditable="false"])'));
    const clickableSelector = 'a[href], button, label, iframe, [role="button"], [role="link"], [tabindex]';
    const hasClickable = element.matches?.(clickableSelector) || Boolean(element.querySelector(clickableSelector));

    // `normalized.length > 1` and `module.hasCandidateText(element)` were the same test plus a tag
    // filter, so the OR always collapsed to the first operand; the cheap probe is exactly that
    // predicate and no longer reads the subtree text (TASKS 8.1).
    if (hasNonWhitespaceText(element, 2)) types.push('text');
    if (hasInput) types.push('input');
    if (hasEditable) types.push('editable');
    if (hasClickable) types.push('clickable');
    if (types.length === 0 && ['img', 'svg', 'canvas', 'picture'].includes(tagName)) types.push('decorative');

    return {
        types,
        hasRelevantContent: types.length > 0
    };
}

function resolveClippingBenignContext(element, context, clippingMatch) {
    const marker = getElementMarker(element);
    const signals = [];

    if (marker.includes('sr-only') || marker.includes('visually-hidden') || marker.includes('screen-reader') || marker.includes('a11y')) {
        signals.push('accessibility-helper');
    }
    if (context.types.includes('decorative')) {
        signals.push('decorative-mask');
    }
    if (marker.includes('avatar') || marker.includes('badge') || marker.includes('icon') || marker.includes('thumbnail')) {
        signals.push('decorative-ui');
    }
    if (
        clippingMatch.clipSource === 'overflow+size'
        && clippingMatch.reason === 'overflow-clipped'
        && context.types.length === 1
        && context.types.includes('text')
    ) {
        signals.push('possible-text-truncation');
    }

    return [...new Set(signals)];
}

function resolveClippingEscalationSignals(element, style, context) {
    // Same marker as elsewhere plus the name attribute, which matters for form controls here.
    const marker = `${getElementMarker(element)} ${element.getAttribute('name') || ''}`.toLowerCase();
    const signals = [];
    const zIndex = Number.parseInt(style.zIndex || '', 10);
    const input = element.matches?.('input:not([type="password"]), textarea, select')
        ? element
        : element.querySelector('input:not([type="password"]), textarea, select');

    if (input) signals.push('hidden-input');
    if (marker.includes('consent') || marker.includes('upload') || marker.includes('file')) signals.push('consent-or-upload');
    if (marker.includes('prompt') || marker.includes('instruction') || marker.includes('submit') || marker.includes('action')) signals.push('prompt-or-action');
    if (['fixed', 'absolute', 'sticky'].includes(style.position) && Number.isFinite(zIndex) && zIndex >= 20) signals.push('overlay-context');
    if (style.pointerEvents !== 'none' && context.types.includes('clickable')) signals.push('deceptive-capture-context');
    if (Number.parseFloat(style.opacity) < 1) signals.push('opacity-context');

    return [...new Set(signals)];
}

function hasUnexplainedClippingOnly(style, element, module) {
    const hasClipping = style.clip !== 'auto' || style.clipPath !== 'none';
    if (!hasClipping) {
        return false;
    }

    // `transform` is deliberately absent here. The string test that used to stand in this spot was
    // dead - computed transforms serialise as matrix(...) - and reviving it through
    // parseSuppressedScale would not be a fix but a behaviour change in the wrong direction: it
    // would let the generic fallback report elements that scanTransformSuppression had already
    // declined, which is exactly the "fallback ignores refusals" defect from TASKS 7.2 (8.9).
    const hasOtherSignal = style.mixBlendMode !== 'normal'
        || (style.filter && style.filter !== 'none')
        || (element.hasAttribute('aria-hidden') && module.hasCandidateText(element));
    return !hasOtherSignal;
}

function hasUnexplainedTransformSuppressionOnly(style, element, module) {
    const transformValue = (style.transform || 'none').trim().toLowerCase();
    if (!parseSuppressedScale(transformValue)) {
        return false;
    }

    const hasOtherSignal = style.mixBlendMode !== 'normal'
        || (style.filter && style.filter !== 'none')
        || style.clip !== 'auto'
        || style.clipPath !== 'none'
        || (element.hasAttribute('aria-hidden') && module.hasCandidateText(element));
    return !hasOtherSignal;
}

function hasUnexplainedFilterBlendOnly(style, element, module) {
    const hasFilterBlend = (style.filter && style.filter !== 'none')
        || (style.backdropFilter && style.backdropFilter !== 'none')
        || (style.webkitBackdropFilter && style.webkitBackdropFilter !== 'none')
        || (style.mixBlendMode && style.mixBlendMode !== 'normal')
        || (style.backgroundBlendMode && style.backgroundBlendMode !== 'normal');
    if (!hasFilterBlend) {
        return false;
    }

    const hasOtherSignal = style.clip !== 'auto'
        || style.clipPath !== 'none'
        || Boolean(parseSuppressedScale((style.transform || 'none').trim().toLowerCase()))
        || (element.hasAttribute('aria-hidden') && module.hasCandidateText(element));
    return !hasOtherSignal;
}

// Same shape as its three neighbours: the gate silences the generic fallback only when the
// semantic signal is the ONLY thing wrong with the element (TASKS 8.8). It used to answer true on
// any semantic signal, so an element carrying real suppression as well - clip-path plus filter,
// say - fell out of the specialised branch and was then silenced here too, and no finding was
// emitted at all.
// The ancestor bound comes from resolveSemanticMismatchMatch itself rather than an unbounded
// closest(): a gate that sees further than the detector can silence what the detector never had a
// chance to claim.
function hasUnexplainedSemanticMismatchOnly(style, element) {
    if (!resolveSemanticMismatchMatch(element)) {
        return false;
    }

    const hasOtherSignal = style.mixBlendMode !== 'normal'
        || (style.filter && style.filter !== 'none')
        || style.clip !== 'auto'
        || style.clipPath !== 'none'
        || Boolean(parseSuppressedScale((style.transform || 'none').trim().toLowerCase()));
    return !hasOtherSignal;
}

function scanCssTextPresentation(context) {
    if (!(context.element instanceof Element) || !context.element.isConnected || isPasswordInput(context.element)) {
        return [];
    }

    const presentationContext = resolveTextPresentationContext(context);
    if (!presentationContext.isCandidate) {
        return [];
    }

    return [
        scanCssBidiPresentation(context, presentationContext),
        scanPseudoContentSubstitution(context, presentationContext),
        scanCssTextMasking(context, presentationContext)
    ].filter(Boolean);
}

function resolveTextPresentationContext({ element, findings, getText }) {
    const tagName = element.tagName?.toLowerCase() || '';
    const role = (element.getAttribute('role') || '').toLowerCase();
    const tabindex = Number.parseInt(element.getAttribute('tabindex') || '', 10);
    const text = getText();
    const isLinkLike = tagName === 'a' || role === 'link';
    const isButtonLike = tagName === 'button' || role === 'button';
    const isClickable = isLinkLike
        || isButtonLike
        || tagName === 'label'
        || (Number.isFinite(tabindex) && tabindex >= 0)
        || element.hasAttribute('onclick');
    const isFocusable = !element.hasAttribute('disabled')
        && element.getAttribute('aria-disabled') !== 'true'
        && (isClickable || ['input', 'select', 'textarea'].includes(tagName) || element.isContentEditable);
    const findingTypes = new Set(findings.map((finding) => finding?.type).filter(Boolean));
    const suppressionSignals = [
        ['hidden-text', 'hidden-dom-text'],
        ['clipping-hiding', 'clipping'],
        ['transform-suppression', 'transform'],
        ['filter-blend-manipulation', 'readability']
    ].filter(([type]) => findingTypes.has(type)).map(([, signal]) => signal);
    const overlaySignals = [
        'full-screen-overlay',
        'click-capture-layer',
        'deceptive-capture-surface',
        'suspicious-stacking-pattern',
        'overlay'
    ].filter((type) => findingTypes.has(type));
    const semanticSignals = findingTypes.has('semantic-visibility-mismatch') ? ['semantic-mismatch'] : [];
    const hasUrlLikePunctuation = /[./@:]/.test(text);
    const nonInteractiveSensitiveText = text.length > 0
        && text.length <= 160
        && hasUrlLikePunctuation
        && (suppressionSignals.length > 0 || overlaySignals.length > 0 || semanticSignals.length > 0);

    return {
        text,
        isClickable,
        isFocusable,
        isLinkLike,
        isButtonLike,
        suppressionSignals,
        overlaySignals,
        semanticSignals,
        hasUrlLikePunctuation,
        isCandidate: isClickable || isFocusable || text.length > 0,
        isBidiCandidate: isClickable || isFocusable || nonInteractiveSensitiveText,
        isPseudoCandidate: isClickable || isFocusable || suppressionSignals.length > 0,
        contextLabel: [
            isLinkLike ? 'link-like' : '',
            isButtonLike ? 'button-like' : '',
            isClickable ? 'clickable' : '',
            isFocusable ? 'focusable' : '',
            !isClickable && !isFocusable && text.length > 0 ? 'text-only' : ''
        ].filter(Boolean).join(', ') || 'text-only'
    };
}

function scanCssBidiPresentation({ element, style, module }, presentationContext) {
    if (!presentationContext.isBidiCandidate) {
        return null;
    }

    const unicodeBidi = (style.unicodeBidi || 'normal').trim().toLowerCase();
    if (!['bidi-override', 'isolate-override'].includes(unicodeBidi)) {
        return null;
    }

    const direction = (style.direction || 'ltr').trim().toLowerCase();
    const signals = [
        presentationContext.isClickable ? 'interactive' : '',
        presentationContext.hasUrlLikePunctuation ? 'url-like-punctuation' : '',
        ...presentationContext.suppressionSignals,
        ...presentationContext.overlaySignals,
        ...presentationContext.semanticSignals
    ].filter(Boolean);
    const independentSignals = new Set(signals.filter((signal) => !['interactive', 'url-like-punctuation'].includes(signal))).size;
    const severity = presentationContext.isClickable
        ? (presentationContext.overlaySignals.length > 0 || independentSignals >= 2 ? 'high' : 'medium')
        : 'low';
    const detailsFallback = `${module.describeElement(element)} [direction=${direction}; unicode-bidi=${unicodeBidi}; reason=${unicodeBidi}; context=${presentationContext.contextLabel}; supporting=${signals.join(', ') || 'none'}]`;

    return createFinding({
        type: 'css-bidi-presentation',
        summary: getMessage('findingCssBidiPresentationSummary', [], 'CSS bidi override can change the perceived order of text'),
        details: getMessage(
            'findingCssBidiPresentationDetails',
            [module.describeElement(element), direction, unicodeBidi, presentationContext.contextLabel, signals.join(', ') || 'none'],
            detailsFallback
        ),
        severity,
        detector: 'styleObfuscationDetector',
        dedupeKey: `css-bidi-presentation|${module.getElementPath(element)}|${unicodeBidi}`
    });
}

function scanPseudoContentSubstitution({ element, module, getPseudoStyle }, presentationContext) {
    if (!presentationContext.isPseudoCandidate || typeof getPseudoStyle !== 'function') {
        return null;
    }

    const pseudoContent = ['::before', '::after']
        .map((pseudoElement) => ({ pseudoElement, content: getPseudoStyle(pseudoElement)?.content || 'none' }))
        .map(({ pseudoElement, content }) => ({ pseudoElement, generatedText: extractGeneratedTextContent(content) }))
        .filter(({ generatedText }) => generatedText);
    if (pseudoContent.length === 0) {
        return null;
    }

    const hasSuppressedDomText = presentationContext.suppressionSignals.length > 0;
    const hasEmptyDomLabel = presentationContext.text.length === 0;
    if (!presentationContext.isClickable && !presentationContext.isFocusable) {
        return null;
    }
    if (!hasSuppressedDomText && !hasEmptyDomLabel) {
        return null;
    }

    const pseudoSources = pseudoContent.map(({ pseudoElement }) => pseudoElement).join('+');
    const supportingSignals = [
        hasSuppressedDomText ? 'suppressed-dom-text' : 'generated-label',
        ...presentationContext.suppressionSignals,
        ...presentationContext.overlaySignals,
        ...presentationContext.semanticSignals
    ];
    const severity = hasSuppressedDomText
        ? (presentationContext.overlaySignals.length > 0 || presentationContext.suppressionSignals.length >= 2 ? 'high' : 'medium')
        : 'low';
    const detailsFallback = `${module.describeElement(element)} [source=${pseudoSources}; reason=${hasSuppressedDomText ? 'suppressed-dom-text' : 'generated-label'}; context=${presentationContext.contextLabel}; supporting=${supportingSignals.join(', ')}]`;

    return createFinding({
        type: 'pseudo-content-substitution',
        summary: getMessage('findingPseudoContentSubstitutionSummary', [], 'Generated CSS content may replace the visible label'),
        details: getMessage(
            'findingPseudoContentSubstitutionDetails',
            [
                module.describeElement(element),
                pseudoSources,
                hasSuppressedDomText ? 'suppressed-dom-text' : 'generated-label',
                presentationContext.contextLabel,
                supportingSignals.join(', ')
            ],
            detailsFallback
        ),
        severity,
        detector: 'styleObfuscationDetector',
        dedupeKey: `pseudo-content-substitution|${module.getElementPath(element)}|${pseudoSources}|${hasSuppressedDomText ? 'suppressed' : 'empty'}`
    });
}

function extractGeneratedTextContent(content) {
    const value = (content || '').trim();
    if (!value || ['none', 'normal', '""', "''"].includes(value.toLowerCase())) {
        return '';
    }
    if (/\b(?:attr|counter|counters|url)\s*\(/i.test(value) || /\b(?:open-quote|close-quote|no-open-quote|no-close-quote)\b/i.test(value)) {
        return '';
    }

    const text = value
        .replace(/^['"]|['"]$/g, '')
        .replace(/\\([0-9a-f]{1,6})\s?/gi, '')
        .trim();
    const meaningfulCharacters = text.match(/[\p{L}\p{N}]/gu) || [];
    return meaningfulCharacters.length >= 2 ? text : '';
}

function scanCssTextMasking({ element, style, module }, presentationContext) {
    if (!presentationContext.isClickable && !presentationContext.isFocusable && presentationContext.text.length === 0) {
        return null;
    }

    const textSecurity = (style.webkitTextSecurity || style.getPropertyValue?.('-webkit-text-security') || 'none').trim().toLowerCase();
    if (!textSecurity || textSecurity === 'none') {
        return null;
    }

    const supportingSignals = [
        presentationContext.isClickable ? 'interactive' : '',
        ...presentationContext.suppressionSignals,
        ...presentationContext.overlaySignals,
        ...presentationContext.semanticSignals
    ].filter(Boolean);
    const severity = presentationContext.isClickable || presentationContext.isFocusable
        ? (presentationContext.overlaySignals.length > 0 || presentationContext.suppressionSignals.length > 0 ? 'high' : 'medium')
        : 'low';
    const detailsFallback = `${module.describeElement(element)} [text-security=${textSecurity}; reason=masked-text; context=${presentationContext.contextLabel}; supporting=${supportingSignals.join(', ') || 'none'}]`;

    return createFinding({
        type: 'css-text-masking',
        summary: getMessage('findingCssTextMaskingSummary', [], 'CSS text masking hides the displayed text'),
        details: getMessage(
            'findingCssTextMaskingDetails',
            [module.describeElement(element), textSecurity, presentationContext.contextLabel, supportingSignals.join(', ') || 'none'],
            detailsFallback
        ),
        severity,
        detector: 'styleObfuscationDetector',
        dedupeKey: `css-text-masking|${module.getElementPath(element)}|${textSecurity}`
    });
}

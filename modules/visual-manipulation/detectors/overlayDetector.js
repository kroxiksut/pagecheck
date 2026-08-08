import { createFinding, getMessage } from '../utils/findingFactory.js';
import { getElementMarker, getNormalizedText, isPasswordInput, resolveZIndex } from '../utils/domUtils.js';

export function scanOverlays({ element, style, module }) {
    const findings = [];
    let deceptiveCaptureFinding = null;
    const overlaysEnabled = module.config.detectOverlays !== false;
    const deceptiveCaptureEnabled = module.config.detectDeceptiveCapture !== false;

    if (deceptiveCaptureEnabled) {
        deceptiveCaptureFinding = scanDeceptiveCaptureSurface({ element, style, module });
        if (deceptiveCaptureFinding) {
            findings.push(deceptiveCaptureFinding);
        }
    }

    const fullScreenOverlayFinding = overlaysEnabled
        ? scanFullScreenOverlay({ element, style, module })
        : null;
    if (fullScreenOverlayFinding) {
        findings.push(fullScreenOverlayFinding);
    }

    const clickCaptureFinding = overlaysEnabled && !deceptiveCaptureFinding && !fullScreenOverlayFinding
        ? scanClickCaptureLayer({ element, style, module })
        : null;
    if (clickCaptureFinding) {
        findings.push(clickCaptureFinding);
    }

    if (overlaysEnabled && !fullScreenOverlayFinding && !clickCaptureFinding && module.isLikelyOverlay(style, element)) {
        findings.push(
            createFinding({
                type: 'overlay',
                summary: getMessage('findingOverlaySummary', undefined, 'Potential deceptive overlay or click-capture layer'),
                details: module.describeElement(element),
                severity: 'medium',
                detector: 'overlayDetector',
                dedupeKey: `overlay|${module.getElementPath(element)}`
            })
        );
    }

    const stackingFinding = overlaysEnabled
        ? scanSuspiciousStackingPattern({ element, style, module, relatedFindings: findings })
        : null;
    if (stackingFinding) {
        findings.push(stackingFinding);
    }

    return findings;
}

function scanSuspiciousStackingPattern({ element, style, module, relatedFindings }) {
    if (!(element instanceof Element) || !element.isConnected) {
        return null;
    }

    const geometry = module.resolveViewportGeometry(element);
    if (!geometry || geometry.visibleWidth < 32 || geometry.visibleHeight < 24) {
        return null;
    }

    const currentStackingSignals = resolveStackingContextSignals(style);
    const markerSignals = resolveOverlayMarkers(element);
    const relatedTypes = relatedFindings
        .map((finding) => finding?.type)
        .filter(Boolean);
    const hasRelatedOverlayFinding = relatedTypes.some((type) => [
        'deceptive-capture-surface',
        'full-screen-overlay',
        'click-capture-layer',
        'overlay'
    ].includes(type));

    if (!hasRelatedOverlayFinding && currentStackingSignals.length < 2 && markerSignals.length === 0) {
        return null;
    }

    const stackEvidence = resolveStackingEvidence(element, geometry, module);
    if (!stackEvidence) {
        return null;
    }

    const hiddenOrDeceptiveSignals = resolveHiddenOverlaySignals(element, style);
    const benignContextSignals = resolveBenignOverlayContext(element, markerSignals);
    const topLayerTransparent = isTopLayerTransparent(style);
    const pointerCapture = style.pointerEvents !== 'none';
    const highZIndexChain = stackEvidence.layers.filter((layer) => layer.zIndex >= 20).length >= 2;
    const multiLayer = stackEvidence.layers.length >= 2;
    const hasCriticalTarget = Boolean(stackEvidence.targetContext?.isCritical);
    const hasSuppressionOrCapture = hiddenOrDeceptiveSignals.length > 0
        || topLayerTransparent
        || pointerCapture
        || relatedTypes.includes('deceptive-capture-surface')
        || relatedTypes.includes('click-capture-layer');

    if (!multiLayer || (!hasSuppressionOrCapture && !highZIndexChain && !hasCriticalTarget)) {
        return null;
    }

    const reasons = [];
    reasons.push('multi-layer');
    if (highZIndexChain) reasons.push('high-z-index-chain');
    if (topLayerTransparent) reasons.push('transparent-top-layer');
    if (pointerCapture) reasons.push('pointer-capture');
    if (hiddenOrDeceptiveSignals.length > 0) reasons.push('suppression-context');
    if (hasCriticalTarget) reasons.push(`${stackEvidence.targetContext.type}-target`);
    if (currentStackingSignals.length > 0) reasons.push(...currentStackingSignals);

    let severity = 'medium';
    if (benignContextSignals.length > 0 && hiddenOrDeceptiveSignals.length === 0 && !hasCriticalTarget) {
        severity = 'low';
    }
    if (hasCriticalTarget && (hiddenOrDeceptiveSignals.length > 0 || topLayerTransparent || highZIndexChain || relatedTypes.includes('deceptive-capture-surface'))) {
        severity = 'high';
    }

    const benignContext = benignContextSignals.length > 0 ? benignContextSignals.join(', ') : 'none';
    const relatedFindingLabel = relatedTypes.length > 0 ? relatedTypes.join(', ') : 'none';
    const layerSummary = stackEvidence.layers.map((layer) => `${layer.description}@z${layer.zIndexLabel}`).join(' > ');
    const pointLabel = `${stackEvidence.point.x},${stackEvidence.point.y}`;
    const reasonLabel = [...new Set(reasons)].join(', ');
    const detailsFallback = `${module.describeElement(element)} [layers=${stackEvidence.layers.length}; point=${pointLabel}; reasons=${reasonLabel}; related=${relatedFindingLabel}; layerStack=${layerSummary}; context=${benignContext}]`;
    const details = getMessage(
        'findingSuspiciousStackingPatternDetails',
        [
            module.describeElement(element),
            String(stackEvidence.layers.length),
            pointLabel,
            reasonLabel,
            relatedFindingLabel,
            layerSummary,
            benignContext
        ],
        detailsFallback
    );

    return createFinding({
        type: 'suspicious-stacking-pattern',
        summary: getMessage('findingSuspiciousStackingPatternSummary', [], 'Suspicious multi-layer stacking pattern around page controls'),
        details,
        severity,
        detector: 'overlayDetector',
        dedupeKey: `suspicious-stacking-pattern|${module.getElementPath(element)}|${pointLabel}|${relatedFindingLabel}`
    });
}

function scanClickCaptureLayer({ element, style, module }) {
    if (!(element instanceof Element) || !element.isConnected) {
        return null;
    }

    const position = style.position;
    if (!['fixed', 'absolute', 'sticky'].includes(position)) {
        return null;
    }

    if (style.pointerEvents === 'none') {
        return null;
    }

    const geometry = module.resolveViewportGeometry(element);
    if (!geometry || geometry.visibleWidth < 32 || geometry.visibleHeight < 24) {
        return null;
    }

    const markerSignals = resolveOverlayMarkers(element);
    const zIndex = resolveZIndex(style);
    const opacity = Number.parseFloat(style.opacity);
    const isWeakLayer = isVisualBoxWeak(style)
        || (Number.isFinite(opacity) && opacity <= 0.35)
        || style.cursor === 'pointer'
        || style.backgroundColor === 'rgba(0, 0, 0, 0)'
        || style.backgroundColor === 'transparent';
    const hasCandidateSignal = zIndex >= 1
        || markerSignals.some((signal) => ['overlay', 'backdrop', 'shield', 'blocker', 'interceptor', 'mask'].includes(signal))
        || isWeakLayer
        || position === 'fixed';

    if (!hasCandidateSignal) {
        return null;
    }

    if (looksLikePageContainer(element, geometry, markerSignals, position, style)) {
        return null;
    }

    const overlap = resolveUnderlyingTargetOverlap(element, geometry, module);
    if (!overlap) {
        return null;
    }

    const benignContextSignals = resolveBenignOverlayContext(element, markerSignals);
    const hiddenOrDeceptiveSignals = resolveHiddenOverlaySignals(element, style);
    const targetContext = overlap.targetContext;
    const targetType = targetContext.type;
    const isCriticalTarget = targetContext.isCritical;
    const isBenignBlockingPattern = benignContextSignals.length > 0 && hiddenOrDeceptiveSignals.length === 0;

    let severity = 'medium';
    if (isBenignBlockingPattern) {
        severity = 'low';
    }
    if (isCriticalTarget && (hiddenOrDeceptiveSignals.length > 0 || zIndex >= 20 || isWeakLayer)) {
        severity = 'high';
    }

    const zIndexLabel = Number.isFinite(zIndex) ? String(zIndex) : 'auto';
    const opacityLabel = Number.isFinite(opacity) ? String(opacity) : '1';
    const benignContext = benignContextSignals.length > 0 ? benignContextSignals.join(', ') : 'none';
    const markerLabel = markerSignals.length > 0 ? markerSignals.join(', ') : 'none';
    const signals = [
        'pointer-events',
        zIndex >= 20 ? 'high-z-index' : '',
        isWeakLayer ? 'weak-visual-layer' : '',
        ...hiddenOrDeceptiveSignals
    ].filter(Boolean).join(', ');
    const pointLabel = `${overlap.point.x},${overlap.point.y}`;

    const detailsFallback = `${module.describeElement(element)} [target=${targetType}; targetElement=${overlap.targetDescription}; point=${pointLabel}; position=${position}; z-index=${zIndexLabel}; pointer-events=${style.pointerEvents}; opacity=${opacityLabel}; markers=${markerLabel}; context=${benignContext}; signals=${signals || 'overlap'}]`;
    const details = getMessage(
        'findingClickCaptureLayerDetails',
        [
            module.describeElement(element),
            targetType,
            overlap.targetDescription,
            pointLabel,
            position,
            zIndexLabel,
            style.pointerEvents,
            opacityLabel,
            markerLabel,
            benignContext,
            signals || 'overlap'
        ],
        detailsFallback
    );

    return createFinding({
        type: 'click-capture-layer',
        summary: getMessage('findingClickCaptureLayerSummary', [], 'Potential click-capture layer over an interactive target'),
        details,
        severity,
        detector: 'overlayDetector',
        dedupeKey: `click-capture-layer|${module.getElementPath(element)}|${targetType}|${pointLabel}`
    });
}

function scanFullScreenOverlay({ element, style, module }) {
    if (!(element instanceof Element) || !element.isConnected) {
        return null;
    }

    const position = style.position;
    if (!['fixed', 'absolute', 'sticky'].includes(position)) {
        return null;
    }

    const geometry = module.resolveViewportGeometry(element);
    if (!geometry || geometry.visibleWidth <= 1 || geometry.visibleHeight <= 1) {
        return null;
    }

    const markerSignals = resolveOverlayMarkers(element);
    const zIndex = resolveZIndex(style);
    const pointerEventsActive = style.pointerEvents !== 'none';
    const hasHighZIndex = zIndex >= 100;
    const hasStackingSignal = hasHighZIndex || zIndex >= 10 || markerSignals.length > 0;
    const hasOverlayVisualContext = hasOverlayVisualSignals(style);
    const hasNearFullscreenGeometry = geometry.coverageRatio >= 0.65
        || (geometry.widthRatio >= 0.9 && geometry.heightRatio >= 0.65);
    const hasLargeOverlayGeometry = geometry.coverageRatio >= 0.45
        || (geometry.widthRatio >= 0.75 && geometry.heightRatio >= 0.75);
    const hasCriticalPartialGeometry = geometry.coverageRatio >= 0.25
        && geometry.visibleTop <= geometry.viewportHeight * 0.2
        && geometry.visibleHeight >= Math.min(240, geometry.viewportHeight * 0.45);

    if (!hasNearFullscreenGeometry && !hasLargeOverlayGeometry && !hasCriticalPartialGeometry) {
        return null;
    }

    if (position === 'sticky' && markerSignals.length === 0 && !hasHighZIndex && !hasOverlayVisualContext) {
        return null;
    }

    if (!hasStackingSignal && !pointerEventsActive && !hasOverlayVisualContext) {
        return null;
    }

    if (looksLikePageContainer(element, geometry, markerSignals, position, style)) {
        return null;
    }

    const benignContextSignals = resolveBenignOverlayContext(element, markerSignals);
    const hiddenOrDeceptiveSignals = resolveHiddenOverlaySignals(element, style);
    const interactionSignals = [];
    if (pointerEventsActive) interactionSignals.push('pointer-events');
    if (hasHighZIndex) interactionSignals.push('high-z-index');
    if (hasOverlayVisualContext) interactionSignals.push('overlay-visual-context');
    if (hasNearFullscreenGeometry) interactionSignals.push('near-fullscreen');
    if (hasCriticalPartialGeometry && !hasNearFullscreenGeometry) interactionSignals.push('critical-partial-viewport');

    let severity = pointerEventsActive ? 'medium' : 'low';
    if (benignContextSignals.length > 0 && hiddenOrDeceptiveSignals.length === 0) {
        severity = 'low';
    }
    if (
        hasNearFullscreenGeometry
        && hasHighZIndex
        && pointerEventsActive
        && hiddenOrDeceptiveSignals.length > 0
    ) {
        severity = 'high';
    }

    const coveragePercent = `${Math.round(geometry.coverageRatio * 100)}%`;
    const markers = markerSignals.length > 0 ? markerSignals.join(', ') : 'none';
    const benignContext = benignContextSignals.length > 0 ? benignContextSignals.join(', ') : 'none';
    const signals = [...interactionSignals, ...hiddenOrDeceptiveSignals].join(', ') || 'geometry';
    const zIndexLabel = Number.isFinite(zIndex) ? String(zIndex) : 'auto';

    const detailsFallback = `${module.describeElement(element)} [coverage=${coveragePercent}; position=${position}; z-index=${zIndexLabel}; pointer-events=${style.pointerEvents}; markers=${markers}; context=${benignContext}; signals=${signals}]`;
    const details = getMessage(
        'findingFullScreenOverlayDetails',
        [module.describeElement(element), coveragePercent, position, zIndexLabel, style.pointerEvents, markers, benignContext, signals],
        detailsFallback
    );

    return createFinding({
        type: 'full-screen-overlay',
        summary: getMessage('findingFullScreenOverlaySummary', [], 'Potential full-screen overlay over page content'),
        details,
        severity,
        detector: 'overlayDetector',
        dedupeKey: `full-screen-overlay|${module.getElementPath(element)}|${position}|${coveragePercent}`
    });
}

function scanDeceptiveCaptureSurface({ element, style, module }) {
    if (!(element instanceof Element) || !element.isConnected) {
        return null;
    }

    const tagName = element.tagName?.toLowerCase() || '';
    const role = (element.getAttribute('role') || '').toLowerCase();
    const hasTabindex = element.hasAttribute('tabindex');
    const tabindexValue = hasTabindex ? Number.parseInt(element.getAttribute('tabindex') || '', 10) : Number.NaN;
    const hasOnclick = element.hasAttribute('onclick');
    const isInteractiveInput = tagName === 'input' && !['hidden', 'password', 'submit', 'reset', 'button', 'image'].includes((element.type || '').toLowerCase());
    const isTagInteractive = ['a', 'button', 'label', 'iframe'].includes(tagName) || isInteractiveInput;
    const hasInteractiveRole = role === 'button' || role === 'link';
    const pointerEventsActive = style.pointerEvents !== 'none';
    const cursorPointer = style.cursor === 'pointer';
    const isGenericClickable = pointerEventsActive && (cursorPointer || hasOnclick || (Number.isFinite(tabindexValue) && tabindexValue >= 0));
    const isFocusable = typeof element.focus === 'function'
        && !element.hasAttribute('disabled')
        && (!Number.isFinite(tabindexValue) || tabindexValue >= 0 || isTagInteractive || hasInteractiveRole);

    const interactiveCandidate = isTagInteractive || hasInteractiveRole || hasOnclick || hasTabindex || isGenericClickable;
    if (!interactiveCandidate) {
        return null;
    }

    const rect = module.getRect(element);
    const width = Math.max(0, rect.width || 0);
    const height = Math.max(0, rect.height || 0);
    if (width <= 1 || height <= 1) {
        return null;
    }

    const { width: viewportWidth, height: viewportHeight } = module.getViewportSize();
    const viewportArea = Math.max(1, viewportWidth * viewportHeight);
    const area = width * height;
    const areaRatio = area / viewportArea;

    const opacity = Number.parseFloat(style.opacity);
    const isOpacityZero = Number.isFinite(opacity) && opacity === 0;
    const isNearTransparent = Number.isFinite(opacity) && opacity > 0 && opacity <= 0.12;
    const hasNoVisibleText = getNormalizedText(element).length === 0;
    const hasNoVisualBox = isVisualBoxWeak(style);
    const hasSuppressionSignals = style.clip !== 'auto' || style.clipPath !== 'none' || style.filter === 'opacity(0)';

    const zIndexRaw = Number.parseInt(style.zIndex || '0', 10);
    const zIndex = Number.isFinite(zIndexRaw) ? zIndexRaw : 0;
    const isHighZIndex = zIndex >= 20;
    const isLargeArea = areaRatio >= 0.12 || (width >= 280 && height >= 120);
    const isOverlayLike = areaRatio >= 0.35 || (width >= viewportWidth * 0.8 && height >= viewportHeight * 0.5);
    const overlayingUi = isLikelyOverlayingVisibleUi(element, module);

    const labelCaptureContext = resolveLabelCaptureContext(element, module);
    const hasLabelHiddenControlLink = Boolean(labelCaptureContext);
    const isIframeSurface = tagName === 'iframe';

    const visibilitySignals = [];
    if (isOpacityZero) visibilitySignals.push('opacity');
    if (isNearTransparent) visibilitySignals.push('near-transparent');
    if (hasNoVisibleText && hasNoVisualBox) visibilitySignals.push('no-visual-marker');
    if (hasSuppressionSignals) visibilitySignals.push('suppression-support');

    const interactionSignals = [];
    if (pointerEventsActive) interactionSignals.push('pointer-events');
    if (cursorPointer) interactionSignals.push('cursor-pointer');
    if (isFocusable) interactionSignals.push('focusable');
    if (isHighZIndex) interactionSignals.push('high-z-index');
    if (isLargeArea) interactionSignals.push('large-area');
    if (overlayingUi) interactionSignals.push('overlaying-ui');
    if (hasLabelHiddenControlLink) interactionSignals.push('label-hidden-control');

    const suspiciousVisibility = isOpacityZero || isNearTransparent || (hasNoVisibleText && hasNoVisualBox);
    const enoughInteractionRisk = pointerEventsActive && (isFocusable || hasOnclick || hasInteractiveRole || isTagInteractive);
    if (!suspiciousVisibility || !enoughInteractionRisk) {
        return null;
    }

    if (tagName === 'label' && !hasLabelHiddenControlLink) {
        return null;
    }

    let severity = 'medium';
    if (isIframeSurface && (isOpacityZero || isNearTransparent || isLargeArea || isHighZIndex)) {
        severity = 'high';
    } else if ((isOpacityZero || isNearTransparent) && (isLargeArea || isHighZIndex || overlayingUi || hasLabelHiddenControlLink)) {
        severity = 'high';
    } else if (!isLargeArea && !overlayingUi && !hasLabelHiddenControlLink && !isIframeSurface) {
        severity = 'low';
    }

    const elementType = resolveCaptureElementType(tagName, isGenericClickable);
    const scopeLabelKey = isOverlayLike
        ? 'findingDeceptiveCaptureScopeOverlayLike'
        : 'findingDeceptiveCaptureScopeLocal';
    const scopeLabel = getMessage(scopeLabelKey, undefined, (isOverlayLike ? 'overlay-like' : 'local'));
    const linkContext = labelCaptureContext || 'none';

    const signalMessageKeys = {
        opacity: 'findingDeceptiveCaptureSignalOpacity',
        'near-transparent': 'findingDeceptiveCaptureSignalNearTransparent',
        'no-visual-marker': 'findingDeceptiveCaptureSignalNoVisualMarker',
        'suppression-support': 'findingDeceptiveCaptureSignalSuppressionSupport',
        'pointer-events': 'findingDeceptiveCaptureSignalPointerEvents',
        'cursor-pointer': 'findingDeceptiveCaptureSignalCursorPointer',
        focusable: 'findingDeceptiveCaptureSignalFocusable',
        'high-z-index': 'findingDeceptiveCaptureSignalHighZIndex',
        'large-area': 'findingDeceptiveCaptureSignalLargeArea',
        'overlaying-ui': 'findingDeceptiveCaptureSignalOverlayingUi',
        'label-hidden-control': 'findingDeceptiveCaptureSignalLabelHiddenControl'
    };

    const mappedSignals = [...visibilitySignals, ...interactionSignals].map((signal) => {
        const signalKey = signalMessageKeys[signal] || signalMessageKeys['label-hidden-control'];
        return getMessage(signalKey, undefined, signal);
    });

    const detailsFallback = `${module.describeElement(element)} [type=${elementType}; scope=${scopeLabel}; signals=${mappedSignals.join(', ')}; linkedContext=${linkContext}]`;
    const details = getMessage('findingDeceptiveCaptureDetails', [module.describeElement(element), elementType, scopeLabel, mappedSignals.join(', '), linkContext], detailsFallback);

    const summaryKey = isIframeSurface
        ? 'findingDeceptiveCaptureIframeSummary'
        : 'findingDeceptiveCaptureSummary';
    const summaryFallback = isIframeSurface
        ? 'Potential deceptive iframe capture surface'
        : 'Potential deceptive capture surface';

    return createFinding({
        type: 'deceptive-capture-surface',
        summary: getMessage(summaryKey, undefined, summaryFallback),
        details,
        severity,
        detector: 'overlayDetector',
        dedupeKey: `deceptive-capture|${elementType}|${module.getElementPath(element)}|${scopeLabel}`
    });
}

function resolveOverlayMarkers(element) {
    const marker = getElementMarker(element);
    const role = (element.getAttribute('role') || '').toLowerCase();
    const markers = [];

    ['overlay', 'modal', 'backdrop', 'dialog', 'popup', 'lightbox', 'interstitial', 'consent', 'cookie', 'shield', 'blocker', 'interceptor', 'mask', 'loading'].forEach((token) => {
        if (marker.includes(token)) {
            markers.push(token);
        }
    });

    if (role === 'dialog' || role === 'alertdialog') {
        markers.push(`role:${role}`);
    }
    if (element.getAttribute('aria-modal') === 'true') {
        markers.push('aria-modal');
    }
    if (element.hasAttribute('popover')) {
        markers.push('popover');
    }

    return [...new Set(markers)];
}

function hasOverlayVisualSignals(style) {
    const opacity = Number.parseFloat(style.opacity);
    const hasOpacityContext = Number.isFinite(opacity) && opacity < 1;
    const hasBackground = Boolean(style.backgroundImage && style.backgroundImage !== 'none')
        || Boolean(style.backgroundColor && style.backgroundColor !== 'transparent' && style.backgroundColor !== 'rgba(0, 0, 0, 0)');
    const hasBackdrop = Boolean(style.backdropFilter && style.backdropFilter !== 'none')
        || Boolean(style.webkitBackdropFilter && style.webkitBackdropFilter !== 'none');
    return hasOpacityContext || hasBackground || hasBackdrop;
}

function resolveHiddenOverlaySignals(element, style) {
    const opacity = Number.parseFloat(style.opacity);
    const hasOpacityZero = Number.isFinite(opacity) && opacity === 0;
    const hasNearTransparent = Number.isFinite(opacity) && opacity > 0 && opacity <= 0.12;
    const hasNoVisibleText = getNormalizedText(element).length === 0;
    const hasNoVisualBox = isVisualBoxWeak(style);
    const signals = [];

    if (hasOpacityZero) signals.push('opacity-zero');
    if (hasNearTransparent) signals.push('near-transparent');
    if (hasNoVisibleText && hasNoVisualBox) signals.push('no-visible-marker');
    if (style.clip !== 'auto' || style.clipPath !== 'none') signals.push('clipping');
    if (style.filter && style.filter !== 'none') signals.push('filter');

    return signals;
}

function resolveStackingEvidence(element, geometry, module) {
    const points = resolveSamplePoints(geometry).slice(0, 5);

    for (const point of points) {
        const stack = module.elementsFromPoint(point.x, point.y);
        if (!Array.isArray(stack) || stack.length < 2) {
            continue;
        }

        const top = stack[0];
        if (top !== element && !element.contains(top)) {
            continue;
        }

        const layers = [];
        for (const node of stack.slice(0, 8)) {
            if (!(node instanceof Element)) {
                continue;
            }

            const tagName = node.tagName?.toLowerCase() || '';
            if (['html', 'body'].includes(tagName)) {
                continue;
            }

            const layerStyle = module.getComputedStyle(node);
            const stackingSignals = resolveStackingContextSignals(layerStyle);
            const zIndex = resolveZIndex(layerStyle);
            const markerSignals = resolveOverlayMarkers(node);
            const target = resolveInteractiveTarget(node);
            const isCurrentLayer = node === element || element.contains(node);
            const isLayerCandidate = isCurrentLayer
                || stackingSignals.length > 0
                || markerSignals.length > 0
                || zIndex >= 10
                || layerStyle.pointerEvents !== 'none'
                || Boolean(target);

            if (!isLayerCandidate) {
                continue;
            }

            layers.push({
                element: node,
                description: module.describeElement(node),
                zIndex,
                zIndexLabel: Number.isFinite(zIndex) ? String(zIndex) : 'auto',
                stackingSignals,
                markerSignals,
                pointerEvents: layerStyle.pointerEvents
            });

            if (layers.length >= 4) {
                break;
            }
        }

        if (layers.length < 2) {
            continue;
        }

        const targetLayer = stack
            .map((node) => (node instanceof Element ? resolveInteractiveTarget(node) : null))
            .find((target) => target && target !== element && !element.contains(target));

        return {
            point,
            layers,
            target: targetLayer || null,
            targetContext: targetLayer ? resolveTargetContext(targetLayer) : null
        };
    }

    return null;
}

function resolveStackingContextSignals(style) {
    const signals = [];
    const zIndex = resolveZIndex(style);
    const opacity = Number.parseFloat(style.opacity);

    if (['fixed', 'absolute', 'sticky', 'relative'].includes(style.position) && zIndex !== 0) {
        signals.push('position-z-index');
    }
    if (style.transform && style.transform !== 'none') {
        signals.push('transform');
    }
    if (style.filter && style.filter !== 'none') {
        signals.push('filter');
    }
    if (Number.isFinite(opacity) && opacity < 1) {
        signals.push('opacity');
    }
    if (style.isolation === 'isolate') {
        signals.push('isolation');
    }
    if (style.contain && style.contain !== 'none') {
        signals.push('contain');
    }
    if (style.willChange && style.willChange !== 'auto') {
        signals.push('will-change');
    }
    if (style.mixBlendMode && style.mixBlendMode !== 'normal') {
        signals.push('mix-blend-mode');
    }
    if ((style.backdropFilter && style.backdropFilter !== 'none') || (style.webkitBackdropFilter && style.webkitBackdropFilter !== 'none')) {
        signals.push('backdrop-filter');
    }

    return signals;
}

function isTopLayerTransparent(style) {
    const opacity = Number.parseFloat(style.opacity);
    return (Number.isFinite(opacity) && opacity <= 0.35)
        || style.backgroundColor === 'transparent'
        || style.backgroundColor === 'rgba(0, 0, 0, 0)';
}

function resolveUnderlyingTargetOverlap(element, geometry, module) {
    const points = resolveSamplePoints(geometry);

    for (const point of points) {
        const stack = module.elementsFromPoint(point.x, point.y);
        if (!Array.isArray(stack) || stack.length < 2) {
            continue;
        }

        const top = stack[0];
        if (top !== element && !element.contains(top)) {
            continue;
        }

        for (const node of stack.slice(1)) {
            if (!(node instanceof Element) || node === element || element.contains(node)) {
                continue;
            }

            const target = resolveInteractiveTarget(node);
            if (!target || element.contains(target)) {
                continue;
            }

            return {
                point,
                target,
                targetDescription: module.describeElement(target),
                targetContext: resolveTargetContext(target)
            };
        }
    }

    return null;
}

function resolveSamplePoints(geometry) {
    const left = geometry.visibleLeft;
    const top = geometry.visibleTop;
    const right = geometry.visibleRight;
    const bottom = geometry.visibleBottom;
    const centerX = Math.round(left + geometry.visibleWidth / 2);
    const centerY = Math.round(top + geometry.visibleHeight / 2);
    const insetX = Math.max(4, Math.round(geometry.visibleWidth * 0.25));
    const insetY = Math.max(4, Math.round(geometry.visibleHeight * 0.25));
    const rawPoints = [
        { x: centerX, y: centerY },
        { x: Math.round(left + insetX), y: Math.round(top + insetY) },
        { x: Math.round(right - insetX), y: Math.round(top + insetY) },
        { x: Math.round(left + insetX), y: Math.round(bottom - insetY) },
        { x: Math.round(right - insetX), y: Math.round(bottom - insetY) }
    ];
    const seen = new Set();

    return rawPoints
        .map((point) => ({
            x: Math.min(Math.max(0, point.x), Math.max(0, geometry.viewportWidth - 1)),
            y: Math.min(Math.max(0, point.y), Math.max(0, geometry.viewportHeight - 1))
        }))
        .filter((point) => {
            const key = `${point.x}:${point.y}`;
            if (seen.has(key)) {
                return false;
            }
            seen.add(key);
            return true;
        });
}

function resolveInteractiveTarget(node) {
    const selector = 'a[href], button, input, select, textarea, label, iframe, [role="button"], [role="link"], [tabindex]';
    const target = node.matches?.(selector) ? node : node.closest?.(selector);
    if (!(target instanceof Element)) {
        return null;
    }

    const tagName = target.tagName?.toLowerCase() || '';
    if (isPasswordInput(target)) {
        return null;
    }

    if (target.hasAttribute('disabled') || target.getAttribute('aria-disabled') === 'true') {
        return null;
    }

    if (target.hasAttribute('tabindex')) {
        const tabindex = Number.parseInt(target.getAttribute('tabindex') || '', 10);
        if (Number.isFinite(tabindex) && tabindex < 0 && !['a', 'button', 'input', 'select', 'textarea', 'label', 'iframe'].includes(tagName)) {
            return null;
        }
    }

    return target;
}

function resolveTargetContext(target) {
    const tagName = target.tagName?.toLowerCase() || '';
    const role = (target.getAttribute('role') || '').toLowerCase();
    const inputType = tagName === 'input'
        ? ((target.getAttribute('type') || target.type || 'text').toLowerCase())
        : '';
    const baseType = inputType || role || tagName || 'interactive';
    const marker = `${target.id || ''} ${typeof target.className === 'string' ? target.className : ''} ${(target.textContent || '').slice(0, 80)}`.toLowerCase();
    const isSubmitLike = inputType === 'submit'
        || inputType === 'button'
        || tagName === 'button'
        || marker.includes('submit')
        || marker.includes('send')
        || marker.includes('pay')
        || marker.includes('buy')
        || marker.includes('checkout')
        || marker.includes('confirm')
        || marker.includes('continue')
        || marker.includes('login')
        || marker.includes('sign in');
    const isConsentLike = marker.includes('consent')
        || marker.includes('agree')
        || marker.includes('accept')
        || marker.includes('cookie')
        || marker.includes('privacy');
    const isUploadLike = inputType === 'file'
        || marker.includes('upload')
        || marker.includes('file');
    const isSensitiveInput = ['email', 'tel', 'search', 'url', 'text'].includes(baseType)
        || tagName === 'textarea'
        || tagName === 'select';
    const isCritical = isSubmitLike || isConsentLike || isUploadLike || isSensitiveInput || tagName === 'iframe';

    return {
        type: isUploadLike ? 'upload'
            : (isConsentLike ? 'consent'
                : (isSubmitLike ? 'submit'
                    : (tagName === 'a' ? 'link' : baseType))),
        isCritical
    };
}

function resolveBenignOverlayContext(element, markerSignals) {
    const role = (element.getAttribute('role') || '').toLowerCase();
    const text = getNormalizedText(element);
    const signals = [];
    const markerText = markerSignals.join(' ');

    if (role === 'dialog' || role === 'alertdialog' || element.getAttribute('aria-modal') === 'true') {
        signals.push('dialog-semantics');
    }
    if (markerText.includes('cookie') || markerText.includes('consent')) {
        signals.push('cookie-or-consent');
    }
    if (markerText.includes('modal') || markerText.includes('lightbox')) {
        signals.push('modal-or-lightbox');
    }
    if (markerText.includes('loading') || markerText.includes('mask')) {
        signals.push('loading-or-mask');
    }
    if (markerText.includes('blocker')) {
        signals.push('intentional-blocker');
    }
    if (element.querySelector('button, [role="button"], [aria-label*="close" i], [class*="close" i], [id*="close" i]')) {
        signals.push('visible-dismiss-control');
    }
    if (text.length >= 12 && text.length <= 800) {
        signals.push('visible-explanatory-text');
    }

    return [...new Set(signals)];
}

function looksLikePageContainer(element, geometry, markerSignals, position, style) {
    const tagName = element.tagName?.toLowerCase() || '';
    if (['html', 'body', 'main'].includes(tagName)) {
        return true;
    }

    const zIndex = resolveZIndex(style);
    const marker = getElementMarker(element);
    const hasContainerMarker = marker.includes('container')
        || marker.includes('wrapper')
        || marker.includes('layout')
        || marker.includes('page')
        || marker.includes('root')
        || marker.includes('app');
    const hasOverlayMarker = markerSignals.length > 0;

    return position !== 'fixed'
        && hasContainerMarker
        && !hasOverlayMarker
        && zIndex < 10
        && geometry.coverageRatio < 0.85;
}

function resolveCaptureElementType(tagName, isGenericClickable) {
    if (tagName === 'a') return 'a';
    if (tagName === 'button') return 'button';
    if (tagName === 'label') return 'label';
    if (tagName === 'iframe') return 'iframe';
    if (tagName === 'input') return 'input';
    return isGenericClickable ? 'generic-clickable' : tagName || 'generic-clickable';
}

function isVisualBoxWeak(style) {
    const backgroundImageNone = !style.backgroundImage || style.backgroundImage === 'none';
    const transparentBackground = !style.backgroundColor
        || style.backgroundColor === 'transparent'
        || style.backgroundColor === 'rgba(0, 0, 0, 0)';
    const borderWidth = Number.parseFloat(style.borderTopWidth || '0')
        + Number.parseFloat(style.borderRightWidth || '0')
        + Number.parseFloat(style.borderBottomWidth || '0')
        + Number.parseFloat(style.borderLeftWidth || '0');
    const hasBoxShadow = style.boxShadow && style.boxShadow !== 'none';
    const hasOutline = style.outlineStyle && style.outlineStyle !== 'none';
    return backgroundImageNone && transparentBackground && (!Number.isFinite(borderWidth) || borderWidth === 0) && !hasBoxShadow && !hasOutline;
}

function isLikelyOverlayingVisibleUi(element, module) {
    const rect = module.getRect(element);
    const cx = Math.floor(rect.left + rect.width / 2);
    const cy = Math.floor(rect.top + rect.height / 2);
    const { width: vw, height: vh } = module.getViewportSize();
    if (cx < 0 || cy < 0 || cx >= vw || cy >= vh) {
        return false;
    }

    const stack = module.elementsFromPoint(cx, cy);
    if (!Array.isArray(stack) || stack.length < 2) {
        return false;
    }

    const top = stack[0];
    if (top !== element && !element.contains(top)) {
        return false;
    }

    const under = stack.find((node) => node !== element && !element.contains(node));
    if (!(under instanceof Element)) {
        return false;
    }

    const underTag = under.tagName?.toLowerCase() || '';
    const underRole = (under.getAttribute('role') || '').toLowerCase();
    const underClass = `${under.id || ''} ${typeof under.className === 'string' ? under.className : ''}`.toLowerCase();
    return ['a', 'button', 'input', 'select', 'textarea'].includes(underTag)
        || underRole === 'button'
        || underRole === 'link'
        || underClass.includes('cta')
        || underClass.includes('submit')
        || underClass.includes('consent')
        || underClass.includes('upload');
}

function resolveLabelCaptureContext(element, module) {
    if (element.tagName?.toLowerCase() !== 'label') {
        return '';
    }

    let target = null;
    const forId = element.getAttribute('for');
    if (forId) {
        target = document.getElementById(forId);
    }
    if (!target) {
        target = element.querySelector('input, textarea, select');
    }
    if (!(target instanceof HTMLInputElement)) {
        return '';
    }

    const targetType = (target.getAttribute('type') || target.type || '').toLowerCase();
    if (!['checkbox', 'radio', 'file'].includes(targetType)) {
        return '';
    }

    // Here the question is whether the real control is unreachable for the user, which includes the
    // non-interactive case. Since 7.2 removed `pointer-events: none` from isInputHidden (a visible
    // but inert control is not "hidden"), that part of the intent is spelled out here instead.
    const targetStyle = module.getComputedStyle(target);
    const isTargetUnreachable = module.isInputHidden(targetStyle, target)
        || targetStyle.pointerEvents === 'none';
    if (!isTargetUnreachable) {
        return '';
    }

    if (targetType === 'file') return 'upload';
    return 'consent';
}

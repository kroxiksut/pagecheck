import { createFinding, getMessage } from '../utils/findingFactory.js';
import { findHidingSource, getElementMarker, getNormalizedText, isPasswordInput } from '../utils/domUtils.js';

export function scanHiddenInputs({ element, style, module }) {
    if (!(element instanceof Element) || !element.isConnected) {
        return [];
    }

    if (isPasswordInput(element)) {
        return [];
    }

    const tagName = element.tagName?.toLowerCase();
    const roleAttr = (element.getAttribute('role') || '').toLowerCase();
    const isRoleTextbox = roleAttr === 'textbox';
    const contentEditableAttrRaw = element.getAttribute('contenteditable');
    const contentEditableAttr = (contentEditableAttrRaw || '').toLowerCase();
    const hasEditableAttr = contentEditableAttrRaw != null;
    const isExplicitEditableAttr = hasEditableAttr
        && (contentEditableAttr === '' || contentEditableAttr === 'true' || contentEditableAttr === 'plaintext-only');
    const isEditableSurfaceCandidate = element.isContentEditable
        || isExplicitEditableAttr
        || isRoleTextbox
        || (element.getAttribute('aria-multiline') === 'true' && hasEditableAttr);

    if (!module.isInputSurface(element) && !isEditableSurfaceCandidate) {
        return [];
    }
    const inputSubtype = tagName === 'input'
        ? ((element.getAttribute('type') || element.type || 'text').toLowerCase() || 'text')
        : '';

    if (tagName === 'input') {
        const normalizedType = inputSubtype;

        const mvpSupportedInputTypes = new Set([
            // text-like
            'text', 'search', 'email', 'url', 'tel', 'number',
            // picker-like
            'date', 'time', 'datetime-local', 'month', 'week', 'color', 'range',
            // consent-like
            'checkbox', 'radio',
            // upload-like
            'file'
        ]);

        // Keep hidden-input MVP focused on input types from block 8.1.
        // Explicitly skip out-of-scope types for now: password (already excluded upstream),
        // image, reset, submit, button, hidden and any vendor/custom non-standard types.
        if (!mvpSupportedInputTypes.has(normalizedType)) {
            return [];
        }
    }

    let hiddenReason = '';
    let hiddenSource = '';
    let hiddenMatchType = '';

    // Hiding attribution walks (self first, then ancestors up to the root). Each predicate keeps the
    // exact lookups of the loop it replaced: the attribute and geometry walks never touch computed
    // style, and the visibility walk reports `computed` for ancestors even when the ancestor set it
    // inline (an inline visibility:hidden is already visible in the computed value).
    const applyHidingSource = (reason, predicate, matchType) => {
        if (hiddenReason) {
            return;
        }

        const hidingSource = findHidingSource(element, predicate, { includeSelf: true });
        if (hidingSource.matched) {
            hiddenReason = reason;
            hiddenSource = hidingSource.source;
            hiddenMatchType = matchType || hidingSource.matchType;
        }
    };

    applyHidingSource(
        'hidden-attribute',
        (node) => (node.hasAttribute('hidden') ? { matched: true } : null),
        'attribute'
    );

    applyHidingSource('display-none', (node, isSelf) => {
        const displayNoneInline = node.style?.display === 'none';
        const displayNoneComputed = (isSelf ? style : module.getComputedStyle(node)).display === 'none';
        if (!displayNoneInline && !displayNoneComputed) {
            return null;
        }

        return { matched: true, matchType: displayNoneInline ? 'inline' : 'computed' };
    });

    applyHidingSource('visibility-hidden', (node, isSelf) => {
        if (isSelf) {
            const visibilityHiddenInline = node.style?.visibility === 'hidden';
            if (visibilityHiddenInline) {
                return { matched: true, matchType: 'inline' };
            }
            return style.visibility === 'hidden' ? { matched: true, matchType: 'computed' } : null;
        }

        return module.getComputedStyle(node).visibility === 'hidden'
            ? { matched: true, matchType: 'computed' }
            : null;
    });

    applyHidingSource('opacity-zero', (node, isSelf) => {
        const opacityInlineRaw = node.style?.opacity;
        const opacityInline = opacityInlineRaw !== '' && opacityInlineRaw != null
            && Number.parseFloat(opacityInlineRaw) === 0;
        const opacityComputed = Number.parseFloat((isSelf ? style : module.getComputedStyle(node)).opacity) === 0;
        if (!opacityInline && !opacityComputed) {
            return null;
        }

        return { matched: true, matchType: opacityInline ? 'inline' : 'computed' };
    });

    if (!hiddenReason) {
        const { width: viewportWidth, height: viewportHeight } = module.getViewportSize();
        const offscreenThresholdPx = 24;

        applyHidingSource(
            'off-screen',
            (node) => {
                const rect = module.getRect(node);
                const offscreen = rect.right <= -offscreenThresholdPx
                    || rect.left >= viewportWidth + offscreenThresholdPx
                    || rect.bottom <= -offscreenThresholdPx
                    || rect.top >= viewportHeight + offscreenThresholdPx;
                return offscreen ? { matched: true } : null;
            },
            'geometry'
        );
    }

    applyHidingSource(
        'zero-size',
        (node) => {
            const rect = module.getRect(node);
            return (rect.width <= 1 || rect.height <= 1) ? { matched: true } : null;
        },
        'geometry'
    );

    if (!hiddenReason && !module.isInputHidden(style, element)) {
        return [];
    }

    if (!hiddenReason) {
        hiddenReason = 'visual-hidden';
        hiddenSource = 'self';
        hiddenMatchType = 'computed';
    }

    const reasonMessageKey = hiddenReason === 'hidden-attribute'
        ? 'findingHiddenInputReasonHidden'
        : (hiddenReason === 'display-none'
            ? 'findingHiddenInputReasonDisplayNone'
            : (hiddenReason === 'visibility-hidden'
                ? 'findingHiddenInputReasonVisibilityHidden'
                : (hiddenReason === 'opacity-zero'
                    ? 'findingHiddenInputReasonOpacityZero'
                    : (hiddenReason === 'off-screen'
                        ? 'findingHiddenInputReasonOffscreen'
                        : (hiddenReason === 'zero-size'
                            ? 'findingHiddenInputReasonZeroSize'
                            : 'findingHiddenInputReasonVisualHidden')))));
    const reasonLabel = getMessage(reasonMessageKey, undefined, hiddenReason);

    const sourceMessageKey = hiddenSource === 'ancestor'
        ? 'findingDisplayNoneSourceAncestor'
        : 'findingDisplayNoneSourceSelf';
    const sourceLabel = getMessage(sourceMessageKey, undefined, hiddenSource);

    const matchTypeMessageKey = hiddenMatchType === 'inline'
        ? 'findingDisplayNoneMatchTypeInline'
        : (hiddenMatchType === 'attribute'
            ? 'findingHiddenInputMatchTypeAttribute'
            : (hiddenMatchType === 'geometry'
                ? 'findingHiddenInputMatchTypeGeometry'
                : 'findingDisplayNoneMatchTypeComputed'));
    const matchTypeLabel = getMessage(matchTypeMessageKey, undefined, hiddenMatchType);

    const controlTypeLabel = tagName === 'input'
        ? 'input'
        : (tagName === 'textarea'
            ? 'textarea'
            : (tagName === 'select' ? 'select' : 'editable-surface'));
    const subtypeLabel = tagName === 'input' ? inputSubtype : 'n/a';

    const isConsentControl = tagName === 'input' && (inputSubtype === 'checkbox' || inputSubtype === 'radio');
    const isUploadControl = tagName === 'input' && inputSubtype === 'file';
    const isEditableSurface = controlTypeLabel === 'editable-surface' || isEditableSurfaceCandidate;
    const hasAriaMultiline = element.getAttribute('aria-multiline') === 'true';
    const hasPlaintextOnly = contentEditableAttr === 'plaintext-only';
    const hasInputMode = Boolean(element.getAttribute('inputmode'));
    const hasSpellcheck = element.hasAttribute('spellcheck');
    const hasMeaningfulEditableText = getNormalizedText(element).length > 2;
    const placeholderRaw = [
        element.getAttribute('placeholder') || '',
        element.getAttribute('aria-placeholder') || '',
        element.getAttribute('data-placeholder') || '',
        element.getAttribute('aria-label') || '',
        element.getAttribute('title') || ''
    ].join(' ').toLowerCase();
    const placeholderLikeKeywords = [
        'type', 'message', 'prompt', 'input', 'comment', 'search', 'enter',
        'введите', 'сообщение', 'поиск', 'комментар', 'промпт', 'текст'
    ];
    const hasPromptLikePlaceholder = placeholderLikeKeywords.some((keyword) => placeholderRaw.includes(keyword));
    const contextCategory = isConsentControl
        ? 'consent'
        : (isUploadControl
            ? 'upload'
            : (isEditableSurface
                ? (hasPlaintextOnly
                    ? 'plain-text-editor'
                    : (isRoleTextbox
                        ? 'textbox-role'
                        : ((element.isContentEditable || isExplicitEditableAttr)
                            ? 'rich-text-editor'
                            : 'focusable-editable')))
                : 'text-input'));

    const isChecked = isConsentControl && (element.checked || element.hasAttribute('checked'));
    const isRequired = element.hasAttribute('required') || element.getAttribute('aria-required') === 'true';
    const labelsText = Array.from(element.labels || [])
        .map((label) => label?.textContent || '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
    const nearbyRawText = [
        element.getAttribute('aria-label') || '',
        element.getAttribute('title') || '',
        labelsText,
        element.parentElement?.textContent || '',
        element.closest('label')?.textContent || '',
        element.closest('form')?.textContent || ''
    ].join(' ').replace(/\s+/g, ' ').trim().toLowerCase();

    const consentKeywords = [
        'consent', 'agree', 'agreement', 'terms', 'policy', 'privacy', 'marketing', 'newsletter', 'subscribe', 'opt-in',
        'соглас', 'оферт', 'правил', 'политик', 'подпис', 'маркет', 'персональн', 'рассыл'
    ];
    const hasConsentNearbyText = isConsentControl && consentKeywords.some((keyword) => nearbyRawText.includes(keyword));

    const consentSignals = [];
    if (isChecked) {
        consentSignals.push('checked');
    }
    if (isRequired) {
        consentSignals.push('required');
    }
    if (hasConsentNearbyText) {
        consentSignals.push('nearby-consent-text');
    }

    const consentSignalLabels = [];
    if (consentSignals.length > 0) {
        for (const consentSignal of consentSignals) {
            const consentSignalKey = consentSignal === 'checked'
                ? 'findingHiddenInputConsentSignalChecked'
                : (consentSignal === 'required'
                    ? 'findingHiddenInputConsentSignalRequired'
                    : 'findingHiddenInputConsentSignalNearbyConsentText');
            const consentSignalLabel = getMessage(consentSignalKey, undefined, consentSignal);
            consentSignalLabels.push(consentSignalLabel);
        }
    } else {
        const noConsentSignalLabel = getMessage('findingHiddenInputConsentSignalNone', undefined, 'none');
        consentSignalLabels.push(noConsentSignalLabel);
    }

    const contextCategoryKey = contextCategory === 'consent'
        ? 'findingHiddenInputContextConsent'
        : (contextCategory === 'upload'
            ? 'findingHiddenInputContextUpload'
            : (contextCategory === 'rich-text-editor'
                ? 'findingHiddenEditableContextRichTextEditor'
                : (contextCategory === 'plain-text-editor'
                    ? 'findingHiddenEditableContextPlainTextEditor'
                    : (contextCategory === 'textbox-role'
                        ? 'findingHiddenEditableContextTextboxRole'
                        : (contextCategory === 'focusable-editable'
                            ? 'findingHiddenEditableContextFocusableEditable'
                            : (contextCategory === 'editable-surface'
                                ? 'findingHiddenInputContextEditableSurface'
                                : 'findingHiddenInputContextTextInput'))))));
    const contextCategoryLabel = getMessage(contextCategoryKey, undefined, contextCategory);

    const isVisiblyPresent = (node) => {
        if (!(node instanceof Element)) {
            return false;
        }

        const nodeStyle = module.getComputedStyle(node);
        if (nodeStyle.display === 'none' || nodeStyle.visibility === 'hidden') {
            return false;
        }
        const nodeOpacity = Number.parseFloat(nodeStyle.opacity);
        if (Number.isFinite(nodeOpacity) && nodeOpacity === 0) {
            return false;
        }
        const rect = module.getRect(node);
        return rect.width > 1 && rect.height > 1;
    };

    const uploadSignals = [];
    let hasVisibleUploadTrigger = false;
    if (isUploadControl) {
        const associatedLabels = Array.from(element.labels || []);
        const id = element.id || '';
        const explicitForLabels = id
            ? Array.from(document.querySelectorAll(`label[for="${CSS.escape(id)}"]`))
            : [];
        const uniqueLabels = Array.from(new Set([...associatedLabels, ...explicitForLabels]));
        const hasVisibleLabelTrigger = uniqueLabels.some((label) => isVisiblyPresent(label));
        if (hasVisibleLabelTrigger) {
            hasVisibleUploadTrigger = true;
            uploadSignals.push('visible-label-trigger');
        }

        const nearbyScope = element.closest('label, form, [role="group"], [class*="upload"], [class*="file"]')
            || element.parentElement
            || element;
        const nearbyButtonTrigger = nearbyScope
            ? nearbyScope.querySelector('button, [role="button"], input[type="button"], input[type="submit"], .btn, .button, [class*="upload"], [class*="file"]')
            : null;
        const hasVisibleButtonTrigger = nearbyButtonTrigger && isVisiblyPresent(nearbyButtonTrigger);
        if (hasVisibleButtonTrigger) {
            hasVisibleUploadTrigger = true;
            uploadSignals.push('visible-button-trigger');
        }

        const ariaControls = nearbyScope?.querySelector(`[aria-controls="${element.id}"]`);
        if (ariaControls && isVisiblyPresent(ariaControls)) {
            hasVisibleUploadTrigger = true;
            uploadSignals.push('aria-controls-trigger');
        }

        if (!hasVisibleUploadTrigger) {
            uploadSignals.push('missing-visible-trigger');
        }
    }

    const contextSignalLabels = [];
    const hasPointerEvents = style.pointerEvents !== 'none';
    const hasDisabledState = element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true';
    const tabindexRaw = element.getAttribute('tabindex');
    const tabindexValue = tabindexRaw == null ? Number.NaN : Number.parseInt(tabindexRaw, 10);
    const isTabbable = !hasDisabledState && (!Number.isFinite(tabindexValue) || tabindexValue >= 0);
    const isFocusable = !hasDisabledState && (typeof element.focus === 'function')
        && (isTabbable || ['input', 'textarea', 'select', 'button', 'a'].includes(tagName) || element.isContentEditable);
    const hasAriaHidden = element.getAttribute('aria-hidden') === 'true';

    if (isConsentControl) {
        contextSignalLabels.push(...consentSignalLabels);
        const replacementScope = element.closest('label, form, [role="group"], [class*="checkbox"], [class*="radio"]')
            || element.parentElement
            || element;
        const visibleReplacement = replacementScope
            ? replacementScope.querySelector('label, [role="checkbox"], [role="radio"], .checkmark, .radio-mark, .custom-control, .switch, .toggle')
            : null;
        const hasVisibleReplacement = visibleReplacement && isVisiblyPresent(visibleReplacement);
        if (hasVisibleReplacement) {
            const replacementSignalLabel = getMessage('findingHiddenInputConsentSignalVisibleReplacement', undefined, 'visible replacement');
            contextSignalLabels.push(replacementSignalLabel);
        }
    } else if (isUploadControl) {
        if (uploadSignals.length > 0) {
            for (const uploadSignal of uploadSignals) {
                const uploadSignalKey = uploadSignal === 'visible-label-trigger'
                    ? 'findingHiddenInputUploadSignalVisibleLabelTrigger'
                    : (uploadSignal === 'visible-button-trigger'
                        ? 'findingHiddenInputUploadSignalVisibleButtonTrigger'
                        : (uploadSignal === 'aria-controls-trigger'
                            ? 'findingHiddenInputUploadSignalAriaControlsTrigger'
                            : 'findingHiddenInputUploadSignalMissingVisibleTrigger'));
                const uploadSignalLabel = getMessage(uploadSignalKey, undefined, uploadSignal);
                contextSignalLabels.push(uploadSignalLabel);
            }
        } else {
            const noUploadSignalLabel = getMessage('findingHiddenInputUploadSignalNone', undefined, 'none');
            contextSignalLabels.push(noUploadSignalLabel);
        }
    } else {
        const noContextSignalLabel = getMessage('findingHiddenInputContextSignalNone', undefined, 'none');
        contextSignalLabels.push(noContextSignalLabel);
    }

    if (isFocusable) {
        const focusableSignalLabel = getMessage('findingHiddenInputInteractionFocusable', undefined, 'focusable');
        contextSignalLabels.push(focusableSignalLabel);
    }
    if (hasPointerEvents) {
        const clickableSignalLabel = getMessage('findingHiddenInputInteractionClickable', undefined, 'clickable');
        contextSignalLabels.push(clickableSignalLabel);
    }
    if (Number.isFinite(tabindexValue)) {
        const tabindexSignalLabel = getMessage('findingHiddenInputInteractionTabindex', undefined, 'tabindex');
        contextSignalLabels.push(`${tabindexSignalLabel}:${tabindexValue}`);
    }
    if (hasDisabledState) {
        const disabledSignalLabel = getMessage('findingHiddenInputInteractionDisabled', undefined, 'disabled');
        contextSignalLabels.push(disabledSignalLabel);
    }
    if (hasAriaHidden) {
        const ariaHiddenSignalLabel = getMessage('findingHiddenInputInteractionAriaHidden', undefined, 'aria-hidden');
        contextSignalLabels.push(ariaHiddenSignalLabel);
    }

    if (isEditableSurface) {
        const editableBySignals = [];
        if (element.isContentEditable) {
            editableBySignals.push('contenteditable');
        }
        if (hasPlaintextOnly) {
            editableBySignals.push('plaintext-only');
        }
        if (isRoleTextbox) {
            editableBySignals.push('role=textbox');
        }
        if (hasAriaMultiline) {
            editableBySignals.push('aria-multiline');
        }
        for (const editableSignal of editableBySignals) {
            const editableSignalKey = editableSignal === 'contenteditable'
                ? 'findingHiddenEditableSignalContentEditable'
                : (editableSignal === 'plaintext-only'
                    ? 'findingHiddenEditableSignalPlaintextOnly'
                    : (editableSignal === 'role=textbox'
                        ? 'findingHiddenEditableSignalRoleTextbox'
                        : 'findingHiddenEditableSignalAriaMultiline'));
            const editableSignalLabel = getMessage(editableSignalKey, undefined, editableSignal);
            contextSignalLabels.push(editableSignalLabel);
        }
        if (hasSpellcheck) {
            const spellcheckLabel = getMessage('findingHiddenEditableSignalSpellcheck', undefined, 'spellcheck');
            contextSignalLabels.push(spellcheckLabel);
        }
        if (hasInputMode) {
            const inputmodeLabel = getMessage('findingHiddenEditableSignalInputmode', undefined, 'inputmode');
            contextSignalLabels.push(inputmodeLabel);
        }
        if (hasPromptLikePlaceholder) {
            const promptLikeLabel = getMessage('findingHiddenEditableSignalPromptLike', undefined, 'prompt-like marker');
            contextSignalLabels.push(promptLikeLabel);
        }
        if (hasMeaningfulEditableText) {
            const meaningfulTextLabel = getMessage('findingHiddenEditableSignalMeaningfulText', undefined, 'meaningful text');
            contextSignalLabels.push(meaningfulTextLabel);
        }
    }

    // getElementMarker also covers SVG (className is an SVGAnimatedString there) - unified in 6.2-B/B2.
    const marker = getElementMarker(element);
    const isLikelyServiceNode = marker.includes('measure')
        || marker.includes('mirror')
        || marker.includes('buffer')
        || marker.includes('staging')
        || marker.includes('draft');
    const isWizardUi = marker.includes('accordion')
        || marker.includes('tab-panel')
        || marker.includes('tabpanel')
        || marker.includes('wizard')
        || marker.includes('step');

    const hiddenInputSummaryKey = isEditableSurface
        ? 'findingHiddenEditableSummary'
        : (contextCategory === 'consent'
            ? 'findingHiddenInputConsentSummary'
            : (contextCategory === 'upload'
                ? 'findingHiddenInputUploadSummary'
                : 'findingHiddenInputSummary'));
    const hiddenInputSummaryFallback = isEditableSurface
        ? 'Potential hidden editable surface'
        : (contextCategory === 'consent'
            ? 'Potential hidden consent control'
            : (contextCategory === 'upload'
                ? 'Potential hidden file-upload control'
                : 'Potential hidden input or editable surface'));
    const hiddenInputSummary = getMessage(hiddenInputSummaryKey, undefined, hiddenInputSummaryFallback);

    const hiddenInputDetailsKey = isEditableSurface
        ? 'findingHiddenEditableDetails'
        : (contextCategory === 'consent'
            ? 'findingHiddenInputConsentDetails'
            : (contextCategory === 'upload'
                ? 'findingHiddenInputUploadDetails'
                : 'findingHiddenInputDetails'));
    const hiddenInputDetailsFallback = `${module.describeElement(element)} [control=${controlTypeLabel}; subtype=${subtypeLabel}; reason=${reasonLabel}; source=${sourceLabel} (${matchTypeLabel}); context=${contextCategoryLabel}; contextSignals=${contextSignalLabels.join(', ')}]`;
    const hiddenInputDetails = getMessage(hiddenInputDetailsKey, [
                module.describeElement(element),
                controlTypeLabel,
                subtypeLabel,
                reasonLabel,
                sourceLabel,
                matchTypeLabel,
                contextCategoryLabel,
                contextSignalLabels.join(', ')
            ], hiddenInputDetailsFallback);

    let severity = 'medium';
    if (isConsentControl && (isChecked || isRequired || hasConsentNearbyText)) {
        severity = 'high';
    } else if (isUploadControl) {
        severity = hasVisibleUploadTrigger ? 'low' : 'high';
    } else if (isEditableSurface) {
        severity = (isFocusable && (hasPromptLikePlaceholder || hasInputMode || hasMeaningfulEditableText)) ? 'high' : 'medium';
    }

    if (isWizardUi && !isConsentControl && !isUploadControl) {
        severity = 'low';
    }
    if (isLikelyServiceNode && !isFocusable && !hasPointerEvents) {
        severity = 'low';
    }
    if (isEditableSurface && !isFocusable && !hasInputMode && !hasPromptLikePlaceholder && !hasMeaningfulEditableText) {
        severity = 'low';
    }
    if (isConsentControl && contextSignalLabels.some((label) => String(label).includes('replacement'))) {
        if (!isChecked && !isRequired && !hasConsentNearbyText) {
            severity = 'low';
        } else if (severity === 'high') {
            severity = 'medium';
        }
    }

    return [
        createFinding({
            type: isEditableSurface ? 'hidden-editable-surface' : 'hidden-input',
            summary: hiddenInputSummary,
            details: hiddenInputDetails,
            severity,
            detector: 'hiddenInputDetector',
            dedupeKey: `${isEditableSurface ? 'hidden-editable-surface' : 'hidden-input'}|${module.getElementPath(element)}|${hiddenReason}|${hiddenSource}`
        })
    ];
}

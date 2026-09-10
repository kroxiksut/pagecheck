import { createFinding } from '../utils/findingFactory.js';
import { findForeignBaseOrigin } from '../utils/urlUtils.js';

// Page-level rather than per-candidate: `<base href>` is one element that retargets every relative
// link on the page at once (TASKS 7.4). It lives here because this file already owns the question
// "where does navigation actually go", and a separate file for one rule would go against the
// module's own rule about not splitting down to one file per micro-heuristic.
// Gated on detectUnsafeProtocols? No - it is a navigation-target signal, but it is not a protocol
// and not a redirect parameter, so it follows the module switch only. `enabled: false` still stops
// it, because nothing in the module runs then.
export function inspectDocumentBase({ module }) {
    const foreignBase = findForeignBaseOrigin();
    if (!foreignBase) {
        return [];
    }

    return [
        createFinding({
            type: 'base-origin-mismatch',
            summary: typeof chrome !== 'undefined' && chrome?.i18n
                ? (chrome.i18n.getMessage('findingBaseOriginMismatchSummary') || 'The page redirects all its relative links to another site')
                : 'The page redirects all its relative links to another site',
            details: typeof chrome !== 'undefined' && chrome?.i18n
                ? (chrome.i18n.getMessage('findingBaseOriginMismatchDetails', [foreignBase.baseOrigin, foreignBase.pageOrigin]) || `base href resolves to ${foreignBase.baseOrigin} instead of ${foreignBase.pageOrigin}`)
                : `base href resolves to ${foreignBase.baseOrigin} instead of ${foreignBase.pageOrigin}`,
            severity: 'high',
            detector: 'navigationTargetDetector',
            dedupeKey: `base-origin-mismatch|${foreignBase.baseOrigin}|${foreignBase.pageOrigin}`
        })
    ];
}

export function inspectNavigationTarget({ element, targetUrl, module }) {
    const findings = [];

    if (module.config.detectUnsafeProtocols) {
        const unsafeProtocol = module.isUnsafeProtocol(targetUrl.protocol);
        if (unsafeProtocol) {
            findings.push(createFinding({
                type: 'unsafe-protocol',
                summary: typeof chrome !== 'undefined' && chrome?.i18n
                    ? (chrome.i18n.getMessage('findingUnsafeProtocolSummary') || 'Potentially unsafe navigation protocol')
                    : 'Potentially unsafe navigation protocol',
                details: typeof chrome !== 'undefined' && chrome?.i18n
                    ? (chrome.i18n.getMessage('findingUnsafeProtocolDetails', [unsafeProtocol.protocol, module.describeElement(element)]) || `protocol=${unsafeProtocol.protocol}; ${module.describeElement(element)}`)
                    : `protocol=${unsafeProtocol.protocol}; ${module.describeElement(element)}`,
                severity: unsafeProtocol.severity,
                detector: 'navigationTargetDetector',
                // The target itself is the identity here: two different javascript: payloads are
                // two different problems, the same one rendered twice is not.
                dedupeKey: `unsafe-protocol|${unsafeProtocol.protocol}|${targetUrl.href.slice(0, 96)}`
            }));
        }
    }

    if (module.config.detectRedirectPatterns) {
        const redirectPattern = module.hasRedirectPattern(targetUrl);
        if (redirectPattern?.hasExternalDestination) {
            const externalDestination = redirectPattern.redirectParameters
                .find((parameter) => parameter.destinationType === 'external');

            findings.push(createFinding({
                type: 'redirect-pattern',
                summary: typeof chrome !== 'undefined' && chrome?.i18n
                    ? (chrome.i18n.getMessage('findingRedirectPatternSummary') || 'Potential redirect or bounce URL pattern')
                    : 'Potential redirect or bounce URL pattern',
                details: typeof chrome !== 'undefined' && chrome?.i18n
                    ? (chrome.i18n.getMessage('findingRedirectPatternDetails', [externalDestination.key, externalDestination.destinationHostname, module.describeElement(element)]) || `redirectKey=${externalDestination.key}; redirectDestination=${externalDestination.destinationHostname}; ${module.describeElement(element)}`)
                    : `redirectKey=${externalDestination.key}; redirectDestination=${externalDestination.destinationHostname}; ${module.describeElement(element)}`,
                severity: 'medium',
                detector: 'navigationTargetDetector',
                dedupeKey: `redirect-pattern|${targetUrl.hostname}|${externalDestination.key}|${externalDestination.destinationHostname}`
            }));
        } else if (redirectPattern?.hasSuspiciousUnknownDestination) {
            // The destination could not be parsed as a URL, but it does not look like an id either:
            // a bare host, a base64 payload or a doubly encoded URL. Reported at LOW severity - the
            // shape is suspicious, the destination is not proven (TASKS 6.3).
            const opaqueDestination = redirectPattern.redirectParameters
                .find((parameter) => parameter.destinationType === 'unknown' && parameter.opaqueSignals.length > 0);
            const opaqueReason = opaqueDestination.opaqueSignals.join(', ');

            findings.push(createFinding({
                type: 'redirect-pattern',
                summary: typeof chrome !== 'undefined' && chrome?.i18n
                    ? (chrome.i18n.getMessage('findingRedirectPatternSummary') || 'Potential redirect or bounce URL pattern')
                    : 'Potential redirect or bounce URL pattern',
                details: typeof chrome !== 'undefined' && chrome?.i18n
                    ? (chrome.i18n.getMessage('findingRedirectPatternOpaqueDetails', [opaqueDestination.key, opaqueReason, module.describeElement(element)]) || `redirectKey=${opaqueDestination.key}; redirectDestination=opaque (${opaqueReason}); ${module.describeElement(element)}`)
                    : `redirectKey=${opaqueDestination.key}; redirectDestination=opaque (${opaqueReason}); ${module.describeElement(element)}`,
                severity: 'low',
                detector: 'navigationTargetDetector',
                dedupeKey: `redirect-pattern|${targetUrl.hostname}|${opaqueDestination.key}|opaque|${opaqueReason}`
            }));
        }
    }

    return findings;
}

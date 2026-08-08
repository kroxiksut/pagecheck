import { createFinding } from '../utils/findingFactory.js';

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
                detector: 'navigationTargetDetector'
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
                detector: 'navigationTargetDetector'
            }));
        }
    }

    return findings;
}

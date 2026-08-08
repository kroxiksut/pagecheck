import { createFinding } from '../utils/findingFactory.js';

export function inspectVisibleTargetMismatch({ element, targetUrl, linkText, hostnameAnalysis, module }) {
    if (!module.config.detectLinkMismatch || !targetUrl.hostname) {
        return [];
    }

    if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
        return [];
    }

    const mismatch = module.hasVisibleTargetMismatch(linkText, targetUrl.hostname, hostnameAnalysis);
    if (!mismatch.eligible || mismatch.matches) {
        return [];
    }

    return [
        createFinding({
            type: 'link-mismatch',
            summary: typeof chrome !== 'undefined' && chrome?.i18n
                ? (chrome.i18n.getMessage('findingLinkMismatchSummary') || 'Visible link text differs from actual target hostname')
                : 'Visible link text differs from actual target hostname',
            details: typeof chrome !== 'undefined' && chrome?.i18n
                ? (chrome.i18n.getMessage('findingLinkMismatchDetails', [mismatch.visibleHostname, mismatch.targetHostname, module.describeElement(element)]) || `visibleHostname=${mismatch.visibleHostname}; targetHostname=${mismatch.targetHostname}; ${module.describeElement(element)}`)
                : `visibleHostname=${mismatch.visibleHostname}; targetHostname=${mismatch.targetHostname}; ${module.describeElement(element)}`,
            severity: 'high',
            detector: 'visibleMismatchDetector'
        })
    ];
}

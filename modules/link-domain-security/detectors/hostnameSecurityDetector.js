import { createFinding } from '../utils/findingFactory.js';

export function inspectCurrentHostname({ module }) {
    if (!module.config.detectHomographs) {
        return [];
    }

    const analysis = module.analyzeHostname(window.location.hostname);
    if (!analysis) {
        return [];
    }

    const findings = [];

    if (analysis.hasPunycode) {
        findings.push(createFinding({
            type: 'hostname-punycode',
            summary: typeof chrome !== 'undefined' && chrome?.i18n
                ? (chrome.i18n.getMessage('findingHostnamePunycodeSummary') || 'Punycode hostname requires review')
                : 'Punycode hostname requires review',
            details: typeof chrome !== 'undefined' && chrome?.i18n
                ? (chrome.i18n.getMessage('findingHostnameCurrentDetails', [analysis.originalHostname]) || `Current page hostname: ${analysis.originalHostname}`)
                : `Current page hostname: ${analysis.originalHostname}`,
            severity: 'low',
            detector: 'hostnameSecurityDetector'
        }));
    }

    if (analysis.hasMixedScript) {
        findings.push(createFinding({
            type: 'hostname-mixed-script',
            summary: typeof chrome !== 'undefined' && chrome?.i18n
                ? (chrome.i18n.getMessage('findingHostnameMixedScriptSummary') || 'Mixed-script hostname may indicate homograph spoofing')
                : 'Mixed-script hostname may indicate homograph spoofing',
            details: typeof chrome !== 'undefined' && chrome?.i18n
                ? (chrome.i18n.getMessage('findingHostnameCurrentDetails', [analysis.originalHostname]) || `Current page hostname: ${analysis.originalHostname}`)
                : `Current page hostname: ${analysis.originalHostname}`,
            severity: 'high',
            detector: 'hostnameSecurityDetector'
        }));
    }

    return findings;
}

export function inspectTargetHostname({ element, targetUrl, hostnameAnalysis, module }) {
    if (!module.config.detectHomographs || !targetUrl.hostname) {
        return [];
    }

    const analysis = hostnameAnalysis || module.analyzeHostname(targetUrl.hostname);
    if (!analysis) {
        return [];
    }

    const findings = [];
    const details = typeof chrome !== 'undefined' && chrome?.i18n
        ? (chrome.i18n.getMessage('findingHostnameTargetDetails', [analysis.originalHostname, module.describeElement(element)]) || `Target hostname: ${analysis.originalHostname}; ${module.describeElement(element)}`)
        : `Target hostname: ${analysis.originalHostname}; ${module.describeElement(element)}`;

    if (analysis.hasPunycode) {
        findings.push(createFinding({
            type: 'hostname-punycode',
            summary: typeof chrome !== 'undefined' && chrome?.i18n
                ? (chrome.i18n.getMessage('findingHostnamePunycodeSummary') || 'Punycode hostname requires review')
                : 'Punycode hostname requires review',
            details,
            severity: 'low',
            detector: 'hostnameSecurityDetector'
        }));
    }

    if (analysis.hasMixedScript) {
        findings.push(createFinding({
            type: 'hostname-mixed-script',
            summary: typeof chrome !== 'undefined' && chrome?.i18n
                ? (chrome.i18n.getMessage('findingHostnameMixedScriptSummary') || 'Mixed-script hostname may indicate homograph spoofing')
                : 'Mixed-script hostname may indicate homograph spoofing',
            details,
            severity: 'high',
            detector: 'hostnameSecurityDetector'
        }));
    }

    return findings;
}

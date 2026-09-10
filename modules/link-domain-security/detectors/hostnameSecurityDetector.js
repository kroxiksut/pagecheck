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

    // Punycode - это СПОСОБ записи, а не сам дефект: если по тому же хосту сработал точный сигнал
    // (whole-script confusable или смешение скриптов), общая низкоприоритетная запись только дублирует
    // ту же проблему менее точной формулировкой. Гасим её по образцу visual-manipulation 8.12
    // (TASKS 6.11).
    // Второе условие - `hasScriptZoneMismatch` (вопрос В4 по итогам Priority 7). Сам по себе punycode
    // информативен не всегда: имя, написанное письменностью собственной зоны (`сахар.рф`,
    // `münchen.de`), это нормальная запись домена, а не повод смотреть на него. Остаётся сообщение
    // о том, что письменность имени не совпадает с письменностью зоны, - `оса.com`.
    const hasPreciseHostnameSignal = analysis.hasMixedScript
        || analysis.hasWholeScriptConfusable
        || analysis.hasLatinLookalike;

    if (analysis.hasPunycode && analysis.hasScriptZoneMismatch && !hasPreciseHostnameSignal) {
        findings.push(createFinding({
            type: 'hostname-punycode',
            summary: typeof chrome !== 'undefined' && chrome?.i18n
                ? (chrome.i18n.getMessage('findingHostnamePunycodeSummary') || 'Punycode hostname requires review')
                : 'Punycode hostname requires review',
            details: typeof chrome !== 'undefined' && chrome?.i18n
                ? (chrome.i18n.getMessage('findingHostnameCurrentDetails', [analysis.originalHostname]) || `Current page hostname: ${analysis.originalHostname}`)
                : `Current page hostname: ${analysis.originalHostname}`,
            severity: 'low',
            detector: 'hostnameSecurityDetector',
            dedupeKey: `hostname-punycode|${analysis.normalizedHostname}`
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
            detector: 'hostnameSecurityDetector',
            dedupeKey: `hostname-mixed-script|${analysis.normalizedHostname}`
        }));
    }

    // A whole-script lookalike carries no script mixing, so it used to reach the user only as the
    // low-severity punycode notice - the least alarming finding for the most classic attack
    // (TASKS 6.2).
    // Two different rules, one sentence for the user: the name is written in letters that imitate
    // another name. Whole-script (6.2) and Latin-internal (В4 residual) share the finding type on
    // purpose - a separate type would need new wording that says the same thing.
    if (analysis.hasWholeScriptConfusable || analysis.hasLatinLookalike) {
        findings.push(createFinding({
            type: 'hostname-confusable',
            summary: typeof chrome !== 'undefined' && chrome?.i18n
                ? (chrome.i18n.getMessage('findingHostnameConfusableSummary') || 'Hostname is written in letters that imitate a Latin name')
                : 'Hostname is written in letters that imitate a Latin name',
            details: typeof chrome !== 'undefined' && chrome?.i18n
                ? (chrome.i18n.getMessage('findingHostnameCurrentDetails', [analysis.originalHostname]) || `Current page hostname: ${analysis.originalHostname}`)
                : `Current page hostname: ${analysis.originalHostname}`,
            severity: 'high',
            detector: 'hostnameSecurityDetector',
            dedupeKey: `hostname-confusable|${analysis.normalizedHostname}`
        }));
    }

    return findings;
}

export function inspectTargetHostname({ element, targetUrl, hostnameAnalysis, module }) {
    if (!module.config.detectHomographs || !targetUrl.hostname) {
        return [];
    }

    // No `||` fallback to a fresh analysis here (TASKS 7.11). Whenever this detector runs, the
    // orchestrator has already analysed the hostname - `detectHomographs` is exactly the flag that
    // makes it do so - and a `null` means "analysed, nothing to say" (localhost, an IP, a single
    // label). The fallback was therefore reachable only for hostnames guaranteed to return `null`
    // again, and paid the full analysis twice for every link to an IP address.
    const analysis = hostnameAnalysis;
    if (!analysis) {
        return [];
    }

    const findings = [];
    const details = typeof chrome !== 'undefined' && chrome?.i18n
        ? (chrome.i18n.getMessage('findingHostnameTargetDetails', [analysis.originalHostname, module.describeElement(element)]) || `Target hostname: ${analysis.originalHostname}; ${module.describeElement(element)}`)
        : `Target hostname: ${analysis.originalHostname}; ${module.describeElement(element)}`;

    // См. подробный комментарий в inspectCurrentHostname: гасим общий сигнал при точном (6.11) и при
    // совпадении письменности имени с письменностью зоны (В4).
    const hasPreciseHostnameSignal = analysis.hasMixedScript
        || analysis.hasWholeScriptConfusable
        || analysis.hasLatinLookalike;

    if (analysis.hasPunycode && analysis.hasScriptZoneMismatch && !hasPreciseHostnameSignal) {
        findings.push(createFinding({
            type: 'hostname-punycode',
            summary: typeof chrome !== 'undefined' && chrome?.i18n
                ? (chrome.i18n.getMessage('findingHostnamePunycodeSummary') || 'Punycode hostname requires review')
                : 'Punycode hostname requires review',
            details,
            severity: 'low',
            detector: 'hostnameSecurityDetector',
            dedupeKey: `hostname-punycode|${analysis.normalizedHostname}`
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
            detector: 'hostnameSecurityDetector',
            dedupeKey: `hostname-mixed-script|${analysis.normalizedHostname}`
        }));
    }

    // Two different rules, one sentence for the user: the name is written in letters that imitate
    // another name. Whole-script (6.2) and Latin-internal (В4 residual) share the finding type on
    // purpose - a separate type would need new wording that says the same thing.
    if (analysis.hasWholeScriptConfusable || analysis.hasLatinLookalike) {
        findings.push(createFinding({
            type: 'hostname-confusable',
            summary: typeof chrome !== 'undefined' && chrome?.i18n
                ? (chrome.i18n.getMessage('findingHostnameConfusableSummary') || 'Hostname is written in letters that imitate a Latin name')
                : 'Hostname is written in letters that imitate a Latin name',
            details,
            severity: 'high',
            detector: 'hostnameSecurityDetector',
            dedupeKey: `hostname-confusable|${analysis.normalizedHostname}`
        }));
    }

    return findings;
}

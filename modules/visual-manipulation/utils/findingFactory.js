import { isSeverity } from './severityModel.js';

// The single gate every finding of this module passes through, so the severity vocabulary is
// enforced here once rather than trusted in four detectors (TASKS Block C.1). A value outside the
// vocabulary is a coding error, not user input, so it degrades to the documented default instead of
// throwing: a scan must not die because one branch mistyped a level.
function resolveSeverity(severity) {
    return isSeverity(severity) ? severity : 'medium';
}

export function createFinding({ type, summary, details, severity = 'medium', detector = 'unknown', ...metadata }) {
    return {
        type,
        summary,
        details,
        severity: resolveSeverity(severity),
        detector,
        ...metadata
    };
}

export function normalizeFindings(findings) {
    return findings
        .filter(Boolean)
        .map((finding) => ({
            detector: 'unknown',
            ...finding,
            severity: resolveSeverity(finding.severity)
        }));
}

export function dedupeFindings(findings, existingFindings = []) {
    const existingDedupeKeys = new Set(
        existingFindings
            .map((finding) => (typeof finding?.dedupeKey === 'string' ? finding.dedupeKey : ''))
            .filter(Boolean)
    );

    return findings.filter((finding) => {
        const dedupeKey = typeof finding?.dedupeKey === 'string' ? finding.dedupeKey : '';
        if (!dedupeKey) {
            return true;
        }

        if (existingDedupeKeys.has(dedupeKey)) {
            return false;
        }

        existingDedupeKeys.add(dedupeKey);
        return true;
    });
}

export function getMessage(key, substitutions, fallback) {
    return typeof chrome !== 'undefined' && chrome?.i18n
        ? (chrome.i18n.getMessage(key, substitutions) || fallback)
        : fallback;
}

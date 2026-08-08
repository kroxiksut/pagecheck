export function createFinding({ type, summary, details, severity = 'medium', detector = 'unknown', ...metadata }) {
    return {
        type,
        summary,
        details,
        severity,
        detector,
        ...metadata
    };
}

export function normalizeFindings(findings) {
    return findings
        .filter(Boolean)
        .map((finding) => ({
            severity: 'medium',
            detector: 'unknown',
            ...finding
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

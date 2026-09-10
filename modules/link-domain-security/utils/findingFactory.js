// Extra fields (currently `dedupeKey`) are passed through: the identity of a finding is decided by
// the detector that knows what makes two findings the same problem (TASKS 6.4).
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

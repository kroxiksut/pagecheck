export function createFinding({ type, summary, details, severity = 'medium', detector = 'unknown' }) {
    return {
        type,
        summary,
        details,
        severity,
        detector
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

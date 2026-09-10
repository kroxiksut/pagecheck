// Severity vocabulary of the module (TASKS Block C.1 / R4).
//
// Why this file exists: severity was assigned by four detectors independently, each with its own
// if-chain and its own literals. That is exactly the configuration that produced 9.3 (severity
// decided by strategy order rather than signal strength), 9.5 (two different mechanisms for one
// class of benign evidence) and 9.6 (the generic branch stricter than every specialised one). The
// levels themselves were never the problem - all four detectors already used low/medium/high and
// nothing else - so this layer fixes the vocabulary and the two operations that move a verdict
// along it, instead of rewriting verdicts that are correct.
//
// Relation to `semantic-analysis`: that module resolves severity from an (evidenceStrength x impact)
// matrix (SemanticAnalysisCore.js). The levels are deliberately the same three, so a finding from
// either module means the same thing in the UI and in the findings API. The matrix itself is NOT
// imported here: the axes of this module are per-mechanism (how the element is hidden, how much
// text is behind it, which benign signals the page author controls), and mapping them onto
// (evidence x impact) today would move severities that have no reason to move - for instance
// `font-size: 0` with a long payload lands on (strong x high) = high, where the branch has always
// reported medium. Vocabulary is shared; the resolution rule stays per-module until there is a
// measured reason to change a verdict.
//
// Note on the findings API: `js/findings-api.js` also accepts 'critical'. This module never emits
// it - there is no visual-manipulation evidence that outranks "hidden interactive element under a
// deceptive overlay", which is already high.

export const SEVERITY_LEVELS = ['low', 'medium', 'high'];

const SEVERITY_RANK = { low: 0, medium: 1, high: 2 };

export function isSeverity(value) {
    return typeof value === 'string' && Object.hasOwn(SEVERITY_RANK, value);
}

// Ordering helper. Returns a negative number when `left` is the milder verdict, 0 when equal.
// Unknown values sort below 'low' so a typo can never win a comparison.
export function compareSeverity(left, right) {
    const leftRank = isSeverity(left) ? SEVERITY_RANK[left] : -1;
    const rightRank = isSeverity(right) ? SEVERITY_RANK[right] : -1;
    return leftRank - rightRank;
}

export function maxSeverity(left, right) {
    if (!isSeverity(left)) {
        return isSeverity(right) ? right : SEVERITY_LEVELS[0];
    }
    if (!isSeverity(right)) {
        return left;
    }
    return compareSeverity(left, right) >= 0 ? left : right;
}

// One step down, floored at 'low'. This is the shape benign evidence takes throughout the module:
// evidence the page author controls (a declared animation, a revealable-container role, an
// unreliable measurement) never proves the content is readable, so it lowers the verdict instead of
// deciding it. Suppression is a separate decision and belongs to the detector, not here.
export function lowerSeverity(severity) {
    if (!isSeverity(severity)) {
        return SEVERITY_LEVELS[0];
    }
    return SEVERITY_RANK[severity] <= 0 ? SEVERITY_LEVELS[0] : SEVERITY_LEVELS[SEVERITY_RANK[severity] - 1];
}

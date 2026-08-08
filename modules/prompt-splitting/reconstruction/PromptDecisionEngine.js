import { analyzeSemanticCandidate } from '../../semantic-analysis/SemanticAnalysisCore.js';

const DECISION_SCHEMA_VERSION = 1;
const CONFIDENCE_RANK = Object.freeze({ insufficient: 0, weak: 1, moderate: 2, strong: 3 });
const DEFAULT_LIMITS = Object.freeze({
    maxSemanticAnalyses: 5,
    maxSourceFragmentAnalyses: 4,
    maxAssessments: 4,
    maxDecisions: 4,
    maxMappedCandidates: 4,
    maxMappedFragments: 4,
    maxSupportingRules: 8,
    maxCodesPerDecision: 12,
    maxElapsedMs: 25
});
const DEFAULT_POLICY = Object.freeze({
    minimumConfidence: 'moderate',
    sensitivity: 'medium',
    eligibleAssemblyPaths: ['boundary-aware', 'spaced'],
    allowAttributeOnly: false
});

function copyLimits(limits = {}) {
    const result = {};
    for (const [key, fallback] of Object.entries(DEFAULT_LIMITS)) {
        result[key] = Number.isInteger(limits[key]) ? Math.max(0, limits[key]) : fallback;
    }
    return result;
}

function copyPolicy(policy = {}) {
    const minimumConfidence = Object.hasOwn(CONFIDENCE_RANK, policy.minimumConfidence)
        ? policy.minimumConfidence
        : DEFAULT_POLICY.minimumConfidence;
    return {
        minimumConfidence,
        sensitivity: typeof policy.sensitivity === 'string' ? policy.sensitivity : DEFAULT_POLICY.sensitivity,
        customLiteralCatalog: Array.isArray(policy.customLiteralCatalog)
            ? policy.customLiteralCatalog.slice(0, 500)
            : [],
        eligibleAssemblyPaths: Array.isArray(policy.eligibleAssemblyPaths)
            ? policy.eligibleAssemblyPaths.filter((path) => typeof path === 'string').slice(0, 3)
            : [...DEFAULT_POLICY.eligibleAssemblyPaths],
        allowAttributeOnly: policy.allowAttributeOnly === true
    };
}

function emptyDiagnostics() {
    return {
        semanticAnalyses: 0,
        sourceFragmentAnalyses: 0,
        assessmentsSeen: 0,
        decisionsCreated: 0,
        decisionsSuppressed: 0,
        contributionMappings: 0,
        mappingFailures: 0,
        standaloneMatches: 0,
        lifecycleCancelled: false,
        elapsedBudgetReached: false,
        semanticError: false,
        partial: false
    };
}

function uniqueBoundedCodes(codes, limit) {
    return [...new Set(codes.filter((code) => typeof code === 'string'))].slice(0, limit);
}

function capConfidence(current, maximum) {
    return CONFIDENCE_RANK[current] > CONFIDENCE_RANK[maximum] ? maximum : current;
}

function clearTransientInput(candidate) {
    if (!candidate || typeof candidate !== 'object') return;
    candidate.text = '';
    for (const fragment of candidate.sourceFragments || []) fragment.text = '';
    (candidate.sourceFragments || []).length = 0;
    (candidate.fragmentSpans || []).length = 0;
}

function mapContributions(assessment, fragmentSpans, limits) {
    const contributionMap = assessment.transientContributionMap;
    if (!contributionMap?.mappingReliable || !Array.isArray(contributionMap.requiredSignals)) {
        return { reliable: false, signalContributions: [], candidateIds: [], fragmentIds: [], candidateCount: 0, fragmentCount: 0, splitSignal: false };
    }
    const signalContributions = [];
    const candidateIds = new Set();
    const fragmentIds = new Set();
    let splitSignal = false;
    for (const signal of contributionMap.requiredSignals) {
        const spans = fragmentSpans.filter((span) => signal.start < span.end && signal.end > span.start);
        if (spans.length === 0) return { reliable: false, signalContributions: [], candidateIds: [], fragmentIds: [], candidateCount: 0, fragmentCount: 0, splitSignal: false };
        const signalCandidateIds = [...new Set(spans.map((span) => span.candidateId))];
        if (signalCandidateIds.length > 1) splitSignal = true;
        for (const span of spans) {
            candidateIds.add(span.candidateId);
            fragmentIds.add(span.fragmentId);
        }
        signalContributions.push({ signalId: signal.signalId, candidateCount: signalCandidateIds.length, fragmentCount: spans.length });
        if (candidateIds.size > limits.maxMappedCandidates || fragmentIds.size > limits.maxMappedFragments) {
            return { reliable: false, signalContributions: [], candidateIds: [], fragmentIds: [], candidateCount: 0, fragmentCount: 0, splitSignal: false };
        }
    }
    return {
        reliable: true,
        signalContributions,
        candidateIds: [...candidateIds],
        fragmentIds: [...fragmentIds],
        candidateCount: candidateIds.size,
        fragmentCount: fragmentIds.size,
        splitSignal
    };
}

function buildConfidence(candidate, contribution, hasStandaloneMatch, policy) {
    const reasonCodes = ['semantic-primary-match'];
    const mitigationCodes = [];
    if (!contribution.reliable) {
        return { confidence: 'insufficient', reasonCodes: [...reasonCodes, 'contribution-mapping-unreliable'], mitigationCodes: ['mapping-required'] };
    }
    if (hasStandaloneMatch) {
        return { confidence: 'insufficient', reasonCodes: [...reasonCodes, 'single-candidate-full-match'], mitigationCodes: ['single-candidate-owned-by-trigger-phrases'] };
    }
    if (contribution.candidateCount < 2) {
        return { confidence: 'insufficient', reasonCodes: [...reasonCodes, 'insufficient-distributed-contribution'], mitigationCodes: ['multi-candidate-required'] };
    }
    let confidence = 'moderate';
    reasonCodes.push('distributed-required-signals');
    if (contribution.splitSignal) reasonCodes.push('signal-split-across-boundary');
    if (candidate.sourceType !== 'text') {
        confidence = 'weak';
        reasonCodes.push('attribute-only-chain');
        mitigationCodes.push('attribute-chain-cap');
    }
    if (candidate.assemblyPath === 'compact') {
        confidence = 'weak';
        reasonCodes.push('compact-assembly');
        mitigationCodes.push('compact-assembly-cap');
    }
    if (!policy.eligibleAssemblyPaths.includes(candidate.assemblyPath)) {
        confidence = capConfidence(confidence, 'weak');
        mitigationCodes.push('assembly-path-policy-cap');
    }
    if (candidate.context?.any?.code || candidate.context?.any?.quote) {
        confidence = 'insufficient';
        mitigationCodes.push(candidate.context.any.code ? 'code-context' : 'quote-context');
    } else if (candidate.context?.any?.navigation || candidate.context?.any?.list) {
        confidence = capConfidence(confidence, 'weak');
        mitigationCodes.push(candidate.context.any.navigation ? 'navigation-context' : 'list-context');
    }
    if (candidate.partial || candidate.truncated) {
        confidence = capConfidence(confidence, 'moderate');
        mitigationCodes.push(candidate.truncated ? 'truncated-evidence-cap' : 'partial-evidence-cap');
    }
    if (candidate.sourceType === 'text'
        && candidate.assemblyPath === 'boundary-aware'
        && !candidate.partial
        && !candidate.truncated
        && !candidate.context?.any?.code
        && !candidate.context?.any?.quote
        && !candidate.context?.any?.navigation
        && !candidate.context?.any?.list
        && contribution.candidateCount === candidate.candidateCount
        && candidate.candidateCount <= 3) {
        confidence = 'strong';
        reasonCodes.push('complete-distributed-boundary-chain');
    }
    return { confidence, reasonCodes, mitigationCodes };
}

export default class PromptDecisionEngine {
    async evaluate(reconstructedCandidate, policyInput = {}, options = {}) {
        const limits = copyLimits(options.limits);
        const policy = copyPolicy(policyInput);
        const isCurrent = typeof options.isCurrent === 'function' ? options.isCurrent : () => true;
        const onEligibleDecision = typeof options.onEligibleDecision === 'function' ? options.onEligibleDecision : null;
        const diagnostics = emptyDiagnostics();
        const decisions = [];
        const startedAt = performance.now();
        const markPartial = () => { diagnostics.partial = true; };
        const shouldStop = () => {
            if (!isCurrent()) {
                diagnostics.lifecycleCancelled = true;
                markPartial();
                return true;
            }
            if (performance.now() - startedAt > limits.maxElapsedMs) {
                diagnostics.elapsedBudgetReached = true;
                markPartial();
                return true;
            }
            return false;
        };
        const createResult = (status) => ({
            schemaVersion: DECISION_SCHEMA_VERSION,
            status,
            partial: status === 'partial' || status === 'error',
            decisions,
            diagnostics,
            dispose: () => { decisions.length = 0; }
        });

        try {
            if (!reconstructedCandidate || typeof reconstructedCandidate.text !== 'string' || !reconstructedCandidate.text) {
                return createResult('complete');
            }
            if (reconstructedCandidate.partial || reconstructedCandidate.truncated) markPartial();
            if (shouldStop()) return createResult('partial');
            diagnostics.semanticAnalyses += 1;
            const semanticResult = analyzeSemanticCandidate({
                text: reconstructedCandidate.text,
                sourceType: reconstructedCandidate.sourceType,
                context: {
                    code: reconstructedCandidate.context?.any?.code === true,
                    quote: reconstructedCandidate.context?.any?.quote === true
                },
                segmentIndex: 0,
                longCandidateSegmented: false
            }, {
                sensitivity: policy.sensitivity,
                includeTransientContributionMap: true,
                customLiteralCatalog: policy.customLiteralCatalog,
                maxCustomLiteralPatterns: policy.customLiteralCatalog.length,
                maxSemanticMatches: limits.maxAssessments,
                shouldStop
            });
            if (semanticResult.status === 'error') {
                diagnostics.semanticError = true;
                markPartial();
                return createResult('error');
            }
            if (semanticResult.status === 'partial') markPartial();
            const assessments = semanticResult.assessments.slice(0, limits.maxAssessments);
            if (semanticResult.assessments.length > assessments.length) markPartial();
            for (const assessment of assessments) {
                if (shouldStop()) break;
                diagnostics.assessmentsSeen += 1;
                if (!assessment.primaryCategory || !assessment.sensitivityEligible) {
                    diagnostics.decisionsSuppressed += 1;
                    continue;
                }
                const contribution = mapContributions(assessment, reconstructedCandidate.fragmentSpans || [], limits);
                diagnostics.contributionMappings += 1;
                if (!contribution.reliable) diagnostics.mappingFailures += 1;
                let hasStandaloneMatch = false;
                const sourceFragments = (reconstructedCandidate.sourceFragments || []).slice(0, limits.maxSourceFragmentAnalyses);
                if ((reconstructedCandidate.sourceFragments || []).length > sourceFragments.length) markPartial();
                for (const fragment of sourceFragments) {
                    if (shouldStop()) break;
                    diagnostics.semanticAnalyses += 1;
                    diagnostics.sourceFragmentAnalyses += 1;
                    if (diagnostics.semanticAnalyses > limits.maxSemanticAnalyses) {
                        markPartial();
                        break;
                    }
                    const fragmentResult = analyzeSemanticCandidate({
                        text: fragment.text,
                        sourceType: reconstructedCandidate.sourceType,
                        context: { code: false, quote: false },
                        segmentIndex: 0,
                        longCandidateSegmented: false
                    }, {
                        sensitivity: policy.sensitivity,
                        customLiteralCatalog: policy.customLiteralCatalog,
                        maxCustomLiteralPatterns: policy.customLiteralCatalog.length,
                        maxSemanticMatches: limits.maxAssessments,
                        shouldStop
                    });
                    if (fragmentResult.status === 'error') {
                        diagnostics.semanticError = true;
                        markPartial();
                        continue;
                    }
                    if (fragmentResult.status === 'partial') markPartial();
                    if (fragmentResult.assessments.some((fragmentAssessment) => (
                        fragmentAssessment.primaryCategory
                        && fragmentAssessment.actionGroup === assessment.actionGroup
                    ))) {
                        hasStandaloneMatch = true;
                        diagnostics.standaloneMatches += 1;
                        break;
                    }
                }
                if (shouldStop()) break;
                const confidenceResult = buildConfidence(reconstructedCandidate, contribution, hasStandaloneMatch, policy);
                const evidenceEligible = assessment.sensitivityEligible
                    && contribution.reliable
                    && contribution.candidateCount >= 2
                    && !hasStandaloneMatch;
                const policyAllowsSource = reconstructedCandidate.sourceType === 'text' || policy.allowAttributeOnly;
                const decisionEligible = Boolean(
                    evidenceEligible
                    && policyAllowsSource
                    && policy.eligibleAssemblyPaths.includes(reconstructedCandidate.assemblyPath)
                    && CONFIDENCE_RANK[confidenceResult.confidence] >= CONFIDENCE_RANK[policy.minimumConfidence]
                );
                if (decisions.length >= limits.maxDecisions) {
                    markPartial();
                    break;
                }
                decisions.push({
                    schemaVersion: DECISION_SCHEMA_VERSION,
                    eligibility: decisionEligible ? 'eligible' : 'ineligible',
                    ruleId: assessment.contributingRuleIds[0],
                    supportingRuleIds: assessment.contributingRuleIds.slice(1, limits.maxSupportingRules),
                    ruleVersion: assessment.ruleVersion,
                    category: assessment.primaryCategory,
                    subtype: assessment.primarySubtype,
                    actionGroup: assessment.actionGroup,
                    semanticSeverity: assessment.severity,
                    semanticImpact: assessment.impact,
                    semanticEvidenceStrength: assessment.evidenceStrength,
                    reconstructionConfidence: confidenceResult.confidence,
                    sourceType: reconstructedCandidate.sourceType,
                    assemblyPath: reconstructedCandidate.assemblyPath,
                    contributingCandidateCount: contribution.candidateCount,
                    contributingFragmentCount: contribution.fragmentCount,
                    structuralEvidence: {
                        regionType: reconstructedCandidate.structuralContext?.type || 'local',
                        candidateCount: reconstructedCandidate.candidateCount,
                        structuralTransitions: reconstructedCandidate.structuralTransitions,
                        hasStructuralMarker: reconstructedCandidate.sequencing?.hasStructuralMarker === true
                    },
                    reasonCodes: uniqueBoundedCodes([...assessment.reasonCodes, ...confidenceResult.reasonCodes], limits.maxCodesPerDecision),
                    mitigationCodes: uniqueBoundedCodes([...assessment.mitigationCodes, ...confidenceResult.mitigationCodes], limits.maxCodesPerDecision),
                    partial: Boolean(diagnostics.partial || reconstructedCandidate.partial),
                    truncated: reconstructedCandidate.truncated === true
                });
                diagnostics.decisionsCreated += 1;
                if (decisionEligible && onEligibleDecision) {
                    await onEligibleDecision(decisions.at(-1), {
                        regionId: reconstructedCandidate.regionId,
                        candidateIds: [...reconstructedCandidate.candidateIds],
                        contributingCandidateIds: [...contribution.candidateIds],
                        contributingFragmentIds: [...contribution.fragmentIds],
                        sourceType: reconstructedCandidate.sourceType,
                        assemblyPath: reconstructedCandidate.assemblyPath
                    });
                }
            }
            return createResult(diagnostics.partial ? 'partial' : 'complete');
        } catch {
            markPartial();
            diagnostics.semanticError = true;
            return createResult('error');
        } finally {
            clearTransientInput(reconstructedCandidate);
        }
    }
}

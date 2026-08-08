import { BUILT_IN_SEMANTIC_RULES } from './semanticCatalog.js';

export const SEMANTIC_ANALYSIS_SCHEMA_VERSION = 2;
const DEFAULT_MAX_CANDIDATE_CHARACTERS = 65536;
const DEFAULT_MAX_CUSTOM_LITERAL_PATTERNS = 500;

const WHITESPACE_PATTERN = /[\s\p{Zs}]+/gu;
const INVISIBLE_CHARACTER_PATTERN = /[\u00AD\u200B\u2060\uFEFF]/gu;
const BIDI_CONTROL_PATTERN = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;
const JOIN_CONTROL_PATTERN = /[\u200C\u200D]/gu;
const INVISIBLE_CHARACTER_TEST_PATTERN = /[\u00AD\u200B\u2060\uFEFF]/u;
const BIDI_CONTROL_TEST_PATTERN = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;
const JOIN_CONTROL_TEST_PATTERN = /[\u200C\u200D]/u;
const WORD_CHARACTER_PATTERN = /[\p{L}\p{M}\p{N}\p{Pc}]/u;
const TOKEN_PATTERN = /[\p{L}\p{M}\p{N}]+/gu;
const EXTENDED_PICTOGRAPHIC_PATTERN = /\p{Extended_Pictographic}/u;
const LITERAL_EXACT_CHARACTER_PATTERN = /[*+?()[\]{}|\\^$\/]/u;
const SCRIPT_PATTERNS = [
    /\p{Script_Extensions=Latin}/u, /\p{Script_Extensions=Cyrillic}/u,
    /\p{Script_Extensions=Greek}/u, /\p{Script_Extensions=Armenian}/u,
    /\p{Script_Extensions=Georgian}/u, /\p{Script_Extensions=Arabic}/u,
    /\p{Script_Extensions=Hebrew}/u, /\p{Script_Extensions=Devanagari}/u,
    /\p{Script_Extensions=Thai}/u, /\p{Script_Extensions=Han}/u,
    /\p{Script_Extensions=Hiragana}/u, /\p{Script_Extensions=Katakana}/u,
    /\p{Script_Extensions=Hangul}/u
];
const SEMANTIC_CATEGORIES = new Set([
    'instruction-override', 'authority-impersonation', 'role-manipulation', 'sensitive-disclosure',
    'safety-bypass', 'hidden-action', 'coercion', 'agent-directed-action'
]);
const CATEGORY_BASE_IMPACT = {
    'instruction-override': 'medium', 'authority-impersonation': 'medium',
    'sensitive-disclosure': 'medium', 'safety-bypass': 'medium', 'hidden-action': 'medium',
    'role-manipulation': 'low', coercion: 'low', 'agent-directed-action': 'low', 'custom-pattern': 'low'
};
const SEVERITY_MATRIX = {
    weak: { low: 'low', medium: 'low', high: 'medium' },
    moderate: { low: 'low', medium: 'medium', high: 'high' },
    strong: { low: 'medium', medium: 'medium', high: 'high' }
};
const SENSITIVITY_SEVERITIES = {
    low: new Set(['high']), medium: new Set(['medium', 'high']), high: new Set(['low', 'medium', 'high'])
};
const wordSegmenter = typeof Intl?.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'word' })
    : null;
const graphemeSegmenter = typeof Intl?.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

function getSemanticRuleValidationError(rule, ruleIds) {
    if (!rule || typeof rule !== 'object' || typeof rule.ruleId !== 'string' || rule.ruleId === '') {
        return 'invalid-rule-id';
    }
    if (ruleIds.has(rule.ruleId)) return 'duplicate-rule-id';
    if (!SEMANTIC_CATEGORIES.has(rule.category)) return 'unknown-category';
    if (!['strong', 'supporting'].includes(rule.baseSignalStrength)) return 'invalid-base-signal-strength';
    if (!Number.isInteger(rule.version)) return 'invalid-rule-version';
    if (typeof rule.actionGroup !== 'string' || rule.actionGroup === '') return 'invalid-action-group';
    if (typeof rule.reasonKey !== 'string') return 'invalid-reason-key';
    if (!Array.isArray(rule.examples?.positive) || rule.examples.positive.length < 2
        || !Array.isArray(rule.examples?.negative) || rule.examples.negative.length < 2) {
        return 'invalid-examples';
    }

    const requiredSignals = Array.isArray(rule.requiredSignals) ? rule.requiredSignals : [];
    const optionalSignals = Array.isArray(rule.optionalSignals) ? rule.optionalSignals : [];
    const forbiddenSignals = Array.isArray(rule.forbiddenSignals) ? rule.forbiddenSignals : [];
    const signalGroups = [...requiredSignals, ...optionalSignals, ...forbiddenSignals];
    if (requiredSignals.length === 0) return 'missing-required-signals';
    if (signalGroups.some((signal) => typeof signal?.id !== 'string'
        || signal.id === ''
        || !Array.isArray(signal.alternatives)
        || signal.alternatives.length === 0)) {
        return 'invalid-signal';
    }

    ruleIds.add(rule.ruleId);
    return null;
}

function collectCatalogValidation(catalog) {
    if (!Array.isArray(catalog)) {
        return {
            validRules: [],
            invalidRules: [{ ruleId: 'catalog', errorCode: 'invalid-catalog' }],
            invalidRulesTruncated: false,
            status: 'error'
        };
    }

    const ruleIds = new Set();
    const validRules = [];
    const invalidRules = [];
    let invalidRulesTruncated = false;
    for (const rule of catalog) {
        const errorCode = getSemanticRuleValidationError(rule, ruleIds);
        if (!errorCode) {
            validRules.push(rule);
            continue;
        }
        if (invalidRules.length < 32) {
            invalidRules.push({
                ruleId: typeof rule?.ruleId === 'string' && rule.ruleId !== '' ? rule.ruleId : 'unknown',
                errorCode
            });
        } else {
            invalidRulesTruncated = true;
        }
    }
    return {
        validRules,
        invalidRules,
        invalidRulesTruncated,
        status: invalidRules.length > 0 || invalidRulesTruncated ? 'partial' : 'complete'
    };
}

export function validateSemanticCatalog(catalog) {
    const validation = collectCatalogValidation(catalog);
    return {
        schemaVersion: SEMANTIC_ANALYSIS_SCHEMA_VERSION,
        status: validation.status,
        acceptedRuleCount: validation.validRules.length,
        rejectedRuleCount: Array.isArray(catalog)
            ? Math.max(0, catalog.length - validation.validRules.length)
            : 1,
        invalidRules: validation.invalidRules.map((entry) => ({ ...entry })),
        invalidRulesTruncated: validation.invalidRulesTruncated
    };
}

const ACTIVE_SEMANTIC_RULES = Object.freeze(collectCatalogValidation(BUILT_IN_SEMANTIC_RULES).validRules);

function countCodePoints(text) {
    let count = 0;
    for (const character of text) count += 1;
    return count;
}

function exceedsCodePointLimit(text, limit) {
    let count = 0;
    for (const character of text) {
        count += 1;
        if (count > limit) return true;
    }
    return false;
}

function isWordCharacter(character) {
    return WORD_CHARACTER_PATTERN.test(character);
}

function getCodePointBefore(text, index) {
    if (index <= 0) return '';
    const trailingCodeUnit = text.charCodeAt(index - 1);
    if (trailingCodeUnit >= 0xDC00 && trailingCodeUnit <= 0xDFFF && index >= 2) {
        const leadingCodeUnit = text.charCodeAt(index - 2);
        if (leadingCodeUnit >= 0xD800 && leadingCodeUnit <= 0xDBFF) return text.slice(index - 2, index);
    }
    return text[index - 1] || '';
}

function getCodePointAt(text, index) {
    if (index < 0 || index >= text.length) return '';
    const codePoint = text.codePointAt(index);
    return Number.isInteger(codePoint) ? String.fromCodePoint(codePoint) : '';
}

function matchesNormalizedPhrase(comparisonText, phrase) {
    let matchIndex = comparisonText.indexOf(phrase);
    while (matchIndex >= 0) {
        if (!isWordCharacter(getCodePointBefore(comparisonText, matchIndex))
            && !isWordCharacter(getCodePointAt(comparisonText, matchIndex + phrase.length))) {
            return true;
        }
        matchIndex = comparisonText.indexOf(phrase, matchIndex + phrase.length);
    }
    return false;
}

function getUnicodeTokenRecords(text) {
    if (wordSegmenter) {
        return Array.from(wordSegmenter.segment(text), ({ segment, index, isWordLike }) => isWordLike
            ? { token: segment, start: index, end: index + segment.length }
            : null).filter(Boolean);
    }
    return Array.from(text.matchAll(TOKEN_PATTERN), ([token, index]) => ({ token, start: index, end: index + token.length }));
}

function getUnicodeTokens(text) {
    return getUnicodeTokenRecords(text).map((record) => record.token);
}

function createComparisonTokenRecords(tokens) {
    let offset = 0;
    return tokens.map((token, index) => {
        const start = offset;
        offset += token.length;
        if (index < tokens.length - 1) offset += 1;
        return { token, start, end: start + token.length };
    });
}

function findNormalizedPhraseRange(comparisonText, phrase, tokenRecords) {
    let matchIndex = comparisonText.indexOf(phrase);
    while (matchIndex >= 0) {
        const matchEnd = matchIndex + phrase.length;
        if (!isWordCharacter(getCodePointBefore(comparisonText, matchIndex))
            && !isWordCharacter(getCodePointAt(comparisonText, matchEnd))) {
            const startTokenIndex = tokenRecords.findIndex((record) => record.start === matchIndex);
            const endTokenIndex = tokenRecords.findIndex((record) => record.end === matchEnd);
            if (startTokenIndex >= 0 && endTokenIndex >= startTokenIndex) {
                return { startTokenIndex, endTokenIndex };
            }
        }
        matchIndex = comparisonText.indexOf(phrase, matchIndex + phrase.length);
    }
    return null;
}

function hasMixedScripts(text) {
    const scripts = new Set();
    for (const character of text) {
        const scriptIndex = SCRIPT_PATTERNS.findIndex((pattern) => pattern.test(character));
        if (scriptIndex >= 0) scripts.add(scriptIndex);
        if (scripts.size > 1) return true;
    }
    return false;
}

function normalizeSegment(candidate, caseSensitive) {
    const whitespaceCollapsedText = candidate.text.replace(WHITESPACE_PATTERN, ' ').trim();
    const canonicalText = whitespaceCollapsedText.normalize('NFC');
    const compatibilityText = canonicalText.normalize('NFKC');
    const comparisonText = caseSensitive ? compatibilityText : compatibilityText.toLowerCase();
    const tokens = getUnicodeTokens(comparisonText);
    const sourceTokenRecords = getUnicodeTokenRecords(candidate.text);
    const normalizeToken = (token) => (caseSensitive ? token : token.toLowerCase()).normalize('NFKC');
    const normalizedSourceTokens = sourceTokenRecords.map((record) => normalizeToken(record.token));
    const normalizationFlags = {
        whitespaceCollapsed: whitespaceCollapsedText !== candidate.text,
        compatibilityChanged: compatibilityText !== canonicalText,
        invisibleCharactersPresent: INVISIBLE_CHARACTER_TEST_PATTERN.test(canonicalText),
        bidiControlsPresent: BIDI_CONTROL_TEST_PATTERN.test(canonicalText),
        joinControlsPresent: JOIN_CONTROL_TEST_PATTERN.test(canonicalText),
        mixedScriptsPresent: hasMixedScripts(canonicalText),
        longCandidateSegmented: candidate.longCandidateSegmented === true,
        deobfuscatedTextChanged: comparisonText
            .replace(INVISIBLE_CHARACTER_PATTERN, '')
            .replace(BIDI_CONTROL_PATTERN, '')
            .replace(JOIN_CONTROL_PATTERN, '') !== comparisonText
    };
    const contributionMappingReliable = !normalizationFlags.compatibilityChanged
        && !normalizationFlags.invisibleCharactersPresent
        && !normalizationFlags.bidiControlsPresent
        && !normalizationFlags.joinControlsPresent
        && !normalizationFlags.longCandidateSegmented
        && normalizedSourceTokens.length === tokens.length
        && normalizedSourceTokens.every((token, index) => token === tokens[index]);
    return {
        comparisonText,
        tokens,
        comparisonTokenRecords: createComparisonTokenRecords(tokens),
        sourceTokenRecords,
        contributionMappingReliable,
        sourceType: candidate.sourceType,
        segmentIndex: candidate.segmentIndex,
        context: { code: Boolean(candidate.context?.code), quote: Boolean(candidate.context?.quote) },
        normalizationFlags
    };
}

function classifyNormalizedSegment(segment) {
    const comparisonText = segment.tokens.join(' ');
    if (!comparisonText) return [];
    return ACTIVE_SEMANTIC_RULES.reduce((matches, rule) => {
        const findSignalMatch = (signal) => signal.alternatives
            .map((phrase) => findNormalizedPhraseRange(comparisonText, phrase, segment.comparisonTokenRecords))
            .find(Boolean);
        if (rule.forbiddenSignals.some((signal) => findSignalMatch(signal))) return matches;
        const requiredSignalMatches = rule.requiredSignals.map((signal) => ({ signalId: signal.id, range: findSignalMatch(signal) }));
        if (requiredSignalMatches.some((entry) => !entry.range)) return matches;
        matches.push({
            ruleId: rule.ruleId, category: rule.category, subtype: rule.subtype, actionGroup: rule.actionGroup,
            language: rule.language, baseSignalStrength: rule.baseSignalStrength, primary: rule.primary,
            supportsPrimaryActionGroups: rule.supportsPrimaryActionGroups === true, normalizationPath: 'comparison',
            segmentIndex: segment.segmentIndex, contributingSignals: requiredSignalMatches.map((entry) => entry.signalId),
            contributionTokenRanges: requiredSignalMatches.map((entry) => ({ signalId: entry.signalId, ...entry.range })),
            supportingSignals: rule.optionalSignals.filter((signal) => findSignalMatch(signal)).map((signal) => signal.id),
            context: segment.context, reasonKey: rule.reasonKey, ruleVersion: rule.version
        });
        return matches;
    }, []);
}

function getRelatedActionGroupsForLiteral(tokenText) {
    if (!tokenText) return [];
    return [...new Set(ACTIVE_SEMANTIC_RULES
        .filter((rule) => rule.primary && rule.requiredSignals.every((signal) => (
            signal.alternatives.some((phrase) => matchesNormalizedPhrase(tokenText, phrase))
        )))
        .map((rule) => rule.actionGroup))];
}

function lowerEvidenceStrength(evidenceStrength) {
    return evidenceStrength === 'strong' ? 'moderate' : 'weak';
}

function resolveSensitivity(sensitivity) {
    return Object.hasOwn(SENSITIVITY_SEVERITIES, sensitivity) ? sensitivity : 'medium';
}

function evaluateSemanticMatch(match, segment, sensitivity, supportingMatches = [], includeTransientContributionMap = false) {
    const uniqueSupportingMatches = [...new Map(supportingMatches
        .filter((supportingMatch) => supportingMatch.ruleId !== match.ruleId)
        .map((supportingMatch) => [supportingMatch.ruleId, supportingMatch])).values()];
    const reasonCodes = new Set();
    const mitigationCodes = new Set();
    const isCustomPattern = match.category === 'custom-pattern';
    let evidenceStrength = isCustomPattern ? (match.shortPattern ? 'weak' : 'strong') : (match.primary ? 'strong' : 'weak');
    let impact = CATEGORY_BASE_IMPACT[match.category] || 'low';
    reasonCodes.add(isCustomPattern ? (match.shortPattern ? 'short-custom-pattern' : 'literal-custom-pattern') : (match.primary ? 'complete-primary-construction' : 'supporting-only-construction'));
    reasonCodes.add(`impact-baseline-${match.category}`);
    if (match.category === 'sensitive-disclosure' && match.supportingSignals.includes('external-transfer')) {
        impact = 'high';
        reasonCodes.add('protected-data-external-transfer');
    }
    if (match.normalizationPath === 'deobfuscated') {
        evidenceStrength = lowerEvidenceStrength(evidenceStrength);
        reasonCodes.add('deobfuscated-match-path');
        mitigationCodes.add('deobfuscated-evidence-cap');
    } else if (segment.normalizationFlags.compatibilityChanged) {
        reasonCodes.add('compatibility-normalization-context');
    }
    if (match.context.code || match.context.quote) {
        evidenceStrength = lowerEvidenceStrength(evidenceStrength);
        mitigationCodes.add(match.context.code ? 'code-context' : 'quote-context');
    }
    if (uniqueSupportingMatches.length > 0) reasonCodes.add('supporting-rule-match');
    let severity = SEVERITY_MATRIX[evidenceStrength]?.[impact] || 'low';
    if (isCustomPattern && (match.shortPattern || match.normalizationPath === 'deobfuscated')) {
        severity = 'low';
        mitigationCodes.add(match.shortPattern ? 'short-custom-pattern-cap' : 'deobfuscated-custom-pattern-cap');
    }
    const effectiveSensitivity = resolveSensitivity(sensitivity);
    const assessment = {
        actionGroup: match.actionGroup, language: match.language, ruleVersion: match.ruleVersion,
        contributingRuleIds: [match.ruleId, ...uniqueSupportingMatches.map((supportingMatch) => supportingMatch.ruleId)],
        contributingSignals: [...match.contributingSignals], supportingSignals: [...match.supportingSignals],
        primaryCategory: match.primary ? match.category : null, primarySubtype: match.primary ? match.subtype : null,
        supportingCategories: match.primary
            ? [...new Set(uniqueSupportingMatches.map((supportingMatch) => supportingMatch.category).filter((category) => category !== match.category))]
            : [match.category],
        impact, evidenceStrength, severity, reasonCodes: [...reasonCodes], mitigationCodes: [...mitigationCodes],
        normalizationPath: match.normalizationPath, sourceType: segment.sourceType, context: { ...match.context },
        sensitivityEligible: SENSITIVITY_SEVERITIES[effectiveSensitivity].has(severity)
    };
    if (includeTransientContributionMap) {
        assessment.transientContributionMap = {
            mappingReliable: segment.contributionMappingReliable,
            requiredSignals: segment.contributionMappingReliable
                ? (match.contributionTokenRanges || []).map((range) => {
                    const startToken = segment.sourceTokenRecords[range.startTokenIndex];
                    const endToken = segment.sourceTokenRecords[range.endTokenIndex];
                    return startToken && endToken
                        ? { signalId: range.signalId, start: startToken.start, end: endToken.end }
                        : null;
                }).filter(Boolean)
                : []
        };
    }
    return assessment;
}

function evaluateSemanticMatches(matches, segment, sensitivity, includeTransientContributionMap = false) {
    const uniqueMatches = [...new Map(matches.map((match) => [match.ruleId, match])).values()];
    const primaryMatches = uniqueMatches.filter((match) => match.primary);
    if (primaryMatches.length === 0) {
        return uniqueMatches.filter((match) => !match.primary)
            .map((match) => evaluateSemanticMatch(match, segment, sensitivity, [], includeTransientContributionMap));
    }
    const groups = new Map();
    const addToGroup = (actionGroup, match) => groups.set(actionGroup, [...(groups.get(actionGroup) || []), match]);
    primaryMatches.filter((match) => match.category !== 'custom-pattern').forEach((match) => addToGroup(match.actionGroup, match));
    primaryMatches.filter((match) => match.category === 'custom-pattern').forEach((match) => {
        const relatedActionGroup = match.relatedActionGroups?.length === 1 ? match.relatedActionGroups[0] : null;
        addToGroup(relatedActionGroup && groups.has(relatedActionGroup) ? relatedActionGroup : match.actionGroup, match);
    });
    const contextualSupportingMatches = uniqueMatches.filter((match) => !match.primary && match.supportsPrimaryActionGroups);
    return [...groups.values()].map((groupMatches) => {
        const primaryMatch = groupMatches.find((match) => match.category !== 'custom-pattern') || groupMatches[0];
        const supportingMatches = groupMatches.filter((match) => match !== primaryMatch)
            .concat(primaryMatch.category === 'custom-pattern' ? [] : contextualSupportingMatches);
        return evaluateSemanticMatch(primaryMatch, segment, sensitivity, supportingMatches, includeTransientContributionMap);
    });
}

export function prepareCustomLiteralCatalog(catalog, config = {}, limits = {}) {
    if (catalog?.version !== 1 || !Array.isArray(catalog.items)) return [];
    const maxPatterns = Number.isInteger(limits.maxPatterns) ? Math.max(0, limits.maxPatterns) : 500;
    const maxCharacters = Number.isInteger(limits.maxCharacters) ? Math.max(0, limits.maxCharacters) : 65536;
    const caseSensitive = config.caseSensitive === true;
    const seenPatterns = new Set();
    const activePatterns = [];
    let totalPatternCharacters = 0;
    for (const item of catalog.items) {
        if (!item?.enabled || item.mode !== 'literal' || typeof item.id !== 'string' || typeof item.source !== 'string') continue;
        const normalized = normalizeSegment({ text: item.source, sourceType: 'custom-pattern', context: {}, segmentIndex: 0 }, caseSensitive);
        const requiresExactComparison = EXTENDED_PICTOGRAPHIC_PATTERN.test(normalized.comparisonText)
            || normalized.normalizationFlags.joinControlsPresent || LITERAL_EXACT_CHARACTER_PATTERN.test(normalized.comparisonText);
        const comparisonText = requiresExactComparison ? normalized.comparisonText : normalized.tokens.join(' ');
        const patternCharacterCount = countCodePoints(comparisonText);
        if (!comparisonText || activePatterns.length >= maxPatterns || totalPatternCharacters + patternCharacterCount > maxCharacters) continue;
        const dedupeKey = `${requiresExactComparison}:${comparisonText}`;
        if (seenPatterns.has(dedupeKey)) continue;
        seenPatterns.add(dedupeKey);
        totalPatternCharacters += patternCharacterCount;
        activePatterns.push(Object.freeze({
            id: item.id, comparisonText, requiresExactComparison,
            shortPattern: (graphemeSegmenter ? Array.from(graphemeSegmenter.segment(comparisonText)).length : countCodePoints(comparisonText)) <= 2,
            relatedActionGroups: getRelatedActionGroupsForLiteral(normalized.tokens.join(' '))
        }));
    }
    return activePatterns;
}

export function analyzeSemanticCandidate(candidate, options = {}) {
    const text = typeof candidate?.text === 'string' ? candidate.text : '';
    if (!text) {
        return { schemaVersion: SEMANTIC_ANALYSIS_SCHEMA_VERSION, status: 'complete', assessments: [], diagnostics: { normalizedCharacters: 0, semanticMatches: 0, customMatches: 0, customLiteralComparisons: 0, normalizationMs: 0, ruleMatchingMs: 0, riskEvaluationMs: 0 } };
    }
    try {
        const maxCandidateCharacters = Number.isInteger(options.maxCandidateCharacters)
            ? Math.max(0, options.maxCandidateCharacters)
            : DEFAULT_MAX_CANDIDATE_CHARACTERS;
        if (exceedsCodePointLimit(text, maxCandidateCharacters)) {
            return {
                schemaVersion: SEMANTIC_ANALYSIS_SCHEMA_VERSION,
                status: 'partial',
                assessments: [],
                diagnostics: {
                    normalizedCharacters: 0,
                    semanticMatches: 0,
                    customMatches: 0,
                    customLiteralComparisons: 0,
                    candidateCharacterBudgetExceeded: true,
                    normalizationMs: 0,
                    ruleMatchingMs: 0,
                    riskEvaluationMs: 0
                }
            };
        }
        const normalizationStartedAt = performance.now();
        const segment = normalizeSegment(candidate, options.caseSensitive === true);
        const normalizationMs = Math.max(0, performance.now() - normalizationStartedAt);
        const normalizedCharacters = countCodePoints(segment.comparisonText);
        if (Number.isFinite(options.maxNormalizedCharacters)
            && normalizedCharacters > Math.max(0, Math.trunc(options.maxNormalizedCharacters))) {
            return {
                schemaVersion: SEMANTIC_ANALYSIS_SCHEMA_VERSION,
                status: 'partial',
                assessments: [],
                diagnostics: {
                    normalizedCharacters,
                    semanticMatches: 0,
                    customMatches: 0,
                    customLiteralComparisons: 0,
                    normalizationFlags: { ...segment.normalizationFlags },
                    normalizedCharacterBudgetExceeded: true,
                    normalizationMs,
                    ruleMatchingMs: 0,
                    riskEvaluationMs: 0
                }
            };
        }
        const matchingStartedAt = performance.now();
        const semanticMatches = classifyNormalizedSegment(segment).slice(0, Math.max(0, options.maxSemanticMatches ?? 10));
        const customMatches = [];
        let customLiteralComparisons = 0;
        const customLiteralCatalog = Array.isArray(options.customLiteralCatalog)
            ? options.customLiteralCatalog
            : [];
        const maxCustomLiteralPatterns = Number.isInteger(options.maxCustomLiteralPatterns)
            ? Math.max(0, options.maxCustomLiteralPatterns)
            : DEFAULT_MAX_CUSTOM_LITERAL_PATTERNS;
        const customPatternLimit = Math.min(customLiteralCatalog.length, maxCustomLiteralPatterns);
        let partial = customLiteralCatalog.length > customPatternLimit;
        const tokenText = segment.tokens.join(' ');
        for (let patternIndex = 0; patternIndex < customPatternLimit; patternIndex += 1) {
            const pattern = customLiteralCatalog[patternIndex];
            if (typeof options.shouldStop === 'function' && options.shouldStop()) {
                partial = true;
                break;
            }
            customLiteralComparisons += 1;
            const candidateText = pattern.requiresExactComparison ? segment.comparisonText : tokenText;
            if (!candidateText || !matchesNormalizedPhrase(candidateText, pattern.comparisonText)) continue;
            customMatches.push({
                ruleId: `custom-pattern:${pattern.id}`, category: 'custom-pattern', subtype: 'literal', actionGroup: `custom-pattern:${pattern.id}`,
                relatedActionGroups: pattern.relatedActionGroups, language: 'user', baseSignalStrength: pattern.shortPattern ? 'weak' : 'strong',
                primary: true, shortPattern: pattern.shortPattern, normalizationPath: 'comparison', segmentIndex: segment.segmentIndex,
                contributingSignals: ['literal-match'], supportingSignals: [], context: segment.context,
                reasonKey: 'findingTriggerPhraseSummary', ruleVersion: 1
            });
            if (customMatches.length >= Math.max(0, options.maxCustomMatches ?? 10)) break;
        }
        const ruleMatchingMs = Math.max(0, performance.now() - matchingStartedAt);
        const riskEvaluationStartedAt = performance.now();
        const assessments = evaluateSemanticMatches(
            [...semanticMatches, ...customMatches],
            segment,
            options.sensitivity,
            options.includeTransientContributionMap === true
        );
        const riskEvaluationMs = Math.max(0, performance.now() - riskEvaluationStartedAt);
        return {
            schemaVersion: SEMANTIC_ANALYSIS_SCHEMA_VERSION,
            status: partial ? 'partial' : 'complete',
            assessments,
            diagnostics: {
                normalizedCharacters, semanticMatches: semanticMatches.length,
                customMatches: customMatches.length, customLiteralComparisons, normalizationFlags: { ...segment.normalizationFlags },
                customCatalogBudgetExceeded: customLiteralCatalog.length > customPatternLimit,
                normalizationMs, ruleMatchingMs, riskEvaluationMs
            }
        };
    } catch {
        return { schemaVersion: SEMANTIC_ANALYSIS_SCHEMA_VERSION, status: 'error', assessments: [], diagnostics: { normalizedCharacters: 0, semanticMatches: 0, customMatches: 0, customLiteralComparisons: 0, normalizationMs: 0, ruleMatchingMs: 0, riskEvaluationMs: 0 } };
    }
}

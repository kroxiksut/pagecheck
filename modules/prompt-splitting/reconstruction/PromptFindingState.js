const FINDING_SCHEMA_VERSION = 1;
const DEFAULT_LIMITS = Object.freeze({
    maxActiveFindings: 200,
    maxReverseIndexEntries: 1000,
    maxPendingFindings: 200,
    // ВНИМАНИЕ: связано с mutationReconstructionLimits.maxRegions в PromptSplitting.js, которое тоже
    // равно 8. Ограничение regionIds в beginBatch() выглядит как источник залипших findings, но
    // сегодня недостижимо ровно потому, что более 8 регионов всегда форсируют markPartial() и
    // неавторитетный коммит. Если ЛЮБАЯ из двух констант изменится независимо, дефект станет
    // достижимым (разбор - раздел «Проверено и снято» в TASKS.ru.md модуля).
    maxCandidateIdsPerFinding: 8,
    maxSupportingRules: 8,
    maxCodes: 12,
    maxHistoryEntries: 20,
    maxSerializedFindings: 10
});
const CONFIDENCE_RANK = Object.freeze({ insufficient: 0, weak: 1, moderate: 2, strong: 3 });
const SEVERITY_RANK = Object.freeze({ low: 0, medium: 1, high: 2, critical: 3 });
const ASSEMBLY_RANK = Object.freeze({ compact: 0, spaced: 1, 'boundary-aware': 2 });

function copyLimits(limits = {}) {
    const result = {};
    for (const [key, fallback] of Object.entries(DEFAULT_LIMITS)) {
        result[key] = Number.isInteger(limits[key]) ? Math.max(0, limits[key]) : fallback;
    }
    return result;
}

function uniqueBounded(values, limit) {
    return [...new Set(values.filter((value) => typeof value === 'string'))].slice(0, limit);
}

function intersects(left, right) {
    const rightSet = new Set(right);
    return left.some((value) => rightSet.has(value));
}

function copyHolder(holder) {
    return {
        key: holder.key,
        candidateIds: [...holder.candidateIds],
        contributingCandidateIds: [...holder.contributingCandidateIds],
        regionIds: [...holder.regionIds],
        finding: {
            ...holder.finding,
            supportingRuleIds: [...holder.finding.supportingRuleIds],
            structuralEvidence: { ...holder.finding.structuralEvidence },
            reasonCodes: [...holder.finding.reasonCodes],
            mitigationCodes: [...holder.finding.mitigationCodes]
        }
    };
}

function materialSignature(holder) {
    const finding = holder.finding;
    return JSON.stringify({
        candidateIds: [...holder.candidateIds].sort(),
        contributingCandidateIds: [...holder.contributingCandidateIds].sort(),
        regionIds: [...holder.regionIds].sort(),
        ruleId: finding.ruleId,
        supportingRuleIds: [...finding.supportingRuleIds].sort(),
        category: finding.category,
        subtype: finding.subtype,
        actionGroup: finding.actionGroup,
        semanticSeverity: finding.semanticSeverity,
        semanticImpact: finding.semanticImpact,
        semanticEvidenceStrength: finding.semanticEvidenceStrength,
        reconstructionConfidence: finding.reconstructionConfidence,
        sourceType: finding.sourceType,
        assemblyPath: finding.assemblyPath,
        contributingCandidateCount: finding.contributingCandidateCount,
        contributingFragmentCount: finding.contributingFragmentCount,
        structuralEvidence: finding.structuralEvidence,
        partial: finding.partial,
        truncated: finding.truncated,
        reasonCodes: finding.reasonCodes,
        mitigationCodes: finding.mitigationCodes
    });
}

function choosePreferredFinding(current, incoming) {
    const currentConfidence = CONFIDENCE_RANK[current.finding.reconstructionConfidence] ?? 0;
    const incomingConfidence = CONFIDENCE_RANK[incoming.finding.reconstructionConfidence] ?? 0;
    if (incomingConfidence !== currentConfidence) return incomingConfidence > currentConfidence ? incoming : current;
    const currentSeverity = SEVERITY_RANK[current.finding.semanticSeverity] ?? 0;
    const incomingSeverity = SEVERITY_RANK[incoming.finding.semanticSeverity] ?? 0;
    if (incomingSeverity !== currentSeverity) return incomingSeverity > currentSeverity ? incoming : current;
    const currentAssembly = ASSEMBLY_RANK[current.finding.assemblyPath] ?? 0;
    const incomingAssembly = ASSEMBLY_RANK[incoming.finding.assemblyPath] ?? 0;
    return incomingAssembly > currentAssembly ? incoming : current;
}

export default class PromptFindingState {
    constructor(limits = {}) {
        this.limits = copyLimits(limits);
        this.activeFindings = new Map();
        this.findingKeysByCandidateId = new Map();
        this.findingKeysByRegionId = new Map();
        this.history = [];
        this.findingRevision = 0;
        this.nextFindingKey = 1;
        this.partialState = false;
        this.overflowCount = 0;
    }

    beginBatch(options = {}) {
        return {
            scope: options.scope === 'region' ? 'region' : 'full',
            lifecycleRevision: options.lifecycleRevision,
            regionIds: uniqueBounded(options.regionIds || [], this.limits.maxCandidateIdsPerFinding),
            pending: [],
            partial: options.partial === true,
            error: false,
            overflow: false
        };
    }

    // Возвращает true, если находка ПРИНЯТА (заведена новой или слита с существующей), и false
    // на каждом отказе по лимиту. Ответ нужен вызывающему: узел для слоя вмешательства отдаётся
    // только по принятой находке (C4.3), а отказ по лимиту - это `partial`, а не находка.
    recordDecision(batch, decision, evidence) {
        if (!batch || decision?.eligibility !== 'eligible' || !evidence?.regionId) return false;
        const candidateIds = uniqueBounded(evidence.candidateIds || [], this.limits.maxCandidateIdsPerFinding + 1);
        const contributingCandidateIds = uniqueBounded(evidence.contributingCandidateIds || [], this.limits.maxCandidateIdsPerFinding + 1);
        if (candidateIds.length === 0 || contributingCandidateIds.length < 2
            || candidateIds.length > this.limits.maxCandidateIdsPerFinding
            || contributingCandidateIds.length > this.limits.maxCandidateIdsPerFinding) {
            batch.partial = true;
            batch.overflow = true;
            return false;
        }
        const now = Date.now();
        const incoming = {
            key: null,
            candidateIds,
            contributingCandidateIds,
            regionIds: [evidence.regionId],
            finding: {
                schemaVersion: FINDING_SCHEMA_VERSION,
                type: 'prompt-splitting',
                detectorId: 'Prompt-Splitting',
                summaryKey: 'findingPromptSplittingSummary',
                ruleId: decision.ruleId,
                supportingRuleIds: uniqueBounded(decision.supportingRuleIds || [], this.limits.maxSupportingRules),
                ruleVersion: decision.ruleVersion,
                category: decision.category,
                subtype: decision.subtype,
                actionGroup: decision.actionGroup,
                semanticSeverity: decision.semanticSeverity,
                semanticImpact: decision.semanticImpact,
                semanticEvidenceStrength: decision.semanticEvidenceStrength,
                reconstructionConfidence: decision.reconstructionConfidence,
                sourceType: decision.sourceType,
                assemblyPath: decision.assemblyPath,
                contributingCandidateCount: decision.contributingCandidateCount,
                contributingFragmentCount: decision.contributingFragmentCount,
                structuralEvidence: { ...decision.structuralEvidence },
                reasonCodes: uniqueBounded(decision.reasonCodes || [], this.limits.maxCodes),
                mitigationCodes: uniqueBounded(decision.mitigationCodes || [], this.limits.maxCodes),
                partial: decision.partial === true,
                truncated: decision.truncated === true,
                firstDetectedAt: now,
                lastDetectedAt: now
            }
        };
        const existing = batch.pending.find((holder) => holder.finding.actionGroup === incoming.finding.actionGroup
            && holder.finding.sourceType === incoming.finding.sourceType
            && holder.regionIds[0] === incoming.regionIds[0]
            && intersects(holder.candidateIds, incoming.candidateIds));
        if (!existing) {
            if (batch.pending.length >= this.limits.maxPendingFindings) {
                batch.partial = true;
                batch.overflow = true;
                return false;
            }
            batch.pending.push(incoming);
            return true;
        }
        const mergedCandidateIds = uniqueBounded([...existing.candidateIds, ...incoming.candidateIds], this.limits.maxCandidateIdsPerFinding + 1);
        const mergedContributingIds = uniqueBounded(
            [...existing.contributingCandidateIds, ...incoming.contributingCandidateIds],
            this.limits.maxCandidateIdsPerFinding + 1
        );
        if (mergedCandidateIds.length > this.limits.maxCandidateIdsPerFinding
            || mergedContributingIds.length > this.limits.maxCandidateIdsPerFinding) {
            batch.partial = true;
            batch.overflow = true;
            return false;
        }
        const preferred = choosePreferredFinding(existing, incoming);
        existing.candidateIds = mergedCandidateIds;
        existing.contributingCandidateIds = mergedContributingIds;
        existing.finding = {
            ...preferred.finding,
            supportingRuleIds: uniqueBounded(
                [...existing.finding.supportingRuleIds, ...incoming.finding.supportingRuleIds],
                this.limits.maxSupportingRules
            ),
            reasonCodes: uniqueBounded([...existing.finding.reasonCodes, ...incoming.finding.reasonCodes], this.limits.maxCodes),
            mitigationCodes: uniqueBounded([...existing.finding.mitigationCodes, ...incoming.finding.mitigationCodes], this.limits.maxCodes),
            contributingCandidateCount: mergedContributingIds.length,
            contributingFragmentCount: Math.max(existing.finding.contributingFragmentCount, incoming.finding.contributingFragmentCount),
            // || как во всём остальном модуле: слияние частичной находки с полной раньше СНИМАЛО
            // флаг, и находка, чья уверенность была срезана через partial-evidence-cap, уходила в UI
            // как полное свидетельство - пользователю показывался более уверенный вывод, чем есть
            // на самом деле (TASKS 11.8).
            partial: existing.finding.partial || incoming.finding.partial,
            truncated: existing.finding.truncated && incoming.finding.truncated,
            firstDetectedAt: existing.finding.firstDetectedAt,
            lastDetectedAt: now
        };
        return true;
    }

    commitBatch(batch, options = {}) {
        if (!batch || (typeof options.isCurrent === 'function' && !options.isCurrent())) {
            return { status: 'aborted', activeCount: this.activeFindings.size, findingRevision: this.findingRevision };
        }
        if (batch.error) {
            this.partialState = true;
            return { status: 'error', activeCount: this.activeFindings.size, findingRevision: this.findingRevision };
        }
        let authoritative = !batch.partial && !batch.overflow;
        const next = new Map();
        if (!authoritative || batch.scope === 'region') {
            for (const [key, holder] of this.activeFindings) next.set(key, copyHolder(holder));
            if (authoritative && batch.scope === 'region') {
                const affectedRegionIds = new Set(batch.regionIds);
                for (const [key, holder] of next) {
                    if (holder.regionIds.some((regionId) => affectedRegionIds.has(regionId))) next.delete(key);
                }
            }
        }
        for (const pendingHolder of batch.pending) {
            const matchingActive = [...next.values(), ...this.activeFindings.values()].find((holder) => (
                holder.finding.actionGroup === pendingHolder.finding.actionGroup
                && holder.finding.sourceType === pendingHolder.finding.sourceType
                && holder.regionIds[0] === pendingHolder.regionIds[0]
                && holder.candidateIds.length === pendingHolder.candidateIds.length
                && holder.candidateIds.every((candidateId) => pendingHolder.candidateIds.includes(candidateId))
            ));
            const holder = copyHolder(pendingHolder);
            if (matchingActive) {
                holder.key = matchingActive.key;
                holder.finding.firstDetectedAt = matchingActive.finding.firstDetectedAt;
                holder.finding.lastDetectedAt = Date.now();
            } else {
                holder.key = `finding-${this.nextFindingKey++}`;
            }
            next.set(holder.key, holder);
        }
        if (next.size > this.limits.maxActiveFindings) {
            this.overflowCount += next.size - this.limits.maxActiveFindings;
            // preserved строится из next, а не из this.activeFindings: раньше основой служило
            // состояние ДО коммита, поэтому находка, которую блок region-scope только что удалил,
            // возвращалась. И поскольку старые findings заполняли preserved первыми, при
            // activeFindings на уровне maxActiveFindings ни один новый pending-finding больше не
            // проходил - состояние запиралось до перезагрузки страницы (TASKS 11.6).
            // Политика вытеснения при переполнении: сохраняем то, что уже прошло коммит, в порядке
            // их появления, затем добираем pending. Менее уверенное не жертвуется отдельно -
            // уверенность здесь не сравнивается ни с чем и такая политика требовала бы собственного
            // замера на корпусе.
            const preserved = new Map();
            for (const [key, holder] of next) {
                if (preserved.size >= this.limits.maxActiveFindings) break;
                preserved.set(key, copyHolder(holder));
            }
            for (const pendingHolder of batch.pending) {
                if (preserved.size >= this.limits.maxActiveFindings) break;
                const matching = [...preserved.values()].find((holder) => (
                    holder.finding.actionGroup === pendingHolder.finding.actionGroup
                    && holder.finding.sourceType === pendingHolder.finding.sourceType
                    && holder.regionIds[0] === pendingHolder.regionIds[0]
                    && holder.candidateIds.length === pendingHolder.candidateIds.length
                    && holder.candidateIds.every((candidateId) => pendingHolder.candidateIds.includes(candidateId))
                ));
                const holder = copyHolder(pendingHolder);
                if (matching) {
                    holder.key = matching.key;
                    holder.finding.firstDetectedAt = matching.finding.firstDetectedAt;
                } else {
                    holder.key = `finding-${this.nextFindingKey++}`;
                }
                preserved.set(holder.key, holder);
            }
            next.clear();
            for (const [key, holder] of preserved) next.set(key, holder);
            batch.partial = true;
            authoritative = false;
        }
        const previousSignatures = [...this.activeFindings.values()].map(materialSignature).sort();
        const nextSignatures = [...next.values()].map(materialSignature).sort();
        const materiallyChanged = previousSignatures.length !== nextSignatures.length
            || previousSignatures.some((signature, index) => signature !== nextSignatures[index]);
        this.activeFindings = next;
        this.rebuildIndexes();
        this.partialState = !authoritative;
        if (materiallyChanged) {
            this.findingRevision += 1;
            this.history.push({ revision: this.findingRevision, activeCount: this.activeFindings.size });
            if (this.history.length > this.limits.maxHistoryEntries) this.history.splice(0, this.history.length - this.limits.maxHistoryEntries);
        }
        return {
            status: this.partialState ? 'partial' : 'complete',
            activeCount: this.activeFindings.size,
            findingRevision: this.findingRevision,
            materiallyChanged
        };
    }

    removeCandidates(candidateIds = []) {
        const keys = new Set();
        for (const candidateId of candidateIds) {
            for (const key of this.findingKeysByCandidateId.get(candidateId) || []) keys.add(key);
        }
        if (keys.size === 0) return false;
        for (const key of keys) this.activeFindings.delete(key);
        this.rebuildIndexes();
        this.findingRevision += 1;
        return true;
    }

    getSnapshot() {
        const findings = [...this.activeFindings.values()]
            .sort((left, right) => left.finding.firstDetectedAt - right.finding.firstDetectedAt || left.key.localeCompare(right.key))
            .map((holder) => ({
                ...holder.finding,
                supportingRuleIds: [...holder.finding.supportingRuleIds],
                structuralEvidence: { ...holder.finding.structuralEvidence },
                reasonCodes: [...holder.finding.reasonCodes],
                mitigationCodes: [...holder.finding.mitigationCodes]
            }));
        const serializedLimit = this.limits.maxSerializedFindings;
        return {
            schemaVersion: FINDING_SCHEMA_VERSION,
            status: this.partialState ? 'partial' : 'complete',
            partialResult: this.partialState,
            activeCount: this.activeFindings.size,
            findingRevision: this.findingRevision,
            findings: findings.slice(0, serializedLimit),
            findingsTruncated: findings.length > serializedLimit,
            cacheFindings: findings.slice(0, serializedLimit).map((finding) => ({
                type: finding.type,
                summary: finding.summaryKey
            }))
        };
    }

    clear() {
        this.activeFindings.clear();
        this.findingKeysByCandidateId.clear();
        this.findingKeysByRegionId.clear();
        this.history.length = 0;
        this.partialState = false;
    }

    rebuildIndexes() {
        this.findingKeysByCandidateId.clear();
        this.findingKeysByRegionId.clear();
        let entries = 0;
        for (const [key, holder] of this.activeFindings) {
            for (const candidateId of holder.candidateIds) {
                if (entries >= this.limits.maxReverseIndexEntries) {
                    this.partialState = true;
                    return;
                }
                if (!this.findingKeysByCandidateId.has(candidateId)) this.findingKeysByCandidateId.set(candidateId, new Set());
                this.findingKeysByCandidateId.get(candidateId).add(key);
                entries += 1;
            }
            for (const regionId of holder.regionIds) {
                if (entries >= this.limits.maxReverseIndexEntries) {
                    this.partialState = true;
                    return;
                }
                if (!this.findingKeysByRegionId.has(regionId)) this.findingKeysByRegionId.set(regionId, new Set());
                this.findingKeysByRegionId.get(regionId).add(key);
                entries += 1;
            }
        }
    }
}

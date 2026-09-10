const CANDIDATE_SCHEMA_VERSION = 1;
const CANDIDATE_MODE = 'candidate';
const MODULE_ID = 'Api-Interceptor';
const CANDIDATE_TYPE = 'image-resource-declared-mime-anomaly';
const CATEGORIES = ['document', 'script'];
const MAX_OCCURRENCE_COUNT = 999;
const MAX_DECISIONS_PER_BATCH = 64;

function normalizeNavigationRevision(context) {
    const value = context?.navigationRevision;
    return Number.isInteger(value) && value >= 0 ? value : null;
}

function isValidDecision(decision) {
    return decision?.type === CANDIDATE_TYPE
        && CATEGORIES.includes(decision.category)
        && decision.severity === 'low';
}

function createInternalKey(category, navigationRevision) {
    return `${MODULE_ID}:${CANDIDATE_TYPE}:${category}:${navigationRevision}`;
}

function freezeCandidate(record) {
    return Object.freeze({
        type: CANDIDATE_TYPE,
        category: record.category,
        severity: 'low',
        occurrenceCount: record.occurrenceCount
    });
}

export default class ApiFindingState {
    constructor() {
        this.activeByCategory = new Map();
        this.navigationRevision = null;
        this.revision = 0;
        this.partial = false;
        // Батчи, отброшенные как устаревшие, считаются: раньше потеря была молчаливой (TASKS 13.5).
        this.staleBatchesDropped = 0;
    }

    applyDecisions(decisions, context) {
        const navigationRevision = normalizeNavigationRevision(context);
        if (navigationRevision === null) {
            return this.getCandidateSnapshot();
        }
        if (this.navigationRevision === null) {
            this.navigationRevision = navigationRevision;
        }
        if (navigationRevision > this.navigationRevision) {
            // Более новая ревизия навигации ПЕРЕКАТЫВАЕТ состояние, а не игнорируется: раньше такой
            // батч терялся навсегда - без счётчика и без флага, - и вместе с пропущенным сбросом
            // (13.4) это давало тихую потерю новых данных, а не только устаревшие старые
            // (TASKS 13.5).
            this.activeByCategory = new Map();
            this.navigationRevision = navigationRevision;
            this.partial = false;
            this.revision += 1;
        } else if (navigationRevision < this.navigationRevision) {
            // Батч более старой навигации применять нельзя, но и молчать о нём нельзя.
            this.staleBatchesDropped += 1;
            return this.getCandidateSnapshot();
        }

        const source = Array.isArray(decisions) ? decisions : [];
        const nextByCategory = new Map(this.activeByCategory);
        let changed = false;
        let nextPartial = this.partial || context?.partial === true || source.length > MAX_DECISIONS_PER_BATCH;
        if (nextPartial !== this.partial) {
            changed = true;
        }

        for (const decision of source.slice(0, MAX_DECISIONS_PER_BATCH)) {
            if (!isValidDecision(decision)) {
                continue;
            }
            const current = nextByCategory.get(decision.category);
            const occurrenceCount = Math.min(
                MAX_OCCURRENCE_COUNT,
                (current?.occurrenceCount || 0) + 1
            );
            if (current?.occurrenceCount === occurrenceCount) {
                continue;
            }
            nextByCategory.set(decision.category, {
                key: createInternalKey(decision.category, navigationRevision),
                category: decision.category,
                occurrenceCount
            });
            changed = true;
        }

        if (changed) {
            this.activeByCategory = nextByCategory;
            this.partial = nextPartial;
            this.revision += 1;
        }
        return this.getCandidateSnapshot();
    }

    reset(context) {
        const navigationRevision = normalizeNavigationRevision(context);
        if (navigationRevision !== null) {
            this.navigationRevision = navigationRevision;
        }
        if (this.activeByCategory.size === 0 && this.partial === false) {
            return this.getCandidateSnapshot();
        }
        this.activeByCategory.clear();
        this.partial = false;
        this.revision += 1;
        return this.getCandidateSnapshot();
    }

    getCandidateSnapshot() {
        const candidates = CATEGORIES
            .map((category) => this.activeByCategory.get(category))
            .filter(Boolean)
            .map(freezeCandidate);
        return Object.freeze({
            schemaVersion: CANDIDATE_SCHEMA_VERSION,
            mode: CANDIDATE_MODE,
            revision: this.revision,
            partial: this.partial,
            candidates: Object.freeze(candidates)
        });
    }

    getProductSnapshot() {
        return Object.freeze({
            schemaVersion: CANDIDATE_SCHEMA_VERSION,
            mode: CANDIDATE_MODE,
            revision: this.revision,
            partial: this.partial,
            findings: Object.freeze([])
        });
    }
}

// Open findings API - the read-only channel through which a cooperating extension (typically an AI
// agent driving the browser) can ask PageCheck what it found on the page the user is looking at.
//
// Design constraints (TASKS C4.6 / C4.7), all of them load-bearing:
//  - EXTENSIONS ONLY. Page scripts must never reach this channel: if they could, the page under
//    analysis would learn our verdicts and could adapt its concealment or serve a clean version to
//    users who have the extension. Chrome already enforces this - with no `externally_connectable`
//    key declared, extensions may send messages and web pages may not - so the manifest stays
//    untouched and the remaining gates live here.
//  - READ ONLY, SEPARATE LISTENER. The internal `chrome.runtime.onMessage` switch in background.js
//    carries `saveConfig`, `toggleModule`, `apiPermission*` and `executeModuleAction`. Sharing that
//    switch with an external channel would hand config and permission control to any allowlisted
//    extension. Nothing here can write anything.
//  - FOREGROUND ONLY. Findings are served for the foreground tab of the focused window and nothing
//    else, so a caller cannot enumerate or poll other tabs. This also matches the runtime's existing
//    foreground-only scanning contract.
//  - UNIFORM REFUSAL. Every rejection returns the same shape and never says which gate closed:
//    a caller must not be able to probe whether the channel is on or who is allowlisted.
//  - NO DOM, NO RAW PAGE TEXT. Only the already-normalized snapshot fields leave the extension -
//    the same privacy contract the session cache follows. The finding-to-node map used by active
//    intervention (TASKS C4.3) must never be reachable from here.

// 2: добавлен блок `context` (automation / longTasks). Поле новое и необязательное, но версия
// поднята намеренно: подписчик обязан уметь отличить «контекста нет, потому что версия старая» от
// «контекста нет, потому что страница чистая».
export const FINDINGS_API_SCHEMA_VERSION = 2;

export const FINDINGS_API_ACTIONS = {
    HELLO: 'pagecheck.hello',
    GET_FINDINGS: 'pagecheck.getFindings'
};

const ALLOWED_ACTIONS = new Set(Object.values(FINDINGS_API_ACTIONS));

export const FINDINGS_API_RATE_LIMIT = {
    windowMs: 10000,
    maxRequests: 20
};

// Deliberately identical for every refusal reason. See "uniform refusal" above.
const REFUSAL = Object.freeze({ ok: false, error: 'unavailable' });

export function createRefusal() {
    return { ...REFUSAL };
}

// Sliding-window limiter keyed by sender extension id. `now` is injected so the limiter is testable
// without timers; the background passes Date.now.
export function createRateLimiter({ windowMs, maxRequests } = FINDINGS_API_RATE_LIMIT) {
    const hitsBySender = new Map();

    return {
        allow(senderId, now) {
            const windowStart = now - windowMs;
            const hits = (hitsBySender.get(senderId) || []).filter((timestamp) => timestamp > windowStart);

            if (hits.length >= maxRequests) {
                hitsBySender.set(senderId, hits);
                return false;
            }

            hits.push(now);
            hitsBySender.set(senderId, hits);

            // Bounded memory: an unbounded map keyed by caller id would be a slow leak in a service
            // worker that survives many callers.
            if (hitsBySender.size > 64) {
                for (const [key, timestamps] of hitsBySender) {
                    if (timestamps.every((timestamp) => timestamp <= windowStart)) {
                        hitsBySender.delete(key);
                    }
                }
            }
            return true;
        }
    };
}

export function isFindingsApiEnabled(config) {
    return config?.settings?.findingsApiEnabled === true;
}

export function isSenderAllowed(config, senderId) {
    if (typeof senderId !== 'string' || senderId.length === 0) {
        return false;
    }

    const allowlist = config?.settings?.findingsApiAllowedExtensionIds;
    return Array.isArray(allowlist) && allowlist.includes(senderId);
}

// origin + pathname only, matching what the session snapshot stores: query and fragment routinely
// carry identifiers and are none of a caller's business.
export function normalizePageIdentity(url) {
    if (typeof url !== 'string' || url.length === 0) {
        return null;
    }

    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return null;
        }
        return { origin: parsed.origin, pathname: parsed.pathname };
    } catch {
        return null;
    }
}

function normalizeSeverity(severity) {
    return ['low', 'medium', 'high', 'critical'].includes(severity) ? severity : 'medium';
}

function takeString(value, limit) {
    return typeof value === 'string' ? value.slice(0, limit) : '';
}

// The snapshot is already normalized and bounded by the background (10 findings per module, clipped
// strings). This re-shapes it into one flat list and re-clips defensively: the API surface must not
// depend on another component's limits staying what they are today.
export function serializeFindings(frameSnapshot) {
    const findings = [];
    const groups = [
        ['Hidden-Content-Visual-Manipulation', frameSnapshot?.visualFindings],
        ['Link-Domain-Security', frameSnapshot?.linkFindings],
        ['Trigger-Phrases', frameSnapshot?.triggerFindings],
        ['Prompt-Splitting', frameSnapshot?.promptSplittingFindings]
    ];

    for (const [moduleId, moduleFindings] of groups) {
        if (!Array.isArray(moduleFindings)) {
            continue;
        }

        for (const finding of moduleFindings.slice(0, 10)) {
            findings.push({
                module: moduleId,
                type: takeString(finding?.type, 96) || 'unknown',
                severity: normalizeSeverity(finding?.severity),
                summary: takeString(finding?.summary, 300),
                details: takeString(finding?.details, 600),
                detector: takeString(finding?.detector, 96) || 'unknown'
            });
        }
    }

    return findings;
}

// Контекст пересобирается здесь заново по тем же соображениям, что и findings: внешняя поверхность
// не имеет права зависеть от того, что лимиты соседнего компонента останутся сегодняшними.
export function serializeContext(context) {
    if (!context || typeof context !== 'object') {
        return null;
    }
    const count = (value) => (Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0);
    return {
        automation: context.automation === true,
        longTasksObserved: count(context.longTasksObserved),
        sliceBackoffSteps: count(context.sliceBackoffSteps),
        // Граница нашего знания, названная вслух. Подписчик, у которого доступ к дереву фреймов есть
        // (browser-агент), обязан знать, что наше «чисто» относится к главному документу, а не ко
        // всей странице. Молчание здесь было бы не экономией, а неверным утверждением об охвате.
        framesPresent: Math.min(count(context.framesPresent), 100),
        framesAnalyzed: Math.min(count(context.framesAnalyzed), 100),
        // Суммарный бюджет вкладки исчерпан - часть модулей не работала вовсе. Имена лежат в
        // `partialModules`, здесь сам факт: подписчик должен уметь отличить «чисто» от «не смотрели».
        scanBudgetExhausted: context.scanBudgetExhausted === true,
        lastScanActiveMs: Number.isFinite(context.lastScanActiveMs)
            ? Math.max(0, Math.round(context.lastScanActiveMs * 100) / 100)
            : 0
    };
}

function buildFindingsResponse(foreground, extensionVersion) {
    const page = normalizePageIdentity(foreground?.url);
    if (!page) {
        return createRefusal();
    }

    const frameSnapshot = foreground?.frameSnapshot || null;
    const findings = serializeFindings(frameSnapshot);
    const partialModules = Array.isArray(frameSnapshot?.partialModules)
        ? frameSnapshot.partialModules.filter((moduleId) => typeof moduleId === 'string').slice(0, 16)
        : [];

    return {
        ok: true,
        schemaVersion: FINDINGS_API_SCHEMA_VERSION,
        extensionVersion: takeString(extensionVersion, 32),
        page,
        status: foreground?.status === 'issues' ? 'issues' : 'clean',
        totalFindings: Number.isFinite(foreground?.totalFindings) ? Math.max(0, Math.trunc(foreground.totalFindings)) : 0,
        stale: foreground?.stale === true,
        partialModules,
        // C4: контекст, а не вердикт. Агент, который читает страницу, узнаёт от нас две вещи:
        // смотрит ли её автоматизированный браузер и отнимает ли она главный поток. Обе - факты о
        // среде, и ни одна не является указанием что-либо делать.
        context: serializeContext(frameSnapshot?.context),
        findings,
        updatedAt: Number.isFinite(foreground?.updatedAt) ? foreground.updatedAt : null
    };
}

// The whole external surface in one pure function: no chrome.* access, everything injected. That is
// what makes the gate order testable in Node (see findings-api.test.mjs).
//
// context: { config, extensionVersion, rateLimiter, now, getForegroundSnapshot }
//   getForegroundSnapshot() -> null, or
//     { tabId, url, status, totalFindings, stale, updatedAt, frameSnapshot }
export function handleFindingsApiRequest(request, sender, context) {
    // Gate 1: channel switched on by the user.
    if (!isFindingsApiEnabled(context?.config)) {
        return createRefusal();
    }

    // Gate 2: this specific extension allowlisted by the user.
    if (!isSenderAllowed(context?.config, sender?.id)) {
        return createRefusal();
    }

    // A message that carries a tab/frame context is coming from a page, not an extension background.
    // Chrome should not deliver such a message here at all; refuse loudly-quietly if it ever does.
    if (sender?.tab || sender?.url?.startsWith('http')) {
        return createRefusal();
    }

    // Gate 3: known read-only action.
    const action = typeof request?.action === 'string' ? request.action : '';
    if (!ALLOWED_ACTIONS.has(action)) {
        return createRefusal();
    }

    // Gate 4: rate limit.
    const now = Number.isFinite(context?.now) ? context.now : 0;
    if (context?.rateLimiter && !context.rateLimiter.allow(sender.id, now)) {
        return createRefusal();
    }

    if (action === FINDINGS_API_ACTIONS.HELLO) {
        return {
            ok: true,
            schemaVersion: FINDINGS_API_SCHEMA_VERSION,
            extensionVersion: takeString(context?.extensionVersion, 32),
            capabilities: [FINDINGS_API_ACTIONS.HELLO, FINDINGS_API_ACTIONS.GET_FINDINGS]
        };
    }

    const foreground = typeof context?.getForegroundSnapshot === 'function'
        ? context.getForegroundSnapshot()
        : null;
    if (!foreground) {
        return createRefusal();
    }

    // A caller may name a tab, but only the foreground one is ever served - naming any other tab is
    // refused rather than silently redirected, so the caller cannot use us to enumerate tabs.
    if (Object.hasOwn(request, 'tabId') && request.tabId !== foreground.tabId) {
        return createRefusal();
    }

    return buildFindingsResponse(foreground, context?.extensionVersion);
}

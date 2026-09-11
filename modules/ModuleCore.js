// modules/ModuleCore.js
import { Logger } from '../utils/logger.js';

// LOOP-SAFETY (C4, core-first prerequisite). Правки, которые расширение вносит в страницу
// (reveal / neutralize / annotate), не должны триггерить рескан и попадать в findings: иначе
// вмешательство порождает мутацию, мутация порождает находку, находка порождает вмешательство.
//
// Реестр общий на весь content-скрипт, а не на экземпляр модуля: правка слоя вмешательства обязана
// быть невидимой для ВСЕХ детекторов, а не для того, кто первым про неё узнал. WeakSet и WeakMap -
// потому что реестр не имеет права удерживать узлы страницы в памяти.
//
// Два разных вопроса, и путать их нельзя:
//  1. «Этот УЗЕЛ наш» - узлы, которые вставили мы (метки annotate). WeakSet, ответ навсегда.
//  2. «Эта ПРАВКА наша» - атрибут чужого узла, который изменили мы (inline-стиль reveal). Ответ
//     одноразовый: страница может выставить тот же атрибут следом, и это уже её действие, а не наше.
//     Поэтому ожидания хранятся счётчиком и ПОГАШАЮТСЯ первой же подходящей записью.
const extensionOwnedNodes = new WeakSet();
const expectedAttributeChanges = new WeakMap();

export function markExtensionOwnedNode(node) {
    if (node && typeof node === 'object') {
        extensionOwnedNodes.add(node);
    }
    return node;
}

export function isExtensionOwnedNode(node) {
    return Boolean(node) && typeof node === 'object' && extensionOwnedNodes.has(node);
}

// Зовётся слоем вмешательства ПЕРЕД записью атрибута. Одно ожидание - одна будущая запись
// наблюдателя; лишних ожиданий не накапливается, потому что запись их гасит.
export function expectExtensionAttributeChange(node, attributeName) {
    if (!node || typeof node !== 'object' || typeof attributeName !== 'string') {
        return;
    }
    const byAttribute = expectedAttributeChanges.get(node) || new Map();
    byAttribute.set(attributeName, (byAttribute.get(attributeName) || 0) + 1);
    expectedAttributeChanges.set(node, byAttribute);
}

// Одноразовое ожидание на СТРУКТУРНУЮ правку чужого узла: neutralize удаляет узел страницы, а
// потом откат возвращает его на место. Пометить такой узел «нашим» навсегда нельзя - это контент
// страницы, и после отката детекторы обязаны видеть его снова. Поэтому ожидание, как у атрибутов:
// одно действие - одна запись наблюдателя, гасится первой подходящей.
const expectedNodeMutations = new WeakMap();

export function expectExtensionNodeMutation(node) {
    if (!node || typeof node !== 'object') {
        return;
    }
    expectedNodeMutations.set(node, (expectedNodeMutations.get(node) || 0) + 1);
}

function consumeExpectedNodeMutation(node) {
    const pending = expectedNodeMutations.get(node);
    if (!pending) {
        return false;
    }
    if (pending === 1) {
        expectedNodeMutations.delete(node);
    } else {
        expectedNodeMutations.set(node, pending - 1);
    }
    return true;
}

function consumeExpectedAttributeChange(node, attributeName) {
    const byAttribute = expectedAttributeChanges.get(node);
    const pending = byAttribute?.get(attributeName);
    if (!pending) {
        return false;
    }
    if (pending === 1) {
        byAttribute.delete(attributeName);
    } else {
        byAttribute.set(attributeName, pending - 1);
    }
    return true;
}

// «Эта запись наблюдателя описывает нашу собственную правку?»
// childList засчитывается своим, только если СВОИ ВСЕ добавленные и удалённые узлы: страница могла
// вставить своё в том же батче, и терять это нельзя.
export function isExtensionOwnedMutation(mutation) {
    if (!mutation) {
        return false;
    }

    if (mutation.type === 'attributes') {
        return consumeExpectedAttributeChange(mutation.target, mutation.attributeName);
    }

    if (mutation.type === 'characterData') {
        return isExtensionOwnedNode(mutation.target) || isExtensionOwnedNode(mutation.target?.parentElement);
    }

    if (mutation.type !== 'childList') {
        return false;
    }

    const added = mutation.addedNodes || [];
    const removed = mutation.removedNodes || [];
    if (added.length === 0 && removed.length === 0) {
        return false;
    }
    // Узел засчитывается своим либо навсегда (наша метка), либо ОДИН раз (структурная правка,
    // которую мы только что внесли в чужой узел). Второй случай гасится здесь же.
    for (const node of added) {
        if (!isExtensionOwnedNode(node) && !consumeExpectedNodeMutation(node)) {
            return false;
        }
    }
    for (const node of removed) {
        if (!isExtensionOwnedNode(node) && !consumeExpectedNodeMutation(node)) {
            return false;
        }
    }
    return true;
}

export default class ModuleCore {
    constructor(moduleName, defaultEnabled = true) {
        this.moduleName = moduleName;
        this.isEnabled = defaultEnabled;
        // Paused is not the same as disabled: a paused module is one the runtime intends to bring
        // back, and it may keep its results. Both states stop work through `isEnabled`.
        this.isPaused = false;
        // Opt-in, and false by default on purpose. Only a module that overrides onPause() to keep
        // its findings may be resumed without a rescan; for everyone else the runtime rescans, which
        // is exactly what happened before pause existed. So migrating modules is one at a time and a
        // forgotten module is slow, never wrong.
        this.keepsStateWhilePaused = false;
        this.observer = null;
        this.usesMutationObserver = false;
        this.isInitialized = false;
        this.lifecycleRevision = 0;
        this.initializationPromise = null;
        this.config = {};
        // `elementsScanned` means DOM ELEMENTS VISITED BY THE TRAVERSAL, not units of work analysed
        // (C7.1 in the root TASKS). Four of the five modules already meant that; link-domain-security
        // counted candidates instead, so one number in a shared object meant two different things and
        // an outside reader had no way to know which. A module that also wants to report units of
        // work exposes its own honestly named counter (`candidatesAnalyzed`) from getStats().
        this.stats = {
            elementsScanned: 0,
            threatsDetected: 0,
            lastScanTime: 0,
            totalScanTime: 0
        };
        // АКТИВНЫЙ НАБОР НАХОДОК (Б1, 2026-09-11). Бейдж обязан означать «проблемы, которые сейчас
        // на странице», а модули с дедупликацией по содержимому (visual, link) считали всё, что
        // видели с последнего полного скана: удалённый узел оставался находкой до перезагрузки.
        // Здесь - общая часть: к ключу принятой находки привязываются узлы, на которых она есть
        // (включая повторы после перерисовки SPA), и находка снимается, когда ни одного из них не
        // осталось в документе. Свои счётчики и списки модуль правит в pruneDetachedFindings().
        // Узлы держатся через WeakRef: снятый со страницы узел не должен жить из-за нас до
        // следующего снапшота.
        this.findingAnchors = new Map();
        this.maxAnchorsPerFinding = 8;
        this.lastAnnouncedFindingCount = 0;
        this.lastMutationTime = 0;
        this.mutationThrottle = 100; // ms
        // TIME-SLICING (C2). Скан идёт в main-thread СТРАНИЦЫ пользователя, поэтому «уложиться в
        // бюджет» и «не подвесить страницу» - разные требования: 90 мс работы внутри бюджета всё
        // равно один длинный таск и заметный джанк. Потолок одного СИНХРОННОГО куска держится
        // отдельно от общего бюджета скана.
        this.maxSliceMs = 16;
        this.currentSliceDeadline = Number.POSITIVE_INFINITY;
        this.currentSliceStartedAt = null;
        // Бюджет скана считается по АКТИВНОЙ работе, а не по стенным часам: иначе уступки
        // event-loop съедали бы бюджет, и слайсинг сам себя выключал бы на первой же паузе.
        this.currentScanActiveMs = 0;
        this.sliceYields = 0;
        this.maximumSliceMs = 0;
        // Scan-exclusion state (C5.1 in the root TASKS).
        this.activeScanToken = null;
        this.scanSequence = 0;
        this.rescanRequested = false;
        this.pendingScanRequest = null;
        this.scanReentryBlocked = 0;
        // C4.3: потребитель пары «находка + узел». Ставится content-скриптом и только при
        // открытом гейте вмешательства; по умолчанию его нет, и детектор ничего никуда не отдаёт.
        this.findingNodeSink = null;
        // Сколько записей наблюдателя описывали наши собственные правки (C4). Ноль на обычной
        // странице; растёт только когда работает слой вмешательства.
        this.ownMutationsIgnored = 0;
        // Error accounting for the three-level policy below (C5.6 in the root TASKS).
        this.unitErrorCount = 0;
        this.scanFailed = false;
        this.lastErrorContext = '';
        this.loggedUnitErrorContexts = new Set();
        this.observerConfig = {
            childList: true,
            subtree: true,
            attributes: false,
            characterData: false,
            attributeOldValue: false,
            characterDataOldValue: false
        };
    }

    // SCAN EXCLUSION (C5.1 in the root TASKS). A module runs ONE analysis pass at a time.
    // Why revisions are not enough: a module's own setTimeout pipeline calls into the scan without
    // going through the content-script queue in js/content.js, and two passes of the SAME
    // configuration carry the same configRevision and lifecycleRevision - so the usual
    // isScanConfigurationCurrent() check says "current" to both and cancels neither. They then
    // overwrite each other's scan state, findings and telemetry.
    // The gate is here rather than in js/content.js on purpose: the queue is an internal detail of
    // the content script, modules must not know about it, and it does not cover calls arriving from
    // the background path.
    // A blocked caller does not queue up: it raises a single deferred rerun, so work that arrived
    // during a pass is not lost and the queue cannot grow. At most one rerun per guarded call - if
    // more work keeps arriving, the module's own scheduler picks it up.
    async runGuardedScan(reason, operation) {
        if (this.activeScanToken) {
            this.scanReentryBlocked += 1;
            this.rescanRequested = true;
            // The deferred rerun runs what the BLOCKED caller asked for, not what the running pass
            // was doing: an explicit scan requested during a mutation batch must not be silently
            // replaced by one more mutation batch. Last request wins - they are all "analyse the
            // page as it is now".
            this.pendingScanRequest = { reason, operation };
            Logger.debug(`[${this.moduleName}] Scan pass "${reason}" deferred: another pass is running`);
            return { skipped: true, reason: 'scan-in-progress', result: null };
        }

        let result = null;
        let passes = 0;
        let nextReason = reason;
        let nextOperation = operation;
        try {
            do {
                this.rescanRequested = false;
                this.pendingScanRequest = null;
                passes += 1;
                const token = {
                    id: (this.scanSequence += 1),
                    reason: nextReason,
                    lifecycleRevision: this.lifecycleRevision
                };
                this.activeScanToken = token;
                try {
                    result = await nextOperation(token);
                } finally {
                    if (this.activeScanToken === token) {
                        this.activeScanToken = null;
                    }
                }

                if (!this.isEnabled || token.lifecycleRevision !== this.lifecycleRevision) {
                    break;
                }

                if (this.rescanRequested && this.pendingScanRequest) {
                    nextReason = this.pendingScanRequest.reason;
                    nextOperation = this.pendingScanRequest.operation;
                }
            } while (this.rescanRequested && passes < 2);
        } finally {
            this.rescanRequested = false;
            this.pendingScanRequest = null;
        }

        return { skipped: false, reason, result };
    }

    // The explicit-scan preamble every module needs, in one place (C7.3 in the root TASKS).
    // Five modules had copied the same line, and when link-domain-security 7.15 wrapped it in the
    // level-2 handler the copies drifted: four modules still let the exception escape, and the
    // caller in js/content.js runs performScan inside a try/finally WITHOUT a catch - so one
    // module's bad page aborted the scan response for all of them.
    // The snapshot itself stays with the module: its shape is the module's own business, only the
    // gate and the error level are shared.
    async runExplicitScan() {
        try {
            // Through the gate: an explicit scan must not run on top of a mutation pass (C5.1).
            await this.runGuardedScan('perform-scan', () => this.firstScan());
        } catch (error) {
            // Level 2 (C5.6), the same level ModuleCore.init() already applies to this exception.
            // The module stays alive and reports incomplete coverage instead of vanishing.
            this.recordScanFailure('perform-scan', error);
        }
    }

    // Начало синхронного куска работы. Зовётся на входе в скан и после каждой уступки.
    beginWorkSlice() {
        this.currentSliceStartedAt = performance.now();
        this.currentSliceDeadline = this.currentSliceStartedAt + this.maxSliceMs;
    }

    // Дошли ли до потолка синхронного куска. Дешёвая проверка: одно чтение часов.
    shouldYieldSlice() {
        return this.currentSliceStartedAt !== null && performance.now() >= this.currentSliceDeadline;
    }

    // Закрыть кусок, не уступая: нужно в конце скана, чтобы активное время досчиталось.
    finishWorkSlice() {
        if (this.currentSliceStartedAt === null) {
            return 0;
        }
        const sliceMs = Math.max(0, performance.now() - this.currentSliceStartedAt);
        this.currentScanActiveMs += sliceMs;
        this.maximumSliceMs = Math.max(this.maximumSliceMs, sliceMs);
        this.currentSliceStartedAt = null;
        this.currentSliceDeadline = Number.POSITIVE_INFINITY;
        return sliceMs;
    }

    // Уступить event-loop и начать новый кусок. Порядок предпочтений - от точного к переносимому:
    // scheduler.postTask('user-visible') планирует продолжение как задачу с приоритетом, а не как
    // «когда-нибудь»; requestIdleCallback с таймаутом не даст задаче зависнуть на занятой странице;
    // setTimeout(0) работает везде и в тестовом стенде.
    // ВАЖНО: страница между кусками может измениться. Всё, что кэшировано в предположении
    // «DOM статичен», действительно только внутри куска - инвариант держится per-slice, не
    // per-scan (C2, связано с visual-manipulation 6.1).
    async yieldSlice() {
        this.finishWorkSlice();
        this.sliceYields += 1;
        await this.scheduleSliceContinuation();
        // Всё, что кэшировано в предположении «DOM статичен», действительно только внутри куска.
        // Модуль сбрасывает такие кэши здесь - один раз на уступку, а не после каждого элемента.
        this.onSliceYield();
        this.beginWorkSlice();
    }

    // Переопределяется модулем, у которого есть scan-local кэш, зависящий от DOM (стили, rect'ы,
    // геометрия). Умолчание пустое: у модуля без такого кэша сбрасывать нечего.
    onSliceYield() {
    }

    scheduleSliceContinuation() {
        return new Promise((resolve) => {
            const scheduler = globalThis.scheduler;
            if (scheduler && typeof scheduler.postTask === 'function') {
                scheduler.postTask(resolve, { priority: 'user-visible' });
                return;
            }
            if (typeof globalThis.requestIdleCallback === 'function') {
                globalThis.requestIdleCallback(() => resolve(), { timeout: 50 });
                return;
            }
            setTimeout(resolve, 0);
        });
    }

    // Активное время скана - то, что тратится на работу, без уступок. Именно оно сравнивается с
    // бюджетом скана.
    getScanActiveMs() {
        const openSliceMs = this.currentSliceStartedAt === null
            ? 0
            : Math.max(0, performance.now() - this.currentSliceStartedAt);
        return this.currentScanActiveMs + openSliceMs;
    }

    resetSliceAccounting() {
        this.currentScanActiveMs = 0;
        this.sliceYields = 0;
        this.maximumSliceMs = 0;
        this.currentSliceStartedAt = null;
        this.currentSliceDeadline = Number.POSITIVE_INFINITY;
    }

    // "Is this still MY pass" - a question configuration revisions cannot answer, because two
    // passes of one configuration share every revision they carry.
    isScanTokenCurrent(token) {
        return Boolean(token)
            && this.activeScanToken === token
            && this.isEnabled
            && token.lifecycleRevision === this.lifecycleRevision;
    }

    isScanPassActive() {
        return this.activeScanToken !== null;
    }

    // ERROR POLICY (C5.6 in the root TASKS). Three levels, and every one of them has to be
    // distinguishable from the outside, because the observable result of all three is the same:
    // "the module shows nothing".
    //  1. Unit of work (one candidate, element, rule): caught here, counted as a SKIPPED unit via
    //     recordUnitError(), which makes the scan report incomplete coverage. The scan continues.
    //  2. Scan: caught by the caller, recorded with recordScanFailure(). The module stays ALIVE and
    //     the next scan may succeed - one bad page must not disable the module.
    //  3. Fatal for the module: only a failed initialization (beforeInit, observer setup,
    //     afterInit). Only this level destroys the module.
    // The hard rule behind all three: "it broke" must never look like "it is clean".
    resetErrorState() {
        this.unitErrorCount = 0;
        this.scanFailed = false;
        this.lastErrorContext = '';
        this.loggedUnitErrorContexts.clear();
    }

    // One unit of work failed. Rate-limited by context so a systematically broken page cannot turn
    // the log into the payload.
    recordUnitError(context, error = null) {
        this.unitErrorCount += 1;
        this.lastErrorContext = String(context || 'unit');
        if (!this.loggedUnitErrorContexts.has(this.lastErrorContext)) {
            this.loggedUnitErrorContexts.add(this.lastErrorContext);
            Logger.warn(`[${this.moduleName}] Unit skipped after an internal error (${this.lastErrorContext})`, error || '');
        }
        return this.unitErrorCount;
    }

    // The scan itself failed. Not fatal: the module keeps its observer and its next chance.
    recordScanFailure(context, error = null) {
        this.scanFailed = true;
        this.lastErrorContext = String(context || 'scan');
        Logger.error(`[${this.moduleName}] Scan failed (${this.lastErrorContext}):`, error || '');
    }

    // Инициализация модуля
    async init() {
        if (!this.isEnabled) {
            Logger.debug(`[${this.moduleName}] Module disabled, skipping initialization`);
            return false;
        }

        if (this.initializationPromise) {
            return this.initializationPromise;
        }

        const lifecycleRevision = ++this.lifecycleRevision;
        this.isInitialized = false;
        const initializationPromise = (async () => {
            try {
                Logger.info(`[${this.moduleName}] Initializing module`);

                await this.beforeInit();
                if (!this.isEnabled || lifecycleRevision !== this.lifecycleRevision) {
                    return false;
                }

                if (this.usesMutationObserver) {
                    this.setupMutationObserver();
                }

                // A failed first scan is a level 2 event: the page could not be analysed, the
                // module is fine. Before C5.6 the exception fell through to the catch below and
                // destroy() took the module down for the whole page - one bad element disabled
                // every detect the module has.
                this.resetErrorState();
                try {
                    await this.runGuardedScan('init', () => this.firstScan());
                } catch (scanError) {
                    this.recordScanFailure('first-scan', scanError);
                }
                if (!this.isEnabled || lifecycleRevision !== this.lifecycleRevision) {
                    return false;
                }

                await this.afterInit();
                if (!this.isEnabled || lifecycleRevision !== this.lifecycleRevision) {
                    return false;
                }

                this.isInitialized = true;
                Logger.info(`[${this.moduleName}] Module initialized successfully`);
                return true;

            } catch (error) {
                Logger.error(`[${this.moduleName}] Failed to initialize:`, error);
                if (lifecycleRevision === this.lifecycleRevision) {
                    this.destroy();
                }
                return false;
            }
        })();

        this.initializationPromise = initializationPromise;

        try {
            return await initializationPromise;
        } finally {
            if (this.initializationPromise === initializationPromise) {
                this.initializationPromise = null;
            }
        }
    }

    // Хук перед инициализацией
    async beforeInit() {
        // Переопределить в дочерних классах
    }

    // Хук после инициализации
    async afterInit() {
        // Переопределить в дочерних классах
    }

    // One teardown, one behaviour (C1, разбор 2026-09-09). The same three lines stood in
    // setupMutationObserver, pause and destroy, and a fourth site disconnected without dropping the
    // reference - four spellings of one operation is how they start to disagree.
    // takeRecords() before disconnect() is defensive, not semantic: disconnect() empties the record
    // queue by itself. It stays so that the intent - no queued record survives a teardown - is
    // readable at the single place that performs it.
    teardownObserver() {
        if (!this.observer) {
            return;
        }
        this.observer.takeRecords();
        this.observer.disconnect();
        this.observer = null;
    }

    // Настройка наблюдателя за DOM
    setupMutationObserver() {
        try {
            if (!this.usesMutationObserver) {
                this.teardownObserver();
                Logger.debug(`[${this.moduleName}] MutationObserver skipped: explicit opt-in is required`);
                return;
            }

            this.teardownObserver();
            this.observer = new MutationObserver(this.handleMutations.bind(this));
            this.observer.observe(document.documentElement, this.observerConfig);

            Logger.debug(`[${this.moduleName}] MutationObserver setup completed`);

        } catch (error) {
            Logger.error(`[${this.moduleName}] Failed to setup MutationObserver:`, error);
        }
    }

    // Loop-safety (C4): первая строка любого конвейера мутаций. Записи, описывающие наши
    // собственные правки, отбрасываются здесь - до бюджетов, очередей и счётчиков, чтобы правка
    // расширения не выглядела для модуля работой страницы.
    filterForeignMutations(mutations) {
        if (!mutations || mutations.length === 0) {
            return mutations || [];
        }
        const foreign = [];
        for (const mutation of mutations) {
            if (!isExtensionOwnedMutation(mutation)) {
                foreign.push(mutation);
            } else {
                this.ownMutationsIgnored += 1;
            }
        }
        return foreign;
    }

    // C4.3: публикация «находка + узел» для слоя вмешательства. Детектор остаётся пассивным -
    // он ОТДАЁТ, а не действует; решает и пишет в DOM слой на content-стороне.
    // Ссылка на узел не сохраняется здесь ни на мгновение: при закрытом гейте sink не установлен, и
    // вызов стоит одну проверку.
    emitFindingNode(finding, node) {
        const sink = this.findingNodeSink;
        if (typeof sink !== 'function' || !finding || !node) {
            return;
        }
        try {
            sink(finding, node, this.moduleName);
        } catch (error) {
            // Уровень 1 (C5.6): сбой потребителя не имеет права стоить находки.
            this.recordUnitError('finding-node-sink', error);
        }
    }

    // Loop-safety (C4): узел, вставленный расширением, не может быть кандидатом - иначе наша
    // собственная метка станет находкой, а находка - поводом для следующей метки.
    isExtensionOwnedElement(element) {
        return isExtensionOwnedNode(element);
    }

    // Обработка мутаций по умолчанию отключена
    handleMutations(mutations) {
        // Safe default: subclasses must provide their own bounded mutation pipeline.
    }

    // Проверка релевантности мутации
    isRelevantMutation(mutation) {
        return false;
    }

    // Хук после обработки мутаций
    onMutationsProcessed(mutations) {
        // Переопределить в дочерних классах
        Logger.debug(`[${this.moduleName}] Processed ${mutations.length} mutations`);
    }

    // Первичное сканирование по умолчанию отключено
    async firstScan() {
        Logger.debug(`[${this.moduleName}] Initial scan skipped: subclass must provide a bounded implementation`);
    }

    // Не хук: ядро НИКОГДА не вызывает scanElement и isRelevantMutation сам - оба потребителя
    // (api-interception, link-domain-security; visual-manipulation для isRelevantMutation)
    // переопределяют их и зовут свои. Это безопасные умолчания, и в этом их смысл: наследник,
    // забывший реализовать обход, молча ничего не делает вместо падения (уровень 1 вместо 3).
    // Разбор 2026-09-07 (C1): удалять их не следует именно поэтому.
    scanElement(element) {
        // Safe default: subclasses decide what constitutes a bounded scan unit.
    }

    // PAUSE (C1 / C2). A background tab must stop working, and until now that was done by
    // destroy() - which also throws away everything the module had found. The cost is not the
    // teardown, it is the return: coming back re-runs init() + firstScan() from scratch. Measured on
    // the stand (`.agents/harness/run-tab-switching.mjs`): on a 1263-element page nine of ten
    // switches produced not one new finding and cost 1044 `matches` and 2183 clock reads each - for
    // ONE module out of five.
    //
    // Two properties make this safe rather than a hole in the foreground-only contract:
    //  1. `isEnabled = false` is what stops the work. Every guard in every module already checks it,
    //     so pausing adds no new "may I work" logic that could be forgotten somewhere.
    //  2. `onPause()` defaults to `onDestroy()`. A module that does not override it behaves exactly
    //     as it did before, so keeping state is opt-in per module and never accidental.
    // The lifecycle revision is bumped for the same reason destroy() bumps it: an async pass that
    // was already in flight must not publish anything after the pause.
    pause() {
        if (!this.isEnabled && !this.isPaused) {
            return;
        }

        this.lifecycleRevision += 1;
        this.isEnabled = false;
        this.isPaused = true;
        this.rescanRequested = false;
        this.pendingScanRequest = null;

        try {
            this.teardownObserver();

            this.onPause();
            Logger.debug(`[${this.moduleName}] Module paused`);
        } catch (error) {
            Logger.error(`[${this.moduleName}] Error during pause:`, error);
        }
    }

    // What pause() stops. The default is the full teardown, i.e. exactly what a paused module did
    // before this hook existed. A module overrides it to keep its findings across a pause - and only
    // then does skipping the rescan on resume become correct for it.
    onPause() {
        this.onDestroy();
    }

    // Resume from pause. `rescan: false` is allowed ONLY when the caller can show the page did not
    // change while the module was paused (js/content.js owns that signal, because it is one question
    // about the document rather than five about the modules). When in doubt, rescan: a wasted scan
    // costs work, a skipped one costs a detection.
    async resume({ rescan = true } = {}) {
        if (this.isEnabled) {
            return true;
        }

        const lifecycleRevision = ++this.lifecycleRevision;
        this.isEnabled = true;
        this.isPaused = false;

        if (this.usesMutationObserver) {
            this.setupMutationObserver();
        }

        if (!rescan) {
            this.isInitialized = true;
            Logger.debug(`[${this.moduleName}] Module resumed without a rescan`);
            return true;
        }

        this.resetErrorState();
        try {
            await this.runGuardedScan('resume', () => this.firstScan());
        } catch (error) {
            // Level 2 (C5.6): the same treatment init() gives this exception.
            this.recordScanFailure('resume-scan', error);
        }

        if (!this.isEnabled || lifecycleRevision !== this.lifecycleRevision) {
            return false;
        }

        this.isInitialized = true;
        return true;
    }

    // Остановка модуля
    destroy() {
        this.lifecycleRevision += 1;
        this.isEnabled = false;
        this.isPaused = false;
        this.isInitialized = false;
        // The deferred request holds a closure over the module's scan state; a destroyed module must
        // not keep it alive (C5.1).
        this.rescanRequested = false;
        this.pendingScanRequest = null;

        try {
            this.teardownObserver();

            this.onDestroy();
            Logger.info(`[${this.moduleName}] Module destroyed`);

        } catch (error) {
            Logger.error(`[${this.moduleName}] Error during destruction:`, error);
        }
    }

    // Хук при уничтожении модуля
    onDestroy() {
        // Переопределить в дочерних классах для cleanup
    }

    // Обновление конфигурации
    updateConfig(newConfig) {
        const oldConfig = { ...this.config };
        this.config = { ...this.config, ...newConfig };

        Logger.debug(`[${this.moduleName}] Config updated`, {
            changedFields: [...new Set([
                ...Object.keys(oldConfig),
                ...Object.keys(this.config)
            ])].sort()
        });

        const updateResult = this.onConfigUpdate(oldConfig, this.config);

        // Отправляем событие о изменении конфигурации
        this.dispatchEvent('configUpdated', {
            module: this.moduleName,
            config: this.config
        });

        return updateResult && typeof updateResult === 'object'
            ? updateResult
            : { requiresDetectionRefresh: false };
    }

    // Хук при обновлении конфигурации
    onConfigUpdate(oldConfig, newConfig) {
        // May return { requiresDetectionRefresh: boolean } for the content lifecycle.
    }

    // ФОРМА СНАПШОТА (C1). Одно место собирает её для всех - и для `performScan()`, и для
    // `buildCurrentScanResponse()` в js/content.js, который раньше собирал ту же форму ЗАНОВО из
    // getStats() и recentFindings, и собирал иначе: свой предел findings (жёсткие 10 против
    // maxSerializedFindings), угадывание числа находок по цепочке имён полей, отсутствие полей
    // getSnapshotState() и захардкоженный по ID модуля особый случай для trigger-phrases. Popup
    // получал разный снапшот одного состояния в зависимости от того, каким путём он построен.
    // Модуль отдаёт СОДЕРЖИМОЕ через хуки ниже и никогда не описывает форму.
    // Снапшот только читает состояние: он не сканирует и вызывается в том числе на паузе.
    buildScanSnapshot() {
        // Находки, чьи узлы ушли со страницы, снимаются до того, как их посчитают (Б1). Это не скан:
        // проверяется только isConnected у уже известных узлов, поэтому и на паузе это законно.
        this.pruneDetachedFindings();
        const snapshotState = this.getSnapshotState();
        const serialized = this.getSerializedFindings();
        const findingCount = this.getFindingCount();
        // Опубликованное число - точка отсчёта для announceFindingCount(): сообщать есть смысл
        // только о расхождении с тем, что рантайм уже видел.
        this.lastAnnouncedFindingCount = findingCount;
        return {
            module: this.moduleName,
            threatsDetected: findingCount,
            findings: serialized.findings,
            findingsTruncated: serialized.findingsTruncated,
            revision: serialized.revision,
            ...snapshotState,
            // Содержимое сериализации перекрывает состояние снапшота, а не наоборот: у
            // trigger-phrases признак неполноты живёт именно в сериализации findings.
            ...(serialized.extra || {}),
            // link-domain-security считает часть stats из того же snapshotState (его 7.18): передаём
            // уже посчитанный, чтобы он не выводился второй раз. Кто аргумент не ждёт - не заметит.
            stats: this.getStats(snapshotState)
        };
    }

    // Хуки содержимого снапшота. Умолчания описывают четыре модуля из пяти.
    getSnapshotState() {
        return { partialResult: Boolean(this.partialResult) };
    }

    getFindingCount() {
        return Math.max(0, Math.trunc(Number(this.stats?.threatsDetected) || 0));
    }

    getSerializedFindings() {
        const limit = Number.isFinite(this.maxSerializedFindings) ? this.maxSerializedFindings : 10;
        const recorded = Array.isArray(this.recentFindings) ? this.recentFindings : [];
        return {
            findings: recorded.slice(0, limit),
            findingsTruncated: recorded.length > limit,
            revision: Math.max(0, Math.trunc(Number(this.scanRevision) || 0)),
            extra: null
        };
    }

    // --- Активный набор находок (Б1) ---------------------------------------------------------------
    // Пользуются visual-manipulation и link-domain-security. trigger-phrases и prompt-splitting ведут
    // активный набор сами и эти методы не зовут; для них pruneDetachedFindings() - пустое умолчание.

    // `isNewFinding`: находка только что принята и посчитана. Повтор уже известной находки (тот же
    // ключ на новом узле после перерисовки) дописывает узел, но не заводит запись: ключ без записи -
    // находка, которую модуль не прибавлял, и вычитать её из счётчика нельзя.
    anchorFinding(key, element, isNewFinding) {
        if (typeof key !== 'string' || !key || !(element instanceof Element)) {
            return;
        }
        let anchors = this.findingAnchors.get(key);
        if (!anchors) {
            if (!isNewFinding) {
                return;
            }
            anchors = [];
            this.findingAnchors.set(key, anchors);
        }
        if (anchors.length >= this.maxAnchorsPerFinding
            || anchors.some((anchor) => this.derefFindingAnchor(anchor) === element)) {
            return;
        }
        anchors.push(typeof WeakRef === 'function' ? new WeakRef(element) : element);
    }

    derefFindingAnchor(anchor) {
        return typeof anchor?.deref === 'function' ? anchor.deref() : anchor;
    }

    // Ключи находок, у которых не осталось ни одного узла в документе. Только чтение isConnected у
    // уже известных узлов - обхода DOM здесь нет. Узел, про который неизвестно, подключён ли он
    // (заглушка без isConnected), считается живым: неизвестность - не повод снимать находку.
    collectDetachedFindingKeys() {
        const detached = [];
        for (const [key, anchors] of this.findingAnchors) {
            const live = anchors.filter((anchor) => {
                const element = this.derefFindingAnchor(anchor);
                return element !== undefined && element.isConnected !== false;
            });
            if (live.length === 0) {
                this.findingAnchors.delete(key);
                detached.push(key);
            } else if (live.length !== anchors.length) {
                this.findingAnchors.set(key, live);
            }
        }
        return detached;
    }

    // Хук: снять находки ушедших узлов и поправить свои счётчики и списки. Возвращает число снятых.
    pruneDetachedFindings() {
        return 0;
    }

    // Сообщить рантайму, что число находок разошлось с опубликованным, - так бейдж следует за
    // страницей. Только при расхождении: большинство батчей мутаций находок не меняет.
    announceFindingCount() {
        const count = this.getFindingCount();
        if (count === this.lastAnnouncedFindingCount) {
            return;
        }
        this.lastAnnouncedFindingCount = count;
        this.dispatchEvent('findingStateChanged', { count });
    }

    // Конец батча мутаций: снять ушедшее, сообщить об изменении.
    settleFindingCount() {
        this.pruneDetachedFindings();
        this.announceFindingCount();
    }

    // Получение статистики
    getStats() {
        return {
            ...this.stats,
            module: this.moduleName,
            enabled: this.isEnabled,
            config: this.config,
            // "It broke" must be readable from the outside, not inferred from an empty finding list.
            scanFailed: this.scanFailed,
            unitErrorCount: this.unitErrorCount,
            lastErrorContext: this.lastErrorContext,
            // A race that is never observed is a race that is never fixed.
            scanReentryBlocked: this.scanReentryBlocked,
            // Loop-safety: сколько наших собственных правок конвейер мутаций отбросил (C4).
            ownMutationsIgnored: this.ownMutationsIgnored
        };
    }

    // Сброс статистики
    resetStats() {
        this.stats = {
            elementsScanned: 0,
            threatsDetected: 0,
            lastScanTime: 0,
            totalScanTime: 0
        };
        Logger.debug(`[${this.moduleName}] Statistics reset`);
    }

    // Система событий для межмодульного взаимодействия. Одно живое событие и один слушатель
    // (C1, разбор 2026-09-07): `findingStateChanged` шлёт prompt-splitting, а с Б1 (2026-09-11) ещё
    // visual-manipulation и link-domain-security через announceFindingCount(); js/content.js слушает. `off()` был удалён вместе с остальной мёртвой поверхностью - подписчик снимается
    // вместе с модулем; если понадобится отписка, её вернуть проще, чем объяснять мёртвый метод.
    eventHandlers = new Map();

    // Подписка на события
    on(eventName, handler) {
        if (!this.eventHandlers.has(eventName)) {
            this.eventHandlers.set(eventName, new Set());
        }
        this.eventHandlers.get(eventName).add(handler);
    }

    // Отправка события
    dispatchEvent(eventName, data) {
        if (this.eventHandlers.has(eventName)) {
            this.eventHandlers.get(eventName).forEach(handler => {
                try {
                    handler(data);
                } catch (error) {
                    Logger.error(`[${this.moduleName}] Error in event handler for ${eventName}:`, error);
                }
            });
        }
    }

    // Проверка, активен ли модуль
    isActive() {
        return this.isEnabled
            && this.isInitialized
            && (!this.usesMutationObserver || this.observer !== null);
    }
}

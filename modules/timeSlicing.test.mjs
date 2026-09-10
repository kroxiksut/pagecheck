// Щит для C2 (time-slicing) в корневом TASKS.
// Скан идёт в main-thread СТРАНИЦЫ пользователя, поэтому «уложиться в бюджет» и «не подвесить
// страницу» - разные требования: 90 мс работы внутри бюджета всё равно один длинный таск и
// заметный джанк. Потолок одного СИНХРОННОГО куска живёт отдельно от бюджета скана, а сам бюджет
// с появлением уступок обязан считаться по активной работе - иначе первая же уступка съедала бы его
// стенными часами, и слайсинг выключал бы сам себя.
// Проверяется на настоящем link-domain-security: первый переведённый модуль.
// Запуск: node modules/timeSlicing.test.mjs

import assert from 'node:assert/strict';

// --- часы под управлением теста -----------------------------------------------------------------
// Каждое обращение двигает время на шаг: так обход гарантированно упирается в потолок куска, а
// стенд не зависит от реальной скорости машины.

let clock = 0;
let clockStep = 0;
globalThis.performance = {
    now: () => {
        clock += clockStep;
        return clock;
    }
};

class StubElement {
    constructor(tagName = 'div', attributes = {}) {
        this.tagName = tagName.toUpperCase();
        this.localName = tagName.toLowerCase();
        this.attributes = new Map(Object.entries(attributes));
        this.childNodes = [];
        this.parentElement = null;
        this.isConnected = true;
        this.nodeType = 1;
    }

    get children() { return this.childNodes.filter((node) => node.nodeType === 1); }

    appendChild(node) {
        node.parentElement = this;
        this.childNodes.push(node);
        return node;
    }

    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
    setAttribute(name, value) { this.attributes.set(name, value); }
    hasAttribute(name) { return this.attributes.has(name); }
    matches() { return false; }
    closest() { return null; }
    querySelector() { return null; }
    querySelectorAll() { return []; }

    get textContent() {
        return this.childNodes.map((node) => (node.nodeType === 3 ? node.data : node.textContent)).join('');
    }
}

class StubText {
    constructor(data) {
        this.nodeType = 3;
        this.data = data;
        this.parentElement = null;
    }

    get textContent() { return this.data; }
}

function buildPage(elementCount) {
    const html = new StubElement('html');
    const body = new StubElement('body');
    html.appendChild(body);
    for (let index = 0; index < elementCount; index += 1) {
        const wrapper = new StubElement('div');
        const link = new StubElement('a', { href: index % 10 === 0 ? 'javascript:alert(1)' : 'https://example.com/ok' });
        link.appendChild(new StubText('Open your account'));
        wrapper.appendChild(link);
        body.appendChild(wrapper);
    }
    return html;
}

let documentRoot = buildPage(400);

globalThis.Element = StubElement;
globalThis.Node = class { static TEXT_NODE = 3; static ELEMENT_NODE = 1; };
globalThis.document = {
    get documentElement() { return documentRoot; },
    baseURI: 'https://shop.example.com/catalog'
};
globalThis.window = {
    location: new URL('https://shop.example.com/catalog'),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    innerWidth: 1280,
    innerHeight: 800
};
globalThis.getComputedStyle = globalThis.window.getComputedStyle;
globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
    takeRecords() { return []; }
};
globalThis.chrome = undefined;

const { Logger } = await import('../utils/logger.js');
Logger.setLevel('silent');
const { default: LinkDomainSecurityDetector } = await import('./link-domain-security/LinkDomainSecurityDetector.js');

function createModule() {
    const module = new LinkDomainSecurityDetector();
    module.isEnabled = true;
    // В стенде одна единица работы стоит несколько «миллисекунд» подставных часов, поэтому обычный
    // бюджет в 100 мс закончился бы на трёх десятках элементов и проверял бы бюджет, а не нарезку.
    module.initialScanTimeBudgetMs = 5000;
    // Уступка в стенде - обычный микротаск: реальные scheduler.postTask / requestIdleCallback здесь
    // отсутствуют, и подменять их незачем - проверяется поведение обхода, а не выбор API.
    module.scheduleSliceContinuation = () => Promise.resolve();
    return module;
}

// --- 1. Обход действительно уступает, и ни один кусок не превышает потолок ----------------------

{
    clock = 0;
    clockStep = 1; // каждое чтение часов - миллисекунда
    const module = createModule();
    await module.firstScan();

    assert.equal(
        module.sliceYields > 0,
        true,
        `обход обязан уступать event-loop, а не идти одним куском (уступок: ${module.sliceYields})`
    );
    // Потолок проверяется между единицами работы, поэтому перерасход равен стоимости ОДНОГО
    // элемента: прервать обработку элемента на середине нельзя, да и не нужно - в браузере это
    // микросекунды. В стенде один элемент стоит несколько «миллисекунд» подставных часов, и это
    // делает допуск видимым, вместо того чтобы прятать его за реальными скоростями.
    const UNIT_TOLERANCE_MS = 8;
    assert.equal(
        module.maximumSliceMs <= module.maxSliceMs + UNIT_TOLERANCE_MS,
        true,
        `самый длинный синхронный кусок обязан укладываться в потолок ${module.maxSliceMs} мс плюс стоимость одной единицы работы (получено ${module.maximumSliceMs})`
    );
    // Нарезка не должна стоить покрытия: обход обязан дойти до конца страницы, а не оборваться.
    assert.equal(module.traversalAborted, false, 'нарезанный обход обязан доходить до конца страницы');
    assert.equal(
        module.currentCandidatesAnalyzed,
        400,
        `все кандидаты обязаны быть разобраны, сколько бы кусков на это ни ушло (разобрано ${module.currentCandidatesAnalyzed})`
    );
}

// --- 2. Бюджет скана считается по активной работе, а не по стенным часам ------------------------
// Уступка в реальности длится столько, сколько решит планировщик. Если бюджет мерить стенными
// часами, одна такая пауза «съедает» его целиком, обход обрывается на первой же уступке, и слайсинг
// оказывается способом сканировать МЕНЬШЕ.

{
    clock = 0;
    clockStep = 1;
    const module = createModule();
    // Каждая уступка «стоит» полсекунды стенных часов - вдесятеро больше бюджета скана.
    module.scheduleSliceContinuation = () => {
        clock += 500;
        return Promise.resolve();
    };

    await module.firstScan();

    assert.equal(
        module.sliceYields > 1,
        true,
        'предусловие: уступок должно быть несколько, иначе проверка ничего не значит'
    );
    assert.equal(
        module.traversalAborted,
        false,
        'долгие уступки не имеют права обрывать обход: бюджет измеряет работу, а не ожидание'
    );
    // Стенные часы за этот скан ушли на километры вперёд, активное время - нет. Именно поэтому
    // обход и не оборвался: сравнивай бюджет со стенными часами, и он был бы исчерпан после десятой
    // уступки, ни разу не сделав полезной работы на эту величину.
    assert.equal(
        module.getScanActiveMs() < module.initialScanTimeBudgetMs,
        true,
        `активное время обязано остаться в бюджете (получено ${module.getScanActiveMs()} мс)`
    );
    assert.equal(
        clock > module.initialScanTimeBudgetMs,
        true,
        `предусловие: стенные часы обязаны выйти за бюджет, иначе проверка не различает две модели (часы: ${clock} мс)`
    );
}

// --- 3. Пауза во время уступки останавливает работу --------------------------------------------
// Между кусками страница живёт своей жизнью, и модуль может уехать в фон. Продолжать после этого
// значит работать в фоновой вкладке - ровно то, что запрещено foreground-контрактом.

{
    clock = 0;
    clockStep = 1;
    const module = createModule();
    let yieldCount = 0;
    module.scheduleSliceContinuation = () => {
        yieldCount += 1;
        if (yieldCount === 1) {
            module.isEnabled = false; // вкладка ушла в фон
        }
        return Promise.resolve();
    };

    await module.firstScan();

    assert.equal(yieldCount, 1, 'после паузы обход обязан прекратиться, а не уступать дальше');
    assert.equal(module.traversalAborted, true, 'прерванный обход обязан отмечать неполноту покрытия');
}

// --- 4. Без потолка поведение прежнее: слайсинг не меняет состав находок ------------------------

{
    clock = 0;
    clockStep = 1;
    const sliced = createModule();
    await sliced.firstScan();

    clock = 0;
    clockStep = 1;
    const unsliced = createModule();
    unsliced.maxSliceMs = Number.POSITIVE_INFINITY;
    await unsliced.firstScan();

    assert.equal(unsliced.sliceYields, 0, 'предусловие: без потолка уступок быть не должно');
    // Ради чего всё: самый длинный синхронный кусок обязан стать кратно короче.
    assert.equal(
        sliced.maximumSliceMs * 5 < unsliced.maximumSliceMs,
        true,
        `нарезка обязана кратно укорачивать самый длинный кусок (${unsliced.maximumSliceMs} -> ${sliced.maximumSliceMs} мс)`
    );
    assert.deepEqual(
        {
            findings: sliced.recentFindings.map((finding) => `${finding.type}:${finding.severity}`),
            candidates: sliced.currentCandidatesAnalyzed,
            elements: sliced.currentElementsVisited,
            aborted: sliced.traversalAborted
        },
        {
            findings: unsliced.recentFindings.map((finding) => `${finding.type}:${finding.severity}`),
            candidates: unsliced.currentCandidatesAnalyzed,
            elements: unsliced.currentElementsVisited,
            aborted: unsliced.traversalAborted
        },
        'нарезка на куски не имеет права менять ни состав находок, ни объём разобранной работы'
    );
}

// --- 5. Нарезка одна на все модули ---------------------------------------------------------------
// Три механизма нарезки рядом друг с другом - это не «три раза сделано», а три разных ответа на
// вопрос «сколько мы уже отработали». Общий потолок куска на вкладку и backoff по длинным таскам
// доходят только до того, кто спрашивает ядро.

globalThis.chrome = { i18n: { getMessage: () => '' } };

const MODULE_PATHS = [
    // ЧЕТЫРЕ, а не пять. `modules/api-interception/ApiInterceptor.js` сюда не входит: js/content.js
    // его не импортирует (Priority 7.3, quarantine), поэтому в браузере он не выполняется НИКОГДА.
    // Пока он стоял в этом списке, отчёт «проверено на всех пяти модулях» означал четыре живых плюс
    // один мёртвый - то есть щит завышал охват. Фактическую загрузку content-модулей пинует
    // modules/api-interception/runtime/ApiResourceObserver.test.mjs (позитивный список + отсутствие
    // ApiInterceptor). Файл остаётся в дереве до Chrome-валидации (Priority 7.7), но проверять его
    // как рабочий модуль нельзя.
    ['visual-manipulation', './visual-manipulation/VisualManipulationDetector.js'],
    ['link-domain-security', './link-domain-security/LinkDomainSecurityDetector.js'],
    ['trigger-phrases', './trigger-phrases/TriggerPhrases.js'],
    ['prompt-splitting', './prompt-splitting/PromptSplitting.js']
];

let checkedModules = 0;
for (const [name, path] of MODULE_PATHS) {
    const { default: ModuleClass } = await import(path);
    const instance = new ModuleClass();

    for (const method of ['beginWorkSlice', 'shouldYieldSlice', 'yieldSlice', 'finishWorkSlice', 'getScanActiveMs']) {
        assert.equal(
            typeof instance[method],
            'function',
            `${name}: нарезка обязана быть ядерной, а не своей (${method})`
        );
    }

    // Одно определение «сколько мы уже отработали» на весь проект: модуль может РАСШИРИТЬ учёт
    // куска, но не может завести своё активное время.
    assert.equal(
        Object.prototype.hasOwnProperty.call(ModuleClass.prototype, 'getScanActiveMs'),
        false,
        `${name}: активное время не имеет права быть переопределено - иначе бюджеты снова разойдутся`
    );

    // Потолок куска приходит из ядра, значит общий потолок вкладки и backoff до модуля доходят.
    assert.equal(
        instance.maxSliceMs,
        16,
        `${name}: потолок куска обязан приходить из ядра (получено ${instance.maxSliceMs})`
    );

    // Учёт куска обязан быть согласован с ядром даже у того, кто его расширяет.
    instance.beginWorkSlice();
    const sliceMs = instance.finishWorkSlice();
    assert.equal(
        typeof sliceMs,
        'number',
        `${name}: закрытие куска обязано возвращать его длительность - на этом держится учёт`
    );
    assert.equal(
        sliceMs > 0,
        true,
        `${name}: подставные часы идут вперёд, поэтому кусок обязан иметь ненулевую длительность`
    );
    // Ключевая проверка слияния: длительность, которую вернул модуль, обязана быть УЧТЕНА ядром.
    // Модуль, считающий своё время сам, вернёт число, но аккумулятор ядра останется нулевым - и
    // общий бюджет снова начнёт расходиться с модульным.
    assert.equal(
        instance.currentScanActiveMs >= sliceMs,
        true,
        `${name}: закрытый кусок обязан попадать в учёт ядра (кусок ${sliceMs}, учтено ${instance.currentScanActiveMs})`
    );

    checkedModules += 1;
}

assert.equal(checkedModules, MODULE_PATHS.length, 'проверены обязаны быть все модули');

console.log('C2: time-slicing - все проверки пройдены');

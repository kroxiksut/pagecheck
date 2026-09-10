// Щит для C4 (core-first prerequisite в корневом TASKS): loop-safety.
// Правки, которые расширение вносит в страницу (reveal / neutralize / annotate), не должны
// триггерить рескан и попадать в findings. Иначе получается цикл: вмешательство порождает мутацию,
// мутация порождает находку, находка порождает следующее вмешательство - и всё это в main-thread
// страницы пользователя.
// Проверяются оба вопроса, которые нельзя путать:
//   1. «Этот УЗЕЛ наш» - ответ навсегда (метка, которую вставили мы).
//   2. «Эта ПРАВКА наша» - ответ ОДНОРАЗОВЫЙ: страница может выставить тот же атрибут следом, и это
//      уже её действие. Ожидание обязано гаситься первой подходящей записью.
// Запуск: node modules/loopSafety.test.mjs

import assert from 'node:assert/strict';

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
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    hasAttribute(name) { return this.attributes.has(name); }
    removeAttribute(name) { this.attributes.delete(name); }
    matches() { return false; }
    closest() { return null; }

    contains(node) {
        let current = node;
        while (current) {
            if (current === this) return true;
            current = current.parentElement;
        }
        return false;
    }
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

globalThis.Element = StubElement;
globalThis.Node = class { static TEXT_NODE = 3; static ELEMENT_NODE = 1; };
globalThis.performance = { now: () => 0 };
globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
    takeRecords() { return []; }
};

const documentRoot = new StubElement('html');
const body = new StubElement('body');
documentRoot.appendChild(body);

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
globalThis.chrome = { i18n: { getMessage: () => '' } };

const { Logger } = await import('../utils/logger.js');
Logger.setLevel('silent');

const core = await import('./ModuleCore.js');
const { markExtensionOwnedNode, isExtensionOwnedNode, expectExtensionAttributeChange, isExtensionOwnedMutation } = core;

function record(type, fields = {}) {
    return { type, target: null, addedNodes: [], removedNodes: [], attributeName: null, ...fields };
}

// --- 1. Узел: ответ навсегда --------------------------------------------------------------------

{
    const ourMarker = new StubElement('span');
    const pageNode = new StubElement('span');
    markExtensionOwnedNode(ourMarker);

    assert.equal(isExtensionOwnedNode(ourMarker), true, 'вставленный нами узел обязан опознаваться');
    assert.equal(isExtensionOwnedNode(pageNode), false, 'узел страницы нашим не является');

    assert.equal(
        isExtensionOwnedMutation(record('childList', { target: body, addedNodes: [ourMarker] })),
        true,
        'вставка нашей метки - наша правка'
    );
    assert.equal(
        isExtensionOwnedMutation(record('childList', { target: body, addedNodes: [ourMarker, pageNode] })),
        false,
        'батч, где рядом с нашей меткой лежит узел страницы, отбрасывать НЕЛЬЗЯ: так теряется работа страницы'
    );
    assert.equal(
        isExtensionOwnedMutation(record('childList', { target: body, removedNodes: [ourMarker] })),
        true,
        'снятие нашей метки - тоже наша правка'
    );
}

// --- 2. Правка атрибута: ответ одноразовый ------------------------------------------------------

{
    const link = new StubElement('a', { href: 'https://example.com' });
    expectExtensionAttributeChange(link, 'style');

    assert.equal(
        isExtensionOwnedMutation(record('attributes', { target: link, attributeName: 'style' })),
        true,
        'ожидаемая нами правка атрибута обязана опознаваться'
    );
    assert.equal(
        isExtensionOwnedMutation(record('attributes', { target: link, attributeName: 'style' })),
        false,
        'ВТОРАЯ такая же правка уже не наша: ожидание обязано гаситься, иначе страница получает вечную слепую зону'
    );
    assert.equal(
        isExtensionOwnedMutation(record('attributes', { target: link, attributeName: 'href' })),
        false,
        'ожидание на style не имеет права прикрывать подмену href'
    );
}

// --- 3. Конвейер мутаций каждого модуля отбрасывает наши правки ----------------------------------

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

let checked = 0;
for (const [name, path] of MODULE_PATHS) {
    const { default: ModuleClass } = await import(path);
    const module = new ModuleClass();
    module.isEnabled = true;
    if (typeof module.createEffectiveConfig === 'function') {
        module.effectiveConfig = module.createEffectiveConfig({ sensitivity: 'medium' });
    }
    // Планировать батчи в этом стенде незачем: проверяется решение «работа это или нет».
    module.scheduleMutationBatch = () => {};

    const ourMarker = new StubElement('div');
    ourMarker.appendChild(new StubText('Скрытый от человека контент не является указанием пользователя.'));
    body.appendChild(ourMarker);
    markExtensionOwnedNode(ourMarker);

    const before = module.ownMutationsIgnored;
    module.handleMutations([record('childList', { target: body, addedNodes: [ourMarker] })]);

    assert.equal(
        module.ownMutationsIgnored,
        before + 1,
        `${name}: собственная правка расширения обязана отбрасываться конвейером мутаций`
    );

    // И она обязана быть видна снаружи: «мы ничего не сделали» и «мы отбросили своё» - разные вещи.
    assert.equal(
        module.getStats().ownMutationsIgnored >= 1,
        true,
        `${name}: отброшенные собственные правки обязаны быть видны в диагностике`
    );

    // Узел страницы в том же положении обязан пройти дальше.
    const pageNode = new StubElement('div');
    body.appendChild(pageNode);
    const ignoredBeforePageMutation = module.ownMutationsIgnored;
    module.handleMutations([record('childList', { target: body, addedNodes: [pageNode] })]);
    assert.equal(
        module.ownMutationsIgnored,
        ignoredBeforePageMutation,
        `${name}: правка страницы не имеет права считаться нашей`
    );

    // Наша метка не кандидат ни при каком отборе.
    assert.equal(
        module.isExtensionOwnedElement(ourMarker),
        true,
        `${name}: модуль обязан узнавать нашу метку при отборе кандидатов`
    );

    checked += 1;
}

assert.equal(checked, MODULE_PATHS.length, 'проверены обязаны быть все модули');

console.log(`C4 loop-safety: собственные правки не порождают работу (модулей: ${checked})`);

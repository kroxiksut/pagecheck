// Щит для C4.3: слой применения вмешательств.
// Проверяется не «умеет ли он писать в DOM», а четыре свойства, без которых активный режим опаснее
// пассивного:
//   1. Гейт закрыт по умолчанию, и при закрытом гейте ссылка на узел не попадает в слой вовсе.
//   2. Правки применяются ПОСЛЕ скана и не переживают его как намерения: очередь пуста после applyQueued.
//   3. Вставленная метка помечена нашей (loop-safety), иначе она станет находкой следующего скана.
//   4. Откат возвращает страницу в прежний вид, а выключение настройки откат вызывает.
// Запуск: node js/interventionLayer.test.mjs

import assert from 'node:assert/strict';

class StubElement {
    constructor(tagName = 'div') {
        this.tagName = tagName.toUpperCase();
        this.localName = tagName.toLowerCase();
        this.attributes = new Map();
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

    removeChild(node) {
        this.childNodes = this.childNodes.filter((child) => child !== node);
        node.parentElement = null;
        return node;
    }

    // Минимальный CSSStyleDeclaration: ровно то, чем пользуется reveal, включая приоритет -
    // без него точный откат непроверяем.
    get style() {
        if (!this._style) {
            const declarations = new Map();
            this._style = {
                declarations,
                setProperty: (property, value, priority = '') => {
                    declarations.set(property, { value: String(value), priority: String(priority) });
                },
                removeProperty: (property) => { declarations.delete(property); },
                getPropertyValue: (property) => declarations.get(property)?.value ?? '',
                getPropertyPriority: (property) => declarations.get(property)?.priority ?? ''
            };
        }
        return this._style;
    }

    get nextSibling() {
        const siblings = this.parentElement ? this.parentElement.childNodes : [];
        const index = siblings.indexOf(this);
        return index >= 0 && index + 1 < siblings.length ? siblings[index + 1] : null;
    }

    insertBefore(node, reference) {
        const index = this.childNodes.indexOf(reference);
        node.parentElement = this;
        if (index < 0) {
            this.childNodes.push(node);
        } else {
            this.childNodes.splice(index, 0, node);
        }
        return node;
    }

    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
    hasAttribute(name) { return this.attributes.has(name); }

    get textContent() {
        return this.childNodes.map((node) => (node.nodeType === 3 ? node.data : node.textContent)).join('');
    }

    set textContent(value) {
        this.childNodes = [{ nodeType: 3, data: String(value), parentElement: this }];
    }
}

globalThis.Element = StubElement;
globalThis.Node = class { static TEXT_NODE = 3; static ELEMENT_NODE = 1; };
globalThis.performance = { now: () => 0 };
globalThis.document = {
    createElement: (tagName) => new StubElement(tagName)
};
globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
    takeRecords() { return []; }
};

const { Logger } = await import('../utils/logger.js');
Logger.setLevel('silent');
const { isExtensionOwnedNode } = await import('../modules/ModuleCore.js');
const { default: InterventionLayer } = await import('./intervention-layer.js');

const ANNOTATION_TEXT = 'PageCheck: этот блок был скрыт от человека.';

function createLayer() {
    return new InterventionLayer({ getMessage: () => ANNOTATION_TEXT });
}

function hiddenTextFinding() {
    return { type: 'hidden-text', severity: 'high', dedupeKey: 'k1' };
}

// --- 1. Гейт закрыт по умолчанию ----------------------------------------------------------------

{
    const layer = createLayer();
    const node = new StubElement('p');

    assert.equal(layer.isEnabled, false, 'активное вмешательство обязано быть выключено по умолчанию');
    assert.equal(
        layer.collectFindingNode(hiddenTextFinding(), node, 'Hidden-Content-Visual-Manipulation'),
        false,
        'при закрытом гейте узел не имеет права попадать в слой'
    );
    assert.equal(layer.getStats().queuedIntentions, 0, 'очередь намерений обязана оставаться пустой');
    assert.equal(layer.applyQueued(), 0, 'при закрытом гейте применять нечего');
    assert.equal(node.children.length, 0, 'при закрытом гейте страница не имеет права меняться');
}

// --- 2. Открытый гейт: намерение живёт до применения и не дольше --------------------------------

{
    const layer = createLayer();
    layer.setEnabled(true);
    const node = new StubElement('p');

    assert.equal(layer.collectFindingNode(hiddenTextFinding(), node, 'm'), true, 'находка о скрытом тексте обязана попадать в очередь');
    assert.equal(layer.getStats().queuedIntentions, 1, 'намерение обязано стоять в очереди до конца скана');

    const applied = layer.applyQueued();
    assert.equal(applied, 1, 'после скана намерение обязано быть применено');
    assert.equal(
        layer.getStats().queuedIntentions,
        0,
        'очередь обязана опустеть: ссылки на узлы не переживают скан - это и есть причина, по которой выбрана очередь, а не карта'
    );

    assert.equal(node.children.length, 1, 'к узлу обязана быть добавлена метка');
    const marker = node.children[0];
    assert.equal(marker.getAttribute('data-pagecheck-annotation'), 'hidden-text', 'метка обязана называть тип находки');
    assert.equal(marker.textContent, ANNOTATION_TEXT, 'текст метки обязан браться из локали');

    // --- 3. Loop-safety: метка наша -------------------------------------------------------------
    assert.equal(
        isExtensionOwnedNode(marker),
        true,
        'вставленная метка обязана быть помечена нашей, иначе она станет находкой следующего скана'
    );

    // Повторная находка на том же узле не плодит вторую метку.
    layer.collectFindingNode(hiddenTextFinding(), node, 'm');
    layer.applyQueued();
    assert.equal(node.children.length, 1, 'на одном узле не может быть двух наших меток');
}

// --- 4. Откат ------------------------------------------------------------------------------------

{
    const layer = createLayer();
    layer.setEnabled(true);
    const node = new StubElement('p');
    layer.collectFindingNode(hiddenTextFinding(), node, 'm');
    layer.applyQueued();
    assert.equal(node.children.length, 1, 'предусловие: метка стоит');

    // Выключение настройки - это откат: правки описывают решение, которого больше нет.
    layer.setEnabled(false);
    assert.equal(node.children.length, 0, 'выключение активного режима обязано снимать наши правки');
    assert.equal(layer.getStats().appliedEdits, 0, 'реестр правок обязан опустеть');
    assert.equal(layer.getStats().annotationsReverted, 1, 'откат обязан быть виден в диагностике');
}

// --- 5. Границы: чужие типы находок и потолок очереди --------------------------------------------

{
    const layer = createLayer();
    layer.setEnabled(true);

    const overlayNode = new StubElement('div');
    assert.equal(
        layer.collectFindingNode({ type: 'overlay' }, overlayNode, 'm'),
        false,
        'overlay-находке аннотировать нечего: там вопрос не «что написано», а «что чем перекрыто»'
    );

    let accepted = 0;
    for (let index = 0; index < 200; index += 1) {
        if (layer.collectFindingNode(hiddenTextFinding(), new StubElement('p'), 'm')) {
            accepted += 1;
        }
    }
    assert.equal(
        accepted <= 50,
        true,
        `очередь намерений обязана быть ограничена: страница не должна уметь заставить нас работать неограниченно (принято ${accepted})`
    );
    assert.equal(layer.getStats().intentionsDropped > 0, true, 'отброшенные намерения обязаны быть видны в диагностике');
}

// --- 6. REVEAL: перебивает страницу и откатывается ТОЧНО ----------------------------------------

{
    const { isExtensionOwnedNode: _unused } = await import('../modules/ModuleCore.js');
    const layer = createLayer();
    layer.setAction('reveal');
    layer.setEnabled(true);

    const node = new StubElement('p');
    // Страница прячет текст и делает это с !important - иначе перебивать было бы нечего.
    node.style.setProperty('display', 'none', 'important');
    node.style.setProperty('color', 'red', '');

    layer.collectFindingNode(hiddenTextFinding(), node, 'm');
    assert.equal(layer.applyQueued(), 1, 'reveal обязан применяться');

    assert.equal(
        node.style.getPropertyValue('display'),
        'inline',
        'скрытый display обязан быть перебит'
    );
    assert.equal(
        node.style.getPropertyPriority('display'),
        'important',
        'без !important правку страницы не перебить - это и есть причина, по которой reveal пишет inline-стили'
    );
    assert.equal(node.style.getPropertyValue('visibility'), 'visible', 'visibility обязана быть раскрыта');

    layer.setEnabled(false);

    assert.equal(
        node.style.getPropertyValue('display'),
        'none',
        'откат обязан возвращать прежнее значение страницы'
    );
    assert.equal(
        node.style.getPropertyPriority('display'),
        'important',
        'откат обязан возвращать и ПРИОРИТЕТ: свойство, объявленное страницей как !important, не имеет права вернуться без него'
    );
    assert.equal(
        node.style.getPropertyValue('visibility'),
        '',
        'свойство, которого у страницы не было, обязано быть снято, а не оставлено нашим значением'
    );
    assert.equal(node.style.getPropertyValue('color'), 'red', 'чужие свойства reveal не трогает');
}

// --- 7. NEUTRALIZE: узел снимается и возвращается НА ТО ЖЕ МЕСТО ---------------------------------

{
    const layer = createLayer();
    layer.setAction('neutralize');
    layer.setEnabled(true);

    const parent = new StubElement('div');
    const before = new StubElement('span');
    const target = new StubElement('p');
    const after = new StubElement('span');
    parent.appendChild(before);
    parent.appendChild(target);
    parent.appendChild(after);

    layer.collectFindingNode(hiddenTextFinding(), target, 'm');
    assert.equal(layer.applyQueued(), 1, 'neutralize обязан применяться');
    assert.equal(parent.childNodes.includes(target), false, 'узел обязан быть снят со страницы');
    assert.deepEqual(parent.childNodes, [before, after], 'соседи обязаны остаться на месте');

    layer.setEnabled(false);
    assert.deepEqual(
        parent.childNodes,
        [before, target, after],
        'откат обязан возвращать узел на ТУ ЖЕ позицию, а не в конец родителя - иначе порядок чтения страницы меняется навсегда'
    );
}

// --- 8. Loop-safety структурной правки: ожидание одноразовое -------------------------------------
// Узел страницы не помечается «нашим» навсегда: после отката детекторы обязаны видеть его снова.

{
    const { isExtensionOwnedMutation, isExtensionOwnedNode } = await import('../modules/ModuleCore.js');
    const layer = createLayer();
    layer.setAction('neutralize');
    layer.setEnabled(true);

    const parent = new StubElement('div');
    const target = new StubElement('p');
    parent.appendChild(target);

    layer.collectFindingNode(hiddenTextFinding(), target, 'm');
    layer.applyQueued();

    assert.equal(
        isExtensionOwnedNode(target),
        false,
        'контент страницы не имеет права становиться «нашим» навсегда: иначе после отката он выпадет из анализа'
    );
    assert.equal(
        isExtensionOwnedMutation({ type: 'childList', target: parent, addedNodes: [], removedNodes: [target] }),
        true,
        'наше собственное удаление обязано опознаваться один раз'
    );
    assert.equal(
        isExtensionOwnedMutation({ type: 'childList', target: parent, addedNodes: [], removedNodes: [target] }),
        false,
        'второе такое же удаление уже дело страницы - ожидание обязано гаситься'
    );
}

// --- 9. Смена действия откатывает применённое ---------------------------------------------------

{
    const layer = createLayer();
    layer.setAction('annotate');
    layer.setEnabled(true);
    const node = new StubElement('p');
    layer.collectFindingNode(hiddenTextFinding(), node, 'm');
    layer.applyQueued();
    assert.equal(node.children.length, 1, 'предусловие: метка стоит');

    layer.setAction('reveal');
    assert.equal(
        node.children.length,
        0,
        'смена действия обязана откатывать прежние правки: они описывают решение, которого больше нет'
    );
}

// --- 10. C4.4: страница снимает нашу метку -------------------------------------------------------
// Требование дизайна сформулировано отрицанием: НЕ восстанавливать. Восстановление в цикле - это
// война правок в main-thread пользователя, а не защита. Правильная реакция - факт в отчёте.

{
    const layer = createLayer();
    layer.setEnabled(true);

    const node = new StubElement('p');
    layer.collectFindingNode(hiddenTextFinding(), node, 'Hidden-Content-Visual-Manipulation');
    layer.applyQueued();
    assert.equal(node.children.length, 1, 'предусловие: метка стоит');

    // Страница снимает нашу метку.
    node.removeChild(node.children[0]);

    assert.equal(layer.verifyAppliedEdits(), 1, 'снятие нашей метки обязано быть замечено');
    assert.equal(layer.getStats().tamperedEdits, 1, 'факт обязан попадать в диагностику');
    assert.deepEqual(
        layer.getStats().tamperedFindingTypes,
        ['hidden-text'],
        'отчёт обязан называть, к какой находке относилось снятое вмешательство'
    );

    // И главное: следующий скан НЕ пытается поставить метку заново.
    layer.collectFindingNode(hiddenTextFinding(), node, 'Hidden-Content-Visual-Manipulation');
    assert.equal(layer.applyQueued(), 0, 'к узлу, где нашу правку сняли, мы больше не возвращаемся');
    assert.equal(node.children.length, 0, 'страница не имеет права получить от нас войну правок');
}

// --- 11. C4.4 для reveal: перебитое объявление тоже считается снятием ----------------------------

{
    const layer = createLayer();
    layer.setAction('reveal');
    layer.setEnabled(true);

    const node = new StubElement('p');
    node.style.setProperty('display', 'none', 'important');
    layer.collectFindingNode(hiddenTextFinding(), node, 'm');
    layer.applyQueued();
    assert.equal(node.style.getPropertyValue('display'), 'inline', 'предусловие: раскрытие применено');

    // Страница возвращает своё.
    node.style.setProperty('display', 'none', 'important');

    assert.equal(layer.verifyAppliedEdits(), 1, 'перебитое объявление обязано считаться снятием раскрытия');
    assert.equal(layer.getStats().appliedEdits, 0, 'снятая правка обязана уйти из реестра');

    layer.collectFindingNode(hiddenTextFinding(), node, 'm');
    assert.equal(layer.applyQueued(), 0, 'раскрывать во второй раз мы не будем');
}

// --- 12. Целое вмешательство снятием не считается ------------------------------------------------

{
    const layer = createLayer();
    layer.setEnabled(true);
    const node = new StubElement('p');
    layer.collectFindingNode(hiddenTextFinding(), node, 'm');
    layer.applyQueued();

    assert.equal(layer.verifyAppliedEdits(), 0, 'нетронутая метка не имеет права выглядеть как враждебность страницы');
    assert.equal(layer.getStats().tamperedEdits, 0, 'ложный сигнал враждебности хуже отсутствия сигнала');
}


// --- 13. Второй модуль-поставщик: link-mismatch аннотируется РЯДОМ со ссылкой --------------------
// Ключевое свойство раздела - метка не попадает внутрь <a>. Причина не косметическая:
// getBoundedLinkText в link-domain-security собирает подпись ссылки обходом её же детей и НЕ
// пропускает наши узлы, поэтому метка внутри стала бы частью того самого видимого текста, который
// детектор сравнивает с адресом, - мы бы судили о собственной работе.

const LINK_ANNOTATION_TEXT = 'PageCheck: видимый текст предыдущей ссылки не совпадает с адресом.';

function createKeyedLayer() {
    return new InterventionLayer({
        getMessage: (key) => (key === 'interventionLinkMismatchAnnotation' ? LINK_ANNOTATION_TEXT : ANNOTATION_TEXT)
    });
}

function linkMismatchFinding() {
    return { type: 'link-mismatch', severity: 'high', dedupeKey: 'lm1' };
}

function createLinkInParagraph() {
    const paragraph = new StubElement('p');
    const link = new StubElement('a');
    const tail = new StubElement('span');
    paragraph.appendChild(link);
    paragraph.appendChild(tail);
    return { paragraph, link, tail };
}

{
    const layer = createKeyedLayer();
    layer.setEnabled(true);
    const { paragraph, link, tail } = createLinkInParagraph();

    assert.equal(
        layer.collectFindingNode(linkMismatchFinding(), link, 'Link-Domain-Security'),
        true,
        'находка о несовпадении текста и адреса обязана приниматься слоем'
    );
    assert.equal(layer.applyQueued(), 1, 'намерение обязано быть применено после скана');

    assert.equal(link.childNodes.length, 0, 'метка НЕ имеет права попадать внутрь ссылки: это вход собственного детектора');
    const marker = paragraph.childNodes[1];
    assert.equal(marker.getAttribute('data-pagecheck-annotation'), 'link-mismatch', 'метка обязана называть тип находки');
    assert.equal(paragraph.childNodes[0], link, 'ссылка обязана остаться на своём месте');
    assert.equal(paragraph.childNodes[2], tail, 'метка обязана встать сразу за ссылкой, а не в конец родителя');
    assert.equal(marker.textContent, LINK_ANNOTATION_TEXT, 'текст обязан браться по СВОЕМУ ключу, а не по ключу скрытого контента');
    assert.equal(isExtensionOwnedNode(marker), true, 'метка обязана быть помечена нашей до вставки (loop-safety)');

    assert.equal(layer.verifyAppliedEdits(), 0, 'целая метка за ссылкой не имеет права выглядеть как снятая страницей');

    layer.setEnabled(false);
    assert.equal(paragraph.childNodes.length, 2, 'откат обязан снять метку');
    assert.equal(paragraph.childNodes[0], link, 'после отката порядок узлов страницы обязан быть прежним');
    assert.equal(paragraph.childNodes[1], tail, 'после отката порядок узлов страницы обязан быть прежним');
}

// Настройка действия к этой находке не применяется: reveal ей бессмыслен, а neutralize удалил бы у
// человека видимую ссылку. Вместо «молча ничего не делаем» - всегда факт рядом со ссылкой.
for (const action of ['reveal', 'neutralize']) {
    const layer = createKeyedLayer();
    layer.setEnabled(true);
    layer.setAction(action);
    const { paragraph, link } = createLinkInParagraph();

    assert.equal(layer.applyQueued.call(layer), 0, 'предусловие: очередь пуста');
    layer.collectFindingNode(linkMismatchFinding(), link, 'Link-Domain-Security');
    assert.equal(layer.applyQueued(), 1, `при действии ${action} находка о ссылке обязана всё равно аннотироваться`);

    assert.equal(link.isConnected, true, `${action} не имеет права удалять у человека видимую ссылку`);
    assert.equal(paragraph.childNodes.includes(link), true, `${action} не имеет права снимать ссылку со страницы`);
    assert.equal(link.style.getPropertyValue('display'), '', `${action} не имеет права трогать стили видимой ссылки`);
    assert.equal(paragraph.childNodes[1].getAttribute('data-pagecheck-annotation'), 'link-mismatch', 'метка обязана стоять за ссылкой');
    assert.equal(layer.getStats().annotationsApplied, 1, 'правка обязана считаться аннотацией, а не раскрытием или изъятием');
}

// Ссылке без родителя писать некуда, и подменять размещение на «внутрь» нельзя.
{
    const layer = createKeyedLayer();
    layer.setEnabled(true);
    const orphan = new StubElement('a');

    layer.collectFindingNode(linkMismatchFinding(), orphan, 'Link-Domain-Security');
    assert.equal(layer.applyQueued(), 0, 'без родителя правка не делается');
    assert.equal(orphan.childNodes.length, 0, 'запасной путь «положить внутрь» запрещён: это вход собственного детектора');
}

// Страница сняла метку - это C4.4, а не повод поставить её заново.
{
    const layer = createKeyedLayer();
    layer.setEnabled(true);
    const { paragraph, link } = createLinkInParagraph();
    layer.collectFindingNode(linkMismatchFinding(), link, 'Link-Domain-Security');
    layer.applyQueued();

    paragraph.removeChild(paragraph.childNodes[1]);
    assert.equal(layer.verifyAppliedEdits(), 1, 'снятая страницей метка обязана считаться враждебностью');

    layer.collectFindingNode(linkMismatchFinding(), link, 'Link-Domain-Security');
    assert.equal(layer.applyQueued(), 0, 'второй раз мы туда не идём: война правок в main-thread пользователя - не защита');
}


// --- 14. Третий модуль-поставщик: prompt-splitting отдаёт ЯКОРЬ региона --------------------------
// Находка описывает регион из многих узлов, а слой работает «один узел = одно намерение». Развилка
// решена в модуле в пользу якоря - контейнера, который коллектор уже считает границей региона.
// Слою остаётся то же правило, что и для ссылки: действие настройки не применяется, метка идёт
// РЯДОМ. Внутрь контейнера её класть нельзя - это была бы вставка нашего текста в тот самый блок,
// о котором мы отчитываемся.

const REGION_ANNOTATION_TEXT = 'PageCheck: предыдущий блок содержит фрагменты, читающиеся как инструкция.';

function createRegionLayer() {
    return new InterventionLayer({
        getMessage: (key) => {
            if (key === 'interventionPromptSplittingAnnotation') return REGION_ANNOTATION_TEXT;
            if (key === 'interventionLinkMismatchAnnotation') return LINK_ANNOTATION_TEXT;
            return ANNOTATION_TEXT;
        }
    });
}

function regionFinding() {
    return { type: 'prompt-splitting', severity: 'medium' };
}

{
    const layer = createRegionLayer();
    layer.setEnabled(true);
    const page = new StubElement('main');
    const region = new StubElement('article');
    const nextBlock = new StubElement('footer');
    page.appendChild(region);
    page.appendChild(nextBlock);
    const regionChild = new StubElement('p');
    region.appendChild(regionChild);

    assert.equal(layer.collectFindingNode(regionFinding(), region, 'Prompt-Splitting'), true, 'находка о собранном промпте обязана приниматься слоем');
    assert.equal(layer.applyQueued(), 1, 'намерение обязано быть применено');

    assert.equal(region.childNodes.length, 1, 'внутрь блока метка не кладётся: это вставка нашего текста в блок, о котором мы отчитываемся');
    assert.equal(region.childNodes[0], regionChild, 'содержимое блока обязано остаться нетронутым');
    const marker = page.childNodes[1];
    assert.equal(marker.getAttribute('data-pagecheck-annotation'), 'prompt-splitting', 'метка обязана называть тип находки');
    assert.equal(marker.textContent, REGION_ANNOTATION_TEXT, 'текст обязан браться по своему ключу');
    assert.equal(page.childNodes[2], nextBlock, 'метка обязана встать сразу за блоком, а не в конец родителя');
    assert.equal(isExtensionOwnedNode(marker), true, 'метка обязана быть помечена нашей');

    layer.setEnabled(false);
    assert.equal(page.childNodes.length, 2, 'откат обязан снять метку');
    assert.equal(page.childNodes[0], region, 'порядок узлов страницы обязан вернуться прежним');
}

// Настройка действия к этой находке не применяется: neutralize снёс бы у человека целый блок.
for (const action of ['reveal', 'neutralize']) {
    const layer = createRegionLayer();
    layer.setEnabled(true);
    layer.setAction(action);
    const page = new StubElement('main');
    const region = new StubElement('article');
    page.appendChild(region);

    layer.collectFindingNode(regionFinding(), region, 'Prompt-Splitting');
    assert.equal(layer.applyQueued(), 1, `при действии ${action} находка о блоке обязана всё равно аннотироваться`);
    assert.equal(page.childNodes.includes(region), true, `${action} не имеет права снимать со страницы целый блок содержимого`);
    assert.equal(region.style.getPropertyValue('display'), '', `${action} не имеет права трогать стили блока`);
    assert.equal(layer.getStats().annotationsApplied, 1, 'правка обязана считаться аннотацией');
}

console.log('C4.3: слой вмешательства - все проверки пройдены');

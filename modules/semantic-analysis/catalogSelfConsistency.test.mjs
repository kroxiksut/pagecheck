// Щит самосогласованности каталога правил (корневой TASKS C3: детерминированные проверки без DOM).
//
// ЗАЧЕМ. Каталог объявляет о себе три вещи, и до этого файла ни одну из них не проверял никто:
//   1. У каждого правила есть примеры - положительные и отрицательные. Пример, который не сходится
//      с правилом, это документация, которая врёт, а заодно потерянный регресс-корпус: примеры
//      единственное место, где смысл правила записан текстом, а не сигналами.
//   2. Каждая альтернатива требуемого сигнала должна уметь совпасть хотя бы сама с собой. Фраза,
//      которая не совпадает после нормализации, - мёртвый вес, и увидеть её глазами невозможно.
//   3. Идентификаторы и версии правил уникальны и осмысленны: по ним findings связываются между
//      модулями и переживают перезапуск.
//
// Проверка (2) - прямое следствие найденного дефекта: у `safety-bypass.ru` подавление было написано
// на несовершенном виде глагола, а требуемые сигналы - на совершенном, поэтому сработать оно не
// могло НИКОГДА. Такую ошибку ловит только прогон фразы через настоящую нормализацию.
// Запуск: node modules/semantic-analysis/catalogSelfConsistency.test.mjs

import assert from 'node:assert/strict';

globalThis.performance = globalThis.performance || { now: () => 0 };

const { analyzeSemanticCandidate } = await import('./SemanticAnalysisCore.js');
const { BUILT_IN_SEMANTIC_RULES } = await import('./semanticCatalog.js');

// Чувствительность `high` намеренно: она пропускает оценки всех уровней, поэтому проверка говорит
// о СРАБАТЫВАНИИ правила, а не о том, прошло ли оно пользовательский фильтр.
function ruleFires(ruleId, text) {
    return analyzeSemanticCandidate({ text }, { sensitivity: 'high' })
        .assessments.some((assessment) => assessment.contributingRuleIds.includes(ruleId));
}

// --- 1. Примеры правила сходятся с самим правилом ------------------------------------------------

let exampleCount = 0;
for (const rule of BUILT_IN_SEMANTIC_RULES) {
    const positives = rule.examples?.positive || [];
    const negatives = rule.examples?.negative || [];
    assert.ok(positives.length > 0, `${rule.ruleId}: правило без положительного примера нечем объяснить читателю`);
    assert.ok(negatives.length > 0, `${rule.ruleId}: правило без отрицательного примера не говорит, где его граница`);

    for (const example of positives) {
        exampleCount += 1;
        assert.equal(ruleFires(rule.ruleId, example), true, `${rule.ruleId}: собственный положительный пример не срабатывает - ${JSON.stringify(example)}`);
    }
    for (const example of negatives) {
        exampleCount += 1;
        assert.equal(ruleFires(rule.ruleId, example), false, `${rule.ruleId}: собственный отрицательный пример срабатывает - ${JSON.stringify(example)}`);
    }
}

// --- 2. Каждая альтернатива требуемого сигнала способна совпасть ---------------------------------
// Правило требует ВСЕ группы сразу, поэтому альтернатива проверяется в контексте: из каждой группы
// берётся по одной и склеивается. Если такая склейка не срабатывает - хотя бы одна из фраз мертва.

let comboCount = 0;
for (const rule of BUILT_IN_SEMANTIC_RULES) {
    const groups = (rule.requiredSignals || []).map((signal) => signal.alternatives || []);
    assert.ok(groups.length > 0, `${rule.ruleId}: правило без требуемых сигналов срабатывает на чём угодно`);
    for (const group of groups) {
        assert.ok(group.length > 0, `${rule.ruleId}: группа требуемых сигналов без альтернатив не может совпасть`);
    }

    const combos = [];
    const build = (index, accumulated) => {
        if (index === groups.length) { combos.push(accumulated.slice()); return; }
        for (const alternative of groups[index]) build(index + 1, [...accumulated, alternative]);
    };
    build(0, []);

    for (const combo of combos) {
        comboCount += 1;
        assert.equal(
            ruleFires(rule.ruleId, combo.join(' ')),
            true,
            `${rule.ruleId}: собственные требуемые фразы не срабатывают вместе - [${combo.join(' | ')}]`
        );
    }
}

// --- 3. Идентичность правил ---------------------------------------------------------------------
// По ruleId findings связываются между модулями и переживают перезапуск; по version отличается
// находка, собранная прежним составом сигналов, от собранной нынешним.

{
    const ids = BUILT_IN_SEMANTIC_RULES.map((rule) => rule.ruleId);
    assert.equal(new Set(ids).size, ids.length, 'идентификаторы правил обязаны быть уникальными');

    for (const rule of BUILT_IN_SEMANTIC_RULES) {
        assert.ok(
            /^[a-z-]+\.(en|ru)\.[a-z-]+$/.test(rule.ruleId),
            `${rule.ruleId}: идентификатор обязан читаться как категория.язык.подтип - по нему findings разбирают люди, а не только код`
        );
        assert.ok(rule.ruleId.startsWith(`${rule.category}.${rule.language}.`), `${rule.ruleId}: идентификатор обязан совпадать с категорией и языком правила`);
        assert.ok(Number.isInteger(rule.version) && rule.version >= 1, `${rule.ruleId}: версия правила обязана быть целым числом от 1`);
        assert.ok(['strong', 'moderate', 'supporting'].includes(rule.baseSignalStrength), `${rule.ruleId}: неизвестная сила сигнала ${rule.baseSignalStrength}`);
    }

    // Правило-компаньон на другом языке обязано существовать: страница на русском не должна
    // детектироваться хуже английской просто потому, что пару забыли завести.
    for (const rule of BUILT_IN_SEMANTIC_RULES) {
        const otherLanguage = rule.language === 'en' ? 'ru' : 'en';
        const counterpart = rule.ruleId.replace(`.${rule.language}.`, `.${otherLanguage}.`);
        assert.ok(
            BUILT_IN_SEMANTIC_RULES.some((other) => other.ruleId === counterpart),
            `${rule.ruleId}: нет пары на языке ${otherLanguage} - покрытие языков разъедется молча`
        );
    }
}

console.log(`catalogSelfConsistency.test.mjs: ok (правил ${BUILT_IN_SEMANTIC_RULES.length}, примеров ${exampleCount}, комбинаций требуемых сигналов ${comboCount})`);

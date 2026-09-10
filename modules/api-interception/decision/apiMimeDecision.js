const DOCUMENT_MIME_TYPES = new Set([
    'text/html',
    'application/xhtml+xml'
]);

// @data-list MIME-типы, которые браузер исполняет как скрипт. Устаревание = ТИШИНА: новый
// исполняемый тип не будет опознан как скрипт. Сверяться с реестром IANA media types и с
// тем, что реально исполняет движок.
const SCRIPT_MIME_TYPES = new Set([
    'application/ecmascript',
    'application/javascript',
    'application/x-ecmascript',
    'application/x-javascript',
    'text/ecmascript',
    'text/javascript'
]);

const CANDIDATE_TYPE = 'image-resource-declared-mime-anomaly';

// Частичность наблюдения живёт на уровне БАТЧА, а не отдельной записи: createNormalizedObservation
// отдаёт ровно одиннадцать полей, и `partial` среди них нет, поэтому стоявшая здесь проверка
// `observation.partial === true` была мёртвой - она не отклоняла ничего. Тест при этом подсовывал ей
// вручную собранный объект `{partial: true}`, которого нормализация никогда не создаёт, то есть
// проверял ветку, недостижимую в продакшене (TASKS 13.6). Решение по развилке - вариант (б):
// проверка убрана, частичность по-прежнему доезжает до ApiFindingState через context батча.
// Протаскивать флаг в каждое наблюдение (вариант «а») означало бы подавлять кандидатов целой
// сессии - это изменение детекта, за которое нет свидетельств, и оно требовало бы своего замера.
export function evaluateImageMimeObservation(observation) {
    if (!observation
        || observation.resourceType !== 'image'
        || observation.completed !== true
        || observation.networkError === true
        || !Number.isInteger(observation.sessionRevision)
        || observation.sessionRevision < 0
        || observation.declaredMimeState !== 'valid'
        || typeof observation.declaredMime !== 'string'
        || !Number.isInteger(observation.responseStatus)
        || observation.responseStatus < 200
        || observation.responseStatus > 299
        || observation.responseStatus === 204
        || observation.responseStatus === 205) {
        return null;
    }

    const category = DOCUMENT_MIME_TYPES.has(observation.declaredMime)
        ? 'document'
        : SCRIPT_MIME_TYPES.has(observation.declaredMime)
            ? 'script'
            : null;
    if (!category) {
        return null;
    }

    return Object.freeze({
        type: CANDIDATE_TYPE,
        category,
        severity: 'low'
    });
}

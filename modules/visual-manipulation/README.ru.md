# Модуль "Скрытый контент и визуальные манипуляции"

## Назначение
Выявляет скрытый текст, скрытые поля ввода, обманные overlay-слои, CSS-сигналы визуальной манипуляции и подозрительные image-presentation сценарии на DOM- и visual-level.

## Архитектура
- `VisualManipulationDetector.js` - точка входа и orchestrator модуля.
- `detectors/hiddenTextDetector.js` - эвристики для скрытого текста.
- `detectors/hiddenInputDetector.js` - эвристики для скрытых полей ввода и editable-поверхностей.
- `detectors/overlayDetector.js` - эвристики для overlay и click-capture слоев.
- `detectors/styleObfuscationDetector.js` - эвристики CSS-обфускации и CSS text-presentation.
- `utils/domUtils.js` - небольшие общие DOM-helper функции модуля.
- `utils/findingFactory.js` - helper-функции для унификации findings модуля.

### Правило доступа к DOM
Детекторы обращаются к DOM только через фасад `module` из scan-контекста: он отдаёт computed-стили,
rect'ы, hit-test стеки, пути элементов, размер вьюпорта, корневой font-size и парсер цвета из
scan-локального кэша. Прямой импорт из `utils/domUtils.js` допустим, но только для функций, которые не
читают layout (например `getElementMarker`, `getNormalizedText`, `isPasswordInput`, `resolveZIndex`,
`findHidingSource` и чистые парсеры). Всё, что вызывало бы `getBoundingClientRect`, `window.innerWidth`,
`documentElement.clientWidth` или `getComputedStyle`, обязано идти через фасад - иначе вызов выпадает из
кэша и может форсировать пересчёт лэйаута на каждом кандидате. Полный перечень обёрток - в комментарии
к фасаду в `VisualManipulationDetector.js`.

## Scope Boundary
- Этот модуль держит DOM- и visual-level проверки: tiny image, hidden image, off-screen image и suspicious inline SVG/image carriers.
- Проверки declared MIME против сигнатуры payload сюда не относятся. Это зона resource-level inspection.
- Семантический анализ валидных изображений, которые скрывают инструкции для AI-систем, пока фиксируется как future scope.

## Текущий статус
- MVP-эвристическая реализация базовых проверок.
- Модуль подключен в runtime и формирует пассивные findings.
- Реального блокирования или активного DOM-вмешательства пока нет.

## Ключи конфигурации
- `enabled`
- `allowIntervention`
- `detectHiddenText`
- `hiddenTextDisplayMode` (`ancestors` по умолчанию, опционально `self`)
- `detectHiddenInputs`
- `detectOverlays`
- `detectDeceptiveCapture`
- `detectStyleObfuscation`
- `trackRemovedBlocks`
- `scanInterval`
- `maxElements`
- `sensitivity`
- `actionOnDetect`

## Текущее поведение
- Постоянный автоматический анализ выполняется только в foreground-вкладке сфокусированного окна Chrome. В фоновых вкладках детекторы приостановлены.
- При потере foreground-статуса модуль отключает observer, отменяет mutation timer и очищает ожидающие mutation records.
- Явный scan приостановленной вкладки является bounded one-shot операцией и не оставляет observer активным.
- Автоматический анализ сейчас выполняется только в main frame и не размножает независимые полные scans по iframe.
- Page-level счётчики и до 10 sanitised visual findings на frame snapshot кэшируются в `chrome.storage.session`; navigation или значимое изменение конфигурации инвалидирует snapshot без пробуждения всех вкладок. Cached finding содержит только ограниченные поля type, локализованные summary/details, severity и detector. URL identity ограничен origin и pathname без query и fragment.
- Сканирует кандидаты на скрытый текст и style-based suppression.
- Для hidden-text сейчас есть отдельные explainable-ветки для:
  - `display: none` (режимы `self` / `ancestors` с явной фиксацией источника в details),
  - `visibility: hidden`,
  - `opacity: 0`,
  - прозрачной заливки глифов (`color: transparent`, цвета с нулевой альфой, `-webkit-text-fill-color`; полоса «почти прозрачный» до alpha 0.05 требует дополнительного контекста),
  - намеренного уноса за пределы экрана (off-screen),
  - suppression через `font-size` (`0`, near-zero и anomalously small с дополнительным контекстом).
- Ветка прозрачного текста намеренно молчит там, где прозрачная заливка — это способ отрисовать видимый текст: градиентный/обрезанный текст (`background-clip: text`) и глифы, нарисованные через `text-shadow` или `-webkit-text-stroke`. Это доказательство видимости, поэтому оно действует при любом объёме текста.
- Слабые признаки трактуются иначе. Объявленные transition/animation или маркер раскрываемого компонента (tooltip, dropdown, menu, modal, accordion, tab, skeleton, ...) говорят лишь о том, что элемент похож на обычную UI-механику: они не доказывают, что текст читаем, и оба тривиально дописываются автором страницы. Такие признаки подавляют отчёт о скрытом тексте только пока текст достаточно короткий, чтобы быть обычной UI-подписью; более крупная закладка сообщается по-прежнему. Решение принимается один раз на элемент, поэтому ветка не может отказаться от случая так, чтобы его подхватила более поздняя и менее точная ветка.
- Цвета текста и фона сравниваются так, как они реально отрисованы: фон собирается композитингом полупрозрачных слоёв до ближайшего непрозрачного (с откатом на белый холст браузера), фоновая картинка или градиент помечают фон как неизвестный и глушат контрастную ветку, а полупрозрачный цвет глифов композитится на этот фон до измерения контраста.
- Для проверки скрытого текста через `display: none` поддерживает два режима:
  - `ancestors` (по умолчанию): проверяет сам элемент и его предков.
  - `self`: проверяет только сам элемент.
- В режиме `ancestors` скрытая область даёт одну находку, а не по находке на каждый скрытый узел. Атрибуция идёт к самому внешнему предку с `display: none`, поэтому вложенные скрытые блоки и все текстовые узлы под ними схлопываются в одну находку, и эта находка называет скрывающий контейнер — просканированный узел приводится лишь как пример скрытого текста.
- Скрытый контейнер, похожий на раскрываемый UI (`role` tabpanel/tab/menu/menuitem/dialog/tooltip/listbox, атрибут `aria-expanded` или `aria-controls`, закрытый `<details>` вокруг него либо маркер компонента), сообщается с пониженной severity, а не подавляется. Структура — более сильный признак, чем имя класса, но её всё равно контролирует автор страницы, поэтому она может стоить уровня severity, но никогда — самой находки.
- В ветке `font-size suppression` low-contrast контекст сейчас поддерживает парсинг цветов для:
  - `rgb()` / `rgba()`,
  - `hsl()` / `hsla()`,
  - `lab()` / `lch()` / `oklab()` / `oklch()`,
  - `currentColor`,
  - hex-цветов (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`).
- Проверяет не-password поля ввода и editable-поверхности на скрытое представление.
- Отмечает вероятные overlay-слои и базовые сигналы CSS-обфускации.
- Выявляет presentation-only CSS spoofing на ограниченном наборе текстовых и интерактивных кандидатов:
  - `unicode-bidi: bidi-override` и `isolate-override`;
  - текстовый `::before` / `::after`, заменяющий подавленную или пустую DOM-подпись;
  - активный `-webkit-text-security` вне password-полей.
- Переиспользует computed style и уже найденные visual-findings текущего элемента через scan-local context. Для pseudo-element style lookup действуют отдельные лимиты initial scan и mutation batch.
- Не декодирует Punycode, не анализирует hostname, не сравнивает подпись с URL, не классифицирует trigger-фразы и не читает значения input.
- Это плановая точка для image-presentation эвристик: `1x1` / `2x2`, hidden image, off-screen image и active inline SVG markers на DOM-уровне.
- Сохраняет последние пассивные findings в статистике модуля.
- Хранит полный счётчик уникальных findings активного scan, даже если сохраняемая история findings ограничена.
- Пользовательские тексты findings локализуются через `_locales/en/messages.json` и `_locales/ru/messages.json`.

## Runtime-матрица конфигурации

| Ключ | Поведение в runtime |
| --- | --- |
| `enabled` | Включает или отключает весь модуль и его observer. |
| `detectHiddenText`, `hiddenTextDisplayMode`, `detectHiddenInputs`, `detectStyleObfuscation` | Независимо включают соответствующие ветки detector'ов; режим display скрытого текста интерпретируется hidden-text detector'ом. |
| `detectOverlays` | Включает full-screen, click-capture, stacking и generic overlay-проверки. |
| `detectDeceptiveCapture` | Включает только проверки deceptive-capture surface. |
| `maxElements` | Ограничивает число детально анализируемых кандидатов в initial scan и каждом mutation batch; невалидное значение заменяется на `250`. |
| `scanInterval` | Задаёт минимальный интервал между накопленными mutation batch; невалидное значение заменяется на `1000` мс. Явный `performScan()` выполняется сразу. |
| `allowIntervention`, `actionOnDetect`, `trackRemovedBlocks`, `sensitivity` | Отложенные параметры: не запускают вмешательство, уведомления, хранение удалённого контента или изменение scoring. |

Runtime-статистика содержит только числовую диагностику candidate budget и ограниченную историю findings. Structural path применяется только для module-local deduplication и не содержит текст, form value, URL или password-данные.

Initial traversal выполняется итеративно и ограничен element- и elapsed-time budgets. Mutation pipeline хранит не более 200 records в ожидающей batch, обходит не более 1000 элементов изменённых поддеревьев и применяет отдельный analysis-time budget. При превышении budget результат помечается как partial и увеличиваются диагностические счётчики вместо создания неограниченного catch-up loop.

## Интеграция с индикатором страницы
- Findings этого модуля должны участвовать в общем page-level индикаторе расширения.
- Каждая найденная проблема увеличивает счетчик action icon на 1. Finding скрытого текста тоже считается одной проблемой.
- Если на странице есть хотя бы одна проблема, иконка расширения должна становиться красной и показывать badge с числом проблем.
- Если findings на странице нет, иконка должна показывать классическую зеленую галочку.

## Ограничения
- `VisualManipulationDetector` должен оставаться публичной точкой входа.
- Не нужно дробить модуль до одного файла на каждую микро-эвристику.
- Небольшие переиспользуемые helper-функции остаются внутри модуля, если не становятся кросс-проектными.
- Нельзя добавлять активное DOM-вмешательство или блокирование без явного согласования.
- Не нужно переносить сюда resource-level MIME- или payload-signature sniffing.

## Примечание
`allowIntervention` пока остается флагом для будущего этапа. На текущем MVP-этапе модуль работает пассивно.

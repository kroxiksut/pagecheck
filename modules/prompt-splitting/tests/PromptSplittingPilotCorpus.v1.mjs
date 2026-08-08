export const PROMPT_SPLITTING_PILOT_CORPUS_VERSION = 1;

export const PROMPT_SPLITTING_PILOT_CORPUS = Object.freeze([
    {
        id: 'P9-CAL-EN-AUTHORITY-001', partition: 'calibration', language: 'en', kind: 'positive',
        fixture: 'article-two-containers', expected: { category: 'authority-impersonation', confidence: 'strong', count: 1, status: 'complete' },
        rationale: 'Baseline multi-container authority directive.'
    },
    {
        id: 'P9-CAL-RU-DISCLOSURE-001', partition: 'calibration', language: 'ru', kind: 'positive',
        fixture: 'comment-two-containers', expected: { category: 'sensitive-disclosure', confidence: 'strong', count: 1, status: 'complete' },
        rationale: 'Russian multi-container disclosure instruction.'
    },
    {
        id: 'P9-CAL-DOC-QUOTE-001', partition: 'calibration', language: 'en', kind: 'benign',
        fixture: 'documentation-quote', expected: { count: 0, status: 'complete' },
        rationale: 'Quoted documentation example must not become a prompt-splitting finding.'
    },
    {
        id: 'P9-CAL-NAV-001', partition: 'calibration', language: 'en', kind: 'benign',
        fixture: 'navigation-breadcrumb', expected: { count: 0, status: 'complete' },
        rationale: 'Navigation context constrains confidence.'
    },
    {
        id: 'P9-REG-SINGLE-001', partition: 'regression', language: 'en', kind: 'benign',
        fixture: 'single-container-match', expected: { count: 0, status: 'complete' },
        rationale: 'Single-container semantic matches remain owned by TriggerPhrases.'
    },
    {
        id: 'P9-REG-COMPACT-001', partition: 'regression', language: 'en', kind: 'benign',
        fixture: 'compact-boundary', expected: { count: 0, status: 'complete' },
        rationale: 'Compact text must not invent a word boundary.'
    },
    {
        id: 'P9-REG-PRIVACY-001', partition: 'regression', language: 'en', kind: 'privacy',
        fixture: 'editable-subtree', expected: { count: 0, status: 'complete' },
        rationale: 'Editable content remains excluded before text collection.'
    },
    {
        id: 'P9-REG-MOVE-001', partition: 'regression', language: 'en', kind: 'dynamic',
        fixture: 'move-between-regions', expected: { count: 1, status: 'complete' },
        rationale: 'Moved chain is re-confirmed in its new region.'
    },
    {
        id: 'P9-CTRL-TABLE-001', partition: 'control', language: 'en', kind: 'benign',
        fixture: 'data-table', expected: { count: 0, status: 'complete' },
        rationale: 'Held-out ordinary table content.'
    },
    {
        id: 'P9-CTRL-CARDS-001', partition: 'control', language: 'en', kind: 'benign',
        fixture: 'repeated-cards', expected: { count: 0, status: 'complete' },
        rationale: 'Held-out repeated card layout.'
    },
    {
        id: 'P9-CTRL-ARIA-001', partition: 'control', language: 'en', kind: 'benign',
        fixture: 'aria-label-surface', expected: { count: 0, status: 'complete' },
        rationale: 'Held-out accessible-label surface.'
    },
    {
        id: 'P9-CTRL-SPA-001', partition: 'control', language: 'en', kind: 'dynamic',
        fixture: 'spa-subtree-replacement', expected: { count: 1, status: 'complete' },
        rationale: 'Held-out dynamic local replacement chain.'
    }
]);

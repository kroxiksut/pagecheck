# Contributing to PageCheck

Thank you for your interest in PageCheck. It is a pre-alpha research project for local detection of hidden instructions, CSS obfuscation, suspicious links, prompt fragments, and related page-level risks.

## Current contribution status

The project is licensed under the Mozilla Public License 2.0 ([LICENSE](LICENSE)). Formal external-contribution terms are not published yet. Please discuss a substantial proposed contribution with the maintainers before opening a pull request. Until terms are published, this document is guidance rather than a request to assign rights through a contribution.

## Before you start

Read [README.md](README.md), [STRUCTURE.md](STRUCTURE.md), and [PACKAGING.md](PACKAGING.md) when the change affects validation or packaging.

## Changes requiring prior discussion

Obtain agreement before a change that adds or renames a function, method, class, or module; changes a public API or architecture; changes UI/styles/icons; changes `manifest.json` or permissions; adds network requests, payload analysis, blocking, active DOM intervention, persistent data collection, or password-field analysis.

## Project-specific constraints

* Preserve local-only analysis and never analyze password fields.
* Keep DOM scans bounded; avoid repeated full-page rescans and heavy synchronous work.
* Preserve module boundaries; do not duplicate a detector owned by another module.
* Add new user-facing strings to both `_locales/en/messages.json` and `_locales/ru/messages.json`.
* Preserve UTF-8 readability in Russian-language files.

Make the smallest agreed change, update nearby documentation, run relevant checks, and include a concise summary, changed files, and test results with a proposed contribution.

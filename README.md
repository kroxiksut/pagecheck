# PageCheck

![Status: pre-alpha](https://img.shields.io/badge/status-pre--alpha-red)
[![License: MPL-2.0](https://img.shields.io/badge/License-MPL--2.0-blue.svg)](https://www.mozilla.org/MPL/2.0/)

> **Pre-alpha research project — use at your own risk.** PageCheck is a pre-alpha Chrome extension for exploring signals of hidden instructions, visual manipulation, suspicious links, unsafe domains, prompt fragments, and related page-level risks. It is not a finished security product and is not a security guarantee.

## Limitations and risks

PageCheck uses local heuristic checks. Its results can be incomplete, inaccurate, or misleading:

* false positives and false negatives are possible;
* unsafe content can be missed;
* a finding is a technical signal, not proof of malicious intent;
* extension bugs, browser changes, or page-specific behavior may reduce performance, interfere with site features, or cause a site to work incorrectly;
* PageCheck must not be the only safeguard for a security-sensitive decision, AI agent, or production workflow.

Review findings independently, test on non-critical pages first, and use the project at your own discretion and risk.

## Status and scope

The project is in pre-alpha development. Its runtime architecture, module configuration, UI, and localization pipeline are present, but many detectors remain heuristic stubs. Treat it as an evolving research framework.

This source has not been validated in a real browser by the maintainers. Only dependency-free Node.js contract checks have been run; no build has been installed and exercised end to end, so expect breakage on first load.

Current modules cover hidden content and visual manipulation, link/domain signals, trigger phrases, prompt splitting, and passive local metadata observation. PageCheck detects presentation and concealment signals; it does not decide whether content is malicious, safe, or truthful. It has no server-side processing, DNS/reputation/blacklist checks, or payload inspection. Page content does not leave the browser through PageCheck, and password fields must not be analyzed.

## Install from source

No build is needed to try the extension.

1. Open `chrome://extensions` in Chrome or another Chromium-based browser.
2. Enable **Developer mode**.
3. Select **Load unpacked** and choose this repository's root directory containing `manifest.json`.
4. After changing source files, select **Reload** for PageCheck.

## Local validation and packaging

Dependency-free Node.js commands for local validation and disposable package directories are documented in [PACKAGING.md](PACKAGING.md) and [PACKAGING.ru.md](PACKAGING.ru.md). They are not CI/CD, do not publish anything, and do not replace manual browser validation. No package build is run as part of the current repository preparation.

## Related project

[Web Security Scenario Lab](https://github.com/kroxiksut/web-security-scenario-lab) is an independent companion project that originated as a controlled scenario environment for developing and testing PageCheck. It is not bundled with PageCheck and is not required to use the extension; follow its own setup and safety documentation.

## Privacy

* All analysis is local.
* Password fields must not be analyzed.
* No external network requests should be introduced without explicit approval.

## Documentation and contribution status

* [Project structure](STRUCTURE.md)
* [Contribution guidance](CONTRIBUTING.md)
* [Русская версия README](README.ru.md)

PageCheck is released under the Mozilla Public License 2.0; the full text is in [LICENSE](LICENSE). Formal external-contribution terms are still pending.

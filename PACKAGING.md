# Local validation and browser packaging

These optional local commands do not publish artifacts, configure CI/CD, or replace manual browser testing. No package build is performed as part of the current repository preparation.

## Prerequisites

Use a current supported Node.js LTS release. The scripts use only Node.js built-in modules, so no package-manager install is required. For ordinary development, load the source directory unpacked through `chrome://extensions`; see [README.md](README.md).

## Commands

Run from the repository root.

```text
node tests/manifest-contract.test.mjs
node tests/release-certification.test.mjs
```

These deterministic checks validate the manifest, target projections, package-inventory rules, and local release-evidence contract. They do not provide browser compatibility or security certification.

```text
node scripts/build-extension.mjs chrome
node scripts/build-extension.mjs edge
node scripts/build-extension.mjs firefox
node scripts/certify-local-release.mjs
```

The builder creates disposable local directories in `dist/<target>/`; both `dist/` and the generated `release/` evidence directory are ignored by Git. The evidence command regenerates local pre-certification records in `release/readiness/<version_name>/`. A generated directory or passing Node.js check is not a release candidate: manually validate every intended browser, review permissions and package inventory, and resolve documented release blockers. The project is licensed under MPL-2.0 (see `LICENSE`); a published-store release process does not exist yet.

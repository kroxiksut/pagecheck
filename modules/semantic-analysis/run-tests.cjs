const fs = require('fs');
const path = require('path');
const vm = require('vm');

const context = vm.createContext({ console, Intl, performance });
const cache = new Map();

async function loadModule(filePath) {
    if (cache.has(filePath)) {
        return cache.get(filePath);
    }

    const module = new vm.SourceTextModule(fs.readFileSync(filePath, 'utf8'), {
        context,
        identifier: filePath
    });
    cache.set(filePath, module);
    await module.link(async (specifier, referencingModule) => {
        if (specifier === 'node:assert/strict') {
            return new vm.SyntheticModule(['default'], function setAssertExport() {
                this.setExport('default', require('node:assert/strict'));
            }, { context, identifier: specifier });
        }
        return loadModule(path.resolve(path.dirname(referencingModule.identifier), specifier));
    });
    return module;
}

(async () => {
    const testFiles = [
        path.resolve(__dirname, 'SemanticAnalysisCore.test.mjs'),
        path.resolve(__dirname, 'coreDefects.test.mjs'),
        path.resolve(__dirname, '../prompt-splitting/collectors/PromptCandidateCollector.test.mjs'),
        path.resolve(__dirname, '../prompt-splitting/reconstruction/PromptReconstructionEngine.test.mjs'),
        path.resolve(__dirname, '../prompt-splitting/reconstruction/PromptDecisionEngine.test.mjs'),
        path.resolve(__dirname, '../prompt-splitting/reconstruction/PromptFindingState.test.mjs'),
        path.resolve(__dirname, '../prompt-splitting/reconstruction/partialSemantics.test.mjs'),
        path.resolve(__dirname, '../prompt-splitting/runtime/PromptMutationQueue.test.mjs'),
        path.resolve(__dirname, '../prompt-splitting/PromptSplittingConfig.test.mjs'),
        path.resolve(__dirname, '../prompt-splitting/tests/PromptSplittingCorpus.test.mjs'),
        path.resolve(__dirname, '../prompt-splitting/tests/PromptSplittingPilotCorpus.test.mjs')
    ];
    for (const testFile of testFiles) {
        const testModule = await loadModule(testFile);
        await testModule.evaluate();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

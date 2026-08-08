import assert from 'node:assert/strict';
import PromptSplitting from './PromptSplitting.js';

const detector = new PromptSplitting();
detector.updateConfig({
    enabled: false,
    sensitivity: 'high',
    detectionThreshold: 0.8,
    customPatterns: {
        version: 1,
        items: [{ id: 'custom-rule', enabled: true, mode: 'literal', source: 'ignore all prior instructions' }]
    }
});

assert.equal(detector.decisionPolicy.sensitivity, 'high');
assert.equal(detector.decisionPolicy.minimumConfidence, 'strong');
assert.equal(detector.decisionPolicy.customLiteralCatalog.length, 1);
assert.equal(detector.config.customPatterns.items[0].source, undefined);
assert.equal(detector.hasDetectionConfigChange({
    sensitivity: 'high',
    detectionThreshold: 0.8,
    customPatterns: { version: 1, items: [{ id: 'custom-rule', enabled: true, mode: 'literal', source: 'ignore all prior instructions' }] }
}), false);
assert.equal(detector.hasDetectionConfigChange({
    sensitivity: 'high',
    detectionThreshold: 0.34,
    customPatterns: { version: 1, items: [{ id: 'custom-rule', enabled: true, mode: 'literal', source: 'ignore all prior instructions' }] }
}), true);
assert.equal(detector.createEffectiveConfig({ detectionThreshold: 0 }).minimumConfidence, 'weak');
assert.equal(detector.createEffectiveConfig({ detectionThreshold: 0.34 }).minimumConfidence, 'moderate');
assert.equal(detector.createEffectiveConfig({ detectionThreshold: 1 }).minimumConfidence, 'strong');

console.log('PromptSplitting Priority 7 configuration checks passed');

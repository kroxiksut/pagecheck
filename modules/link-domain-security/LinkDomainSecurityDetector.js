import ModuleCore from '../ModuleCore.js';
import { Logger } from '../../utils/logger.js';
import { inspectCurrentHostname, inspectTargetHostname } from './detectors/hostnameSecurityDetector.js';
import { inspectNavigationTarget } from './detectors/navigationTargetDetector.js';
import { inspectVisibleTargetMismatch } from './detectors/visibleMismatchDetector.js';
import {
    analyzeHostname,
    hasVisibleTargetMismatch,
    isUnsafeProtocol
} from './utils/domainUtils.js';
import { createFinding, normalizeFindings } from './utils/findingFactory.js';
import { hasRedirectPattern, parseUrl } from './utils/urlUtils.js';

const LINK_TEXT_PRIVACY_SELECTOR = 'input, textarea, select, option, optgroup, [contenteditable]:not([contenteditable="false"]), [role="textbox" i]';

export default class LinkDomainSecurityDetector extends ModuleCore {
    constructor() {
        super('Link-Domain-Security', true);
        this.usesMutationObserver = true;
        this.maxRecordedFindings = 20;
        this.maxSerializedFindings = 10;
        this.maxInitialElements = 20000;
        this.maxInitialCandidates = 3000;
        this.maxMutationElements = 1000;
        this.maxMutationCandidates = 300;
        this.maxPendingMutationRecords = 200;
        this.maxMutationNodesPerRecord = 100;
        this.maxMutationNodesPerBatch = 1000;
        this.maxPendingMutationRoots = 100;
        this.maxRawTargetCharacters = 8192;
        this.maxLinkTextCharacters = 2048;
        this.maxLinkTextNodes = 64;
        this.initialScanTimeBudgetMs = 100;
        this.mutationScanTimeBudgetMs = 25;
        this.mutationThrottle = 500;
        this.recentFindings = [];
        this.pendingMutationRoots = new Set();
        this.mutationBatchTimer = null;
        this.processedCandidateElements = new WeakSet();
        this.scanRevision = 0;
        this.currentElementLimit = this.maxInitialElements;
        this.currentCandidateLimit = this.maxInitialCandidates;
        this.currentElementsVisited = 0;
        this.currentCandidatesAnalyzed = 0;
        this.currentScanDeadline = Number.POSITIVE_INFINITY;
        this.scanTimeBudgetReachedInBatch = false;
        this.resetWorkStats();
    }

    async firstScan() {
        if (!this.isEnabled) {
            return;
        }

        const startTime = performance.now();
        this.resetStats();
        this.recentFindings = [];
        this.resetWorkStats();
        this.beginScanBatch(
            this.maxInitialElements,
            this.maxInitialCandidates,
            this.initialScanTimeBudgetMs
        );

        try {
            this.inspectCurrentLocation();
        } catch {
            Logger.warn(`[${this.moduleName}] Current hostname analysis skipped after an internal error`);
        }

        try {
            this.collectCandidatesFromRoot(document.documentElement);
            this.scanRevision += 1;

            const duration = performance.now() - startTime;
            this.stats.lastScanTime = duration;
            this.stats.totalScanTime = duration;

            Logger.info(`[${this.moduleName}] Target scan completed: ${this.currentCandidatesAnalyzed} candidates, ${this.currentElementsVisited} DOM elements, ${duration.toFixed(2)}ms`);
        } catch (error) {
            Logger.error(`[${this.moduleName}] Target scan failed:`, error);
            throw error;
        } finally {
            this.processedCandidateElements = new WeakSet();
        }
    }

    async performScan() {
        await this.firstScan();
        return {
            module: this.moduleName,
            threatsDetected: this.stats.threatsDetected,
            findings: this.recentFindings.slice(0, this.maxSerializedFindings),
            findingsTruncated: this.recentFindings.length > this.maxSerializedFindings,
            revision: this.scanRevision,
            ...this.getSnapshotState(),
            stats: this.getStats()
        };
    }

    scanElement(element) {
        if (!(element instanceof Element)
            || !this.isEnabled
            || this.processedCandidateElements.has(element)
            || this.isTimeBudgetReached()) {
            return;
        }

        const isLink = element.matches('a[href]');
        const isForm = !isLink && element.matches('form[action]');
        if (!isLink && !isForm) {
            return;
        }

        this.processedCandidateElements.add(element);
        if (this.currentCandidatesAnalyzed >= this.currentCandidateLimit) {
            this.candidatesSkippedByLimit += 1;
            return;
        }

        const rawTarget = element.getAttribute(isLink ? 'href' : 'action');
        if (typeof rawTarget === 'string' && rawTarget.length > this.maxRawTargetCharacters) {
            this.targetsSkippedByLength += 1;
            return;
        }

        this.currentCandidatesAnalyzed += 1;
        this.stats.elementsScanned += 1;
        const linkText = isLink && !element.matches(LINK_TEXT_PRIVACY_SELECTOR)
            ? this.getBoundedLinkText(element)
            : '';
        if (this.isTimeBudgetReached()) {
            return;
        }
        this.inspectTarget(element, rawTarget, linkText);
    }

    collectCandidatesFromRoot(root) {
        if (!(root instanceof Element) || !root.isConnected || !this.isEnabled) {
            return;
        }

        const pendingElements = [root];
        while (pendingElements.length > 0) {
            if (this.currentElementsVisited >= this.currentElementLimit) {
                this.elementsSkippedByLimit += pendingElements.length;
                break;
            }
            if (this.isTimeBudgetReached()) {
                this.elementsSkippedByTime += pendingElements.length;
                break;
            }

            const element = pendingElements.pop();
            if (!element.isConnected) {
                continue;
            }

            this.currentElementsVisited += 1;
            try {
                this.scanElement(element);
            } catch {
                Logger.warn(`[${this.moduleName}] Target candidate skipped after an internal error`);
            }

            for (let index = element.children.length - 1; index >= 0; index -= 1) {
                pendingElements.push(element.children[index]);
            }
        }
    }

    getBoundedLinkText(element) {
        const textParts = [];
        const pendingNodes = [];
        let charactersCollected = 0;
        let nodesVisited = 0;
        let truncated = false;

        for (let index = element.childNodes.length - 1; index >= 0; index -= 1) {
            pendingNodes.push(element.childNodes[index]);
        }

        while (pendingNodes.length > 0) {
            if (nodesVisited >= this.maxLinkTextNodes || this.isTimeBudgetReached()) {
                truncated = true;
                break;
            }

            const node = pendingNodes.pop();
            nodesVisited += 1;
            if (node.nodeType === Node.TEXT_NODE) {
                const text = node.textContent || '';
                const remainingCharacters = this.maxLinkTextCharacters - charactersCollected;
                if (remainingCharacters <= 0) {
                    truncated = true;
                    break;
                }
                if (text.length > remainingCharacters) {
                    textParts.push(text.slice(0, remainingCharacters));
                    truncated = true;
                    break;
                }
                textParts.push(text);
                charactersCollected += text.length;
                continue;
            }

            if (!(node instanceof Element) || node.matches(LINK_TEXT_PRIVACY_SELECTOR)) {
                continue;
            }
            for (let index = node.childNodes.length - 1; index >= 0; index -= 1) {
                pendingNodes.push(node.childNodes[index]);
            }
        }

        if (truncated) {
            this.linkTextsTruncated += 1;
        }
        return textParts.join('');
    }

    inspectCurrentLocation() {
        const findings = normalizeFindings(inspectCurrentHostname({ module: this }));
        this.stats.threatsDetected += findings.length;
        findings.forEach((finding) => this.recordFinding(finding));
    }

    inspectTarget(element, rawTarget, linkText) {
        if (typeof rawTarget !== 'string' || rawTarget.trim() === '' || rawTarget.trim().startsWith('#')) {
            return;
        }

        const targetUrl = this.parseUrl(rawTarget);
        if (!targetUrl) {
            return;
        }

        const requiresHostnameAnalysis = targetUrl.hostname && (
            this.config.detectHomographs || (
                this.config.detectLinkMismatch &&
                element.matches('a[href]') &&
                linkText.trim() &&
                (targetUrl.protocol === 'http:' || targetUrl.protocol === 'https:')
            )
        );
        const hostnameAnalysis = requiresHostnameAnalysis ? this.analyzeHostname(targetUrl.hostname) : null;
        const context = { element, targetUrl, hostnameAnalysis, linkText, module: this };
        const findings = [
            ...inspectNavigationTarget(context),
            ...inspectTargetHostname(context)
        ];

        if (element.matches('a[href]') && linkText.trim()) {
            findings.push(...inspectVisibleTargetMismatch(context));
        }

        if (findings.length === 0) {
            return;
        }

        const normalizedFindings = normalizeFindings(findings);
        this.stats.threatsDetected += normalizedFindings.length;
        normalizedFindings.forEach((finding) => this.recordFinding(finding));
    }

    handleMutations(mutations) {
        if (!this.isEnabled) {
            return;
        }

        const recordLimit = Math.min(mutations.length, this.maxPendingMutationRecords);
        if (mutations.length > recordLimit) {
            this.mutationRecordsSkippedByLimit += mutations.length - recordLimit;
        }

        let mutationNodesInspected = 0;
        mutationLoop:
        for (let mutationIndex = 0; mutationIndex < recordLimit; mutationIndex += 1) {
            const mutation = mutations[mutationIndex];
            if (mutation.type !== 'childList') {
                continue;
            }

            const nodeLimit = Math.min(
                mutation.addedNodes.length,
                this.maxMutationNodesPerRecord,
                Math.max(0, this.maxMutationNodesPerBatch - mutationNodesInspected)
            );
            if (mutation.addedNodes.length > nodeLimit) {
                this.mutationNodesSkippedByLimit += mutation.addedNodes.length - nodeLimit;
            }
            for (let nodeIndex = 0; nodeIndex < nodeLimit; nodeIndex += 1) {
                if (this.pendingMutationRoots.size >= this.maxPendingMutationRoots) {
                    this.mutationRootsSkippedByLimit += 1;
                    this.mutationRecordsSkippedByLimit += recordLimit - mutationIndex;
                    break mutationLoop;
                }
                const node = mutation.addedNodes[nodeIndex];
                mutationNodesInspected += 1;
                if (node instanceof Element && node.isConnected) {
                    this.addMutationRoot(node);
                }
            }
            if (mutationNodesInspected >= this.maxMutationNodesPerBatch) {
                this.mutationRecordsSkippedByLimit += Math.max(0, recordLimit - mutationIndex - 1);
                break;
            }
        }

        if (this.pendingMutationRoots.size > 0) {
            this.scheduleMutationBatch();
        }
    }

    processMutation(mutation) {
        this.handleMutations([mutation]);
    }

    addMutationRoot(root) {
        for (const pendingRoot of this.pendingMutationRoots) {
            if (pendingRoot.contains(root)) {
                return;
            }
        }

        for (const pendingRoot of [...this.pendingMutationRoots]) {
            if (root.contains(pendingRoot)) {
                this.pendingMutationRoots.delete(pendingRoot);
            }
        }

        if (this.pendingMutationRoots.size >= this.maxPendingMutationRoots) {
            this.mutationRootsSkippedByLimit += 1;
            return;
        }
        this.pendingMutationRoots.add(root);
    }

    scheduleMutationBatch() {
        if (this.mutationBatchTimer !== null) {
            return;
        }

        const delay = Math.max(0, this.mutationThrottle - (Date.now() - this.lastMutationTime));
        this.mutationBatchTimer = setTimeout(() => {
            this.mutationBatchTimer = null;
            const roots = [...this.pendingMutationRoots];
            this.pendingMutationRoots.clear();
            if (roots.length === 0 || !this.isEnabled) {
                return;
            }

            this.lastMutationTime = Date.now();
            this.processMutationRoots(roots);
            if (this.pendingMutationRoots.size > 0) {
                this.scheduleMutationBatch();
            }
        }, delay);
    }

    processMutationRoots(roots) {
        const startTime = performance.now();
        this.beginScanBatch(
            this.maxMutationElements,
            this.maxMutationCandidates,
            this.mutationScanTimeBudgetMs
        );

        try {
            for (const root of roots) {
                if (this.isTimeBudgetReached()) {
                    this.mutationRootsSkippedByTime += 1;
                    break;
                }
                this.collectCandidatesFromRoot(root);
            }
            this.scanRevision += 1;
            const duration = performance.now() - startTime;
            this.stats.totalScanTime += duration;
            this.stats.lastScanTime = duration;
        } catch (error) {
            Logger.error(`[${this.moduleName}] Error processing mutation roots:`, error);
        } finally {
            this.processedCandidateElements = new WeakSet();
        }
    }

    beginScanBatch(elementLimit, candidateLimit, timeBudgetMs) {
        this.currentElementLimit = elementLimit;
        this.currentCandidateLimit = candidateLimit;
        this.currentElementsVisited = 0;
        this.currentCandidatesAnalyzed = 0;
        this.currentScanDeadline = performance.now() + timeBudgetMs;
        this.scanTimeBudgetReachedInBatch = false;
        this.processedCandidateElements = new WeakSet();
    }

    isTimeBudgetReached() {
        if (performance.now() <= this.currentScanDeadline) {
            return false;
        }

        if (!this.scanTimeBudgetReachedInBatch) {
            this.scanTimeBudgetReached += 1;
            this.scanTimeBudgetReachedInBatch = true;
        }
        return true;
    }

    resetWorkStats() {
        this.candidatesSkippedByLimit = 0;
        this.elementsSkippedByLimit = 0;
        this.elementsSkippedByTime = 0;
        this.targetsSkippedByLength = 0;
        this.linkTextsTruncated = 0;
        this.mutationRecordsSkippedByLimit = 0;
        this.mutationNodesSkippedByLimit = 0;
        this.mutationRootsSkippedByLimit = 0;
        this.mutationRootsSkippedByTime = 0;
        this.scanTimeBudgetReached = 0;
    }

    getSnapshotState() {
        const partialResult = this.candidatesSkippedByLimit > 0
            || this.elementsSkippedByLimit > 0
            || this.elementsSkippedByTime > 0
            || this.targetsSkippedByLength > 0
            || this.linkTextsTruncated > 0
            || this.mutationRecordsSkippedByLimit > 0
            || this.mutationNodesSkippedByLimit > 0
            || this.mutationRootsSkippedByLimit > 0
            || this.mutationRootsSkippedByTime > 0
            || this.scanTimeBudgetReached > 0;

        return {
            status: partialResult ? 'partial' : 'complete',
            partialResult,
            budgetReached: partialResult
        };
    }

    onDestroy() {
        if (this.mutationBatchTimer !== null) {
            clearTimeout(this.mutationBatchTimer);
            this.mutationBatchTimer = null;
        }
        this.pendingMutationRoots.clear();
        this.processedCandidateElements = new WeakSet();
        this.currentScanDeadline = Number.NEGATIVE_INFINITY;
        this.recentFindings = [];
    }

    parseUrl(rawTarget) {
        return parseUrl(rawTarget);
    }

    isUnsafeProtocol(protocol) {
        return isUnsafeProtocol(protocol);
    }

    hasRedirectPattern(targetUrl) {
        return hasRedirectPattern(targetUrl);
    }

    analyzeHostname(hostname) {
        return analyzeHostname(hostname);
    }

    hasVisibleTargetMismatch(linkText, hostname, hostnameAnalysis) {
        return hasVisibleTargetMismatch(linkText, hostname, hostnameAnalysis);
    }

    recordFindingForElement(type, summary, element) {
        this.stats.threatsDetected += 1;
        this.recordFinding(createFinding({
            type,
            summary,
            details: this.describeElement(element),
            severity: 'medium',
            detector: 'LinkDomainSecurityDetector'
        }));
    }

    describeElement(element) {
        const tag = element.tagName.toLowerCase();
        return `<${tag}>`;
    }

    recordFinding(finding) {
        this.recentFindings.unshift({
            ...finding,
            timestamp: Date.now()
        });

        if (this.recentFindings.length > this.maxRecordedFindings) {
            this.recentFindings = this.recentFindings.slice(0, this.maxRecordedFindings);
        }
    }

    getStats() {
        return {
            ...super.getStats(),
            recentFindings: this.recentFindings.slice(0, 5),
            scanRevision: this.scanRevision,
            elementsVisited: this.currentElementsVisited,
            candidatesAnalyzed: this.currentCandidatesAnalyzed,
            candidatesSkippedByLimit: this.candidatesSkippedByLimit,
            elementsSkippedByLimit: this.elementsSkippedByLimit,
            elementsSkippedByTime: this.elementsSkippedByTime,
            targetsSkippedByLength: this.targetsSkippedByLength,
            linkTextsTruncated: this.linkTextsTruncated,
            mutationRecordsSkippedByLimit: this.mutationRecordsSkippedByLimit,
            mutationNodesSkippedByLimit: this.mutationNodesSkippedByLimit,
            mutationRootsSkippedByLimit: this.mutationRootsSkippedByLimit,
            mutationRootsSkippedByTime: this.mutationRootsSkippedByTime,
            scanTimeBudgetReached: this.scanTimeBudgetReached,
            findingsTruncated: this.recentFindings.length > this.maxSerializedFindings,
            ...this.getSnapshotState()
        };
    }
}

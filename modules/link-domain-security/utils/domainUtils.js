export function isUnsafeProtocol(protocol) {
    const normalizedProtocol = String(protocol || '').toLowerCase();

    if (normalizedProtocol === 'javascript:') {
        return { protocol: normalizedProtocol, severity: 'high' };
    }

    if (normalizedProtocol === 'data:' || normalizedProtocol === 'file:') {
        return { protocol: normalizedProtocol, severity: 'medium' };
    }

    return null;
}

export function analyzeHostname(hostname) {
    const normalizedHostname = normalizeHostname(hostname);
    const labels = getHostnameLabels(normalizedHostname);

    if (isExcludedHostname(normalizedHostname, labels)) {
        return null;
    }

    const punycodeLabels = labels.filter((label) => label.startsWith('xn--'));
    const decodedLabels = labels.map((label) => {
        if (!label.startsWith('xn--')) {
            return label;
        }

        return decodePunycodeLabel(label) || label;
    });
    const mixedScriptLabels = decodedLabels.filter(hasLatinAndCyrillicLetters);

    return {
        originalHostname: String(hostname || ''),
        normalizedHostname,
        labels,
        punycodeLabels,
        decodedLabels,
        mixedScriptLabels,
        hasPunycode: punycodeLabels.length > 0,
        hasMixedScript: mixedScriptLabels.length > 0
    };
}

export function hasVisibleTargetMismatch(linkText, hostname, hostnameAnalysis = null) {
    const normalizedText = normalizeVisibleText(linkText);
    const targetHostname = normalizeComparableHostname(hostname);

    if (!normalizedText.normalizedText || !targetHostname) {
        return {
            eligible: false,
            matches: false,
            visibleHostname: '',
            targetHostname,
            normalizedText: normalizedText.normalizedText,
            originalText: normalizedText.originalText,
            mismatchReason: 'empty-input'
        };
    }

    const visibleHostname = extractVisibleHostname(normalizedText.normalizedText);
    if (!visibleHostname) {
        return {
            eligible: false,
            matches: false,
            visibleHostname: '',
            targetHostname,
            normalizedText: normalizedText.normalizedText,
            originalText: normalizedText.originalText,
            mismatchReason: 'not-domain-like'
        };
    }

    const targetHostnames = getComparableTargetHostnames(targetHostname, hostnameAnalysis);
    const matches = targetHostnames.some((candidate) => hostnameMatches(visibleHostname, candidate));

    return {
        eligible: true,
        matches,
        visibleHostname,
        targetHostname,
        normalizedText: normalizedText.normalizedText,
        originalText: normalizedText.originalText,
        mismatchReason: matches ? '' : 'hostname-mismatch'
    };
}

function normalizeHostname(hostname) {
    return String(hostname || '')
        .trim()
        .toLowerCase()
        .replace(/\.$/, '');
}

function getHostnameLabels(hostname) {
    if (!hostname) {
        return [];
    }

    return hostname
        .split('.')
        .map((label) => label.trim())
        .filter(Boolean);
}

function isExcludedHostname(hostname, labels) {
    if (!hostname || labels.length === 0) {
        return true;
    }

    if (hostname === 'localhost' || labels.length === 1) {
        return true;
    }

    return isIpv4Hostname(hostname) || isIpv6Hostname(hostname);
}

function isIpv4Hostname(hostname) {
    const parts = hostname.split('.');
    if (parts.length !== 4) {
        return false;
    }

    return parts.every((part) => {
        if (!/^\d+$/.test(part)) {
            return false;
        }

        const value = Number(part);
        return value >= 0 && value <= 255;
    });
}

function isIpv6Hostname(hostname) {
    const normalized = hostname.replace(/^\[/, '').replace(/\]$/, '');
    return normalized.includes(':') && /^[0-9a-f:]+$/i.test(normalized);
}

function decodePunycodeLabel(label) {
    const input = label.slice(4);
    const delimiterIndex = input.lastIndexOf('-');
    const output = [];

    if (delimiterIndex >= 0) {
        for (let inputIndex = 0; inputIndex < delimiterIndex; inputIndex += 1) {
            output.push(input.charCodeAt(inputIndex));
        }
    }

    let inputIndex = delimiterIndex >= 0 ? delimiterIndex + 1 : 0;
    let insertionIndex = 0;
    let codePoint = 128;
    let bias = 72;

    while (inputIndex < input.length) {
        const oldInsertionIndex = insertionIndex;
        let weight = 1;

        for (let base = 36; ; base += 36) {
            if (inputIndex >= input.length) {
                return '';
            }

            const digit = decodePunycodeDigit(input.charCodeAt(inputIndex));
            inputIndex += 1;

            if (digit >= 36) {
                return '';
            }

            insertionIndex += digit * weight;

            if (insertionIndex > Number.MAX_SAFE_INTEGER) {
                return '';
            }

            const threshold = base <= bias ? 1 : (base >= bias + 26 ? 26 : base - bias);
            if (digit < threshold) {
                break;
            }

            weight *= 36 - threshold;
        }

        const outputLength = output.length + 1;
        bias = adaptPunycodeBias(insertionIndex - oldInsertionIndex, outputLength, oldInsertionIndex === 0);
        codePoint += Math.floor(insertionIndex / outputLength);

        if (codePoint > 0x10ffff) {
            return '';
        }

        insertionIndex %= outputLength;
        output.splice(insertionIndex, 0, codePoint);
        insertionIndex += 1;
    }

    return String.fromCodePoint(...output);
}

function decodePunycodeDigit(codePoint) {
    if (codePoint >= 48 && codePoint <= 57) {
        return codePoint - 22;
    }

    if (codePoint >= 65 && codePoint <= 90) {
        return codePoint - 65;
    }

    if (codePoint >= 97 && codePoint <= 122) {
        return codePoint - 97;
    }

    return 36;
}

function adaptPunycodeBias(delta, numPoints, isFirstTime) {
    let adjustedDelta = isFirstTime ? Math.floor(delta / 700) : delta >> 1;
    adjustedDelta += Math.floor(adjustedDelta / numPoints);

    let base = 0;
    while (adjustedDelta > 455) {
        adjustedDelta = Math.floor(adjustedDelta / 35);
        base += 36;
    }

    return base + Math.floor((36 * adjustedDelta) / (adjustedDelta + 38));
}

function hasLatinAndCyrillicLetters(label) {
    return /[a-z]/i.test(label) && /[\u0400-\u04ff]/i.test(label);
}
function normalizeVisibleText(linkText) {
    const originalText = String(linkText || '');
    let normalizedText = originalText.replace(/\s+/g, ' ').trim();
    normalizedText = normalizedText.replace(/[.,;:!?]+$/u, '').trim();
    normalizedText = stripMatchedWrapper(normalizedText);
    normalizedText = normalizedText.replace(/[.,;:!?]+$/u, '').trim().toLowerCase();

    return { originalText, normalizedText };
}

function stripMatchedWrapper(text) {
    const wrapperPairs = [
        ['(', ')'],
        ['[', ']'],
        ['{', '}'],
        ['"', '"'],
        ["'", "'"],
        ['«', '»'],
        ['“', '”'],
        ['‘', '’']
    ];

    let strippedText = text;
    let changed = true;

    while (changed && strippedText.length >= 2) {
        changed = false;

        for (const [open, close] of wrapperPairs) {
            if (strippedText.startsWith(open) && strippedText.endsWith(close)) {
                strippedText = strippedText.slice(open.length, -close.length).trim();
                changed = true;
                break;
            }
        }
    }

    return strippedText;
}

function extractVisibleHostname(text) {
    if (!text || /\s/u.test(text)) {
        return '';
    }

    const urlLikeMatch = text.match(/^https?:\/\/([^/?#]+)(?:[/?#].*)?$/iu);
    const domainText = urlLikeMatch ? urlLikeMatch[1] : text.replace(/^(?:\/\/)/u, '').split(/[/?#]/u)[0];
    const normalizedHostname = normalizeComparableHostname(domainText);

    if (!normalizedHostname || !isDomainLikeHostname(normalizedHostname)) {
        return '';
    }

    return normalizedHostname;
}

function normalizeComparableHostname(hostname) {
    return String(hostname || '')
        .trim()
        .toLowerCase()
        .replace(/^www\./u, '')
        .replace(/\.$/, '');
}

function isDomainLikeHostname(hostname) {
    if (!hostname.includes('.') || hostname.startsWith('.') || hostname.endsWith('.')) {
        return false;
    }

    if (/[:@\s]/u.test(hostname)) {
        return false;
    }

    return hostname
        .split('.')
        .every((label) => /^[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?$/u.test(label));
}

function getComparableTargetHostnames(targetHostname, hostnameAnalysis) {
    const candidates = new Set([targetHostname]);

    if (hostnameAnalysis?.decodedLabels?.length) {
        candidates.add(normalizeComparableHostname(hostnameAnalysis.decodedLabels.join('.')));
    }

    return Array.from(candidates).filter(Boolean);
}

function hostnameMatches(visibleHostname, targetHostname) {
    return targetHostname === visibleHostname || targetHostname.endsWith(`.${visibleHostname}`);
}
(function initializeLearningPrivacy(root, factory) {
  const privacy = factory();
  root.WebMcpLearningPrivacy = privacy;
  if (typeof module === 'object' && module.exports) {
    module.exports = privacy;
  }
}(typeof globalThis === 'undefined' ? this : globalThis, () => {
  'use strict';

  const ATTRIBUTE_ALLOWLIST = new Set([
    'aria-checked',
    'aria-controls',
    'aria-current',
    'aria-describedby',
    'aria-expanded',
    'aria-label',
    'aria-labelledby',
    'aria-selected',
    'data-component-type',
    'data-field',
    'data-product-card',
    'data-product-id',
    'data-testid',
    'href',
    'itemprop',
    'name',
    'placeholder',
    'role',
    'type',
  ]);
  const INPUT_TYPES = new Set(['checkbox', 'radio']);
  const SENSITIVE_FIELD = /(?:address|auth|card|credential|cvv|cvc|email|login|name|pass|phone|postal|secret|ssn|tel|token)/i;
  const SENSITIVE_PATTERNS = Object.freeze([
    ['email', /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi],
    ['payment', /\b(?:\d[ -]*?){13,19}\b/g],
    ['phone', /(?:\+?\d[\d(). -]{7,}\d)/g],
    ['credential', /\b(?:bearer\s+)?(?:sk|pk|api|key|token|secret|password|passwd|credential|canary)[-_:./a-z0-9]{4,}\b/gi],
    ['address', /\b\d{1,6}\s+[A-Z0-9][A-Z0-9 .'-]{2,}\s(?:avenue|ave|boulevard|blvd|court|ct|drive|dr|lane|ln|road|rd|street|st|way)\b/gi],
    ['account', /\b(?:account|order|customer|session)[-_ ]?(?:id|number)?[:# -]*[A-Z0-9-]{8,}\b/gi],
  ]);
  const SENSITIVE_IDENTIFIER_PATTERNS = Object.freeze([
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
    /(?:^|[^a-z0-9])(?:account|auth|credential|customer|key|login|order|password|secret|session|token|user)[-_.:@/][a-z0-9][a-z0-9_.:@/-]{3,}/i,
    /[a-z0-9][a-z0-9_.:@/-]{3,}[-_.:@/](?:auth|credential|key|order|password|secret|session|token)(?:$|[^a-z0-9])/i,
  ]);
  const SECRET_MARKER = '[redacted]';

  const normalizeText = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

  const truncate = (value, limit = 320) => {
    const normalized = normalizeText(value);
    return normalized.length <= limit
      ? normalized
      : `${normalized.slice(0, limit - 1).trimEnd()}…`;
  };

  const createLedger = (initial = null) => {
    const counts = Object.assign(Object.create(null), initial?.counts || {});
    let total = Object.values(counts).reduce((sum, count) => (
      sum + (Number.isInteger(count) && count > 0 ? count : 0)
    ), 0);
    const record = (category, amount = 1) => {
      if (!Number.isInteger(amount) || amount < 1) return;
      counts[category] = (counts[category] || 0) + amount;
      total += amount;
    };
    const summary = () => ({
      schemaVersion: 'redaction-ledger/1',
      total,
      counts: Object.fromEntries(Object.entries(counts).sort(([left], [right]) => (
        left.localeCompare(right)
      ))),
    });
    return Object.freeze({ record, summary });
  };

  const argumentName = (element) => {
    const candidates = [
      element?.getAttribute?.('name'),
      element?.getAttribute?.('aria-label'),
      element?.getAttribute?.('placeholder'),
      element?.id,
    ].filter(Boolean).join(' ').toLowerCase();
    if (/\b(?:q|query|search|term|keyword)s?\b/.test(candidates)) return 'query';
    if (/\b(?:count|quantity|qty|number)\b/.test(candidates)) return 'quantity';
    if (/\b(?:category|kind|type)\b/.test(candidates)) return 'category';
    const preferred = element?.getAttribute?.('name') || element?.id || 'value';
    const normalized = String(preferred)
      .replace(/[^a-zA-Z0-9]+(.)?/g, (_match, next) => next ? next.toUpperCase() : '')
      .replace(/^[^a-zA-Z]+/, '')
      .replace(/^./, (character) => character.toLowerCase());
    return normalized || 'value';
  };

  const argumentToken = (name) => `{{arg.${name}}}`;

  const fieldValue = (element) => {
    if (!element) return null;
    const type = String(element.getAttribute?.('type') || '').toLowerCase();
    if (INPUT_TYPES.has(type)) return Boolean(element.checked);
    if ('value' in element) return element.value;
    if (element.isContentEditable) return element.textContent;
    return null;
  };

  const collectArguments = (document) => {
    const argumentsByValue = new Map();
    const add = (name, rawValue) => {
      const normalized = normalizeText(rawValue);
      if (!normalized || normalized.length < 2) return;
      argumentsByValue.set(normalized, argumentToken(name));
    };
    try {
      const url = new URL(document.location.href);
      url.searchParams.forEach((value, key) => add(
        /^(?:q|query|search|term|keyword)$/i.test(key) ? 'query' : key,
        value,
      ));
    } catch (error) {
      // An invalid document URL contributes no argument candidates.
    }
    document.querySelectorAll([
      'input:not([type="hidden"]):not([type="password"])',
      'select',
      'textarea',
      '[contenteditable="true"]',
    ].join(',')).forEach((element) => {
      if (!SENSITIVE_FIELD.test([
        element.getAttribute('autocomplete'),
        element.getAttribute('name'),
        element.id,
        element.getAttribute('type'),
      ].filter(Boolean).join(' '))) {
        add(argumentName(element), fieldValue(element));
      }
    });
    return argumentsByValue;
  };

  const replaceArguments = (value, argumentsByValue, ledger) => {
    let output = String(value ?? '');
    [...(argumentsByValue || new Map()).entries()]
      .sort(([left], [right]) => right.length - left.length)
      .forEach(([rawValue, token]) => {
        if (!output.includes(rawValue)) return;
        output = output.split(rawValue).join(token);
        ledger?.record('argument');
      });
    return output;
  };

  const sanitizeText = (value, {
    argumentsByValue = new Map(),
    ledger,
    limit = 320,
  } = {}) => {
    let output = replaceArguments(normalizeText(value), argumentsByValue, ledger);
    SENSITIVE_PATTERNS.forEach(([category, pattern]) => {
      pattern.lastIndex = 0;
      let matches = 0;
      output = output.replace(pattern, () => {
        matches += 1;
        return SECRET_MARKER;
      });
      if (matches > 0) ledger?.record(category, matches);
    });
    return truncate(output, limit);
  };

  const sensitiveIdentifier = (value) => {
    const source = String(value ?? '');
    let decoded = source;
    try {
      decoded = decodeURIComponent(source);
    } catch (error) {
      // Test the undecoded source when a site provides malformed escaping.
    }
    return SENSITIVE_IDENTIFIER_PATTERNS.some((pattern) => pattern.test(decoded));
  };

  const sanitizeUrl = (value, ledger) => {
    try {
      const url = new URL(value);
      if (url.search || url.hash || url.username || url.password) ledger?.record('url');
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      const pathname = url.pathname.split('/').map((part) => {
        let decoded = part;
        try {
          decoded = decodeURIComponent(part);
        } catch (error) {
          // The raw segment remains subject to the same identifier checks.
        }
        if (sensitiveIdentifier(decoded)) {
          ledger?.record('url_path');
          return ':redacted';
        }
        const sanitized = sanitizeText(decoded, { ledger, limit: 180 });
        if (sanitized !== decoded) {
          ledger?.record('url_path');
          return ':redacted';
        }
        if (/^[a-z0-9_-]{25,}$/i.test(decoded)) {
          ledger?.record('url_path');
          return ':id';
        }
        return decoded;
      }).map((part) => encodeURIComponent(part).replace(/%3A/gi, ':')).join('/');
      return `${url.origin}${pathname}`;
    } catch (error) {
      ledger?.record('url');
      return '';
    }
  };

  const sanitizeAttributes = (attributes, context = {}) => Object.fromEntries(
    Object.entries(attributes || {}).flatMap(([name, value]) => {
      if (!ATTRIBUTE_ALLOWLIST.has(name)) {
        context.ledger?.record('attribute');
        return [];
      }
      let sanitized;
      if (name === 'href') {
        sanitized = sanitizeUrl(value, context.ledger);
      } else if (sensitiveIdentifier(value)) {
        context.ledger?.record('identifier');
        sanitized = SECRET_MARKER;
      } else {
        sanitized = sanitizeText(value, { ...context, limit: 180 });
      }
      return sanitized ? [[name, sanitized]] : [];
    }),
  );

  const valueTypeFor = (value) => {
    if (typeof value === 'boolean') return 'boolean';
    if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
    return 'string';
  };

  const tokenizeInput = (element, ledger) => {
    const rawValue = fieldValue(element);
    const name = argumentName(element);
    const token = argumentToken(name);
    ledger?.record('input');
    return {
      redacted: true,
      token,
      value: token,
      valueType: valueTypeFor(rawValue),
    };
  };

  const redactArgument = (value, rawValue, token, ledger) => {
    const raw = String(rawValue ?? '');
    if (!raw) return value;
    let replacements = 0;
    const visit = (current) => {
      if (typeof current === 'string') {
        if (!current.includes(raw)) return current;
        replacements += current.split(raw).length - 1;
        return current.split(raw).join(token);
      }
      if (Array.isArray(current)) return current.map(visit);
      if (current && typeof current === 'object') {
        return Object.fromEntries(Object.entries(current).map(([key, item]) => [key, visit(item)]));
      }
      return current;
    };
    const redacted = visit(value);
    if (replacements > 0) ledger?.record('argument', replacements);
    return redacted;
  };

  const sanitizeLedgerSummary = (ledger) => {
    const summary = typeof ledger?.summary === 'function' ? ledger.summary() : ledger;
    const counts = Object.fromEntries(Object.entries(summary?.counts || {})
      .filter(([category, count]) => typeof category === 'string' && Number.isInteger(count))
      .map(([category, count]) => [sanitizeText(category, { limit: 40 }), count]));
    return {
      schemaVersion: 'redaction-ledger/1',
      total: Object.values(counts).reduce((sum, count) => sum + count, 0),
      counts,
    };
  };

  const createDebugArtifact = (trace, ledger) => ({
    schemaVersion: 'learning-debug/1',
    trace,
    redactions: sanitizeLedgerSummary(ledger),
  });

  const serializeDebugArtifact = (trace, ledger) => JSON.stringify(
    createDebugArtifact(trace, ledger),
    null,
    2,
  );

  const downloadDebugArtifact = (trace, ledger, {
    document = globalThis.document,
    filename = `learning-trace-${trace?.recordingId || 'debug'}.json`,
  } = {}) => {
    const body = serializeDebugArtifact(trace, ledger);
    const blob = new Blob([body], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.download = filename;
    link.href = url;
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return { bytes: new TextEncoder().encode(body).byteLength, filename };
  };

  return Object.freeze({
    ATTRIBUTE_ALLOWLIST,
    argumentName,
    argumentToken,
    collectArguments,
    createDebugArtifact,
    createLedger,
    downloadDebugArtifact,
    redactArgument,
    sanitizeAttributes,
    sanitizeLedgerSummary,
    sanitizeText,
    sanitizeUrl,
    sensitiveIdentifier,
    serializeDebugArtifact,
    tokenizeInput,
  });
}));

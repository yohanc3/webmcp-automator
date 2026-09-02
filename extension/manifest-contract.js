(function initializeManifestContract(root, factory) {
  const manifestContract = factory();

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = manifestContract;
  }

  root.WebMcpManifest = manifestContract;
}(typeof globalThis === 'undefined' ? this : globalThis, () => {
  'use strict';

  const SCHEMA_VERSION = 'learned-adapter/1';
  const ALLOWED_OPERATIONS = new Set(['fill', 'click', 'press', 'wait', 'extract']);
  const ALLOWED_SAFETY_LEVELS = new Set(['read', 'write', 'danger']);
  const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,29}$/;
  const PARAMETER_NAME_PATTERN = /^[a-z][a-z0-9_]{0,29}$/;

  const isPlainObject = (value) => (
    value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
  );

  const asString = (value) => (typeof value === 'string' ? value.trim() : '');

  const nullableString = (value) => {
    const normalized = asString(value);
    return normalized || null;
  };

  const normalizeLocator = (locator = {}) => ({
    css: nullableString(locator.css),
    role: nullableString(locator.role),
    name: nullableString(locator.name),
    placeholder: nullableString(locator.placeholder),
    text: nullableString(locator.text),
    hrefContains: nullableString(locator.hrefContains),
  });

  const locatorHasEvidence = (locator) => Object.values(normalizeLocator(locator))
    .some((value) => value !== null);

  const normalizeParameter = (parameter = {}) => ({
    name: asString(parameter.name),
    description: asString(parameter.description),
    type: asString(parameter.type),
    required: parameter.required !== false,
  });

  const normalizeStep = (step = {}) => ({
    op: asString(step.op),
    target: normalizeLocator(step.target),
    valueFrom: nullableString(step.valueFrom),
    literalValue: nullableString(step.literalValue),
    key: nullableString(step.key),
    expectNavigation: step.expectNavigation === true,
    timeoutMs: Number.isInteger(step.timeoutMs)
      ? Math.min(Math.max(step.timeoutMs, 100), 30000)
      : 5000,
  });

  const normalizeField = (field = {}) => ({
    name: asString(field.name),
    locator: normalizeLocator(field.locator),
    attribute: nullableString(field.attribute),
    required: field.required === true,
  });

  const normalizeOutput = (output = {}) => ({
    mode: asString(output.mode),
    collectionRoot: normalizeLocator(output.collectionRoot),
    item: normalizeLocator(output.item),
    limit: Number.isInteger(output.limit)
      ? Math.min(Math.max(output.limit, 1), 25)
      : 10,
    fields: Array.isArray(output.fields) ? output.fields.map(normalizeField) : [],
  });

  const normalizeManifest = (manifest = {}) => {
    const tool = isPlainObject(manifest.tool) ? manifest.tool : {};
    const site = isPlainObject(manifest.site) ? manifest.site : {};

    return {
      schemaVersion: asString(manifest.schemaVersion),
      usable: manifest.usable === true,
      site: {
        origin: asString(site.origin),
        routePatterns: Array.isArray(site.routePatterns)
          ? site.routePatterns.map(asString).filter(Boolean)
          : [],
      },
      tool: {
        name: asString(tool.name),
        description: asString(tool.description),
        safety: asString(tool.safety),
        parameters: Array.isArray(tool.parameters)
          ? tool.parameters.map(normalizeParameter)
          : [],
        steps: Array.isArray(tool.steps) ? tool.steps.map(normalizeStep) : [],
        output: normalizeOutput(tool.output),
        annotations: {
          readOnlyHint: tool.annotations?.readOnlyHint === true,
          untrustedContentHint: tool.annotations?.untrustedContentHint !== false,
        },
      },
      confidence: Number.isFinite(manifest.confidence)
        ? Math.min(Math.max(manifest.confidence, 0), 1)
        : 0,
      evidence: asString(manifest.evidence),
      issues: Array.isArray(manifest.issues)
        ? manifest.issues.map(asString).filter(Boolean)
        : [],
    };
  };

  const validateManifest = (input) => {
    const manifest = normalizeManifest(input);
    const errors = [];

    if (manifest.schemaVersion !== SCHEMA_VERSION) {
      errors.push(`schemaVersion must be ${SCHEMA_VERSION}`);
    }
    if (!manifest.site.origin.startsWith('http://') && !manifest.site.origin.startsWith('https://')) {
      errors.push('site.origin must be an HTTP or HTTPS origin');
    }
    if (!manifest.usable) {
      return { valid: false, manifest, errors: [...errors, ...manifest.issues] };
    }
    if (!TOOL_NAME_PATTERN.test(manifest.tool.name)) {
      errors.push('tool.name must be lowercase snake_case and at most 30 characters');
    }
    if (!manifest.tool.description) {
      errors.push('tool.description is required');
    }
    if (!ALLOWED_SAFETY_LEVELS.has(manifest.tool.safety)) {
      errors.push('tool.safety is invalid');
    }

    const parameterNames = new Set();
    manifest.tool.parameters.forEach((parameter) => {
      if (!PARAMETER_NAME_PATTERN.test(parameter.name)) {
        errors.push(`invalid parameter name: ${parameter.name || '(empty)'}`);
      }
      if (parameterNames.has(parameter.name)) {
        errors.push(`duplicate parameter name: ${parameter.name}`);
      }
      parameterNames.add(parameter.name);
    });

    if (manifest.tool.steps.length === 0) {
      errors.push('tool.steps must include at least one operation');
    }

    manifest.tool.steps.forEach((step, index) => {
      if (!ALLOWED_OPERATIONS.has(step.op)) {
        errors.push(`step ${index + 1} uses unsupported operation ${step.op}`);
      }
      if (['fill', 'click'].includes(step.op) && !locatorHasEvidence(step.target)) {
        errors.push(`step ${index + 1} requires a target locator`);
      }
      if (step.op === 'fill') {
        if (!step.valueFrom && step.literalValue === null) {
          errors.push(`step ${index + 1} must declare valueFrom or literalValue`);
        }
        if (step.valueFrom && !parameterNames.has(step.valueFrom)) {
          errors.push(`step ${index + 1} references unknown parameter ${step.valueFrom}`);
        }
      }
      if (step.op === 'press' && !step.key) {
        errors.push(`step ${index + 1} requires a key`);
      }
    });

    if (manifest.tool.output.mode === 'collection') {
      if (!locatorHasEvidence(manifest.tool.output.item)) {
        errors.push('collection output requires an item locator');
      }
      if (manifest.tool.output.fields.length === 0) {
        errors.push('collection output requires at least one field');
      }
    }
    if (!['page', 'collection'].includes(manifest.tool.output.mode)) {
      errors.push('tool.output.mode must be page or collection');
    }

    return { valid: errors.length === 0, manifest, errors };
  };

  const buildInputSchema = (tool) => {
    const properties = {};
    const required = [];

    tool.parameters.forEach((parameter) => {
      properties[parameter.name] = {
        type: parameter.type,
        description: parameter.description,
      };
      if (parameter.required) {
        required.push(parameter.name);
      }
    });

    return {
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    };
  };

  const routeMatches = (routePatterns, url) => {
    if (!Array.isArray(routePatterns) || routePatterns.length === 0) {
      return true;
    }

    return routePatterns.some((pattern) => {
      try {
        return new RegExp(pattern).test(url);
      } catch (error) {
        return url.includes(pattern);
      }
    });
  };

  const manifestMatchesLocation = (manifest, url) => {
    try {
      const currentUrl = new URL(url);
      return currentUrl.origin === manifest.site.origin
        && routeMatches(manifest.site.routePatterns, currentUrl.href);
    } catch (error) {
      return false;
    }
  };

  return {
    ALLOWED_OPERATIONS,
    SCHEMA_VERSION,
    buildInputSchema,
    locatorHasEvidence,
    manifestMatchesLocation,
    normalizeLocator,
    normalizeManifest,
    validateManifest,
  };
}));

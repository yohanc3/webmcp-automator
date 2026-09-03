(function initializeActorRuntime(root, factory) {
  const runtime = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = runtime;
  root.WebMcpActor = runtime;
}(typeof globalThis === 'undefined' ? this : globalThis, () => {
  'use strict';

  const COMPLETED = 'step.completed';
  const FAILED = 'step.failed';
  const MAX_MATCH_OBSERVATIONS = 20;
  const POLL_INTERVAL_MS = 20;
  const ALLOWED_KEYS = new Set([
    'Enter', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    'Home', 'End', 'PageUp', 'PageDown', 'Tab', 'Space',
  ]);
  const ROLE_SELECTOR = [
    'a[href]', 'article', 'button', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'input:not([type="hidden"])', 'li', 'main', 'nav', 'option', 'select', 'summary',
    'textarea', '[contenteditable="true"]', '[role]',
  ].join(',');
  const TEXT_SELECTOR = [
    'a[href]', 'article', 'button', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'label',
    'li', 'option', 'p', 'span', '[role]',
  ].join(',');

  class ActorError extends Error {
    constructor(code, message, { stepId = null, retryable = false, observed = {} } = {}) {
      super(message);
      this.name = 'ActorError';
      this.code = code;
      this.stepId = stepId;
      this.retryable = retryable;
      this.observed = observed;
    }
  }

  const normalizeText = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const comparableText = (value) => normalizeText(value).toLowerCase();
  const boundedText = (value, limit = 500) => {
    const text = normalizeText(value);
    return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
  };
  const windowFor = (document) => document.defaultView || globalThis;
  const currentURL = (document) => document.defaultView?.location?.href || document.URL;
  const delay = (milliseconds, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ActorError('CANCELLED', 'The actor command was cancelled'));
      return;
    }
    const timer = setTimeout(done, milliseconds);
    function done() {
      signal?.removeEventListener('abort', aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      reject(new ActorError('CANCELLED', 'The actor command was cancelled'));
    }
    signal?.addEventListener('abort', aborted, { once: true });
  });

  const implicitRole = (element) => {
    const tag = element.localName;
    if ((tag === 'a' || tag === 'area') && element.hasAttribute('href')) return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return element.multiple ? 'listbox' : 'combobox';
    if (tag === 'option') return 'option';
    if (tag === 'article') return 'article';
    if (tag === 'main') return 'main';
    if (tag === 'nav') return 'navigation';
    if (tag === 'form') return 'form';
    if (tag === 'li') return 'listitem';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'input') {
      const roles = {
        button: 'button', checkbox: 'checkbox', email: 'textbox', number: 'spinbutton',
        radio: 'radio', range: 'slider', search: 'searchbox', submit: 'button',
        tel: 'textbox', text: 'textbox', url: 'textbox',
      };
      return roles[(element.type || 'text').toLowerCase()] || 'textbox';
    }
    return null;
  };

  const roleFor = (element) => {
    const explicit = normalizeText(element.getAttribute('role')).split(' ')[0];
    return ['generic', 'none', 'presentation'].includes(explicit)
      ? null
      : explicit || implicitRole(element);
  };

  const referencedText = (element, attribute) => normalizeText(
    normalizeText(element.getAttribute(attribute)).split(' ').filter(Boolean).map((id) => {
      const root = element.getRootNode();
      const referenced = (typeof root.getElementById === 'function' && root.getElementById(id))
        || element.ownerDocument.getElementById(id);
      return referenced?.textContent || '';
    }).join(' '),
  );

  const accessibleName = (element) => {
    const labelled = referencedText(element, 'aria-labelledby');
    if (labelled) return labelled;
    const aria = normalizeText(element.getAttribute('aria-label'));
    if (aria) return aria;
    if (element.labels?.length) {
      const labels = normalizeText(Array.from(element.labels).map((label) => label.textContent).join(' '));
      if (labels) return labels;
    }
    return normalizeText(
      element.getAttribute('alt')
      || element.getAttribute('title')
      || element.getAttribute('placeholder')
      || element.innerText
      || element.textContent,
    );
  };

  const isVisible = (element) => {
    if (!element || element.nodeType !== 1 || element.hidden) return false;
    const view = element.ownerDocument.defaultView;
    const style = view?.getComputedStyle?.(element);
    if (style && (style.display === 'none' || style.visibility === 'hidden'
      || Number.parseFloat(style.opacity || '1') <= 0.01)) return false;
    if (element.closest('[hidden], [aria-hidden="true"]')) return false;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (Number.parseFloat(view?.getComputedStyle(parent).opacity || '1') <= 0.01) return false;
    }
    const rect = element.getBoundingClientRect?.();
    return !rect || rect.width > 0.5 || rect.height > 0.5;
  };

  const isEnabled = (element) => !(
    element.disabled
    || element.matches(':disabled')
    || element.getAttribute('aria-disabled') === 'true'
    || element.closest('[inert]')
  );

  const textMatches = (actual, expected, exact) => {
    const left = comparableText(actual);
    const right = comparableText(expected);
    return exact ? left === right : left.includes(right);
  };

  const queryAll = (scope, selector) => {
    try {
      return Array.from(scope.querySelectorAll(selector));
    } catch (error) {
      return [];
    }
  };

  const uniqueElements = (elements) => Array.from(new Set(elements)).filter(
    (element) => element?.nodeType === 1,
  );

  const candidatesForStrategy = (strategy, scope, document) => {
    switch (strategy.kind) {
      case 'css':
        return queryAll(scope, strategy.selector);
      case 'role':
        return queryAll(scope, ROLE_SELECTOR).filter((element) => (
          comparableText(roleFor(element)) === comparableText(strategy.role)
          && textMatches(accessibleName(element), strategy.name, strategy.exact)
        ));
      case 'label':
        return uniqueElements(queryAll(scope, 'label').filter((label) => (
          textMatches(label.textContent, strategy.text, strategy.exact)
        )).flatMap((label) => {
          if (label.control) return [label.control];
          const id = label.getAttribute('for');
          return id ? [document.getElementById(id)] : queryAll(label, 'input, select, textarea, button');
        }));
      case 'placeholder':
        return queryAll(scope, '[placeholder]').filter((element) => (
          textMatches(element.getAttribute('placeholder'), strategy.text, strategy.exact)
        ));
      case 'text':
        return queryAll(scope, TEXT_SELECTOR).filter((element) => (
          textMatches(element.innerText || element.textContent, strategy.text, strategy.exact)
        ));
      case 'attribute':
        return queryAll(scope, `[${strategy.attribute}]`).filter((element) => (
          element.getAttribute(strategy.attribute) === strategy.value
        ));
      case 'href':
        return queryAll(scope, 'a[href], area[href]').filter((element) => (
          element.href.includes(strategy.contains)
        ));
      case 'active_element': {
        const active = document.activeElement;
        return active && (scope === document || scope.contains(active)) ? [active] : [];
      }
      default:
        throw new ActorError('INTERNAL_ERROR', `Unsupported locator strategy: ${strategy.kind}`);
    }
  };

  const filteredMatches = (matches, locator) => matches.filter((element) => (
    (!locator.visible || isVisible(element)) && (!locator.enabled || isEnabled(element))
  ));

  const resolveLocator = (locator, {
    document, scope = document, allowEmpty = false, stepId = null,
  }) => {
    let sawNonInteractable = false;
    for (let index = 0; index < locator.strategies.length; index += 1) {
      const raw = uniqueElements(candidatesForStrategy(locator.strategies[index], scope, document))
        .filter((element) => scope === document || scope.contains(element));
      const matches = filteredMatches(raw, locator);
      if (raw.length > 0 && matches.length === 0) sawNonInteractable = true;
      if (matches.length === 0) continue;
      if (locator.cardinality !== 'many' && matches.length > 1) {
        throw new ActorError('TARGET_AMBIGUOUS', 'A one-target locator matched multiple elements', {
          stepId,
          observed: { strategyIndex: index, matchCount: matches.length },
        });
      }
      return {
        elements: locator.cardinality === 'many' ? matches : matches.slice(0, 1),
        strategyIndex: index,
        matchCount: matches.length,
      };
    }
    if (allowEmpty || locator.cardinality === 'zero_or_one') return { elements: [], strategyIndex: null, matchCount: 0 };
    if (sawNonInteractable) {
      throw new ActorError('TARGET_NOT_INTERACTABLE', 'The target exists but is not interactable', {
        stepId, observed: { matchCount: 0 },
      });
    }
    throw new ActorError('TARGET_NOT_FOUND', 'No locator strategy matched a target', {
      stepId, observed: { matchCount: 0 },
    });
  };

  const resolveValue = (source, args, stepId) => {
    if (Object.hasOwn(source, 'literal')) return source.literal;
    if (Object.hasOwn(source, 'fromArgument')) {
      if (!Object.hasOwn(args, source.fromArgument)) {
        throw new ActorError('INVALID_ARGUMENTS', `Missing argument: ${source.fromArgument}`, { stepId });
      }
      return args[source.fromArgument];
    }
    throw new ActorError('INTERNAL_ERROR', 'Invalid value source', { stepId });
  };

  const validateArguments = (schema, args) => {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return 'Arguments must be an object';
    const properties = schema?.properties || {};
    for (const required of schema?.required || []) {
      if (!Object.hasOwn(args, required)) return `Missing required argument: ${required}`;
    }
    if (schema?.additionalProperties === false) {
      const extra = Object.keys(args).find((name) => !Object.hasOwn(properties, name));
      if (extra) return `Unexpected argument: ${extra}`;
    }
    for (const [name, value] of Object.entries(args)) {
      const rule = properties[name];
      if (!rule) continue;
      const actualType = Number.isInteger(value) ? 'integer' : typeof value;
      if (rule.type === 'number') {
        if (typeof value !== 'number' || !Number.isFinite(value)) return `Argument ${name} must be a number`;
      } else if (actualType !== rule.type) return `Argument ${name} must be a ${rule.type}`;
      if (rule.enum && !rule.enum.some((candidate) => Object.is(candidate, value))) {
        return `Argument ${name} is not an allowed value`;
      }
      if (typeof value === 'string' && rule.minLength != null && Array.from(value).length < rule.minLength) {
        return `Argument ${name} is shorter than ${rule.minLength}`;
      }
      if (typeof value === 'string' && rule.maxLength != null && Array.from(value).length > rule.maxLength) {
        return `Argument ${name} is longer than ${rule.maxLength}`;
      }
      if (typeof value === 'number' && rule.minimum != null && value < rule.minimum) {
        return `Argument ${name} is less than ${rule.minimum}`;
      }
      if (typeof value === 'number' && rule.maximum != null && value > rule.maximum) {
        return `Argument ${name} is greater than ${rule.maximum}`;
      }
    }
    return null;
  };

  const setNativeValue = (element, value, document) => {
    const view = windowFor(document);
    const text = String(value ?? '');
    if (element instanceof view.HTMLInputElement) {
      Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, 'value')?.set?.call(element, text);
    } else if (element instanceof view.HTMLTextAreaElement) {
      Object.getOwnPropertyDescriptor(view.HTMLTextAreaElement.prototype, 'value')?.set?.call(element, text);
    } else if (element instanceof view.HTMLSelectElement) {
      element.value = text;
    } else if (element.isContentEditable) {
      element.textContent = text;
    } else {
      throw new ActorError('TARGET_NOT_INTERACTABLE', 'The fill target is not editable');
    }
    const InputEventType = view.InputEvent || view.Event;
    element.dispatchEvent(new InputEventType('input', { bubbles: true, composed: true }));
    element.dispatchEvent(new view.Event('change', { bubbles: true, composed: true }));
  };

  const dispatchKey = (element, key, document) => {
    const view = windowFor(document);
    if (!ALLOWED_KEYS.has(key)) throw new ActorError('INTERNAL_ERROR', `Unsupported key: ${key}`);
    element.focus?.();
    const dispatch = (type) => element.dispatchEvent(new view.KeyboardEvent(type, {
      key: key === 'Space' ? ' ' : key, code: key,
      bubbles: true, composed: true, cancelable: true,
    }));
    if (dispatch('keydown') && ['Enter', 'Space'].includes(key)) dispatch('keypress');
    dispatch('keyup');
  };

  const createObservation = (document) => {
    const counts = { added: 0, removed: 0, changed: 0 };
    let lastMutationAt = Date.now();
    const view = windowFor(document);
    const observer = new view.MutationObserver((records) => {
      lastMutationAt = Date.now();
      records.forEach((record) => {
        if (record.type === 'childList') {
          counts.added += record.addedNodes.length;
          counts.removed += record.removedNodes.length;
        } else {
          counts.changed += 1;
        }
      });
    });
    observer.observe(document.documentElement, {
      attributes: true, characterData: true, childList: true, subtree: true,
    });
    return { counts, observer, get lastMutationAt() { return lastMutationAt; } };
  };

  const detectState = async (context, document, args, observation, signal, excluded = new Set()) => {
    if (typeof context.getStateId === 'function') return context.getStateId(document);
    for (const state of context.states || []) {
      if (excluded.has(state.id)) continue;
      const nextExcluded = new Set(excluded).add(state.id);
      if (await evaluateSet(state.match, {
        action: context, args, document, observation, signal, step: null,
        once: true, excludedStates: nextExcluded,
      })) return state.id;
    }
    return null;
  };

  const evaluateCondition = async (condition, context) => {
    const { action, args, document, observation, signal, step } = context;
    switch (condition.kind) {
      case 'url':
        return new RegExp(condition.pattern).test(currentURL(document));
      case 'element': {
        const located = resolveLocator(condition.target, {
          document, allowEmpty: true, stepId: step?.id,
        }).elements;
        if (condition.assertion === 'absent') return located.length === 0;
        if (condition.assertion === 'present') return located.length > 0;
        if (located.length === 0) return false;
        if (condition.assertion === 'visible') return located.every(isVisible);
        if (condition.assertion === 'hidden') return located.every((element) => !isVisible(element));
        if (condition.assertion === 'enabled') return located.every(isEnabled);
        if (condition.assertion === 'disabled') return located.every((element) => !isEnabled(element));
        return false;
      }
      case 'collection':
        return resolveLocator(condition.target, {
          document, allowEmpty: true, stepId: step?.id,
        }).elements.length >= condition.minimumItems;
      case 'state':
        return (await detectState(
          action, document, args, observation, signal, context.excludedStates,
        )) === condition.stateId;
      case 'target_value': {
        if (!step?.target) return false;
        const target = resolveLocator(step.target, { document, stepId: step.id, allowEmpty: true }).elements[0];
        if (!target) return false;
        const expected = resolveValue(condition.value, args, step.id);
        const actual = 'value' in target ? target.value : target.textContent;
        return String(actual ?? '') === String(expected ?? '');
      }
      case 'dom_change':
        return observation.counts.added >= condition.minimumAdded
          && observation.counts.removed >= condition.minimumRemoved
          && observation.counts.changed >= condition.minimumChanged;
      case 'dom_stable':
        return Date.now() - observation.lastMutationAt >= condition.quietMs;
      default:
        throw new ActorError('INTERNAL_ERROR', `Unsupported condition: ${condition.kind}`, {
          stepId: step?.id || null,
        });
    }
  };

  async function evaluateSet(set, context) {
    const values = await Promise.all(set.checks.map((check) => evaluateCondition(check, context)));
    return set.mode === 'all' ? values.every(Boolean) : values.some(Boolean);
  }

  const waitForConditions = async (set, context, deadline) => {
    while (Date.now() <= deadline) {
      if (context.signal?.aborted) throw new ActorError('CANCELLED', 'The actor command was cancelled');
      if (await evaluateSet(set, context)) return true;
      await delay(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())), context.signal);
    }
    return false;
  };

  const normalizeReadValue = (field, element, document) => {
    let value;
    if (field.read === 'text') value = normalizeText(element.innerText || element.textContent);
    else if (field.read === 'value') value = element.value;
    else if (field.read === 'href' || field.read === 'src') value = element.getAttribute(field.read);
    else if (field.read === 'checked') value = element.checked;
    else if (field.read === 'selected') value = element.selected;
    const invalid = () => { throw new ActorError('POSTCONDITION_FAILED', 'Extracted field does not match its declared type'); };
    if (value == null) { if (!field.required) return null; return invalid(); }
    if (field.type === 'url') {
      try { return new URL(value, currentURL(document)).href; } catch { return invalid(); }
    }
    if (field.type === 'number' || field.type === 'integer') {
      const number = Number(value);
      if (String(value).trim() === '' || !Number.isFinite(number)
        || (field.type === 'integer' && !Number.isInteger(number))) return invalid();
      return number;
    }
    if (field.type === 'boolean') {
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === 'false') return value === 'true';
      return invalid();
    }
    return String(value);
  };

  const extractFields = (fields, scope, document, stepId) => {
    const output = {};
    fields.forEach((field) => {
      const located = resolveLocator(field.locator, {
        document, scope, allowEmpty: !field.required, stepId,
      });
      if (located.elements.length === 0) {
        output[field.name] = null;
        return;
      }
      if (located.elements.length > 1) throw new ActorError('TARGET_AMBIGUOUS', 'An output field matched multiple elements', { stepId });
      Object.defineProperty(output, field.name, { value: normalizeReadValue(field, located.elements[0], document), enumerable: true });
    });
    return output;
  };

  const extractOutput = (output, document, stepId) => {
    if (output.mode === 'none') return null;
    if (output.mode === 'page') return extractFields(output.fields, document, document, stepId);
    const roots = resolveLocator(output.collectionRoot, { document, stepId }).elements;
    if (roots.length !== 1) throw new ActorError(roots.length ? 'TARGET_AMBIGUOUS' : 'TARGET_NOT_FOUND', 'Extraction requires one collection root', { stepId });
    const root = roots[0];
    const items = resolveLocator(output.item, {
      document, scope: root, allowEmpty: true, stepId,
    }).elements.slice(0, output.limit);
    return {
      count: items.length,
      items: items.map((item) => extractFields(output.fields, item, document, stepId)),
    };
  };

  const navigationExpected = (step, beforeURL) => step.expect.checks.some((condition) => (
    condition.kind === 'url' && !new RegExp(condition.pattern).test(beforeURL)
  ));

  const effectFor = async ({ action, args, document, observation, signal, step, beforeURL, beforeState }) => {
    const afterURL = currentURL(document);
    return {
      urlBefore: beforeURL,
      urlAfter: afterURL,
      urlChanged: beforeURL !== afterURL,
      navigationExpected: navigationExpected(step, beforeURL),
      navigationObserved: observation.navigationObserved === true,
      stateBefore: beforeState,
      stateAfter: await detectState(action, document, args, observation, signal),
      postconditionSatisfied: true,
    };
  };

  const failurePayload = (command, error) => {
    const actorError = error instanceof ActorError ? error : new ActorError(
      'INTERNAL_ERROR', boundedText(error?.message || 'The actor command failed'),
      { stepId: command.step?.id || null },
    );
    return {
      commandId: command.commandId,
      stepId: command.step?.id || actorError.stepId,
      stepIndex: command.stepIndex,
      error: {
        code: actorError.code,
        message: boundedText(actorError.message, 2000),
        stepId: actorError.stepId || command.step?.id || null,
        retryable: actorError.retryable,
        observed: actorError.observed,
      },
    };
  };

  // JSON comparison ignores property order but never ignores changed plan fields.
  const sameJSON = (left, right) => {
    if (left === right) return true;
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object'
      || Array.isArray(left) !== Array.isArray(right)) return false;
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length
      && keys.every((key) => Object.hasOwn(right, key) && sameJSON(left[key], right[key]));
  };

  const interactionTarget = (step, document) => {
    const targets = resolveLocator(step.target, { document, stepId: step.id }).elements;
    if (targets.length !== 1) throw new ActorError(targets.length ? 'TARGET_AMBIGUOUS' : 'TARGET_NOT_FOUND',
      'The operation requires exactly one target', { stepId: step.id });
    const target = targets[0];
    if (!isVisible(target) || !isEnabled(target) || (step.op === 'fill' && target.readOnly)) {
      throw new ActorError('TARGET_NOT_INTERACTABLE', 'The target is not interactable', { stepId: step.id });
    }
    target.scrollIntoView?.({ block: 'center', inline: 'center' });
    if (step.op === 'click' && document.elementFromPoint) {
      const rect = target.getBoundingClientRect();
      const view = windowFor(document);
      const x = (Math.max(0, rect.left) + Math.min(view.innerWidth, rect.right)) / 2;
      const y = (Math.max(0, rect.top) + Math.min(view.innerHeight, rect.bottom)) / 2;
      const hit = document.elementFromPoint(x, y);
      if (!hit || (hit !== target && !target.contains(hit))) {
        throw new ActorError('TARGET_NOT_INTERACTABLE', 'The click target is obstructed', { stepId: step.id });
      }
    }
    return target;
  };

  const executeStep = async ({
    action, command: envelopeOrPayload, arguments: explicitArguments, document, signal,
    actionStartedAt = Date.now(), states = [], getStateId = null,
  }) => {
    const command = envelopeOrPayload?.payload || envelopeOrPayload;
    const step = command?.step;
    let cleanup = () => {};
    try {
      if (!action || !command || !step || !document) {
        throw new ActorError('INTERNAL_ERROR', 'Actor input is missing action, command, step, or document');
      }
      if (signal?.aborted) throw new ActorError('CANCELLED', 'The actor command was cancelled');
      if (envelopeOrPayload?.payload && (envelopeOrPayload.protocol !== 'webmcp-run/1'
        || envelopeOrPayload.type !== 'step.command')) {
        throw new ActorError('PLAN_VERSION_MISMATCH', 'Unsupported command envelope');
      }
      if (!sameJSON(action.steps?.[command.stepIndex], step)) {
        throw new ActorError('PLAN_VERSION_MISMATCH', 'The command step does not match the pinned action');
      }
      const args = explicitArguments ?? command.arguments ?? {};
      if (explicitArguments !== undefined && !sameJSON(explicitArguments, command.arguments)) {
        throw new ActorError('INVALID_ARGUMENTS', 'Arguments differ from the command arguments');
      }
      const argumentError = validateArguments(action.tool?.inputSchema, args);
      if (argumentError) throw new ActorError('INVALID_ARGUMENTS', argumentError);
      const actionDeadline = actionStartedAt + action.runtime.maxDurationMs;
      const deadline = Math.min(Date.now() + step.timeoutMs, actionDeadline);
      let operationStarted = false;
      let documentReplaced = false;
      const timeoutCode = () => operationStarted && step.op !== 'wait' && deadline !== actionDeadline
        ? 'POSTCONDITION_FAILED' : 'TIMEOUT';
      const check = () => {
        if (documentReplaced) throw new ActorError('TRANSPORT_DISCONNECTED', 'The document was replaced', {
          observed: { navigationObserved: true },
        });
        if (signal?.aborted) throw new ActorError('CANCELLED', 'The actor command was cancelled');
        if (Date.now() >= deadline) throw new ActorError(timeoutCode(), 'The actor duration has expired');
        if (!action.runtime.allowedOrigins.includes(new URL(currentURL(document)).origin)) {
          throw new ActorError('NAVIGATION_OUT_OF_SCOPE', 'The page is outside the action origin allowlist');
        }
      };
      check();
      const beforeURL = currentURL(document);
      const observation = createObservation(document);
      observation.navigationObserved = false;
      const view = windowFor(document);
      const waiting = new AbortController();
      let rejectStopped;
      const stopped = new Promise((_, reject) => { rejectStopped = reject; });
      // Attach a handler immediately; this also covers a synchronous pagehide during click.
      stopped.catch(() => {});
      const onAbort = () => rejectStopped(new ActorError('CANCELLED', 'The actor command was cancelled'));
      const onNavigation = () => {
        documentReplaced = true;
        observation.navigationObserved = true;
        rejectStopped(new ActorError('TRANSPORT_DISCONNECTED', 'The document was replaced; the execution client must reconcile navigation', {
          observed: { navigationObserved: true },
        }));
      };
      const timer = setTimeout(() => rejectStopped(new ActorError(
        timeoutCode(),
        'The declared condition did not complete within the actor budget',
      )), Math.max(0, deadline - Date.now()));
      signal?.addEventListener('abort', onAbort, { once: true });
      view.addEventListener('pagehide', onNavigation, { once: true });
      cleanup = () => {
        clearTimeout(timer);
        waiting.abort();
        observation.observer.disconnect();
        signal?.removeEventListener('abort', onAbort);
        view.removeEventListener('pagehide', onNavigation);
      };
      const bounded = async (promise) => { const result = await Promise.race([promise, stopped]); check(); return result; };
      const runtimeContext = { ...action, states, getStateId };
      const context = { action: runtimeContext, args, document, observation, signal: waiting.signal, step, excludedStates: new Set() };
      const beforeState = await bounded(detectState(runtimeContext, document, args, observation, signal));
      check();
      let result = null;
      operationStarted = true;
      if (step.op === 'fill') {
        const target = interactionTarget(step, document);
        check();
        setNativeValue(target, resolveValue(step.value, args, step.id), document);
      } else if (step.op === 'click') {
        const target = interactionTarget(step, document);
        check();
        target.click();
      } else if (step.op === 'press') {
        const target = interactionTarget(step, document);
        check();
        dispatchKey(target, step.key, document);
      } else if (step.op === 'extract') {
        result = extractOutput(action.output, document, step.id);
      } else if (step.op !== 'wait') {
        throw new ActorError('INTERNAL_ERROR', `Unsupported operation: ${step.op}`);
      }
      const passed = await bounded(waitForConditions(step.expect, context, deadline));
      if (!passed) throw new ActorError(
        timeoutCode(),
        'The declared postcondition did not pass',
        { observed: {
          added: Math.min(observation.counts.added, MAX_MATCH_OBSERVATIONS),
          removed: Math.min(observation.counts.removed, MAX_MATCH_OBSERVATIONS),
          changed: Math.min(observation.counts.changed, MAX_MATCH_OBSERVATIONS),
        } },
      );
      const effect = await bounded(effectFor({
        action: runtimeContext, args, document, observation, signal, step, beforeURL, beforeState,
      }));
      return { type: COMPLETED, payload: {
        commandId: command.commandId, stepId: step.id, stepIndex: command.stepIndex, effect, result,
      } };
    } catch (error) {
      return { type: FAILED, payload: failurePayload(command || {}, error) };
    } finally {
      cleanup();
    }
  };

  const detectStateId = async ({
    action,
    states = [],
    document,
    arguments: args = {},
    timeoutMs = 0,
  }) => {
    if (!action || !document) {
      throw new ActorError('INTERNAL_ERROR', 'State detection requires an action and document');
    }
    const observation = createObservation(document);
    const controller = new AbortController();
    try {
      const deadline = Date.now() + timeoutMs;
      do {
        const stateId = await detectState(
          { ...action, states },
          document,
          args,
          observation,
          controller.signal,
        );
        if (stateId || Date.now() >= deadline) return stateId;
        await delay(Math.min(POLL_INTERVAL_MS, deadline - Date.now()), controller.signal);
      } while (Date.now() <= deadline);
      return null;
    } finally {
      controller.abort();
      observation.observer.disconnect();
    }
  };

  const evaluateConditionSet = async ({
    action,
    states = [],
    document,
    arguments: args = {},
    set,
    step = null,
    timeoutMs = 0,
  }) => {
    if (!action || !document || !set || !Array.isArray(set.checks)) return false;
    const observation = createObservation(document);
    const controller = new AbortController();
    try {
      const context = {
        action: { ...action, states },
        args,
        document,
        excludedStates: new Set(),
        observation,
        signal: controller.signal,
        step,
      };
      if (timeoutMs > 0) {
        return await waitForConditions(set, context, Date.now() + timeoutMs);
      }
      return await evaluateSet(set, context);
    } finally {
      controller.abort();
      observation.observer.disconnect();
    }
  };

  return {
    ActorError,
    accessibleName,
    detectStateId,
    evaluateConditionSet,
    executeStep,
    extractOutput,
    isEnabled,
    isVisible,
    resolveLocator,
    roleFor,
    validateArguments,
  };
}));

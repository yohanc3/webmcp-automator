(function initializeRunner(root, factory) {
  root.WebMcpRunner = factory(root.WebMcpSemantic);
}(typeof globalThis === 'undefined' ? this : globalThis, (semantic) => {
  'use strict';

  const CONTROL_SELECTOR = [
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'option',
    'select',
    'summary',
    'textarea',
    '[contenteditable="true"]',
    '[role]',
  ].join(',');

  const TEXT_SELECTOR = [
    'a[href]',
    'article',
    'button',
    'h1',
    'h2',
    'h3',
    'h4',
    'label',
    'li',
    'option',
    'p',
    'span',
    '[role]',
  ].join(',');

  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();

  const hasEvidence = (locator = {}) => Object.values(locator).some((value) => (
    typeof value === 'string' && value.trim()
  ));

  const unique = (elements) => Array.from(new Set(elements)).filter((element) => (
    element instanceof Element
  ));

  const queryCSS = (scope, selector) => {
    if (!selector) return [];
    try {
      return Array.from(scope.querySelectorAll(selector));
    } catch (error) {
      return [];
    }
  };

  const candidates = (scope, selector) => queryCSS(scope, selector).slice(0, 3000);

  const resolveAll = (locator = {}, scope = document) => {
    if (!hasEvidence(locator)) {
      return scope instanceof Element ? [scope] : [];
    }

    if (locator.css) {
      const cssMatches = queryCSS(scope, locator.css);
      if (cssMatches.length) return cssMatches;
    }

    let matches = candidates(scope, CONTROL_SELECTOR);
    if (locator.role) {
      const role = normalize(locator.role);
      matches = matches.filter((element) => normalize(semantic.roleFor(element)) === role);
    }
    if (locator.name) {
      const name = normalize(locator.name);
      matches = matches.filter((element) => normalize(semantic.accessibleName(element)) === name);
    }
    if (locator.placeholder) {
      const placeholder = normalize(locator.placeholder);
      matches = matches.filter((element) => normalize(element.getAttribute('placeholder')) === placeholder);
    }
    if (locator.hrefContains) {
      matches = matches.filter((element) => (
        element instanceof HTMLAnchorElement && element.href.includes(locator.hrefContains)
      ));
    }
    if (matches.length && (locator.role || locator.name || locator.placeholder || locator.hrefContains)) {
      return unique(matches);
    }

    if (locator.text) {
      const text = normalize(locator.text);
      return unique(candidates(scope, TEXT_SELECTOR).filter((element) => (
        normalize(element.innerText || element.textContent).includes(text)
      )));
    }
    return [];
  };

  const resolveOne = (locator, scope = document) => {
    const matches = resolveAll(locator, scope);
    if (matches.length === 0) {
      throw new Error(`Target not found: ${JSON.stringify(locator)}`);
    }
    return matches[0];
  };

  const setNativeValue = (element, value) => {
    const stringValue = String(value ?? '');
    if (element instanceof HTMLInputElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(element, stringValue);
    } else if (element instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(element, stringValue);
    } else if (element instanceof HTMLSelectElement) {
      element.value = stringValue;
    } else if (element.isContentEditable) {
      element.textContent = stringValue;
    } else {
      throw new Error('Fill target is not an editable control');
    }
    element.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      composed: true,
      data: stringValue,
      inputType: 'insertText',
    }));
    element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  };

  const dispatchKey = (element, key) => {
    ['keydown', 'keypress', 'keyup'].forEach((type) => {
      element.dispatchEvent(new KeyboardEvent(type, {
        key,
        code: key === 'Enter' ? 'Enter' : key,
        bubbles: true,
        composed: true,
        cancelable: true,
      }));
    });
  };

  const wait = (milliseconds) => new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

  const waitForTarget = async (locator, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      const matches = resolveAll(locator);
      if (matches.length) return matches[0];
      await wait(100);
    }
    throw new Error(`Timed out waiting for target: ${JSON.stringify(locator)}`);
  };

  const waitForDOMQuiet = (timeoutMs) => new Promise((resolve) => {
    let quietTimer;
    const finish = () => {
      clearTimeout(quietTimer);
      clearTimeout(deadlineTimer);
      observer.disconnect();
      resolve();
    };
    const scheduleQuiet = () => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, 300);
    };
    const observer = new MutationObserver(scheduleQuiet);
    const deadlineTimer = setTimeout(finish, timeoutMs);
    observer.observe(document.documentElement, {
      attributes: true,
      childList: true,
      subtree: true,
    });
    scheduleQuiet();
  });

  const readElement = (element, attribute) => {
    if (attribute) {
      return element.getAttribute(attribute);
    }
    if (element instanceof HTMLInputElement
      || element instanceof HTMLTextAreaElement
      || element instanceof HTMLSelectElement) {
      return element.value;
    }
    return String(element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
  };

  const extractFields = (fields, scope) => {
    const output = {};
    fields.forEach((field) => {
      const element = resolveAll(field.locator, scope)[0];
      if (!element) {
        if (field.required) {
          throw new Error(`Required output field not found: ${field.name}`);
        }
        output[field.name] = null;
        return;
      }
      output[field.name] = readElement(element, field.attribute);
    });
    return output;
  };

  const extract = (output) => {
    const base = {
      url: window.location.href,
      title: document.title,
    };
    if (output.mode === 'collection') {
      const root = hasEvidence(output.collectionRoot)
        ? resolveOne(output.collectionRoot)
        : document;
      const items = resolveAll(output.item, root).slice(0, output.limit);
      if (items.length === 0) {
        throw new Error('The output collection was not found');
      }
      return {
        ...base,
        count: items.length,
        items: items.map((item) => extractFields(output.fields, item)),
      };
    }
    return {
      ...base,
      fields: extractFields(output.fields, document),
    };
  };

  const scheduleNavigationAction = (action) => {
    setTimeout(action, 0);
    return { navigating: true };
  };

  const executeStep = async (step, args, tool) => {
    globalThis.__webMcpRunnerActive = true;
    try {
      if (step.op === 'fill') {
        const target = resolveOne(step.target);
        const value = step.valueFrom ? args[step.valueFrom] : step.literalValue;
        setNativeValue(target, value);
        return { ok: true };
      }
      if (step.op === 'click') {
        const target = resolveOne(step.target);
        if (step.expectNavigation) {
          return scheduleNavigationAction(() => target.click());
        }
        target.click();
        await waitForDOMQuiet(step.timeoutMs);
        return { ok: true };
      }
      if (step.op === 'press') {
        const target = hasEvidence(step.target) ? resolveOne(step.target) : document.activeElement;
        if (!(target instanceof Element)) {
          throw new Error('No target is available for the key press');
        }
        if (step.expectNavigation) {
          return scheduleNavigationAction(() => dispatchKey(target, step.key));
        }
        dispatchKey(target, step.key);
        await waitForDOMQuiet(step.timeoutMs);
        return { ok: true };
      }
      if (step.op === 'wait') {
        if (hasEvidence(step.target)) {
          await waitForTarget(step.target, step.timeoutMs);
        } else {
          await waitForDOMQuiet(step.timeoutMs);
        }
        return { ok: true };
      }
      if (step.op === 'extract') {
        return { ok: true, result: extract(tool.output) };
      }
      throw new Error(`Unsupported operation: ${step.op}`);
    } finally {
      globalThis.__webMcpRunnerActive = false;
    }
  };

  return {
    executeStep,
    extract,
    hasEvidence,
    resolveAll,
    resolveOne,
  };
}));

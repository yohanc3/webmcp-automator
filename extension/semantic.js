(function initializeSemanticExtractor(root, factory) {
  root.WebMcpSemantic = factory();
}(typeof globalThis === 'undefined' ? this : globalThis, () => {
  'use strict';

  const MAX_NODES = 900;
  const MAX_TEXT_LENGTH = 320;
  const SEMANTIC_SELECTOR = [
    'a[href]',
    'article',
    'button',
    'form',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'input:not([type="hidden"])',
    'li',
    'main',
    'nav',
    'option',
    'section',
    'select',
    'summary',
    'textarea',
    '[contenteditable="true"]',
    '[data-asin]',
    '[data-component-type]',
    '[data-product-card]',
    '[data-testid]',
    '[role]',
  ].join(',');

  const SENSITIVE_AUTOCOMPLETE = /(?:cc-|card|password|one-time-code|transaction|address|postal|email|tel|name)/i;
  const SENSITIVE_NAME = /(?:pass|secret|token|card|cvv|cvc|email|phone|address|postal|ssn)/i;

  const normalizeText = (value) => String(value || '')
    .replace(/\s+/g, ' ')
    .trim();

  const truncate = (value, limit = MAX_TEXT_LENGTH) => {
    const normalized = normalizeText(value);
    return normalized.length <= limit
      ? normalized
      : `${normalized.slice(0, limit - 1).trimEnd()}…`;
  };

  const hash = (value) => {
    let result = 2166136261;
    const input = String(value);
    for (let index = 0; index < input.length; index += 1) {
      result ^= input.charCodeAt(index);
      result = Math.imul(result, 16777619);
    }
    return (result >>> 0).toString(36);
  };

  const isVisible = (element) => {
    if (!(element instanceof Element)) {
      return false;
    }
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return !element.hidden
      && style.display !== 'none'
      && style.visibility !== 'hidden'
      && Number.parseFloat(style.opacity || '1') > 0.01
      && rect.width > 0.5
      && rect.height > 0.5;
  };

  const implicitRole = (element) => {
    const tag = element.localName;
    if (tag === 'a' && element.hasAttribute('href')) return 'link';
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
      const inputRoles = {
        button: 'button',
        checkbox: 'checkbox',
        email: 'textbox',
        number: 'spinbutton',
        radio: 'radio',
        range: 'slider',
        search: 'searchbox',
        submit: 'button',
        tel: 'textbox',
        text: 'textbox',
        url: 'textbox',
      };
      return inputRoles[(element.type || 'text').toLowerCase()] || 'textbox';
    }
    return null;
  };

  const roleFor = (element) => normalizeText(element.getAttribute('role')).split(' ')[0]
    || implicitRole(element);

  const referencedText = (element, attributeName) => normalizeText(
    normalizeText(element.getAttribute(attributeName))
      .split(' ')
      .filter(Boolean)
      .map((id) => element.ownerDocument.getElementById(id)?.textContent || '')
      .join(' '),
  );

  const accessibleName = (element) => {
    const labelled = referencedText(element, 'aria-labelledby');
    if (labelled) return truncate(labelled);

    const ariaLabel = normalizeText(element.getAttribute('aria-label'));
    if (ariaLabel) return truncate(ariaLabel);

    if (element.labels?.length) {
      const labelText = normalizeText(Array.from(element.labels)
        .map((label) => label.textContent)
        .join(' '));
      if (labelText) return truncate(labelText);
    }

    const alternative = element.getAttribute('alt')
      || element.getAttribute('title')
      || element.getAttribute('placeholder');
    if (alternative) return truncate(alternative);

    return truncate(element.innerText || element.textContent || '');
  };

  const cssEscape = (value) => {
    if (globalThis.CSS?.escape) {
      return globalThis.CSS.escape(value);
    }
    return String(value).replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`);
  };

  const attributeSelector = (name, value) => (
    `[${name}="${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`
  );

  const stableAttributeSelector = (element) => {
    const candidates = [
      'data-testid',
      'data-component-type',
      'data-product-card',
      'data-asin',
      'itemprop',
      'name',
      'aria-label',
      'placeholder',
    ];

    for (const attributeName of candidates) {
      if (!element.hasAttribute(attributeName)) continue;
      const value = element.getAttribute(attributeName);
      if (value && value.length <= 160) {
        return `${element.localName}${attributeSelector(attributeName, value)}`;
      }
      if (attributeName === 'data-product-card') {
        return `${element.localName}[data-product-card]`;
      }
    }
    return null;
  };

  const idLooksStable = (id) => (
    id
    && id.length <= 64
    && !/^\d/.test(id)
    && !/[a-f0-9]{18,}/i.test(id)
  );

  const nthPath = (element) => {
    const parts = [];
    let current = element;
    while (current && current !== document.documentElement && parts.length < 6) {
      const parent = current.parentElement;
      if (!parent) break;
      const siblings = Array.from(parent.children)
        .filter((sibling) => sibling.localName === current.localName);
      const index = siblings.indexOf(current) + 1;
      parts.unshift(`${current.localName}:nth-of-type(${index})`);
      current = parent;
    }
    return parts.length ? parts.join(' > ') : element.localName;
  };

  const stableCss = (element) => {
    if (idLooksStable(element.id)) {
      return `#${cssEscape(element.id)}`;
    }
    const attribute = stableAttributeSelector(element);
    if (attribute) {
      try {
        if (document.querySelectorAll(attribute).length === 1) {
          return attribute;
        }
      } catch (error) {
        // Fall through to a structural path when a site provides an invalid attribute value.
      }
    }
    return nthPath(element);
  };

  const selectedAttributes = (element) => {
    const output = {};
    [
      'aria-expanded',
      'aria-selected',
      'aria-checked',
      'aria-current',
      'data-testid',
      'data-component-type',
      'data-product-card',
      'data-product-id',
      'data-asin',
      'itemprop',
      'name',
      'placeholder',
      'type',
    ].forEach((name) => {
      if (element.hasAttribute(name)) {
        output[name] = truncate(element.getAttribute(name), 180);
      }
    });
    if (element.localName === 'a' && element.href) {
      try {
        const href = new URL(element.href);
        output.href = `${href.origin}${href.pathname}`;
      } catch (error) {
        output.href = truncate(element.getAttribute('href'), 240);
      }
    }
    return output;
  };

  const rectangle = (element) => {
    const rect = element.getBoundingClientRect();
    return {
      x: Math.round(rect.left + window.scrollX),
      y: Math.round(rect.top + window.scrollY),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  };

  const describeElement = (element) => {
    const role = roleFor(element);
    const name = accessibleName(element);
    const attributes = selectedAttributes(element);
    const css = stableCss(element);
    const parent = element.parentElement;
    const parentContext = parent
      ? truncate(accessibleName(parent) || parent.innerText, 160)
      : '';
    const identity = [
      css,
      element.localName,
      role,
      name,
      attributes.href,
      attributes['data-asin'],
      attributes['data-product-id'],
    ].filter(Boolean).join('|');

    return {
      id: `n_${hash(identity)}`,
      identity,
      tag: element.localName,
      role,
      name,
      text: truncate(element.innerText || element.textContent || ''),
      css,
      attributes,
      parentContext,
      rect: rectangle(element),
    };
  };

  const collectionCandidate = (elements) => {
    if (elements.length < 3) return null;
    const first = elements[0];
    const sharedAttributeNames = [
      'data-component-type',
      'data-product-card',
      'data-testid',
      'role',
    ];
    let itemCss = null;

    for (const name of sharedAttributeNames) {
      const value = first.getAttribute(name);
      const allMatch = elements.every((element) => element.getAttribute(name) === value);
      if (allMatch && (value || name === 'data-product-card')) {
        itemCss = value
          ? `${first.localName}${attributeSelector(name, value)}`
          : `${first.localName}[${name}]`;
        break;
      }
    }
    itemCss ||= first.localName;

    return {
      parentCss: stableCss(first.parentElement),
      itemCss,
      count: elements.length,
      sample: elements.slice(0, 3).map((element) => ({
        name: accessibleName(element),
        text: truncate(element.innerText, 220),
        attributes: selectedAttributes(element),
      })),
    };
  };

  const detectCollections = () => {
    const collections = [];
    const parents = new Set();
    document.querySelectorAll('[data-component-type], [data-product-card], article, li')
      .forEach((element) => {
        if (element.parentElement && isVisible(element)) {
          parents.add(element.parentElement);
        }
      });

    parents.forEach((parent) => {
      const groups = new Map();
      Array.from(parent.children).filter(isVisible).forEach((child) => {
        const signature = [
          child.localName,
          child.getAttribute('data-component-type'),
          child.hasAttribute('data-product-card') ? 'product-card' : '',
          child.getAttribute('role'),
        ].join('|');
        const group = groups.get(signature) || [];
        group.push(child);
        groups.set(signature, group);
      });

      groups.forEach((elements) => {
        const candidate = collectionCandidate(elements);
        if (candidate) collections.push(candidate);
      });
    });

    return collections.slice(0, 30);
  };

  const xmlSafe = (value) => String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const nodesToXml = (nodes) => [
    `<page schema="learning-ui/1" url="${xmlSafe(window.location.href)}" title="${xmlSafe(document.title)}">`,
    ...nodes.map((node) => {
      const attributes = [
        `ref="${xmlSafe(node.id)}"`,
        `tag="${xmlSafe(node.tag)}"`,
        node.role ? `role="${xmlSafe(node.role)}"` : '',
        node.name ? `name="${xmlSafe(node.name)}"` : '',
        `css="${xmlSafe(node.css)}"`,
        `x="${node.rect.x}"`,
        `y="${node.rect.y}"`,
        `width="${node.rect.width}"`,
        `height="${node.rect.height}"`,
      ].filter(Boolean).join(' ');
      return `  <node ${attributes}>${xmlSafe(node.text)}</node>`;
    }),
    '</page>',
  ].join('\n');

  const capturePageState = () => {
    const elements = Array.from(document.querySelectorAll(SEMANTIC_SELECTOR))
      .filter(isVisible)
      .slice(0, MAX_NODES);
    const nodes = elements.map(describeElement);
    const collections = detectCollections();
    const stateIdentity = JSON.stringify({
      url: window.location.href,
      title: document.title,
      nodes: nodes.map(({ identity, text, attributes }) => ({ identity, text, attributes })),
      collections,
    });

    return {
      capturedAt: new Date().toISOString(),
      url: window.location.href,
      origin: window.location.origin,
      title: document.title,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        scrollX: Math.round(window.scrollX),
        scrollY: Math.round(window.scrollY),
      },
      fingerprint: hash(stateIdentity),
      nodes,
      collections,
      semanticXml: nodesToXml(nodes),
      truncated: elements.length >= MAX_NODES,
    };
  };

  const comparableNode = (node) => JSON.stringify({
    name: node.name,
    text: node.text,
    attributes: node.attributes,
  });

  const diffStates = (before, after) => {
    const beforeNodes = new Map((before?.nodes || []).map((node) => [node.identity, node]));
    const afterNodes = new Map((after?.nodes || []).map((node) => [node.identity, node]));
    const added = [];
    const removed = [];
    const changed = [];

    afterNodes.forEach((node, identity) => {
      if (!beforeNodes.has(identity)) {
        added.push(node);
      } else if (comparableNode(beforeNodes.get(identity)) !== comparableNode(node)) {
        changed.push({ before: beforeNodes.get(identity), after: node });
      }
    });
    beforeNodes.forEach((node, identity) => {
      if (!afterNodes.has(identity)) removed.push(node);
    });

    const beforeCollections = JSON.stringify(before?.collections || []);
    const afterCollections = JSON.stringify(after?.collections || []);
    return {
      urlChanged: before?.url !== after?.url,
      beforeUrl: before?.url || null,
      afterUrl: after?.url || null,
      titleChanged: before?.title !== after?.title,
      beforeTitle: before?.title || null,
      afterTitle: after?.title || null,
      added: added.slice(0, 160),
      removed: removed.slice(0, 100),
      changed: changed.slice(0, 100),
      collectionsChanged: beforeCollections !== afterCollections,
      collections: after?.collections || [],
      beforeFingerprint: before?.fingerprint || null,
      afterFingerprint: after?.fingerprint || null,
    };
  };

  const isSensitiveControl = (element) => {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
      return false;
    }
    const type = element instanceof HTMLInputElement ? element.type : '';
    const autocomplete = element.getAttribute('autocomplete') || '';
    const fieldName = `${element.name || ''} ${element.id || ''}`;
    return ['password', 'email', 'tel', 'file'].includes(type)
      || SENSITIVE_AUTOCOMPLETE.test(autocomplete)
      || SENSITIVE_NAME.test(fieldName);
  };

  const eventValue = (element) => {
    if (isSensitiveControl(element)) {
      return { redacted: true, value: null };
    }
    if (element instanceof HTMLInputElement) {
      if (['checkbox', 'radio'].includes(element.type)) {
        return { redacted: false, value: element.checked };
      }
      return { redacted: false, value: truncate(element.value, 500) };
    }
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
      return { redacted: false, value: truncate(element.value, 500) };
    }
    return { redacted: false, value: null };
  };

  return {
    accessibleName,
    capturePageState,
    describeElement,
    diffStates,
    eventValue,
    isSensitiveControl,
    roleFor,
  };
}));

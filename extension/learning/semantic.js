(function initializeLearningSemantic(root, factory) {
  const semantic = factory(
    root.WebMcpLearningPrivacy || (typeof module === 'object' && module.exports ? require('./privacy.js') : null),
  );
  root.WebMcpLearningSemantic = semantic;
  root.WebMcpSemantic = semantic;
  if (typeof module === 'object' && module.exports) {
    module.exports = semantic;
  }
}(typeof globalThis === 'undefined' ? this : globalThis, (privacy) => {
  'use strict';

  if (!privacy) throw new Error('WebMcpLearningPrivacy must load before learning semantic capture');

  const MAX_NODES = 500;
  const MAX_SCANNED_ELEMENTS = 4000;
  const CONTEXT_TAGS = new Set(['article', 'h1', 'h2', 'h3', 'li', 'main', 'nav', 'section']);
  const INTERACTIVE_ROLES = new Set([
    'button',
    'checkbox',
    'combobox',
    'link',
    'listbox',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'option',
    'radio',
    'searchbox',
    'slider',
    'spinbutton',
    'switch',
    'tab',
    'textbox',
    'treeitem',
  ]);
  const SEMANTIC_SELECTOR = [
    'a[href]',
    'article',
    'button',
    'h1',
    'h2',
    'h3',
    'input:not([type="hidden"])',
    'li',
    'option',
    'select',
    'summary',
    'textarea',
    '[contenteditable="true"]',
    '[role]',
  ].join(',');

  const hash = (value) => {
    let result = 2166136261;
    const input = String(value);
    for (let index = 0; index < input.length; index += 1) {
      result ^= input.charCodeAt(index);
      result = Math.imul(result, 16777619);
    }
    return (result >>> 0).toString(36);
  };

  const normalizeText = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

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
    if (tag === 'li') return 'listitem';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'input') {
      const roles = {
        button: 'button',
        checkbox: 'checkbox',
        number: 'spinbutton',
        radio: 'radio',
        range: 'slider',
        search: 'searchbox',
        submit: 'button',
      };
      return roles[(element.type || 'text').toLowerCase()] || 'textbox';
    }
    return null;
  };

  const roleFor = (element) => {
    const explicit = normalizeText(element.getAttribute('role')).split(' ')[0];
    if (['generic', 'none', 'presentation'].includes(explicit)) return null;
    return explicit || implicitRole(element);
  };

  const isInteractive = (element) => {
    const tag = element.localName;
    if (['button', 'select', 'summary', 'textarea'].includes(tag)) return true;
    if (tag === 'input') return (element.getAttribute('type') || 'text') !== 'hidden';
    if (tag === 'a' && element.hasAttribute('href')) return true;
    if (element.isContentEditable) return true;
    return INTERACTIVE_ROLES.has(roleFor(element));
  };

  const isVisible = (element) => {
    if (!(element instanceof element.ownerDocument.defaultView.Element)) return false;
    if (element.hidden || element.closest('[aria-hidden="true"]')) return false;
    const style = element.ownerDocument.defaultView.getComputedStyle(element);
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && Number.parseFloat(style.opacity || '1') > 0.01;
  };

  const referencedText = (element, name) => normalizeText(
    normalizeText(element.getAttribute(name)).split(' ').filter(Boolean).map((id) => (
      element.ownerDocument.getElementById(id)?.textContent || ''
    )).join(' '),
  );

  const rawAccessibleName = (element) => {
    const labelled = referencedText(element, 'aria-labelledby');
    if (labelled) return labelled;
    const ariaLabel = normalizeText(element.getAttribute('aria-label'));
    if (ariaLabel) return ariaLabel;
    if (element.labels?.length) {
      const label = normalizeText(Array.from(element.labels).map((item) => item.textContent).join(' '));
      if (label) return label;
    }
    return element.getAttribute('alt')
      || element.getAttribute('title')
      || element.getAttribute('placeholder')
      || element.innerText
      || element.textContent
      || '';
  };

  const rawAttributes = (element) => Object.fromEntries(Array.from(element.attributes)
    .filter(({ name }) => !['class', 'style', 'value'].includes(name))
    .map(({ name, value }) => [name, value]));

  const stableCss = (element, ledger) => {
    const id = element.id;
    if (/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id)
      && !privacy.sensitiveIdentifier(id)) {
      const escaped = globalThis.CSS?.escape ? globalThis.CSS.escape(id) : id;
      return `#${escaped}`;
    }
    if (id && privacy.sensitiveIdentifier(id)) ledger?.record('locator');
    if (element.hasAttribute('data-product-card')) return `${element.localName}[data-product-card]`;
    const parts = [];
    let current = element;
    while (current?.parentElement && parts.length < 6) {
      const siblings = Array.from(current.parentElement.children)
        .filter((candidate) => candidate.localName === current.localName);
      parts.unshift(`${current.localName}:nth-of-type(${siblings.indexOf(current) + 1})`);
      current = current.parentElement;
    }
    return parts.join(' > ') || element.localName;
  };

  const rectangle = (element) => {
    const rect = element.getBoundingClientRect();
    const view = element.ownerDocument.defaultView;
    return {
      x: Math.round(rect.left + view.scrollX),
      y: Math.round(rect.top + view.scrollY),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  };

  const describeElement = (element, {
    argumentsByValue = privacy.collectArguments(element.ownerDocument),
    ledger = privacy.createLedger(),
  } = {}) => {
    const context = { argumentsByValue, ledger };
    const role = roleFor(element);
    const name = privacy.sanitizeText(rawAccessibleName(element), context);
    const text = privacy.sanitizeText(element.innerText || element.textContent || '', context);
    const attributes = privacy.sanitizeAttributes(rawAttributes(element), context);
    const css = stableCss(element, ledger);
    const parentContext = privacy.sanitizeText(
      element.parentElement ? rawAccessibleName(element.parentElement) : '',
      { ...context, limit: 160 },
    );
    const identity = JSON.stringify({
      attributes,
      css,
      name,
      role,
      tag: element.localName,
    });
    return {
      id: `n_${hash(identity)}`,
      identity,
      tag: element.localName,
      role,
      name: name || null,
      text: text && text !== name ? text : null,
      css,
      attributes,
      interaction: isInteractive(element)
        ? { kind: 'confirmed', confidence: 'high', source: 'semantic' }
        : null,
      context: parentContext || null,
      rect: rectangle(element),
    };
  };

  const boundedElements = (document) => Array.from(document.querySelectorAll(SEMANTIC_SELECTOR))
    .slice(0, MAX_SCANNED_ELEMENTS)
    .filter((element) => !element.closest('[data-webmcp-learning-ui]'))
    .filter(isVisible)
    .filter((element) => isInteractive(element) || CONTEXT_TAGS.has(element.localName))
    .slice(0, MAX_NODES);

  const collectionsFor = (elements) => {
    const parents = new Set(elements
      .filter((element) => ['article', 'li'].includes(element.localName))
      .map((element) => element.parentElement)
      .filter(Boolean));
    return [...parents].flatMap((parent) => {
      const items = Array.from(parent.children)
        .filter((element) => ['article', 'li'].includes(element.localName) && isVisible(element));
      if (items.length < 2) return [];
      return [{ parent, items: items.slice(0, 3), count: items.length }];
    }).slice(0, 20);
  };

  const xmlSafe = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const nodesToXml = (nodes, url, title) => [
    `<semantic-ui schema="semantic-ui/2" url="${xmlSafe(url)}" title="${xmlSafe(title)}">`,
    ...nodes.map((node) => {
      const attributes = Object.entries(node.attributes || {})
        .filter(([name]) => !['name', 'role'].includes(name))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, value]) => ` ${xmlSafe(name)}="${xmlSafe(value)}"`)
        .join('');
      return [
        `  <node ref="${xmlSafe(node.id)}" tag="${xmlSafe(node.tag)}"`,
        node.role ? ` role="${xmlSafe(node.role)}"` : '',
        node.name ? ` name="${xmlSafe(node.name)}"` : '',
        ` css="${xmlSafe(node.css)}"${attributes}>${xmlSafe(node.text || '')}</node>`,
      ].join('');
    }),
    '</semantic-ui>',
  ].join('\n');

  const capturePageState = ({
    document = globalThis.document,
    ledger = privacy.createLedger(),
  } = {}) => {
    const argumentsByValue = privacy.collectArguments(document);
    const context = { argumentsByValue, ledger };
    const elements = boundedElements(document);
    const nodes = elements.map((element) => describeElement(element, context));
    const collections = collectionsFor(elements).map(({ parent, items, count }) => ({
      parentCss: stableCss(parent, ledger),
      itemCss: items[0]?.localName || null,
      count,
      sample: items.map((item) => ({
        name: privacy.sanitizeText(rawAccessibleName(item), context) || null,
        text: privacy.sanitizeText(item.innerText || item.textContent || '', {
          ...context,
          limit: 220,
        }) || null,
        attributes: privacy.sanitizeAttributes(rawAttributes(item), context),
      })),
    }));
    const url = privacy.sanitizeUrl(document.location.href, ledger);
    const title = privacy.sanitizeText(document.title, context);
    const fingerprint = hash(JSON.stringify({
      collections,
      nodes: nodes.map(({ identity, text }) => ({ identity, text })),
      title,
      url,
    }));
    return {
      capturedAt: new Date().toISOString(),
      fingerprint,
      url,
      origin: document.location.origin,
      title,
      viewport: {
        width: document.defaultView.innerWidth,
        height: document.defaultView.innerHeight,
        scrollX: Math.round(document.defaultView.scrollX),
        scrollY: Math.round(document.defaultView.scrollY),
      },
      nodes,
      collections,
      semanticXml: nodesToXml(nodes, url, title),
      truncated: elements.length >= MAX_NODES,
    };
  };

  const comparableNode = (node) => JSON.stringify({
    attributes: node.attributes,
    name: node.name,
    text: node.text,
  });

  const diffStates = (before, after) => {
    const beforeNodes = new Map((before?.nodes || []).map((node) => [node.identity, node]));
    const afterNodes = new Map((after?.nodes || []).map((node) => [node.identity, node]));
    const added = [];
    const removed = [];
    const changed = [];
    afterNodes.forEach((node, identity) => {
      if (!beforeNodes.has(identity)) added.push(node);
      else if (comparableNode(beforeNodes.get(identity)) !== comparableNode(node)) {
        changed.push({ before: beforeNodes.get(identity), after: node });
      }
    });
    beforeNodes.forEach((node, identity) => {
      if (!afterNodes.has(identity)) removed.push(node);
    });
    return {
      urlChanged: before?.url !== after?.url,
      beforeUrl: before?.url || null,
      afterUrl: after?.url || null,
      titleChanged: before?.title !== after?.title,
      beforeTitle: before?.title || null,
      afterTitle: after?.title || null,
      added: added.slice(0, 100),
      removed: removed.slice(0, 60),
      changed: changed.slice(0, 60),
      collectionsChanged: JSON.stringify(before?.collections || [])
        !== JSON.stringify(after?.collections || []),
      collections: after?.collections || [],
      beforeFingerprint: before?.fingerprint || null,
      afterFingerprint: after?.fingerprint || null,
    };
  };

  const eventValue = (element, ledger) => privacy.tokenizeInput(element, ledger);

  return Object.freeze({
    capturePageState,
    describeElement,
    diffStates,
    eventValue,
    isInteractive,
    nodesToXml,
    roleFor,
  });
}));

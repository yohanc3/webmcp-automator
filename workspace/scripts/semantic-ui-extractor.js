/* global copy */

/**
 * Paste into a browser console to copy a semantic-ui/2 XML snapshot.
 * `ref` identifies confirmed controls. `candidate-ref` identifies separately
 * calibrated custom-control candidates and should not be auto-executed.
 */

(() => {
  'use strict';

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
    'scrollbar',
    'searchbox',
    'slider',
    'spinbutton',
    'switch',
    'tab',
    'textbox',
    'treeitem',
  ]);

  const NAME_FROM_CONTENT_ROLES = new Set([
    'button',
    'checkbox',
    'link',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'option',
    'radio',
    'switch',
    'tab',
    'treeitem',
  ]);

  const COMPOSITE_CHILD_ROLES = new Set([
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'option',
    'tab',
    'treeitem',
  ]);

  const STRUCTURAL_TAGS = new Set([
    'address',
    'article',
    'aside',
    'blockquote',
    'br',
    'caption',
    'code',
    'dd',
    'details',
    'dialog',
    'dl',
    'dt',
    'fieldset',
    'figcaption',
    'figure',
    'footer',
    'form',
    'header',
    'hgroup',
    'hr',
    'iframe',
    'label',
    'legend',
    'li',
    'main',
    'menu',
    'meter',
    'nav',
    'ol',
    'optgroup',
    'option',
    'output',
    'p',
    'pre',
    'progress',
    'search',
    'section',
    'summary',
    'table',
    'tbody',
    'td',
    'tfoot',
    'th',
    'thead',
    'time',
    'tr',
    'ul',
  ]);

  const EXCLUDED_BRANCH_TAGS = new Set([
    'head',
    'noscript',
    'script',
    'style',
    'template',
  ]);

  const MEDIA_TAGS = new Set([
    'img',
    'picture',
    'source',
    'track',
  ]);

  const INLINE_TAGS = new Set([
    'a',
    'abbr',
    'b',
    'bdi',
    'bdo',
    'button',
    'cite',
    'code',
    'data',
    'del',
    'em',
    'i',
    'ins',
    'kbd',
    'label',
    'mark',
    'q',
    's',
    'samp',
    'small',
    'span',
    'strong',
    'sub',
    'sup',
    'time',
    'u',
    'var',
  ]);

  const DEFAULTS = Object.freeze({
    copyToClipboard: true,
    includeGeneratedText: true,
    includeInferredControls: true,
    pointerHeuristic: true,
    viewportOnly: false,
    maxNodes: 12000,
    maxTextCharacters: 300000,
  });

  const xmlSafe = (value) => String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

  const validXmlTag = (tag) => (
    /^[A-Za-z_][A-Za-z0-9._-]*$/.test(tag) ? tag : 'element'
  );

  const normalizeText = (value) => String(value || '')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const truncate = (value, limit) => {
    const normalized = normalizeText(value);
    if (normalized.length <= limit) {
      return normalized;
    }
    return `${normalized.slice(0, limit - 1).trimEnd()}…`;
  };

  const nodeWindow = (node) => node.ownerDocument?.defaultView || window;

  const composedParent = (node) => {
    if (node.assignedSlot) {
      return node.assignedSlot;
    }
    if (node.parentElement) {
      return node.parentElement;
    }

    const root = typeof node.getRootNode === 'function' ? node.getRootNode() : null;
    return root && root.host ? root.host : null;
  };

  const composedChildren = (node) => {
    if (node.nodeType === Node.ELEMENT_NODE && node.localName === 'slot') {
      const assigned = node.assignedNodes({ flatten: true });
      return assigned.length > 0 ? assigned : Array.from(node.childNodes);
    }
    if (node.nodeType === Node.ELEMENT_NODE && node.shadowRoot) {
      return Array.from(node.shadowRoot.childNodes);
    }
    return Array.from(node.childNodes || []);
  };

  const collectComposedElements = (root) => {
    const elements = [];
    const visited = new Set();

    const visit = (node) => {
      if (visited.has(node)) {
        return;
      }
      visited.add(node);

      if (node.nodeType === Node.ELEMENT_NODE) {
        elements.push(node);
        if (EXCLUDED_BRANCH_TAGS.has(node.localName)) {
          return;
        }
      }
      composedChildren(node).forEach(visit);
    };

    visit(root);
    return elements;
  };

  const rectIsUsable = (rect) => rect.width > 0.5 && rect.height > 0.5;

  const rectIsInViewport = (rect, view) => (
    rect.right > 0
    && rect.bottom > 0
    && rect.left < view.innerWidth
    && rect.top < view.innerHeight
  );

  const isRendered = (element) => {
    let current = element;
    while (current) {
      const style = nodeWindow(current).getComputedStyle(current);
      const opacity = Number.parseFloat(style.opacity);
      if (
        current.hidden
        || style.display === 'none'
        || style.visibility === 'hidden'
        || style.visibility === 'collapse'
        || style.contentVisibility === 'hidden'
        || (!Number.isNaN(opacity) && opacity <= 0.01)
      ) {
        return false;
      }
      current = composedParent(current);
    }
    return true;
  };

  const elementHasVisibleBox = (element, options) => {
    const rects = Array.from(element.getClientRects()).filter(rectIsUsable);
    if (rects.length === 0) {
      return false;
    }
    if (!options.viewportOnly) {
      return true;
    }

    const view = nodeWindow(element);
    return rects.some((rect) => rectIsInViewport(rect, view));
  };

  const textRects = (textNode) => {
    const range = textNode.ownerDocument.createRange();
    range.selectNodeContents(textNode);
    const rects = Array.from(range.getClientRects()).filter(rectIsUsable);
    if (typeof range.detach === 'function') {
      range.detach();
    }
    return rects;
  };

  const textIsVisuallyClipped = (textNode) => {
    let current = composedParent(textNode);
    while (current) {
      const style = nodeWindow(current).getComputedStyle(current);
      const rect = current.getBoundingClientRect();
      const clippedToNothing = (
        /rect\(0(px)?,?\s+0(px)?,?\s+0(px)?,?\s+0(px)?\)/.test(style.clip)
        || /inset\((50|100)%/.test(style.clipPath)
      );
      if (clippedToNothing && rect.width <= 2 && rect.height <= 2) {
        return true;
      }
      current = composedParent(current);
    }
    return false;
  };

  const textIsVisible = (textNode, options, forceVisible = false) => {
    const parent = composedParent(textNode);
    if (!parent || !isRendered(parent) || textIsVisuallyClipped(textNode)) {
      return false;
    }
    if (forceVisible) {
      return true;
    }

    const rects = textRects(textNode);
    if (rects.length === 0) {
      return false;
    }
    if (!options.viewportOnly) {
      return true;
    }

    const view = nodeWindow(textNode);
    return rects.some((rect) => rectIsInViewport(rect, view));
  };

  const unionRect = (rects) => {
    if (rects.length === 0) {
      return null;
    }
    const left = Math.min(...rects.map((rect) => rect.left));
    const top = Math.min(...rects.map((rect) => rect.top));
    const right = Math.max(...rects.map((rect) => rect.right));
    const bottom = Math.max(...rects.map((rect) => rect.bottom));
    return {
      left,
      top,
      right,
      bottom,
      width: right - left,
      height: bottom - top,
    };
  };

  const boxForElement = (element, children = []) => {
    const ownRect = element.getBoundingClientRect();
    if (rectIsUsable(ownRect)) {
      return ownRect;
    }
    return unionRect(children.map(({ box }) => box).filter(Boolean));
  };

  const boxForText = (textNode) => unionRect(textRects(textNode));

  const isHeading = (tag) => /^h[1-6]$/.test(tag);

  const isHeaderOrFooterLandmark = (element) => (
    !element.closest('article, aside, main, nav, section')
  );

  const implicitRole = (element) => {
    const { localName: tag } = element;

    if (element.isContentEditable && !composedParent(element)?.isContentEditable) {
      return 'textbox';
    }
    if ((tag === 'a' || tag === 'area') && element.hasAttribute('href')) {
      return 'link';
    }
    if (tag === 'button') {
      return 'button';
    }
    if (tag === 'textarea') {
      return 'textbox';
    }
    if (tag === 'select') {
      return element.multiple || element.size > 1 ? 'listbox' : 'combobox';
    }
    if (tag === 'option') {
      return 'option';
    }
    if (tag === 'summary') {
      return 'button';
    }
    if (tag === 'input') {
      const type = (element.getAttribute('type') || 'text').toLowerCase();
      const roles = {
        button: 'button',
        checkbox: 'checkbox',
        email: 'textbox',
        image: 'button',
        number: 'spinbutton',
        password: 'textbox',
        radio: 'radio',
        range: 'slider',
        reset: 'button',
        search: 'searchbox',
        submit: 'button',
        tel: 'textbox',
        text: 'textbox',
        url: 'textbox',
      };
      return roles[type] || null;
    }

    const roles = {
      article: 'article',
      aside: 'complementary',
      dialog: 'dialog',
      fieldset: 'group',
      figure: 'figure',
      form: 'form',
      hr: 'separator',
      li: 'listitem',
      main: 'main',
      menu: 'list',
      meter: 'meter',
      nav: 'navigation',
      ol: 'list',
      optgroup: 'group',
      output: 'status',
      progress: 'progressbar',
      search: 'search',
      table: 'table',
      tbody: 'rowgroup',
      td: 'cell',
      tfoot: 'rowgroup',
      thead: 'rowgroup',
      tr: 'row',
      ul: 'list',
    };

    if (tag === 'header' && isHeaderOrFooterLandmark(element)) {
      return 'banner';
    }
    if (tag === 'footer' && isHeaderOrFooterLandmark(element)) {
      return 'contentinfo';
    }
    if (tag === 'th') {
      return element.getAttribute('scope') === 'row' ? 'rowheader' : 'columnheader';
    }
    if (
      tag === 'section'
      && (element.hasAttribute('aria-label') || element.hasAttribute('aria-labelledby'))
    ) {
      return 'region';
    }
    if (isHeading(tag)) {
      return 'heading';
    }
    return roles[tag] || null;
  };

  const effectiveRole = (element) => {
    const explicitRole = normalizeText(element.getAttribute('role')).split(' ')[0];
    if (['generic', 'none', 'presentation'].includes(explicitRole)) {
      return null;
    }
    return explicitRole || implicitRole(element);
  };

  const isEditingHost = (element) => {
    if (!element.isContentEditable) {
      return false;
    }
    const parent = composedParent(element);
    return !parent || !parent.isContentEditable;
  };

  const isNativeControl = (element) => {
    const { localName: tag } = element;
    if ((tag === 'a' || tag === 'area') && element.hasAttribute('href')) {
      return true;
    }
    if (['button', 'select', 'textarea', 'summary'].includes(tag)) {
      return true;
    }
    if (tag === 'input') {
      return (element.getAttribute('type') || 'text').toLowerCase() !== 'hidden';
    }
    return (tag === 'audio' || tag === 'video') && element.hasAttribute('controls');
  };

  const isConfirmedControl = (element) => (
    isNativeControl(element)
    || INTERACTIVE_ROLES.has(effectiveRole(element))
    || isEditingHost(element)
  );

  const containsComposed = (ancestor, descendant) => {
    let current = descendant;
    while (current) {
      if (current === ancestor) {
        return true;
      }
      current = composedParent(current);
    }
    return false;
  };

  const nearestAncestorIn = (element, elements) => {
    let current = composedParent(element);
    while (current) {
      if (elements.has(current)) {
        return current;
      }
      current = composedParent(current);
    }
    return null;
  };

  const elementDepth = (element) => {
    let depth = 0;
    let current = element;
    while (current) {
      depth += 1;
      current = composedParent(current);
    }
    return depth;
  };

  const rootById = (element, id) => {
    const root = element.getRootNode();
    if (root && typeof root.getElementById === 'function') {
      return root.getElementById(id);
    }
    return element.ownerDocument.getElementById(id);
  };

  const accessibleText = (node, visited = new Set()) => {
    if (!node || visited.has(node)) {
      return '';
    }
    visited.add(node);

    if (node.nodeType === Node.TEXT_NODE) {
      return node.nodeValue || '';
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return '';
    }
    if (EXCLUDED_BRANCH_TAGS.has(node.localName) || node.getAttribute('aria-hidden') === 'true') {
      return '';
    }

    const ariaLabel = normalizeText(node.getAttribute('aria-label'));
    if (ariaLabel) {
      return ariaLabel;
    }
    if (node.localName === 'img' || (node.localName === 'input' && node.type === 'image')) {
      return node.getAttribute('alt') || '';
    }
    if (node.localName === 'input' && ['button', 'reset', 'submit'].includes(node.type)) {
      return node.value || '';
    }

    return composedChildren(node)
      .map((child) => accessibleText(child, visited))
      .join(' ');
  };

  const referencedText = (element, attributeName) => {
    const ids = normalizeText(element.getAttribute(attributeName)).split(' ').filter(Boolean);
    return normalizeText(ids
      .map((id) => accessibleText(rootById(element, id)))
      .join(' '));
  };

  const explicitAccessibleName = (element) => (
    referencedText(element, 'aria-labelledby')
    || normalizeText(element.getAttribute('aria-label'))
  );

  const controlAccessibleName = (element, interaction) => {
    const explicitName = explicitAccessibleName(element);
    if (explicitName) {
      return truncate(explicitName, 800);
    }

    if (element.labels && element.labels.length > 0) {
      const label = Array.from(element.labels)
        .map((item) => accessibleText(item))
        .join(' ');
      if (normalizeText(label)) {
        return truncate(label, 800);
      }
    }

    if (element.localName === 'input') {
      const type = (element.getAttribute('type') || 'text').toLowerCase();
      if (type === 'image' && element.alt) {
        return truncate(element.alt, 800);
      }
      if (['button', 'reset', 'submit'].includes(type) && element.value) {
        return truncate(element.value, 800);
      }
    }

    const role = effectiveRole(element);
    if (interaction.kind === 'candidate' || NAME_FROM_CONTENT_ROLES.has(role)) {
      const contentName = normalizeText(accessibleText(element));
      if (contentName) {
        return truncate(contentName, interaction.kind === 'candidate' ? 300 : 800);
      }
    }

    const title = normalizeText(element.getAttribute('title'));
    return title ? truncate(title, 800) : '';
  };

  const containerAccessibleName = (element) => {
    const explicitName = explicitAccessibleName(element);
    if (!explicitName || explicitName.length > 300) {
      return '';
    }
    return explicitName;
  };

  const accessibleDescription = (element, name) => {
    const description = (
      referencedText(element, 'aria-describedby')
      || normalizeText(element.getAttribute('aria-description'))
    );
    if (description) {
      return truncate(description, 800);
    }

    const title = normalizeText(element.getAttribute('title'));
    return title && title !== name ? truncate(title, 800) : '';
  };

  const pruneNestedConfirmedControls = (rawControls) => {
    const retained = new Set();
    rawControls.forEach((element) => {
      const ancestor = nearestAncestorIn(element, rawControls);
      if (!ancestor) {
        retained.add(element);
        return;
      }

      const role = effectiveRole(element);
      if (element.localName === 'option' || COMPOSITE_CHILD_ROLES.has(role)) {
        retained.add(element);
        return;
      }

      const interaction = { kind: 'confirmed' };
      const name = controlAccessibleName(element, interaction);
      const ancestorName = controlAccessibleName(ancestor, interaction);
      const hasIndependentDestination = (
        element.hasAttribute('href')
        || element.hasAttribute('formaction')
      );
      if (hasIndependentDestination || (name && name !== ancestorName)) {
        retained.add(element);
      }
    });
    return retained;
  };

  const isPointerBoundary = (element) => {
    const view = nodeWindow(element);
    if (view.getComputedStyle(element).cursor !== 'pointer') {
      return false;
    }

    const parent = composedParent(element);
    return !parent || view.getComputedStyle(parent).cursor !== 'pointer';
  };

  const candidateSignal = (element, options) => {
    if (element.hasAttribute('onclick')) {
      return { source: 'inline-onclick', confidence: 'medium' };
    }
    if (element.getAttribute('draggable') === 'true') {
      return { source: 'draggable', confidence: 'medium' };
    }
    if (options.pointerHeuristic && isPointerBoundary(element)) {
      return { source: 'pointer', confidence: 'low' };
    }
    return null;
  };

  const isBroadSurface = (element) => {
    const rect = element.getBoundingClientRect();
    const view = nodeWindow(element);
    return (
      rect.width >= view.innerWidth * 0.85
      && rect.height >= view.innerHeight * 0.75
    );
  };

  const discoverCandidates = (elements, confirmedControls, options) => {
    if (!options.includeInferredControls) {
      return new Map();
    }

    const rawCandidates = elements.flatMap((element) => {
      if (
        confirmedControls.has(element)
        || nearestAncestorIn(element, confirmedControls)
        || !isRendered(element)
        || !elementHasVisibleBox(element, options)
        || isBroadSurface(element)
      ) {
        return [];
      }

      const containsConfirmedControl = Array.from(confirmedControls)
        .some((control) => containsComposed(element, control));
      if (containsConfirmedControl) {
        return [];
      }

      const signal = candidateSignal(element, options);
      if (!signal) {
        return [];
      }

      const interaction = { kind: 'candidate', ...signal };
      const name = controlAccessibleName(element, interaction);
      if (!name) {
        return [];
      }
      return [{ element, interaction, name, depth: elementDepth(element) }];
    });

    const selected = [];
    rawCandidates
      .sort((first, second) => second.depth - first.depth)
      .forEach((candidate) => {
        const containsSelectedCandidate = selected
          .some(({ element }) => containsComposed(candidate.element, element));
        if (!containsSelectedCandidate) {
          selected.push(candidate);
        }
      });

    return new Map(selected.map(({ element, interaction, name }) => [
      element,
      { ...interaction, name },
    ]));
  };

  const generatedText = (element, pseudoElement) => {
    const content = nodeWindow(element).getComputedStyle(element, pseudoElement).content;
    if (!content || content === 'none' || content === 'normal' || /^url\(/.test(content)) {
      return '';
    }

    const unquoted = content
      .replace(/^(["'])(.*)\1$/, '$2')
      .replace(/\\A\s?/gi, ' ')
      .replace(/\\(["'\\])/g, '$1');
    const normalized = normalizeText(unquoted);

    // Private-use icon-font glyphs should not masquerade as readable text.
    return /[\p{L}\p{N}]/u.test(normalized) ? normalized : '';
  };

  const modalIsOpen = (element) => {
    if (!isRendered(element) || !elementHasVisibleBox(element, DEFAULTS)) {
      return false;
    }
    if (element.localName === 'dialog' && element.open) {
      return true;
    }
    if (
      ['dialog', 'alertdialog'].includes(effectiveRole(element))
      && element.getAttribute('aria-modal') === 'true'
    ) {
      return true;
    }
    try {
      return element.matches(':modal');
    } catch (error) {
      return false;
    }
  };

  const hasInertAncestor = (element) => {
    let current = element;
    while (current) {
      if (current.inert || current.hasAttribute('inert')) {
        return true;
      }
      current = composedParent(current);
    }
    return false;
  };

  const addAttribute = (entries, name, value) => {
    if (value !== null && value !== undefined && value !== '' && value !== false) {
      entries.push([name, String(value)]);
    }
  };

  const addBooleanAttribute = (entries, name, value) => {
    if (value) {
      entries.push([name, 'true']);
    }
  };

  const interactionCount = (children) => children.reduce((count, child) => {
    if (child.kind === 'text') {
      return count;
    }
    return count + (child.interaction ? 1 : 0) + interactionCount(child.children);
  }, 0);

  const meaningfulBranches = (children) => children.filter((child) => (
    child.kind === 'element'
    && (
      child.interaction
      || child.role
      || STRUCTURAL_TAGS.has(child.tag)
      || interactionCount(child.children) > 0
    )
  ));

  const inferLayout = (element, children) => {
    const units = children.filter(({ box }) => box);
    if (units.length < 2) {
      return null;
    }

    const style = nodeWindow(element).getComputedStyle(element);
    if (style.display.includes('grid')) {
      return 'grid';
    }
    if (style.display.includes('flex')) {
      if (style.flexWrap !== 'nowrap') {
        const topValues = units.map(({ box }) => Math.round(box.top));
        if (new Set(topValues).size > 1) {
          return 'grid';
        }
      }
      return style.flexDirection.startsWith('column') ? 'column' : 'row';
    }

    const boxes = units.map(({ box }) => box);
    const minimumHeight = Math.min(...boxes.map(({ height }) => height));
    const topSpread = Math.max(...boxes.map(({ top }) => top))
      - Math.min(...boxes.map(({ top }) => top));
    return topSpread <= Math.max(8, minimumHeight * 0.45) ? 'row' : null;
  };

  const shouldKeepVisualGroup = (element, children, layout) => {
    if (!layout || !['div', 'span'].includes(element.localName)) {
      return false;
    }

    const branches = meaningfulBranches(children);
    if (branches.length < 2) {
      return false;
    }

    const display = nodeWindow(element).getComputedStyle(element).display;
    const explicitLayout = display.includes('flex') || display.includes('grid');
    return explicitLayout || (layout === 'row' && interactionCount(children) >= 2);
  };

  const mergeAdjacentText = (children) => children.reduce((merged, child) => {
    const previous = merged[merged.length - 1];
    if (child.kind === 'text' && previous?.kind === 'text') {
      previous.value = normalizeText(`${previous.value} ${child.value}`);
      previous.box = unionRect([previous.box, child.box].filter(Boolean));
    } else {
      merged.push(child);
    }
    return merged;
  }, []);

  const deepActiveElement = (documentRoot) => {
    let active = documentRoot.activeElement;
    while (active?.shadowRoot?.activeElement) {
      active = active.shadowRoot.activeElement;
    }
    return active;
  };

  const createProjection = (documentRoot, options) => {
    const rootElement = documentRoot.body || documentRoot.documentElement;
    const elements = collectComposedElements(rootElement);
    const visibleConfirmedControls = new Set(elements.filter((element) => {
      const selectOption = element.localName === 'option' && Boolean(element.closest('select'));
      return isConfirmedControl(element)
        && isRendered(element)
        && (selectOption || elementHasVisibleBox(element, options));
    }));
    const confirmedControls = pruneNestedConfirmedControls(visibleConfirmedControls);
    const candidates = discoverCandidates(elements, confirmedControls, options);
    const interactions = new Map([
      ...Array.from(confirmedControls, (element) => [element, { kind: 'confirmed' }]),
      ...candidates,
    ]);
    const modals = elements.filter(modalIsOpen);
    let nodeCount = 0;
    let textCharacters = 0;
    let truncatedOutput = false;

    const canAdd = (textLength = 0) => {
      if (
        nodeCount + 1 > options.maxNodes
        || textCharacters + textLength > options.maxTextCharacters
      ) {
        truncatedOutput = true;
        return false;
      }
      nodeCount += 1;
      textCharacters += textLength;
      return true;
    };

    const projectText = (textNode, forceVisible = false) => {
      const value = normalizeText(textNode.nodeValue);
      if (!value || !textIsVisible(textNode, options, forceVisible) || !canAdd(value.length)) {
        return [];
      }
      return [{
        kind: 'text',
        value,
        box: forceVisible ? null : boxForText(textNode),
      }];
    };

    const projectElement = (element, forceVisible = false) => {
      const { localName: sourceTag } = element;
      if (EXCLUDED_BRANCH_TAGS.has(sourceTag) || !isRendered(element)) {
        return [];
      }

      const interaction = interactions.get(element) || null;
      const selectOption = sourceTag === 'option' && Boolean(element.closest('select'));
      const elementVisible = (
        forceVisible
        || selectOption
        || elementHasVisibleBox(element, options)
      );
      if (!elementVisible && !interaction) {
        return [];
      }
      if (MEDIA_TAGS.has(sourceTag) && !interaction) {
        return [];
      }

      const children = [];
      if (options.includeGeneratedText && elementVisible) {
        const before = generatedText(element, '::before');
        if (before && canAdd(before.length)) {
          children.push({ kind: 'text', value: before, box: null });
        }
      }

      if (!['input', 'textarea'].includes(sourceTag)) {
        composedChildren(element).forEach((child) => {
          if (child.nodeType === Node.TEXT_NODE) {
            children.push(...projectText(child, forceVisible || selectOption));
          } else if (child.nodeType === Node.ELEMENT_NODE) {
            children.push(...projectElement(child, forceVisible || selectOption));
          }
        });
      }

      if (options.includeGeneratedText && elementVisible) {
        const after = generatedText(element, '::after');
        if (after && canAdd(after.length)) {
          children.push({ kind: 'text', value: after, box: null });
        }
      }

      const mergedChildren = mergeAdjacentText(children);
      const role = effectiveRole(element);
      const containerName = containerAccessibleName(element);
      const semantic = (
        STRUCTURAL_TAGS.has(sourceTag)
        || isHeading(sourceTag)
        || Boolean(role)
        || Boolean(containerName)
      );
      const layout = inferLayout(element, mergedChildren);
      const visualGroup = shouldKeepVisualGroup(element, mergedChildren, layout);
      const style = nodeWindow(element).getComputedStyle(element);
      const textBlock = (
        sourceTag === 'div'
        && style.display !== 'inline'
        && mergedChildren.some(({ kind }) => kind === 'text')
      );
      const keep = interaction || semantic || visualGroup || textBlock;

      if (!keep) {
        return mergedChildren;
      }
      if (
        !interaction
        && mergedChildren.length === 0
        && !['br', 'hr', 'iframe'].includes(sourceTag)
      ) {
        return [];
      }
      if (!canAdd()) {
        return mergedChildren;
      }

      const interactionName = interaction
        ? (interaction.name || controlAccessibleName(element, interaction))
        : '';
      const name = interactionName || containerName;
      const outputNode = {
        kind: 'element',
        tag: validXmlTag(sourceTag),
        element,
        role,
        interaction,
        name,
        description: accessibleDescription(element, name),
        children: mergedChildren,
        grouping: visualGroup && !semantic,
        layout: layout && (visualGroup || style.display.includes('flex') || style.display.includes('grid'))
          ? layout
          : null,
        box: boxForElement(element, mergedChildren),
      };

      if (
        outputNode.grouping
        && outputNode.children.every(({ kind }) => kind === 'element')
        && ['row', 'grid'].includes(outputNode.layout)
      ) {
        outputNode.children.sort((first, second) => (
          first.box.top - second.box.top || first.box.left - second.box.left
        ));
      }
      return [outputNode];
    };

    const projected = composedChildren(rootElement).flatMap((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        return projectText(child);
      }
      if (child.nodeType === Node.ELEMENT_NODE) {
        return projectElement(child);
      }
      return [];
    });

    return {
      projected: mergeAdjacentText(projected),
      modals,
      nodeCount,
      textCharacters,
      truncatedOutput,
    };
  };

  const assignReferences = (nodes) => {
    let controlCount = 0;
    let candidateCount = 0;
    const refByElement = new Map();

    const visit = (node) => {
      if (node.kind === 'text') {
        return;
      }
      if (node.interaction?.kind === 'confirmed') {
        controlCount += 1;
        node.ref = `c${controlCount}`;
        refByElement.set(node.element, node.ref);
      } else if (node.interaction?.kind === 'candidate') {
        candidateCount += 1;
        node.ref = `i${candidateCount}`;
      }
      node.children.forEach(visit);
    };

    nodes.forEach(visit);
    return { controlCount, candidateCount, refByElement };
  };

  const elementAttributes = (outputNode, context) => {
    const { element, interaction } = outputNode;
    const entries = [];

    if (interaction?.kind === 'confirmed') {
      addAttribute(entries, 'ref', outputNode.ref);
    } else if (interaction?.kind === 'candidate') {
      addAttribute(entries, 'candidate-ref', outputNode.ref);
      entries.push(['interaction', 'inferred']);
      entries.push(['confidence', interaction.confidence]);
      entries.push(['evidence', interaction.source]);
    }

    addAttribute(entries, 'role', outputNode.role);
    addAttribute(entries, 'accessible-name', outputNode.name);
    addAttribute(entries, 'accessible-description', outputNode.description);

    if ((element.localName === 'a' || element.localName === 'area') && element.hasAttribute('href')) {
      addAttribute(entries, 'href', element.href);
      addAttribute(entries, 'target', element.getAttribute('target'));
      addAttribute(entries, 'rel', element.getAttribute('rel'));
      if (element.hasAttribute('download')) {
        entries.push(['download', element.getAttribute('download') || 'true']);
      }
    }

    if (element.localName === 'input') {
      const type = (element.getAttribute('type') || 'text').toLowerCase();
      entries.push(['type', type]);
      addAttribute(entries, 'placeholder', element.getAttribute('placeholder'));

      if (type === 'password') {
        addBooleanAttribute(entries, 'value-present', element.value.length > 0);
      } else if (type === 'file') {
        addAttribute(
          entries,
          'selected-files',
          Array.from(element.files || []).map(({ name }) => name).join(', '),
        );
      } else if (!['button', 'checkbox', 'image', 'radio', 'reset', 'submit'].includes(type)) {
        addAttribute(entries, 'value', element.value);
      }

      ['min', 'max', 'step', 'pattern', 'inputmode'].forEach((name) => {
        addAttribute(entries, name, element.getAttribute(name));
      });
    }

    if (element.localName === 'textarea') {
      addAttribute(entries, 'placeholder', element.getAttribute('placeholder'));
      addAttribute(entries, 'value', element.value);
    }
    if (element.localName === 'select') {
      addAttribute(entries, 'value', element.value);
      addBooleanAttribute(entries, 'multiple', element.multiple);
    }

    if (element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true') {
      entries.push(['disabled', 'true']);
    }
    if (hasInertAncestor(element)) {
      entries.push(['unavailable', 'true']);
    }
    if (
      context.modals.length > 0
      && interaction
      && !context.modals.some((modal) => containsComposed(modal, element))
    ) {
      entries.push(['blocked-by-modal', 'true']);
    }

    if ('checked' in element && ['checkbox', 'radio'].includes(element.type)) {
      entries.push(['checked', String(element.checked)]);
    } else {
      addAttribute(entries, 'checked', element.getAttribute('aria-checked'));
    }
    if ('selected' in element && element.localName === 'option') {
      entries.push(['selected', String(element.selected)]);
    } else {
      addAttribute(entries, 'selected', element.getAttribute('aria-selected'));
    }

    [
      'expanded',
      'pressed',
      'current',
      'invalid',
      'busy',
      'orientation',
    ].forEach((state) => {
      addAttribute(entries, state, element.getAttribute(`aria-${state}`));
    });
    addAttribute(entries, 'haspopup', element.getAttribute('aria-haspopup'));
    addBooleanAttribute(
      entries,
      'required',
      element.required || element.getAttribute('aria-required') === 'true',
    );
    addBooleanAttribute(
      entries,
      'readonly',
      element.readOnly || element.getAttribute('aria-readonly') === 'true',
    );
    addBooleanAttribute(entries, 'open', Boolean(element.open));
    addBooleanAttribute(entries, 'modal', context.modals.includes(element));
    addBooleanAttribute(entries, 'focused', context.activeElement === element);

    if (!interaction && element.hasAttribute('tabindex') && element.tabIndex >= 0) {
      entries.push(['focusable', 'true']);
    }
    if (isHeading(element.localName)) {
      addAttribute(
        entries,
        'level',
        element.getAttribute('aria-level') || element.localName.slice(1),
      );
    }
    addAttribute(entries, 'datetime', element.getAttribute('datetime'));
    addAttribute(entries, 'lang', element.getAttribute('lang'));
    addAttribute(entries, 'scope', element.getAttribute('scope'));
    addAttribute(entries, 'live', element.getAttribute('aria-live'));
    addAttribute(entries, 'role-description', element.getAttribute('aria-roledescription'));

    if (outputNode.grouping) {
      entries.push(['grouping', 'visual']);
    }
    addAttribute(entries, 'layout', outputNode.layout);
    addAttribute(entries, 'src', element.localName === 'iframe' ? element.src : '');
    addAttribute(entries, 'title', element.localName === 'iframe' ? element.title : '');

    const labelControl = element.localName === 'label' ? element.control : null;
    addAttribute(entries, 'for-ref', context.refByElement.get(labelControl));
    return entries;
  };

  const attributes = (entries) => entries
    .filter(([, value]) => value !== null && value !== undefined && value !== false && value !== '')
    .map(([name, value]) => `${name}="${xmlSafe(value)}"`)
    .join(' ');

  const canRenderInline = (node) => {
    if (node.kind === 'text') {
      return true;
    }
    return INLINE_TAGS.has(node.tag) && node.children.every(canRenderInline);
  };

  const renderCompact = (node, context) => {
    if (node.kind === 'text') {
      return xmlSafe(node.value);
    }

    const attributeText = attributes(elementAttributes(node, context));
    const opening = attributeText ? `<${node.tag} ${attributeText}` : `<${node.tag}`;
    if (node.children.length === 0) {
      return `${opening} />`;
    }
    return `${opening}>${node.children
      .map((child) => renderCompact(child, context))
      .join(' ')}</${node.tag}>`;
  };

  const renderNode = (node, depth, context) => {
    const indent = '  '.repeat(depth);
    if (node.kind === 'text') {
      return `${indent}${xmlSafe(node.value)}`;
    }

    const attributeText = attributes(elementAttributes(node, context));
    const opening = attributeText ? `<${node.tag} ${attributeText}` : `<${node.tag}`;
    if (node.children.length === 0) {
      return `${indent}${opening} />`;
    }

    if (node.children.every(canRenderInline)) {
      const compact = `${opening}>${node.children
        .map((child) => renderCompact(child, context))
        .join(' ')}</${node.tag}>`;
      if (compact.length <= 240) {
        return `${indent}${compact}`;
      }
    }

    return [
      `${indent}${opening}>`,
      ...node.children.map((child) => renderNode(child, depth + 1, context)),
      `${indent}</${node.tag}>`,
    ].join('\n');
  };

  const copyWithSelection = (value) => {
    const previousFocus = document.activeElement;
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', '');
    Object.assign(textarea.style, {
      position: 'fixed',
      left: '-9999px',
      opacity: '0',
      pointerEvents: 'none',
    });
    document.documentElement.append(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();

    if (previousFocus instanceof HTMLElement) {
      previousFocus.focus({ preventScroll: true });
    }
    return copied;
  };

  const writeToClipboard = (value) => {
    const reportSuccess = () => console.info('Semantic UI XML copied to clipboard.');
    const trySelectionCopy = () => {
      try {
        if (copyWithSelection(value)) {
          reportSuccess();
          return;
        }
      } catch (error) {
        console.warn('Clipboard fallback failed.', error);
      }
      console.warn('Clipboard access was blocked; the XML is still returned and logged.');
    };

    try {
      if (typeof copy === 'function') {
        copy(value);
        reportSuccess();
        return;
      }
    } catch (error) {
      console.warn('DevTools clipboard helper failed.', error);
    }

    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(value).then(reportSuccess).catch(trySelectionCopy);
      return;
    }
    trySelectionCopy();
  };

  const extractSemanticUI = (userOptions = {}) => {
    const options = { ...DEFAULTS, ...userOptions };
    const projection = createProjection(document, options);
    const {
      controlCount,
      candidateCount,
      refByElement,
    } = assignReferences(projection.projected);
    const context = {
      activeElement: deepActiveElement(document),
      modals: projection.modals,
      refByElement,
    };
    const pageEntries = [
      ['schema', 'semantic-ui/2'],
      ['url', window.location.href],
      ['title', document.title],
      ['lang', document.documentElement.lang],
      ['controls', controlCount],
      ['inferred-candidates', candidateCount],
      ['nodes', projection.nodeCount],
      ['text-characters', projection.textCharacters],
      ['modal-open', projection.modals.length > 0 ? 'true' : undefined],
      ['truncated', projection.truncatedOutput ? 'true' : undefined],
    ];
    const content = projection.projected.map((node) => renderNode(node, 1, context));
    if (projection.truncatedOutput) {
      content.push('  <truncated reason="configured-output-limit" />');
    }

    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<page ${attributes(pageEntries)}>`,
      ...content,
      '</page>',
    ].join('\n');

    if (options.copyToClipboard) {
      writeToClipboard(xml);
    }
    return xml;
  };

  window.extractSemanticUI = extractSemanticUI;
  window.extractWebsiteUI = extractSemanticUI;
  const xml = extractSemanticUI();
  console.log(xml);
  return xml;
})();

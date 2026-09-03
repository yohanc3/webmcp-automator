/* global copy */

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
    'script',
    'style',
    'template',
    'noscript',
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

  const truncate = (value, limit = 1200) => {
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
      const view = nodeWindow(current);
      const style = view.getComputedStyle(current);
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
    range.detach();
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

  const isHeaderOrFooterLandmark = (element) => {
    const disqualifyingAncestor = element.closest('article, aside, main, nav, section');
    return !disqualifyingAncestor;
  };

  const implicitRole = (element) => {
    const { localName: tag } = element;

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
        radio: 'radio',
        range: 'slider',
        reset: 'button',
        search: 'searchbox',
        submit: 'button',
        tel: 'textbox',
        text: 'textbox',
        url: 'textbox',
      };
      return roles[type] || (type === 'password' ? 'textbox' : null);
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
    if (explicitRole === 'none' || explicitRole === 'presentation') {
      return null;
    }
    return explicitRole || implicitRole(element);
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

  const isSemanticControl = (element) => (
    isNativeControl(element)
    || INTERACTIVE_ROLES.has(effectiveRole(element))
    || element.isContentEditable
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

  const hasAncestorIn = (element, elements) => {
    let current = composedParent(element);
    while (current) {
      if (elements.has(current)) {
        return true;
      }
      current = composedParent(current);
    }
    return false;
  };

  const isPointerBoundary = (element) => {
    const view = nodeWindow(element);
    if (view.getComputedStyle(element).cursor !== 'pointer') {
      return false;
    }

    const parent = composedParent(element);
    return !parent || view.getComputedStyle(parent).cursor !== 'pointer';
  };

  const interactionInfo = (element, semanticControls, options) => {
    if (semanticControls.has(element)) {
      return { source: 'semantic', inferred: false };
    }
    if (element.hasAttribute('onclick') || typeof element.onclick === 'function') {
      return { source: 'onclick', inferred: true };
    }
    if (element.tabIndex >= 0 && element.hasAttribute('tabindex')) {
      return { source: 'focusable', inferred: true };
    }
    if (element.getAttribute('draggable') === 'true') {
      return { source: 'draggable', inferred: true };
    }
    if (!options.pointerHeuristic || !isPointerBoundary(element)) {
      return null;
    }
    if (hasAncestorIn(element, semanticControls)) {
      return null;
    }

    const containsSemanticControl = Array.from(semanticControls)
      .some((control) => control !== element && containsComposed(element, control));
    if (containsSemanticControl) {
      return null;
    }

    const rect = element.getBoundingClientRect();
    const view = nodeWindow(element);
    const coversMostOfViewport = (
      rect.width >= view.innerWidth * 0.9
      && rect.height >= view.innerHeight * 0.9
    );
    return coversMostOfViewport
      ? null
      : { source: 'pointer', inferred: true };
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

  const accessibleName = (element, controlInfo) => {
    const explicitName = explicitAccessibleName(element);
    if (explicitName) {
      return truncate(explicitName);
    }

    if (controlInfo && element.labels && element.labels.length > 0) {
      const label = Array.from(element.labels)
        .map((item) => accessibleText(item))
        .join(' ');
      if (normalizeText(label)) {
        return truncate(label);
      }
    }

    if (element.localName === 'input') {
      const type = (element.getAttribute('type') || 'text').toLowerCase();
      if (type === 'image' && element.alt) {
        return truncate(element.alt);
      }
      if (['button', 'reset', 'submit'].includes(type) && element.value) {
        return truncate(element.value);
      }
    }
    if (
      controlInfo
      && (controlInfo.inferred || NAME_FROM_CONTENT_ROLES.has(effectiveRole(element)))
    ) {
      const contentName = normalizeText(accessibleText(element));
      if (contentName) {
        return truncate(contentName);
      }
    }

    const title = normalizeText(element.getAttribute('title'));
    return (controlInfo || element.localName === 'iframe') && title ? truncate(title) : '';
  };

  const accessibleDescription = (element, name) => {
    const description = (
      referencedText(element, 'aria-describedby')
      || normalizeText(element.getAttribute('aria-description'))
    );
    if (description) {
      return truncate(description);
    }

    const title = normalizeText(element.getAttribute('title'));
    return title && title !== name ? truncate(title) : '';
  };

  const generatedText = (element, pseudoElement) => {
    const view = nodeWindow(element);
    const content = view.getComputedStyle(element, pseudoElement).content;
    if (!content || content === 'none' || content === 'normal' || /^url\(/.test(content)) {
      return '';
    }

    const unquoted = content
      .replace(/^(["'])(.*)\1$/, '$2')
      .replace(/\\A\s?/gi, ' ')
      .replace(/\\(["'\\])/g, '$1');
    const normalized = normalizeText(unquoted);

    // Generated icon-font glyphs are not readable UI text.
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

  const elementStateAttributes = (outputNode, context) => {
    const { element, controlInfo } = outputNode;
    const entries = [];

    if (controlInfo) {
      addAttribute(entries, 'ref', outputNode.ref);
    }
    addAttribute(entries, 'role', outputNode.role);
    addAttribute(entries, 'accessible-name', outputNode.name);
    addAttribute(entries, 'accessible-description', outputNode.description);

    if (controlInfo?.inferred) {
      entries.push(['interaction', 'inferred']);
      entries.push(['interaction-source', controlInfo.source]);
    }

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
      && controlInfo
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

  const countControls = (children) => children.reduce((count, child) => {
    if (child.kind === 'text') {
      return count;
    }
    return count + (child.controlInfo ? 1 : 0) + countControls(child.children);
  }, 0);

  const childUnits = (children) => children.filter((child) => (
    child.kind === 'element' || normalizeText(child.value)
  ));

  const inferLayout = (element, children) => {
    const units = childUnits(children).filter(({ box }) => box);
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
    const sortedByHeight = [...boxes].sort((first, second) => first.height - second.height);
    const medianHeight = sortedByHeight[Math.floor(sortedByHeight.length / 2)].height;
    const topSpread = Math.max(...boxes.map(({ top }) => top))
      - Math.min(...boxes.map(({ top }) => top));
    if (topSpread <= Math.max(8, medianHeight * 0.45)) {
      return 'row';
    }
    return null;
  };

  const shouldKeepVisualGroup = (element, children, layout) => {
    if (!layout || !['div', 'span'].includes(element.localName)) {
      return false;
    }

    const units = childUnits(children);
    if (units.length < 2) {
      return false;
    }
    const style = nodeWindow(element).getComputedStyle(element);
    const explicitLayout = style.display.includes('flex') || style.display.includes('grid');
    return explicitLayout || countControls(children) >= 2;
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

  const createProjection = (documentRoot, options) => {
    const rootElement = documentRoot.body || documentRoot.documentElement;
    const elements = collectComposedElements(rootElement);
    const semanticControls = new Set(elements.filter((element) => {
      const isSelectOption = element.localName === 'option' && Boolean(element.closest('select'));
      return isSemanticControl(element)
        && isRendered(element)
        && (isSelectOption || elementHasVisibleBox(element, options));
    }));
    const interactionByElement = new Map();

    elements.forEach((element) => {
      const isSelectOption = element.localName === 'option' && Boolean(element.closest('select'));
      if (
        element === rootElement
        || EXCLUDED_BRANCH_TAGS.has(element.localName)
        || !isRendered(element)
        || (!isSelectOption && !elementHasVisibleBox(element, options))
      ) {
        return;
      }

      const info = interactionInfo(element, semanticControls, options);
      if (info) {
        interactionByElement.set(element, info);
      }
    });

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
      const { localName: tag } = element;
      if (EXCLUDED_BRANCH_TAGS.has(tag) || !isRendered(element)) {
        return [];
      }

      const controlInfo = interactionByElement.get(element) || null;
      const isOption = tag === 'option' && Boolean(element.closest('select'));
      const elementVisible = forceVisible
        || isOption
        || elementHasVisibleBox(element, options);
      if (!elementVisible && !controlInfo) {
        return [];
      }

      if (MEDIA_TAGS.has(tag) && !controlInfo) {
        return [];
      }

      const children = [];
      if (options.includeGeneratedText && elementVisible) {
        const before = generatedText(element, '::before');
        if (before && canAdd(before.length)) {
          children.push({ kind: 'text', value: before, box: null });
        }
      }

      const skipDomChildren = tag === 'input' || tag === 'textarea';
      if (!skipDomChildren) {
        composedChildren(element).forEach((child) => {
          if (child.nodeType === Node.TEXT_NODE) {
            children.push(...projectText(child, forceVisible || isOption));
          } else if (child.nodeType === Node.ELEMENT_NODE) {
            children.push(...projectElement(child, forceVisible || isOption));
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
      const namedContainer = Boolean(explicitAccessibleName(element));
      const semanticallyRetained = (
        STRUCTURAL_TAGS.has(tag)
        || isHeading(tag)
        || Boolean(role)
        || namedContainer
      );
      const layout = inferLayout(element, mergedChildren);
      const visualGroup = shouldKeepVisualGroup(element, mergedChildren, layout);
      const style = nodeWindow(element).getComputedStyle(element);
      const textBlock = (
        tag === 'div'
        && style.display !== 'inline'
        && mergedChildren.some(({ kind }) => kind === 'text')
      );
      const keep = controlInfo || semanticallyRetained || visualGroup || textBlock;

      if (!keep) {
        return mergedChildren;
      }
      if (!controlInfo && mergedChildren.length === 0 && !['br', 'hr', 'iframe'].includes(tag)) {
        return [];
      }
      if (!canAdd()) {
        return mergedChildren;
      }

      const name = accessibleName(element, controlInfo || namedContainer);
      const outputNode = {
        kind: 'element',
        tag: validXmlTag(tag),
        element,
        role,
        controlInfo,
        name,
        description: accessibleDescription(element, name),
        children: mergedChildren,
        grouping: visualGroup && !semanticallyRetained,
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

  const deepActiveElement = (documentRoot) => {
    let active = documentRoot.activeElement;
    while (active?.shadowRoot?.activeElement) {
      active = active.shadowRoot.activeElement;
    }
    return active;
  };

  const assignControlRefs = (nodes) => {
    let controlCount = 0;
    const refByElement = new Map();
    const visit = (node) => {
      if (node.kind === 'text') {
        return;
      }
      if (node.controlInfo) {
        controlCount += 1;
        node.ref = `c${controlCount}`;
        refByElement.set(node.element, node.ref);
      }
      node.children.forEach(visit);
    };
    nodes.forEach(visit);
    return { controlCount, refByElement };
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

    const entries = elementStateAttributes(node, context);
    const attributeText = attributes(entries);
    const opening = attributeText ? `<${node.tag} ${attributeText}` : `<${node.tag}`;
    if (node.children.length === 0) {
      return `${opening} />`;
    }
    return `${opening}>${node.children.map((child) => renderCompact(child, context)).join(' ')}</${node.tag}>`;
  };

  const renderNode = (node, depth, context) => {
    const indent = '  '.repeat(depth);
    if (node.kind === 'text') {
      return `${indent}${xmlSafe(node.value)}`;
    }

    const entries = elementStateAttributes(node, context);
    const attributeText = attributes(entries);
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

  const extractWebsiteUI = (userOptions = {}) => {
    const options = { ...DEFAULTS, ...userOptions };
    const projection = createProjection(document, options);
    const { controlCount, refByElement } = assignControlRefs(projection.projected);
    const context = {
      activeElement: deepActiveElement(document),
      modals: projection.modals,
      refByElement,
    };
    const pageEntries = [
      ['schema', 'semantic-ui/1'],
      ['url', window.location.href],
      ['title', document.title],
      ['lang', document.documentElement.lang],
      ['controls', controlCount],
      ['nodes', projection.nodeCount],
      ['text-characters', projection.textCharacters],
      ['modal-open', projection.modals.length > 0 ? 'true' : undefined],
      ['truncated', projection.truncatedOutput ? 'true' : undefined],
    ];
    const pageAttributes = attributes(pageEntries);
    const content = projection.projected.map((node) => renderNode(node, 1, context));
    if (projection.truncatedOutput) {
      content.push('  <truncated reason="configured-output-limit" />');
    }

    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<page ${pageAttributes}>`,
      ...content,
      '</page>',
    ].join('\n');

    if (options.copyToClipboard) {
      writeToClipboard(xml);
    }
    return xml;
  };

  window.extractWebsiteUI = extractWebsiteUI;
  window.extractSemanticUI = extractWebsiteUI;
  const xml = extractWebsiteUI();
  console.log(xml);
  return xml;
})();

(() => {
  'use strict';

  const model = globalThis.XActionModel.createActionModel(globalThis.X_ACTION_SNAPSHOT);
  const actions = [...model.actions].sort((first, second) => (
    first.y - second.y || first.x - second.x || first.sourceIndex - second.sourceIndex
  ));
  const meaningfulActions = actions.filter(({ height }) => height < 3000);
  const contentExtent = Math.ceil(Math.max(
    ...meaningfulActions.map(({ y, height }) => y + height),
    Number.parseFloat(model.meta['viewport-height'] || '0'),
  ) + 32);
  const state = { scale: 0.7, selectedId: '' };

  const elements = {
    canvas: document.querySelector('#ui-canvas'),
    sizer: document.querySelector('#ui-stage-sizer'),
    stage: document.querySelector('#ui-stage'),
    summary: document.querySelector('#canvas-summary'),
    showLabels: document.querySelector('#show-labels'),
    inspectorTitle: document.querySelector('#inspector-title'),
    inspectorOutcome: document.querySelector('#inspector-outcome'),
    inspectorContent: document.querySelector('#inspector-content'),
    ledgerLink: document.querySelector('#inspector-ledger-link'),
  };

  const confidenceLabels = {
    confirmed: 'Confirmed by XML',
    inferred: 'Inferred from layout',
    unclear: 'Unclear from XML',
  };

  const escapeHtml = (value = '') => String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

  const truncate = (value, length = 92) => (
    value.length > length ? `${value.slice(0, length - 1).trim()}…` : value
  );

  const postMarkup = (action) => {
    const match = action.innerText.match(/^(.+?)\s+(@[A-Za-z0-9_]+)\s+·\s+([^ ]+)\s+([\s\S]*)$/);
    if (!match) {
      return `<div class="post-reconstruction"><span>${escapeHtml(truncate(action.innerText, 240))}</span></div>`;
    }
    const [, author, handle, time, body] = match;
    return `
      <div class="post-reconstruction">
        <strong>${escapeHtml(author)}</strong>
        <small>${escapeHtml(`${handle} · ${time}`)}</small>
        <span>${escapeHtml(truncate(body, 260))}</span>
      </div>
    `;
  };

  const iconFor = (action) => {
    const title = action.title.toLowerCase();
    if (title.includes('reply')) return '↩';
    if (title.includes('repost')) return '↻';
    if (title.includes('like')) return '♡';
    if (title.includes('bookmark')) return '◇';
    if (title.includes('share')) return '↗';
    if (title.includes('more')) return '•••';
    if (title.includes('grok')) return '✦';
    if (title.includes('play') || title.includes('media')) return '▶';
    if (title.includes('gif')) return 'GIF';
    if (title.includes('poll')) return '≡';
    if (title.includes('emoji')) return '☺';
    if (title.includes('schedule')) return '◷';
    if (title.includes('location')) return '⌖';
    if (title.includes('photo')) return 'Photo';
    if (title.includes('timeline controls')) return '≡';
    return '?';
  };

  const profileInitial = (action) => {
    try {
      const segment = new URL(action.href).pathname.split('/').filter(Boolean)[0] || '';
      return segment.slice(0, 1).toUpperCase();
    } catch (error) {
      return '•';
    }
  };

  const isPhoto = (action) => action.href.includes('/photo/');

  const isAvatar = (action) => (
    !action.innerText
    && action.width >= 40
    && action.width <= 52
    && action.height >= 40
    && action.height <= 55
    && action.category === 'Account'
  );

  const isEngagement = (action) => /^(Reply|Repost|Like|Bookmark|Share)/.test(action.title);

  const isBroadRegion = (action) => (
    ['a3', 'a11'].includes(action.id) || action.height > 3000
  );

  const visualClasses = (action) => {
    const classes = [
      'ui-hit',
      `type-${action.type.replace(/[^a-z0-9-]/gi, '-').toLowerCase()}`,
      `confidence-${action.confidence}`,
    ];
    if (isAvatar(action)) classes.push('is-avatar');
    if (
      isPhoto(action)
      || (action.category === 'Media' && action.width > 100)
    ) classes.push('is-media');
    if (action.width <= 40 && action.height <= 40 && !action.innerText) {
      classes.push('is-small-control');
    }
    if (isEngagement(action)) classes.push('is-engagement');
    if (action.region === 'navigation' && action.width > 150) classes.push('is-navigation');
    if (action.region === 'discovery' && action.width > 300 && action.height >= 50) {
      classes.push('is-rail-card');
    }
    if (isBroadRegion(action)) classes.push('is-broad-region');
    return classes.join(' ');
  };

  const visualText = (action) => {
    if (action.type === 'article') {
      return postMarkup(action);
    }
    if (isAvatar(action)) {
      return escapeHtml(profileInitial(action));
    }
    if (isPhoto(action)) {
      const match = action.href.match(/\/photo\/(\d+)/);
      return escapeHtml(`Photo ${match?.[1] || ''}`.trim());
    }
    if (action.type === 'textbox' || action.type === 'combobox') {
      return '';
    }
    if (isEngagement(action)) {
      return `${escapeHtml(iconFor(action))}<span>${escapeHtml(action.innerText)}</span>`;
    }
    if (action.innerText) {
      return escapeHtml(truncate(action.innerText));
    }
    if (action.id === 'a12') {
      return 'X';
    }
    return escapeHtml(iconFor(action));
  };

  const renderAction = (action) => {
    const style = [
      `left:${action.x}px`,
      `top:${action.y}px`,
      `width:${Math.max(action.width, 2)}px`,
      `height:${Math.max(action.height, 2)}px`,
    ].join(';');
    const disabled = isBroadRegion(action) ? ' tabindex="-1"' : '';
    return `
      <button
        class="${visualClasses(action)}"
        type="button"
        style="${style}"
        data-action-id="${escapeHtml(action.id)}"
        aria-label="${escapeHtml(`${action.id}: ${action.title}`)}"
        title="${escapeHtml(`${action.id} · ${action.title}`)}"
        ${disabled}
      >
        ${visualText(action)}
        <span class="ui-id-label">${escapeHtml(action.id)}</span>
      </button>
    `;
  };

  const renderCanvas = () => {
    const structuralColumns = Array.from(elements.canvas.querySelectorAll('.ui-column'))
      .map((column) => column.outerHTML)
      .join('');
    elements.canvas.innerHTML = `${structuralColumns}${actions.map(renderAction).join('')}`;
    elements.canvas.style.width = `${model.meta.width}px`;
    elements.canvas.style.height = `${contentExtent}px`;
    elements.canvas.style.transform = `scale(${state.scale})`;
    elements.sizer.style.width = `${model.meta.width * state.scale}px`;
    elements.sizer.style.height = `${contentExtent * state.scale}px`;
    elements.summary.textContent = [
      `${actions.length} action targets`,
      `${contentExtent.toLocaleString()}px loaded extent`,
    ].join(' · ');
  };

  const evidenceRow = (label, value) => (
    value
      ? `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`
      : ''
  );

  const selectAction = (actionId) => {
    const action = actions.find(({ id }) => id === actionId);
    if (!action) {
      return;
    }
    state.selectedId = actionId;
    elements.canvas.querySelectorAll('.ui-hit.is-selected').forEach((node) => {
      node.classList.remove('is-selected');
    });
    elements.canvas.querySelector(`[data-action-id="${CSS.escape(actionId)}"]`)?.classList.add('is-selected');
    elements.inspectorTitle.textContent = action.title;
    elements.inspectorOutcome.textContent = action.outcome;
    elements.inspectorContent.innerHTML = `
      <span class="badge ${escapeHtml(action.confidence)}">${confidenceLabels[action.confidence]}</span>
      <dl class="inspector-grid">
        ${evidenceRow('XML id', action.id)}
        ${evidenceRow('node', `<${action.tag}>`)}
        ${evidenceRow('type', action.type)}
        ${evidenceRow('region', action.regionLabel)}
        ${evidenceRow('inner text', action.innerText || '(empty)')}
        ${evidenceRow('href', action.href)}
        ${evidenceRow('box', `${action.x}, ${action.y} · ${action.width} × ${action.height}px`)}
        ${evidenceRow('basis', action.basis)}
      </dl>
    `;
    elements.ledgerLink.href = `index.html?action=${encodeURIComponent(action.id)}`;
    elements.ledgerLink.hidden = false;
  };

  const setScale = (scale) => {
    state.scale = scale;
    elements.canvas.style.transform = `scale(${scale})`;
    elements.sizer.style.width = `${model.meta.width * scale}px`;
    elements.sizer.style.height = `${contentExtent * scale}px`;
    document.querySelectorAll('[data-scale]').forEach((button) => {
      button.classList.toggle('is-active', Number.parseFloat(button.dataset.scale) === scale);
    });
  };

  document.addEventListener('click', (event) => {
    const scaleButton = event.target.closest('[data-scale]');
    if (scaleButton) {
      setScale(Number.parseFloat(scaleButton.dataset.scale));
      return;
    }
    const hit = event.target.closest('[data-action-id]');
    if (hit && !hit.classList.contains('is-broad-region')) {
      selectAction(hit.dataset.actionId);
    }
  });

  elements.showLabels.addEventListener('change', (event) => {
    elements.canvas.classList.toggle('hide-labels', !event.target.checked);
  });

  renderCanvas();
  setScale(state.scale);
})();

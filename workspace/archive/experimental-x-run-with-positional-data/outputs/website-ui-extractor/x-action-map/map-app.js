(() => {
  'use strict';

  const model = globalThis.XActionModel.createActionModel(globalThis.X_ACTION_SNAPSHOT);
  const orderedActions = [...model.actions].sort((first, second) => (
    first.y - second.y || first.x - second.x || first.sourceIndex - second.sourceIndex
  ));
  const state = {
    query: '',
    region: 'all',
    confidence: 'all',
    category: 'all',
    selectedId: new URLSearchParams(window.location.search).get('action') || '',
  };

  const elements = {
    stats: document.querySelector('#snapshot-stats'),
    search: document.querySelector('#action-search'),
    regionFilters: document.querySelector('#region-filters'),
    confidenceFilters: document.querySelector('#confidence-filters'),
    categoryFilters: document.querySelector('#category-filters'),
    resultsSummary: document.querySelector('#results-summary'),
    clearFilters: document.querySelector('#clear-filters'),
    list: document.querySelector('#action-list'),
    empty: document.querySelector('#empty-state'),
    strip: document.querySelector('#strip-markers'),
    coverage: document.querySelector('#coverage-count'),
    toast: document.querySelector('#toast'),
  };

  const confidenceLabels = {
    confirmed: 'Confirmed',
    inferred: 'Inferred',
    unclear: 'Unclear',
  };

  const escapeHtml = (value = '') => String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

  const safeHref = (value) => {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
    } catch (error) {
      return '';
    }
  };

  const countBy = (key) => orderedActions.reduce((counts, action) => {
    counts.set(action[key], (counts.get(action[key]) || 0) + 1);
    return counts;
  }, new Map());

  const countMatching = (action) => {
    const searchable = [
      action.id,
      action.title,
      action.outcome,
      action.innerText,
      action.href,
      action.type,
      action.category,
      action.regionLabel,
      action.classes,
    ].join(' ').toLowerCase();
    const terms = state.query.toLowerCase().split(/\s+/).filter(Boolean);
    return (
      terms.every((term) => searchable.includes(term))
      && (state.region === 'all' || action.region === state.region)
      && (state.confidence === 'all' || action.confidence === state.confidence)
      && (state.category === 'all' || action.category === state.category)
    );
  };

  const filterOptions = (counts, labels) => [
    { value: 'all', label: 'All', count: orderedActions.length },
    ...Array.from(counts.entries()).map(([value, count]) => ({
      value,
      label: labels[value] || value,
      count,
    })),
  ];

  const renderFilterGroup = (container, filterName, options) => {
    container.innerHTML = options.map(({ value, label, count }) => `
      <button
        class="filter-chip"
        type="button"
        data-filter="${escapeHtml(filterName)}"
        data-value="${escapeHtml(value)}"
        aria-pressed="${state[filterName] === value}"
      >
        ${escapeHtml(label)}<span class="chip-count">${count}</span>
      </button>
    `).join('');
  };

  const evidenceRow = (label, value) => (
    value === undefined || value === null || value === ''
      ? ''
      : `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`
  );

  const renderAction = (action) => {
    const href = safeHref(action.href);
    const selectedClass = action.id === state.selectedId ? ' is-selected' : '';
    const position = `${Math.round(action.x)}, ${Math.round(action.y)}`;
    const size = `${Math.round(action.width)} × ${Math.round(action.height)}px`;
    const actionLink = href
      ? `<a class="action-link" href="${escapeHtml(href)}" target="_blank" rel="noreferrer">Open destination ↗</a>`
      : '';

    return `
      <article
        class="action-row${selectedClass}"
        id="action-${escapeHtml(action.id)}"
        data-action-id="${escapeHtml(action.id)}"
      >
        <div class="action-index">
          <code>${escapeHtml(action.id)}</code>
          <span>y ${Math.round(action.y)}</span>
        </div>
        <div class="action-copy">
          <div class="action-meta">
            <span class="badge ${escapeHtml(action.confidence)}">${confidenceLabels[action.confidence]}</span>
            <span class="category-label">${escapeHtml(action.category)}</span>
            <span class="region-label">${escapeHtml(action.regionLabel)}</span>
          </div>
          <h2>${escapeHtml(action.title)}</h2>
          <p class="action-outcome">${escapeHtml(action.outcome)}</p>
          <p class="action-basis">Why: ${escapeHtml(action.basis)}</p>
          <details class="evidence-details">
            <summary>XML evidence</summary>
            <dl class="evidence-grid">
              ${evidenceRow('node', `<${action.tag}>`)}
              ${evidenceRow('type', action.type)}
              ${evidenceRow('inner-text', action.innerText || '(empty)')}
              ${evidenceRow('href', action.href)}
              ${evidenceRow('box x,y', position)}
              ${evidenceRow('size', size)}
              ${evidenceRow('parent group', action.parentGroup)}
              ${evidenceRow('DOM id', action.domId)}
              ${evidenceRow('classes', action.classes)}
            </dl>
          </details>
        </div>
        <div class="action-links">
          ${actionLink}
          <button class="copy-id" type="button" data-copy-id="${escapeHtml(action.id)}">Copy ID</button>
        </div>
      </article>
    `;
  };

  const visibleActions = () => orderedActions.filter(countMatching);

  const updateMarkerState = (visible) => {
    const visibleIds = new Set(visible.map(({ id }) => id));
    elements.strip.querySelectorAll('.strip-marker').forEach((marker) => {
      marker.classList.toggle('is-filtered-out', !visibleIds.has(marker.dataset.actionId));
      marker.classList.toggle('is-selected', marker.dataset.actionId === state.selectedId);
    });
  };

  const renderResults = () => {
    const visible = visibleActions();
    elements.list.innerHTML = visible.map(renderAction).join('');
    elements.empty.hidden = visible.length !== 0;
    elements.resultsSummary.innerHTML = `<strong>${visible.length}</strong> of ${orderedActions.length} actions shown`;
    elements.coverage.textContent = `${visible.length}/${orderedActions.length}`;
    updateMarkerState(visible);
  };

  const renderStats = () => {
    const withText = orderedActions.filter(({ innerText }) => innerText).length;
    const withHref = orderedActions.filter(({ href }) => href).length;
    const iconOnly = orderedActions.filter(({ innerText, href }) => !innerText && !href).length;
    const unclear = orderedActions.filter(({ confidence }) => confidence === 'unclear').length;
    const items = [
      [orderedActions.length, 'XML actions mapped'],
      [withText, 'with inner text'],
      [withHref, 'with destinations'],
      [iconOnly, 'icon-only'],
      [unclear, 'still unclear'],
    ];
    elements.stats.innerHTML = items.map(([value, label]) => `
      <span class="stat-item"><strong>${value}</strong>${escapeHtml(label)}</span>
    `).join('');
  };

  const renderFilters = () => {
    const regionLabels = model.regionLabels;
    renderFilterGroup(
      elements.regionFilters,
      'region',
      filterOptions(countBy('region'), regionLabels),
    );
    renderFilterGroup(
      elements.confidenceFilters,
      'confidence',
      filterOptions(countBy('confidence'), confidenceLabels),
    );
    const categoryCounts = countBy('category');
    const categoryOptions = filterOptions(categoryCounts, {});
    categoryOptions.sort((first, second) => (
      first.value === 'all' ? -1 : second.value === 'all' ? 1 : first.label.localeCompare(second.label)
    ));
    renderFilterGroup(elements.categoryFilters, 'category', categoryOptions);
  };

  const renderStrip = () => {
    elements.strip.innerHTML = orderedActions.map((action) => {
      const left = Math.min(98, Math.max(2, ((action.x + (action.width / 2)) / model.meta.width) * 100));
      const top = Math.min(99.3, Math.max(0.7, ((action.y + (action.height / 2)) / model.meta.height) * 100));
      return `
        <button
          class="strip-marker ${escapeHtml(action.confidence)}"
          type="button"
          style="left:${left.toFixed(2)}%;top:${top.toFixed(2)}%"
          data-action-id="${escapeHtml(action.id)}"
          aria-label="${escapeHtml(`${action.id}: ${action.title}`)}"
          title="${escapeHtml(`${action.id} · ${action.title}`)}"
        ></button>
      `;
    }).join('');
  };

  const clearFilters = () => {
    state.query = '';
    state.region = 'all';
    state.confidence = 'all';
    state.category = 'all';
    elements.search.value = '';
    renderFilters();
    renderResults();
  };

  const selectAction = (actionId, shouldScroll = true) => {
    state.selectedId = actionId;
    clearFilters();
    state.selectedId = actionId;
    renderResults();
    if (shouldScroll) {
      requestAnimationFrame(() => {
        document.querySelector(`#action-${CSS.escape(actionId)}`)?.scrollIntoView({
          behavior: 'smooth',
          block: 'center',
        });
      });
    }
  };

  let toastTimer;
  const showToast = (message) => {
    window.clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.classList.add('is-visible');
    toastTimer = window.setTimeout(() => elements.toast.classList.remove('is-visible'), 1800);
  };

  const copyText = async (value) => {
    try {
      await navigator.clipboard.writeText(value);
      showToast(`${value} copied`);
    } catch (error) {
      showToast(`Could not copy ${value}`);
    }
  };

  document.addEventListener('click', (event) => {
    const filter = event.target.closest('[data-filter]');
    if (filter) {
      state[filter.dataset.filter] = filter.dataset.value;
      renderFilters();
      renderResults();
      return;
    }

    const marker = event.target.closest('.strip-marker');
    if (marker) {
      selectAction(marker.dataset.actionId);
      return;
    }

    const copyButton = event.target.closest('[data-copy-id]');
    if (copyButton) {
      copyText(copyButton.dataset.copyId);
    }
  });

  elements.search.addEventListener('input', (event) => {
    state.query = event.target.value;
    renderResults();
  });

  elements.clearFilters.addEventListener('click', clearFilters);

  document.addEventListener('keydown', (event) => {
    if (event.key === '/' && document.activeElement !== elements.search) {
      event.preventDefault();
      elements.search.focus();
    }
    if (event.key === 'Escape' && document.activeElement === elements.search) {
      elements.search.value = '';
      state.query = '';
      elements.search.blur();
      renderResults();
    }
  });

  renderStats();
  renderFilters();
  renderStrip();
  renderResults();
  if (state.selectedId && orderedActions.some(({ id }) => id === state.selectedId)) {
    selectAction(state.selectedId);
  }
})();

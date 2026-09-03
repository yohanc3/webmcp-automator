(() => {
  'use strict';

  const products = [
    {
      id: 'field-h1', kind: 'Closed-back headphones', title: 'Field H1',
      description: 'Neutral monitoring headphones with replaceable pads and a folding hinge.',
      price: '$129', rating: '4.8 / 5',
      terms: ['headphones', 'audio', 'monitoring', 'closed back'],
    },
    {
      id: 'reference-h4', kind: 'Open-back headphones', title: 'Reference H4',
      description: 'Wide-stage studio headphones tuned for long editing and comparison sessions.',
      price: '$189', rating: '4.6 / 5',
      terms: ['headphones', 'audio', 'studio', 'open back'],
    },
    {
      id: 'transit-buds', kind: 'Wireless earphones', title: 'Transit Buds',
      description: 'Compact noise-cancelling earphones with multipoint pairing and a pocket case.',
      price: '$99', rating: '4.4 / 5',
      terms: ['headphones', 'earphones', 'wireless', 'travel'],
    },
    {
      id: 'desk-m2', kind: 'USB microphone', title: 'Desk M2',
      description: 'Cardioid desktop microphone with a hardware mute control and low-profile stand.',
      price: '$149', rating: '4.7 / 5',
      terms: ['microphone', 'audio', 'usb', 'voice'],
    },
    {
      id: 'meter-p1', kind: 'Portable sound meter', title: 'Meter P1',
      description: 'A pocket sound-pressure meter with a clear display and thirty-hour battery.',
      price: '$79', rating: '4.5 / 5',
      terms: ['meter', 'measurement', 'portable', 'sound'],
    },
    {
      id: 'stand-c2', kind: 'Desktop stand', title: 'Stand C2',
      description: 'Weighted low-profile stand for microphones, cameras, and compact recorders.',
      price: '$49', rating: '4.3 / 5',
      terms: ['stand', 'desktop', 'microphone', 'camera'],
    },
  ];

  const CART_KEY = 'instrument-supply-cart';
  const root = document.querySelector('#storefront');
  const searchInput = document.querySelector('#catalog-query');
  const productTemplate = document.querySelector('#product-card-template');
  const productById = (id) => products.find((product) => product.id === id);

  const cart = () => {
    try {
      const stored = JSON.parse(localStorage.getItem(CART_KEY) || '[]');
      return Array.isArray(stored) ? stored.filter((id) => productById(id)) : [];
    } catch (error) {
      return [];
    }
  };

  const saveCart = (items) => {
    localStorage.setItem(CART_KEY, JSON.stringify(items));
    document.querySelector('[data-cart-count]').textContent = String(items.length);
  };

  const addToCart = (productId) => {
    const items = cart();
    items.push(productId);
    saveCart(items);
  };

  const pageHeader = (eyebrow, title, copy = '') => {
    const header = document.createElement('header');
    header.className = 'page-heading';
    const category = document.createElement('p');
    category.className = 'eyebrow';
    category.textContent = eyebrow;
    const heading = document.createElement('h1');
    heading.textContent = title;
    header.append(category, heading);
    if (copy) {
      const description = document.createElement('p');
      description.className = 'page-copy';
      description.textContent = copy;
      header.append(description);
    }
    return header;
  };

  const productCard = (product, compare = true) => {
    const fragment = productTemplate.content.cloneNode(true);
    const card = fragment.querySelector('[data-product-card]');
    const title = fragment.querySelector('[data-product-title]');
    card.dataset.productId = product.id;
    fragment.querySelector('[data-product-kind]').textContent = product.kind;
    title.textContent = product.title;
    title.href = `/demo/product/${product.id}`;
    fragment.querySelector('[data-product-description]').textContent = product.description;
    fragment.querySelector('[data-product-price]').textContent = product.price;
    fragment.querySelector('[data-product-rating]').textContent = product.rating;
    fragment.querySelector('[data-add-to-basket]').dataset.productId = product.id;
    const compareInput = fragment.querySelector('[data-compare-product]');
    compareInput.value = product.id;
    if (!compare) compareInput.closest('label').remove();
    return fragment;
  };

  const productGrid = (items, compare = true) => {
    const grid = document.createElement('div');
    grid.className = 'product-grid';
    grid.dataset.productResults = '';
    items.forEach((product) => grid.append(productCard(product, compare)));
    return grid;
  };

  const renderHome = () => {
    root.append(pageHeader(
      'Catalog 04 / Bench instruments',
      'Tools for careful work.',
      'A small, functional storefront built to make browser action discovery observable.',
    ));
    const links = document.createElement('nav');
    links.className = 'category-links';
    links.setAttribute('aria-label', 'Popular searches');
    ['headphones', 'microphone', 'portable'].forEach((term) => {
      const link = document.createElement('a');
      link.href = `/demo/search?q=${encodeURIComponent(term)}`;
      link.textContent = term;
      links.append(link);
    });
    root.append(links);
    const section = document.createElement('section');
    section.className = 'featured';
    const heading = document.createElement('h2');
    heading.textContent = 'Frequently inspected';
    section.append(heading, productGrid(products.slice(0, 3), false));
    root.append(section);
  };

  const renderSearch = () => {
    const query = new URLSearchParams(window.location.search).get('q')?.trim() || '';
    searchInput.value = query;
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = products.filter((product) => tokens.every((token) => [
      product.title,
      product.kind,
      product.description,
      ...product.terms,
    ].join(' ').toLowerCase().includes(token)));
    root.append(pageHeader('Matched inventory', 'Search results'));
    const summary = document.createElement('p');
    summary.className = 'result-summary';
    summary.dataset.resultCount = '';
    summary.setAttribute('aria-live', 'polite');
    summary.textContent = `${matches.length} result${matches.length === 1 ? '' : 's'} for “${query}”`;
    root.append(summary);
    if (matches.length === 0) {
      const empty = document.createElement('p');
      empty.textContent = 'Try headphones, microphone, portable, or stand.';
      root.append(empty);
      return;
    }
    const form = document.createElement('form');
    form.action = '/demo/compare';
    form.method = 'get';
    form.dataset.compareForm = '';
    form.append(productGrid(matches));
    const compareButton = document.createElement('button');
    compareButton.type = 'submit';
    compareButton.dataset.compareSelected = '';
    compareButton.disabled = true;
    compareButton.textContent = 'Compare selected';
    form.append(compareButton);
    root.append(form);
  };

  const renderProduct = (productId) => {
    const product = productById(productId);
    if (!product) {
      root.append(pageHeader('Not found', 'That instrument is not in this catalog.'));
      return;
    }
    const article = document.createElement('article');
    article.className = 'product-detail';
    article.dataset.productId = product.id;
    const facts = document.createElement('dl');
    facts.className = 'detail-facts';
    facts.innerHTML = `<div><dt>Price</dt><dd>${product.price}</dd></div><div><dt>Rating</dt><dd>${product.rating}</dd></div>`;
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.addToBasket = '';
    button.dataset.productId = product.id;
    button.textContent = 'Add to basket';
    const status = document.createElement('p');
    status.className = 'basket-status';
    status.dataset.basketStatus = '';
    status.setAttribute('aria-live', 'polite');
    status.setAttribute('role', 'status');
    article.append(pageHeader(product.kind, product.title, product.description), facts, button, status);
    root.append(article);
  };

  const renderCompare = () => {
    const requested = new URLSearchParams(window.location.search).getAll('product');
    const selected = [...new Set(requested)].map(productById).filter(Boolean).slice(0, 3);
    root.append(pageHeader(
      'Side-by-side',
      'Compare instruments',
      selected.length >= 2
        ? 'Compare stable product fields before choosing an instrument.'
        : 'Select at least two products from search results to build a comparison.',
    ));
    if (selected.length < 2) {
      const link = document.createElement('a');
      link.className = 'primary-link';
      link.href = '/demo/search?q=headphones';
      link.textContent = 'Find products to compare';
      root.append(link);
      return;
    }
    const comparison = document.createElement('div');
    comparison.className = 'comparison-grid';
    comparison.dataset.comparisonResults = '';
    selected.forEach((product) => comparison.append(productCard(product, false)));
    root.append(comparison);
  };

  const renderCart = () => {
    const items = cart().map(productById).filter(Boolean);
    root.append(pageHeader('Current selection', 'Basket'));
    const list = document.createElement('div');
    list.className = 'basket-list';
    list.dataset.basketItems = '';
    const counts = new Map();
    items.forEach((product) => counts.set(product.id, (counts.get(product.id) || 0) + 1));
    [...counts].forEach(([productId, quantity]) => {
      const product = productById(productId);
      const row = document.createElement('article');
      row.className = 'basket-row';
      row.dataset.productId = product.id;
      const heading = document.createElement('h2');
      const link = document.createElement('a');
      link.href = `/demo/product/${product.id}`;
      link.textContent = product.title;
      heading.append(link);
      const detail = document.createElement('p');
      detail.textContent = `${product.price} · Quantity ${quantity}`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.dataset.removeFromBasket = '';
      remove.dataset.productId = product.id;
      remove.textContent = 'Remove one';
      row.append(heading, detail, remove);
      list.append(row);
    });
    root.append(list);
    if (items.length === 0) {
      const empty = document.createElement('p');
      empty.textContent = 'Your basket is empty.';
      root.append(empty);
      return;
    }
    const checkout = document.createElement('a');
    checkout.className = 'primary-link';
    checkout.href = '/demo/checkout';
    checkout.textContent = 'Continue to test checkout';
    root.append(checkout);
  };

  const renderCheckout = () => {
    root.append(pageHeader(
      'Privacy test surface',
      'Test checkout',
      'The fields below exercise redaction. Nothing is transmitted or charged.',
    ));
    const form = document.createElement('form');
    form.className = 'checkout-form';
    form.dataset.checkoutForm = '';
    form.innerHTML = `
      <label>Email <input type="email" name="email" autocomplete="email" required></label>
      <label>Delivery address <textarea name="address" autocomplete="street-address" required></textarea></label>
      <label>Test card number <input name="card_number" inputmode="numeric" autocomplete="cc-number" required></label>
      <button type="submit">Place test order</button>
    `;
    root.append(form);
  };

  const renderConfirmation = () => {
    saveCart([]);
    root.append(pageHeader(
      'Complete',
      'Demo order confirmed',
      'No purchase was made. This state exists so the recorder can observe a completed write path.',
    ));
    const link = document.createElement('a');
    link.className = 'primary-link';
    link.href = '/demo/';
    link.textContent = 'Return to catalog';
    root.append(link);
  };

  const render = () => {
    root.replaceChildren();
    saveCart(cart());
    const path = window.location.pathname.replace(/\/$/, '') || '/demo';
    if (path === '/demo') renderHome();
    else if (path === '/demo/search') renderSearch();
    else if (path.startsWith('/demo/product/')) renderProduct(path.split('/').pop());
    else if (path === '/demo/compare') renderCompare();
    else if (path === '/demo/cart') renderCart();
    else if (path === '/demo/checkout') renderCheckout();
    else if (path === '/demo/order/confirmed') renderConfirmation();
    else root.append(pageHeader('Not found', 'This test page does not exist.'));
  };

  document.addEventListener('click', (clickEvent) => {
    const addButton = clickEvent.target.closest('[data-add-to-basket]');
    if (addButton) {
      addToCart(addButton.dataset.productId);
      addButton.textContent = 'Added to basket';
      addButton.disabled = true;
      const status = addButton.parentElement.querySelector('[data-basket-status]');
      if (status) status.textContent = 'This instrument is now in your basket.';
      return;
    }
    const removeButton = clickEvent.target.closest('[data-remove-from-basket]');
    if (removeButton) {
      const items = cart();
      const index = items.indexOf(removeButton.dataset.productId);
      if (index >= 0) items.splice(index, 1);
      saveCart(items);
      render();
    }
  });

  document.addEventListener('change', (changeEvent) => {
    if (!changeEvent.target.matches('[data-compare-product]')) return;
    const checked = document.querySelectorAll('[data-compare-product]:checked').length;
    const button = document.querySelector('[data-compare-selected]');
    if (button) button.disabled = checked < 2;
  });

  document.addEventListener('submit', (submitEvent) => {
    if (!submitEvent.target.matches('[data-checkout-form]')) return;
    submitEvent.preventDefault();
    window.location.assign('/demo/order/confirmed');
  });

  render();
})();

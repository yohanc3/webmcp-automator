(function actionTreeToXML() {
  const actionableSelector = `
    button, a[href], input:not([type="hidden"]), select, textarea, summary,
    [role="button"], [role="link"], [role="menuitem"], [role="menuitemcheckbox"],
    [role="menuitemradio"], [role="tab"], [role="checkbox"], [role="switch"],
    [role="option"], [role="radio"], [role="slider"], [role="textbox"],
    [contenteditable="true"], [tabindex]:not([tabindex="-1"])
  `.replace(/\s+/g, ' ').trim();

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  function getName(el) {
    return (
      el.getAttribute('aria-label') ||
      el.innerText?.trim().slice(0, 80) ||
      el.getAttribute('title') ||
      el.getAttribute('placeholder') ||
      el.getAttribute('alt') ||
      el.value ||
      ''
    ).replace(/\s+/g, ' ').trim();
  }

  function esc(str) {
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  const actionable = [...document.querySelectorAll(actionableSelector)]
    .filter(isVisible)
    .map(el => ({ el, tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '', name: getName(el) }))
    .filter(item => item.name);

  const keepSet = new Set(actionable.map(a => a.el));
  actionable.forEach(a => {
    let node = a.el.parentElement;
    while (node) { keepSet.add(node); node = node.parentElement; }
  });

  function nodeToXML(el) {
    if (!keepSet.has(el)) return '';
    const isAction = actionable.find(a => a.el === el);
    const childrenXML = [...el.children].map(nodeToXML).filter(Boolean).join('');
    if (isAction) {
      const attrs = `tag="${isAction.tag}" role="${esc(isAction.role)}" name="${esc(isAction.name)}"`;
      return `<action ${attrs}>${childrenXML}</action>`;
    }
    return childrenXML || '';
  }

  const bodyXML = nodeToXML(document.body);
  const xml = `<page url="${esc(location.href)}" title="${esc(document.title)}">\n${bodyXML}\n</page>`;

  console.log(xml);
  return xml;
})();

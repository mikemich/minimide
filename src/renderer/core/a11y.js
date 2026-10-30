// Accessibility helpers shared by the core UI and packages: a safety net that gives icon-only
// controls a name, focus handling for dialogs, and unique ids for ARIA references.

let counter = 0;
export const uniqueId = (prefix = 'a11y') => `${prefix}-${++counter}`;

/** Whether the OS reports a screen reader (or other assistive technology) in use; set by the app from main. */
export const screenReader = {
  active: false,
  listeners: new Set(),
  set(on) {
    if (this.active === !!on) return;
    this.active = !!on;
    for (const fn of this.listeners) fn(this.active);
  },
  onDidChange(fn) { this.listeners.add(fn); return { dispose: () => this.listeners.delete(fn) }; },
};

const FOCUSABLE = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex], [contenteditable="true"]';

/** Elements inside `root` that Tab can reach right now, in DOM order. */
export function focusables(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter((el) => {
    if (el.disabled || el.tabIndex < 0 || el.closest('[hidden], [inert]')) return false;
    return el.getClientRects().length > 0;
  });
}

/** Keeps Tab and Shift+Tab inside `container` (a dialog). Call it from a keydown handler. */
export function trapTab(container, e) {
  if (e.key !== 'Tab' || e.altKey || e.ctrlKey || e.metaKey) return;
  const items = focusables(container);
  if (!items.length) { e.preventDefault(); return; }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (!container.contains(active)) { e.preventDefault(); first.focus(); }
  else if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
}

// --- naming ------------------------------------------------------------------------------------
// Buttons and fields built without a label get one from their tooltip or placeholder, so a screen
// reader never says just "button". Controls that can name themselves better do so explicitly.

const NAMEABLE = 'button, [role="button"], [role="tab"], [role="menuitem"], [role="switch"], [role="checkbox"], a[href], summary';
const FIELDS = 'input:not([type="hidden"]), select, textarea';
const AUTO = 'a11yAuto';

function hasName(el) {
  if (el.getAttribute('aria-label')?.trim() || el.hasAttribute('aria-labelledby')) return true;
  if (el.matches(FIELDS)) return [...(el.labels || [])].some((l) => l.textContent.trim());
  return !!el.textContent.trim();
}

function nameElement(el) {
  const auto = AUTO in el.dataset;
  if (!auto && hasName(el)) return;
  if (!auto) {
    const tooltip = (el.getAttribute('title') || (el.matches(FIELDS) ? el.getAttribute('placeholder') : '') || '').trim();
    if (!tooltip) return;
    el.dataset[AUTO] = '';
    // Text that shows up later (a status item filled in after it was added) names the control better than its tooltip.
    if (!el.matches(FIELDS)) new MutationObserver(() => nameElement(el)).observe(el, { childList: true, characterData: true, subtree: true });
  }
  const tooltip = (el.getAttribute('title') || (el.matches(FIELDS) ? el.getAttribute('placeholder') : '') || '').trim();
  if (!el.matches(FIELDS) && el.textContent.trim()) el.removeAttribute('aria-label');
  else if (tooltip) el.setAttribute('aria-label', tooltip);
}

function scan(node) {
  if (node.nodeType !== 1) return;
  if (node.matches(NAMEABLE) || node.matches(FIELDS)) nameElement(node);
  for (const el of node.querySelectorAll(`${NAMEABLE}, ${FIELDS}`)) nameElement(el);
}

/** Starts naming unlabeled controls (existing ones now, later ones as they are added or retitled). */
export function installA11y(root = document.body) {
  const added = new Set();
  const retitled = new Set();
  let frame = 0;
  const flush = () => {
    frame = 0;
    for (const n of [...added]) if (n.isConnected) scan(n);
    for (const n of [...retitled]) if (n.isConnected && n.matches(`${NAMEABLE}, ${FIELDS}`)) nameElement(n);
    added.clear();
    retitled.clear();
  };
  const queue = (set, n) => { set.add(n); if (!frame) frame = requestAnimationFrame(flush); };
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'attributes') queue(retitled, r.target);
      else for (const n of r.addedNodes) if (n.nodeType === 1) queue(added, n);
    }
  }).observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['title', 'placeholder'] });
  scan(root);
}

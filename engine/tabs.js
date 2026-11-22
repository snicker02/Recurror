// Phone layout: each <details> section of the side panel becomes a tab, with
// the tab bar sitting directly under the drawing. Desktop keeps the stacked,
// collapsible sections unchanged.
//
// body.tabbed turns the layout on; the active section carries .tabon.

const KEY = 'recurror.tab';
const QUERY = '(max-width: 820px), (max-height: 500px) and (orientation: landscape)';

export function initPanelTabs(panel) {
  const mq = window.matchMedia(QUERY);
  const sections = [...panel.querySelectorAll(':scope > details')];
  const bar = document.createElement('nav');
  bar.id = 'tabbar';
  bar.setAttribute('role', 'tablist');
  bar.setAttribute('aria-label', 'Panel sections');
  panel.parentNode.insertBefore(bar, panel);

  // Tab label = the summary's own text, without its trailing hint span.
  const nameOf = d => {
    const s = d.querySelector(':scope > summary');
    if (!s) return 'Section';
    const c = s.cloneNode(true);
    c.querySelectorAll('.hint').forEach(h => h.remove());
    return c.textContent.trim();
  };

  const tabs = sections.map((d, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tab';
    b.textContent = nameOf(d);
    b.setAttribute('role', 'tab');
    b.addEventListener('click', () => select(i));
    bar.append(b);
    return { d, b };
  });

  let cur = 0;
  try { const v = +localStorage.getItem(KEY); if (v >= 0 && v < tabs.length && !tabs[v].d.hidden) cur = v; } catch { /* storage unavailable */ }

  function select(i, scroll = true) {
    cur = i;
    tabs.forEach((t, j) => {
      const on = j === i;
      t.b.classList.toggle('sel', on);
      t.b.setAttribute('aria-selected', on ? 'true' : 'false');
      t.d.classList.toggle('tabon', on);
      if (on) t.d.open = true; // a collapsed section would show an empty tab
    });
    panel.scrollTop = 0;
    if (scroll) tabs[i].b.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
    try { localStorage.setItem(KEY, String(i)); } catch { /* storage unavailable */ }
  }

  // a section hidden by the current mode (e.g. Bucket outside the bucket tool) hides its tab too
  function syncHidden() {
    tabs.forEach((t) => { t.b.hidden = t.d.hidden; });
    if (tabs[cur].d.hidden) {
      const i = tabs.findIndex((t) => !t.d.hidden);
      if (i >= 0) select(i, false);
    }
  }
  new MutationObserver(syncHidden).observe(panel, { subtree: true, attributes: true, attributeFilter: ['hidden'] });

  const apply = () => document.body.classList.toggle('tabbed', mq.matches);
  if (mq.addEventListener) mq.addEventListener('change', apply); else mq.addListener(apply);
  select(cur, false);
  syncHidden();
  apply();
  /** Open the tab of a given <details> section. */
  const show = (d) => { const i = tabs.findIndex((t) => t.d === d); if (i >= 0 && !d.hidden) select(i); };
  return { select, show };
}

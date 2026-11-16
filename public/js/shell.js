const $ = s => document.querySelector(s);
const pages = { home:'首页', create:'创作空间', assets:'我的资产', studio:'Studio', tasks:'任务中心', settings:'偏好与连接' };
export function initShell({ onView, onTheme }) {
  let view = 'home';
  const sidebar = $('#appSidebar');
  const menu = $('#menuToggle');
  const mobile = matchMedia('(max-width:780px)');
  const menuFocusables = () => [...sidebar.querySelectorAll('a,button')];
  function closeMenu(restoreFocus = false) {
    sidebar.classList.remove('is-open');
    $('#menuBackdrop').hidden = true;
    menu.setAttribute('aria-expanded','false');
    sidebar.inert = mobile.matches;
    sidebar.removeAttribute('role');
    sidebar.removeAttribute('aria-modal');
    $('#mainContent').inert = false;
    if (restoreFocus) menu.focus();
  }
  menu.addEventListener('click', () => {
    if (sidebar.classList.contains('is-open')) return closeMenu(true);
    sidebar.inert = false;
    sidebar.classList.add('is-open');
    sidebar.setAttribute('role','dialog'); sidebar.setAttribute('aria-modal','true');
    $('#menuBackdrop').hidden = false;
    $('#mainContent').inert = true;
    menu.setAttribute('aria-expanded','true');
    menuFocusables()[0]?.focus();
  });
  $('#menuBackdrop').addEventListener('click', () => closeMenu(true));
  sidebar.addEventListener('keydown', e => {
    if (!mobile.matches || !sidebar.classList.contains('is-open')) return;
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(true); }
    if (e.key === 'Tab') {
      const items = menuFocusables(), first = items[0], last = items.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  mobile.addEventListener('change', () => closeMenu());
  function theme(value) {
    document.documentElement.dataset.theme = value;
    try { localStorage.setItem('sanzo-3d-theme', value); } catch {}
    $('#themeLabel').textContent = value === 'dark' ? '深色模式' : '浅色模式';
    $('#themeToggle use').setAttribute('href',`#i-${value === 'dark' ? 'moon':'sun'}`);
    document.querySelectorAll('[data-theme-choice]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.themeChoice === value)));
    onTheme?.(value);
  }
  $('#themeToggle').addEventListener('click', () => theme(document.documentElement.dataset.theme === 'dark' ? 'light':'dark'));
  document.querySelectorAll('[data-theme-choice]').forEach(b => b.addEventListener('click', () => theme(b.dataset.themeChoice)));
  theme(document.documentElement.dataset.theme);
  function mobileTab(value) {
    $('#studio').dataset.mobileTab = value;
    document.querySelectorAll('[data-work-tab]').forEach(b => b.setAttribute('aria-pressed',String(b.dataset.workTab === value)));
  }
  document.querySelectorAll('[data-work-tab]').forEach(b => b.addEventListener('click',() => mobileTab(b.dataset.workTab)));
  mobileTab('form');
  function render() {
    const requested = location.pathname.split('/').filter(Boolean)[0] || 'home';
    const legacy = {'#studio':'create','#gallery':'assets'}[location.hash];
    view = legacy || (pages[requested] ? requested : 'home');
    if (legacy) history.replaceState({},'',`/${view}/`);
    document.body.dataset.view = view;
    $('#homePage').hidden = view !== 'home';
    $('#appShell').hidden = view === 'home';
    $('#pageTitle').textContent = pages[view];
    document.querySelector('.skip').href = view === 'home' ? '#homeMain' : '#mainContent';
    document.title = view === 'home' ? 'SANZO 3D · 让想象成为形体' : `SANZO 3D · ${pages[view]}`;
    const work = ['create','studio'].includes(view);
    $('#studio').hidden = !work;
    $('#mobileWorkTabs').hidden = !work;
    for (const p of ['assets','tasks','settings']) $(`#${p}Page`).hidden = p !== view;
    document.querySelectorAll('[data-nav]').forEach(a => {
      if (a.dataset.nav === view) a.setAttribute('aria-current','page'); else a.removeAttribute('aria-current');
    });
    closeMenu();
    onView(view);
  }
  function navigate(path) {
    const target = new URL(path,location.origin);
    if (target.pathname !== location.pathname || target.hash !== location.hash) history.pushState({},'',target.pathname+target.hash);
    render();
    if (view === 'home') window.scrollTo({top:0,behavior:'instant'});
  }
  document.addEventListener('click', e => {
    const a = e.target.closest('a[data-route]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    e.preventDefault(); navigate(a.getAttribute('href'));
  });
  addEventListener('popstate',render);
  addEventListener('hashchange', () => { if (['#studio','#gallery'].includes(location.hash)) render(); });
  render();
  return { navigate, mobileTab, get view() { return view; } };
}

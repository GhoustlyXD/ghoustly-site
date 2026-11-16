// Browser behaviour for the public site. Plain ES module, no dependencies.

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const canHover = matchMedia('(hover: hover) and (pointer: fine)').matches;
const NEW_DAYS = 14;

function initTheme() {
  $$('[data-theme-toggle]').forEach((b) =>
    b.addEventListener('click', () => {
      const cur = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
      const next = cur === 'light' ? 'dark' : 'light';
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem('theme', next); } catch (e) {}
    })
  );
}

function initClock() {
  $$('[data-clock]').forEach((el) => {
    const tz = el.dataset.clock;
    const tick = () => {
      try {
        el.textContent = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz }).format(new Date());
      } catch (e) { el.textContent = ''; }
    };
    tick();
    setInterval(tick, 30000);
  });
}

function initImages() {
  // Low-quality placeholder stays as background until the real image has loaded.
  $$('img').forEach((im) => {
    if (im.complete) im.style.backgroundImage = '';
    else im.addEventListener('load', () => { im.style.backgroundImage = ''; }, { once: true });
  });
}

function initNewBadges() {
  const now = Date.now();
  $$('.tile[data-recent][data-created]').forEach((t) => {
    const d = Date.parse(t.dataset.created);
    if (d && now - d < NEW_DAYS * 864e5) { const b = $('.chip.new', t); if (b) b.hidden = false; }
  });
}

function initFilters() {
  const btns = $$('[data-filter]');
  if (!btns.length) return;
  const tiles = $$('#work .tile');
  const count = $('[data-count]');
  btns.forEach((b) =>
    b.addEventListener('click', () => {
      const f = b.dataset.filter;
      btns.forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      let n = 0;
      tiles.forEach((t) => { const show = !f || t.dataset.cat === f; t.hidden = !show; if (show) n++; });
      if (count) count.textContent = n;
    })
  );
}

function initMore() {
  const b = $('[data-more]');
  if (!b) return;
  const grid = $('#more-grid');
  const label = b.textContent;
  b.addEventListener('click', () => {
    grid.hidden = !grid.hidden;
    b.setAttribute('aria-expanded', String(!grid.hidden));
    b.textContent = grid.hidden ? label : 'Hide';
  });
}

// Tile slideshow: on hover (desktop) or while the tile is in the middle of the screen (touch).
function initTileCycle() {
  const tiles = $$('.tile[data-images]').filter((t) => { try { return JSON.parse(t.dataset.images).length > 1; } catch (e) { return false; } });
  const start = (t) => {
    if (t._iv || reduceMotion) return;
    const list = JSON.parse(t.dataset.images);
    const img = $('img', t);
    const bars = $$('.bars span', t);
    const num = $('[data-i]', t);
    list.slice(1).forEach((src) => { const i = new Image(); i.src = src; });
    let i = 0;
    const show = () => {
      img.src = list[i];
      bars.forEach((b, k) => b.classList.toggle('on', k <= i));
      if (num) num.textContent = i + 1;
    };
    t.classList.add('cycling');
    show();
    t._iv = setInterval(() => { i = (i + 1) % list.length; show(); }, 1000);
  };
  const stop = (t) => {
    if (!t._iv) return;
    clearInterval(t._iv); t._iv = null;
    t.classList.remove('cycling');
    const list = JSON.parse(t.dataset.images);
    $('img', t).src = list[0];
    const num = $('[data-i]', t); if (num) num.textContent = 1;
  };
  if (canHover) {
    tiles.forEach((t) => {
      t.addEventListener('mouseenter', () => start(t));
      t.addEventListener('mouseleave', () => stop(t));
      t.addEventListener('focus', () => start(t));
      t.addEventListener('blur', () => stop(t));
    });
  } else if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => (e.isIntersecting && !e.target.hidden ? start(e.target) : stop(e.target))),
      { rootMargin: '-35% 0px -35% 0px' }
    );
    tiles.forEach((t) => io.observe(t));
  }
}

function initFeatured() {
  const root = $('[data-featured]');
  if (!root) return;
  const slides = $$('.slide', root);
  const dots = $$('.dots button', root);
  if (slides.length < 2) return;
  let i = 0;
  let timer;
  const go = (k) => {
    i = (k + slides.length) % slides.length;
    slides.forEach((s, n) => {
      s.classList.toggle('on', n === i);
      if (n === i) { s.removeAttribute('aria-hidden'); s.removeAttribute('tabindex'); }
      else { s.setAttribute('aria-hidden', 'true'); s.setAttribute('tabindex', '-1'); }
    });
    dots.forEach((d, n) => d.setAttribute('aria-pressed', String(n === i)));
  };
  const play = () => { if (!reduceMotion) { clearInterval(timer); timer = setInterval(() => go(i + 1), 5000); } };
  dots.forEach((d, n) => d.addEventListener('click', () => { go(n); play(); }));
  root.addEventListener('mouseenter', () => clearInterval(timer));
  root.addEventListener('mouseleave', play);
  swipe($('.feat-stage', root), (dir) => { go(i + dir); play(); });
  play();
}

function initReviews() {
  const root = $('[data-reviews]');
  if (!root) return;
  const items = $$('.review', root);
  if (items.length < 2) return;
  let i = 0;
  const go = (k) => { i = (k + items.length) % items.length; items.forEach((r, n) => r.classList.toggle('on', n === i)); };
  $('[data-prev]', root).addEventListener('click', () => go(i - 1));
  $('[data-next]', root).addEventListener('click', () => go(i + 1));
  swipe($('.review-box', root), (dir) => go(i + dir));
}

function swipe(el, cb) {
  if (!el) return;
  let x0 = null;
  let y0 = null;
  el.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
  el.addEventListener('touchend', (e) => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0;
    const dy = e.changedTouches[0].clientY - y0;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
      cb(dx < 0 ? 1 : -1);
      el.dataset.swiped = '1';
      setTimeout(() => delete el.dataset.swiped, 300);
    }
    x0 = null;
  });
  // A swipe should not also count as a click on a link inside.
  el.addEventListener('click', (e) => { if (el.dataset.swiped) { e.preventDefault(); e.stopPropagation(); } }, true);
}

// Full-screen zoom dialog, shared by WIP images and the project gallery.
let openZoom = () => {};
function initZoom() {
  const dlg = $('dialog.zoom');
  if (!dlg) return;
  const img = $('[data-zoom-img]', dlg);
  const area = $('.zoom-area', dlg);
  const label = $('[data-zoom-label]', dlg);
  let z = 1;
  const apply = () => {
    img.style.width = 92 * z + 'vw';
    area.classList.toggle('zoomed', z > 1);
    label.textContent = Math.round(z * 100) + '%';
  };
  openZoom = (src, alt) => {
    img.src = src; img.alt = alt || '';
    z = 1; apply();
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
  };
  $('[data-zoom-in]', dlg).addEventListener('click', () => { z = Math.min(4, z + 0.5); apply(); });
  $('[data-zoom-out]', dlg).addEventListener('click', () => { z = Math.max(1, z - 0.5); apply(); });
  $('[data-zoom-close]', dlg).addEventListener('click', () => dlg.close());
  img.addEventListener('click', (e) => {
    const r = img.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width;
    const fy = (e.clientY - r.top) / r.height;
    z = z > 1 ? 1 : 2.5; apply();
    if (z > 1) { area.scrollLeft = fx * img.offsetWidth - area.clientWidth / 2; area.scrollTop = fy * img.offsetHeight - area.clientHeight / 2; }
  });
  $$('[data-zoom-src]').forEach((b) => b.addEventListener('click', () => openZoom(b.dataset.zoomSrc, 'Work in progress')));
}

function initGallery() {
  const g = $('[data-gallery]');
  if (!g) return;
  const sets = { render: JSON.parse(g.dataset.render || '[]'), wire: JSON.parse(g.dataset.wire || '[]') };
  const stage = $('[data-stage]', g);
  const counter = $('[data-counter]', g);
  const thumbs = $('[data-thumbs]', g);
  let mode = 'render';
  let i = 0;
  if (!stage) return;
  const list = () => sets[mode];
  const show = () => {
    const im = list()[i];
    stage.style.backgroundImage = im.lqip ? `url('${im.lqip}')` : '';
    stage.src = im.src;
    counter.textContent = `${i + 1} / ${list().length}`;
    $$('button', thumbs).forEach((b, k) => b.setAttribute('aria-pressed', String(k === i)));
    const nav = list().length > 1;
    $$('[data-prev],[data-next]', g).forEach((b) => (b.hidden = !nav));
  };
  const buildThumbs = () => {
    thumbs.innerHTML = '';
    if (list().length < 2) return;
    list().forEach((im, k) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('aria-label', `Image ${k + 1}`);
      const t = document.createElement('img');
      t.src = im.src; t.alt = ''; t.loading = 'lazy';
      b.append(t);
      b.addEventListener('click', () => { i = k; show(); });
      thumbs.append(b);
    });
  };
  const step = (d) => { i = (i + d + list().length) % list().length; show(); };
  $('[data-prev]', g)?.addEventListener('click', () => step(-1));
  $('[data-next]', g)?.addEventListener('click', () => step(1));
  $$('[data-mode]', g).forEach((b) =>
    b.addEventListener('click', () => {
      mode = b.dataset.mode; i = 0;
      $$('[data-mode]', g).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      buildThumbs(); show();
    })
  );
  const zoom = () => openZoom(list()[i].src, document.title);
  stage.addEventListener('click', zoom);
  $('[data-expand]', g).addEventListener('click', zoom);
  document.addEventListener('keydown', (e) => {
    if ($('dialog.zoom[open]') || /INPUT|TEXTAREA/.test(document.activeElement?.tagName)) return;
    if (e.key === 'ArrowLeft') step(-1);
    if (e.key === 'ArrowRight') step(1);
  });
  swipe($('.stage', g), step);
  buildThumbs(); show();
}

function initCopyLink() {
  $$('[data-copy-link]').forEach((b) =>
    b.addEventListener('click', async () => {
      const url = location.href.split('#')[0].split('?')[0];
      const label = $('span', b);
      try {
        if (navigator.share && !canHover) { await navigator.share({ title: document.title, url }); return; }
        await navigator.clipboard.writeText(url);
        label.textContent = 'Copied!';
      } catch (e) {
        label.textContent = url;
      }
      setTimeout(() => (label.textContent = 'Copy link'), 2000);
    })
  );
}

function init() {
  initTheme(); initClock(); initImages(); initNewBadges(); initFilters(); initMore();
  initTileCycle(); initFeatured(); initReviews(); initZoom(); initGallery(); initCopyLink();
}

// Admin preview: ?preview=1 re-renders the page from the unsaved draft kept by the admin panel.
async function preview() {
  let draft;
  try { draft = JSON.parse(localStorage.getItem('ghoustly-preview') || 'null'); } catch (e) {}
  if (!draft) return false;
  const r = await import('./render.js');
  const base = document.querySelector('link[href$="assets/styles.css"]').getAttribute('href').replace(/assets\/styles\.css$/, '');
  const m = location.pathname.match(/\/p\/([^/]+)\/?$/);
  let body;
  if (m) {
    const slug = decodeURIComponent(m[1]);
    const p = draft.projects.find((x) => x.slug === slug);
    body = p ? r.projectBody(draft, base, p) : '<main class="wrap"><p style="padding:40px 0">This project is not in the draft.</p></main>';
  } else {
    body = r.homeBody(draft, base);
  }
  document.body.innerHTML = `<div class="topbar" style="background:#7c2d12;color:#fff">Preview — not published yet</div>${body}`;
  // Keep links inside the preview.
  $$('a[href]').forEach((a) => { if (a.getAttribute('href').startsWith(base)) { const u = new URL(a.href); u.searchParams.set('preview', '1'); a.href = u.toString(); } });
  return true;
}

(async () => {
  if (new URLSearchParams(location.search).has('preview')) await preview();
  init();
})();

// Ghoustly 3D — admin panel. Talks only to the Cloudflare Worker (which holds the GitHub token).
const API = (window.GHOUSTLY_CONFIG?.workerUrl || '').replace(/\/+$/, '');
const BASE = location.pathname.replace(/admin\/.*$/, '');
const WATERMARK = '@Ghoustly3D';
const MAX_BATCH = 1.5 * 1024 * 1024; // bytes of base64 per request (small: the free Worker has a tight CPU limit)

const app = document.getElementById('app');
let token = sessionStorage.getItem('gh-token') || '';
let content = null;      // draft being edited
let savedJson = '';      // last published version, to detect changes
let contentSha = '';
let originalsEnabled = false;
let tab = 'works';
let busy = '';
let processing = 0; // images being converted right now
let publishingJson = ''; // what the save in progress is sending
let queued = false;      // publish again as soon as the current save ends
const changedSinceSave = () => !!busy && JSON.stringify(clean(content)) !== publishingJson;
const pending = new Map(); // path -> { blob, url }   new files not yet published
const pendingOriginals = new Map(); // path -> blob (private repo)

// ---------- tiny DOM helper (never uses innerHTML with user data) ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
const toast = (msg, ms = 3500) => {
  const t = h('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
};
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const slugify = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'project';
const imgUrl = (path) => (pending.has(path) ? pending.get(path).url : /^(https?:|data:|blob:)/.test(path) ? path : BASE + path);
const dirty = () => JSON.stringify(clean(content)) !== savedJson;
const clean = (c) => JSON.parse(JSON.stringify(c, (k, v) => (k.startsWith('_') ? undefined : v)));

// ---------- API ----------
async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    signal: AbortSignal.timeout(opts.timeout || 120000),
    ...opts,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...(opts.headers || {}) },
  });
  if (res.status === 401 && path !== '/login') { token = ''; sessionStorage.removeItem('gh-token'); renderLogin('La sesión ha caducado. Vuelve a entrar.'); throw new Error('unauthorized'); }
  const isJson = (res.headers.get('content-type') || '').includes('json');
  const data = isJson ? await res.json() : await res.blob();
  if (!res.ok) throw new Error((isJson && data.error) || 'Error ' + res.status);
  return data;
}

// ---------- login ----------
function renderLogin(msg) {
  if (!API) {
    app.replaceChildren(h('div', { class: 'login' }, h('div', { class: 'panel', style: { maxWidth: '460px' } },
      h('h1', {}, 'Falta configurar el panel'),
      h('p', { class: 'muted' }, 'Pon la dirección de tu Cloudflare Worker en admin/config.js (mira el README).'))));
    return;
  }
  const pw = h('input', { id: 'pw', type: 'password', class: 'fld', autocomplete: 'current-password', required: true });
  const err = h('p', { class: 'err', role: 'alert' }, msg || '');
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Entrar');
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      btn.disabled = true; err.textContent = '';
      try {
        const r = await api('/login', { method: 'POST', body: JSON.stringify({ password: pw.value }) });
        token = r.token; sessionStorage.setItem('gh-token', token);
        await load();
      } catch (ex) { if (ex.message !== 'unauthorized') err.textContent = ex.message; }
      btn.disabled = false;
    },
  }, h('h1', {}, 'Panel · Ghoustly 3D'), h('p', { class: 'muted' }, 'Solo tú tienes acceso.'),
    h('label', { class: 'lbl', for: 'pw' }, 'Contraseña', pw), btn, err);
  app.replaceChildren(h('div', { class: 'login' }, form));
  pw.focus();
}

async function load() {
  app.replaceChildren(h('p', { class: 'boot' }, 'Cargando contenido…'));
  const r = await api('/content');
  content = r.content; contentSha = r.sha; originalsEnabled = !!r.originals;
  savedJson = JSON.stringify(clean(content));
  pending.clear(); pendingOriginals.clear();
  await offerDraft();
  render();
}

// ---------- drafts: unpublished changes survive a reload or a closed tab (kept in this browser only) ----------
const DB_NAME = 'ghoustly-admin';
function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('kv', mode);
      const req = fn(tx.objectStore('kv'));
      tx.oncomplete = () => { resolve(req?.result); open.result.close(); };
      tx.onerror = () => { reject(tx.error); open.result.close(); };
    };
  });
}
let draftTimer = null;
function scheduleDraftSave() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraft, 800);
}
async function saveDraft() {
  if (!content) return;
  try {
    if (!dirty() && !pending.size) { await idb('readwrite', (st) => st.delete('draft')); return; }
    const draft = {
      time: Date.now(), baseSha: contentSha, content: JSON.parse(JSON.stringify(content)),
      pending: [...pending].map(([path, f]) => [path, f.blob]),
      originals: [...pendingOriginals],
    };
    await idb('readwrite', (st) => st.put(draft, 'draft'));
  } catch (e) { /* private mode or storage full: drafts are a bonus, never block editing */ }
}
async function offerDraft() {
  let d;
  try { d = await idb('readonly', (st) => st.get('draft')); } catch (e) { return; }
  if (!d || JSON.stringify(clean(d.content)) === savedJson) return;
  const when = new Date(d.time).toLocaleString();
  const n = d.pending.length;
  const changedElsewhere = d.baseSha !== contentSha;
  const msg = `Tienes cambios sin publicar guardados (${when}${n ? `, ${Math.round(n / 2)} imágenes nuevas` : ''}).\n\n¿Quieres recuperarlos?` +
    (changedElsewhere ? '\n\nOjo: desde entonces se publicó algo desde otro sitio. Si los recuperas y publicas, sustituirás esa versión.' : '') +
    '\n\nAceptar = recuperar · Cancelar = descartarlos';
  if (confirm(msg)) {
    content = d.content;
    for (const [path, blob] of d.pending) pending.set(path, { blob, url: URL.createObjectURL(blob) });
    for (const [path, blob] of d.originals) pendingOriginals.set(path, blob);
    setTimeout(() => toast('Cambios recuperados. Pulsa Publicar cuando quieras.'), 300);
  } else {
    try { await idb('readwrite', (st) => st.delete('draft')); } catch (e) {}
  }
}

// ---------- shell ----------
let topEl = null;
// Refresh only the top bar (status, buttons). Used while saving so the page you are editing is left alone.
function renderTop() {
  scheduleDraftSave();
  if (!topEl || !topEl.isConnected) return render();
  const next = buildTop();
  topEl.replaceWith(next); topEl = next;
}
function setBusy(msg) { busy = msg; renderTop(); }

function render() {
  scheduleDraftSave();
  topEl = buildTop();
  const main = h('main');
  ({ works: viewWorks, site: viewSite, wip: viewWip, proof: viewProof, history: viewHistory })[tab](main);
  app.replaceChildren(topEl, main);
}

function buildTop() {
  const s = content.site;
  const st = busy || processing ? 'busy' : dirty() ? 'dirty' : '';
  const statusText = busy || (processing ? 'Procesando imagen…' : dirty() ? 'Cambios sin publicar' : 'Todo publicado');
  const slot = (d) => () => { s.slotsFilled = Math.max(0, Math.min(Number(s.slotsTotal) || 0, (Number(s.slotsFilled) || 0) + d)); renderTop(); };
  const top = h('div', { class: 'top' },
    h('div', { class: 'top-in' },
      h('span', { class: 'brand' }, 'GHOUSTLY ', h('span', {}, '3D'), ' · Panel'),
      h('span', { class: 'status mono ' + st }, h('i'), statusText),
      h('div', { class: 'top-actions' },
        h('span', { class: 'slots', title: 'Plazas de encargo ocupadas' },
          h('button', { type: 'button', 'aria-label': 'Una plaza menos', onclick: slot(-1) }, '−'),
          h('span', { class: 'mono' }, `${s.slotsFilled}/${s.slotsTotal} plazas`),
          h('button', { type: 'button', 'aria-label': 'Una plaza más', onclick: slot(1) }, '+')),
        h('a', { class: 'btn', href: BASE, target: '_blank', rel: 'noopener' }, 'Ver web ↗'),
        h('button', { class: 'btn', type: 'button', onclick: openPreview }, 'Vista previa'),
        busy
          ? h('button', { class: 'btn primary', type: 'button', disabled: queued || !changedSinceSave(), onclick: () => { queued = true; renderTop(); toast('En cola: se publicará en cuanto termine el guardado actual.'); } }, queued ? 'En cola ✓' : 'Añadir a la cola')
          : h('button', { class: 'btn primary', type: 'button', disabled: processing > 0 || !dirty(), onclick: publish }, 'Publicar'))),
    h('nav', { class: 'tabs', role: 'tablist' },
      ...[['works', 'Trabajos'], ['site', 'Portada'], ['wip', 'WIP'], ['proof', 'Clientes y reseñas'], ['history', 'Historial']].map(([id, label]) =>
        h('button', { role: 'tab', 'aria-selected': String(tab === id), onclick: () => { tab = id; render(); } }, label))));
  return top;
}
document.addEventListener('input', () => { if (content) renderTop(); });
window.addEventListener('beforeunload', (e) => { if (content && dirty()) { e.preventDefault(); e.returnValue = ''; } });

// ---------- Trabajos ----------
function viewWorks(main) {
  const cats = content.categories;
  const byCat = (cid, section) => content.projects.filter((p) => p.category === cid && p.section === section);
  const card = (p) => {
    const cover = p.images?.[0];
    return h('div', { class: 'card', 'data-id': p.id },
      h('div', { class: 'th', style: cover ? { backgroundImage: `url("${imgUrl(cover.thumb || cover.src)}")` } : {} },
        h('div', { class: 'badges mono' }, p.featured ? h('span', {}, '★ Destacado') : null, p.isNew ? h('span', {}, 'NEW') : null, p.wireframes?.length ? h('span', {}, 'Malla') : null)),
      h('div', { class: 't' }, h('span', {}, p.title || 'Sin título'), h('button', { type: 'button', onclick: () => openEditor(p) }, 'Editar')));
  };
  let n = 0;
  const groups = h('div', { class: 'groups' }, ...cats.map((c, gi) => {
    const list = byCat(c.id, 'main');
    const cards = h('div', { class: 'cards' + (list.length ? '' : ' empty'), 'data-cat': c.id, 'data-section': 'main' }, ...list.map((p) => { n++; return card(p); }));
    return h('section', { class: 'group', 'data-cat': c.id },
      h('div', { class: 'g-head' }, h('span', { 'aria-hidden': 'true' }, '⠿'), h('span', { class: 'pos mono' }, gi + 1 + '.'), h('strong', {}, c.label), h('span', { class: 'n mono muted' }, `${list.length} trabajos`)),
      cards);
  }));
  const moreList = content.projects.filter((p) => p.section === 'more');
  const more = h('div', { class: 'cards' + (moreList.length ? '' : ' empty'), 'data-section': 'more' }, ...moreList.map(card));
  main.append(
    h('div', { class: 'row' }, h('h2', { style: { flex: 1 } }, `Portfolio principal (${n})`), h('button', { class: 'btn primary', type: 'button', onclick: addProject }, '+ Nuevo trabajo')),
    h('p', { class: 'hint' }, 'Arrastra la barra de una categoría para cambiar su orden. Arrastra los trabajos para ordenarlos; si lo sueltas en otra categoría, cambia de categoría. En el móvil: mantén pulsado y arrastra.'),
    groups,
    h('section', { class: 'more-zone' }, h('h2', { style: { marginBottom: '6px' } }, `More work (${moreList.length})`), h('p', { class: 'hint', style: { marginBottom: '10px' } }, 'Oculto tras «Show more», sin filtros. Arrastra aquí para pasar un trabajo a segundo plano.'), more));

  const sync = () => {
    const order = [...groups.querySelectorAll('.group')].map((g) => g.dataset.cat);
    content.categories = order.map((id) => cats.find((c) => c.id === id));
    const next = [];
    groups.querySelectorAll('.cards').forEach((list) => list.querySelectorAll('.card').forEach((el) => {
      const p = content.projects.find((x) => x.id === el.dataset.id); p.category = list.dataset.cat; p.section = 'main'; next.push(p);
    }));
    more.querySelectorAll('.card').forEach((el) => { const p = content.projects.find((x) => x.id === el.dataset.id); p.section = 'more'; next.push(p); });
    content.projects = next;
    render();
  };
  const opts = { animation: 150, delay: 180, delayOnTouchOnly: true, onEnd: sync };
  if (window.Sortable) {
    Sortable.create(groups, { ...opts, handle: '.g-head', draggable: '.group' });
    groups.querySelectorAll('.cards').forEach((el) => Sortable.create(el, { ...opts, group: 'works', filter: 'button', preventOnFilter: false }));
    Sortable.create(more, { ...opts, group: 'works', filter: 'button', preventOnFilter: false });
  }
}

function addProject() {
  const id = 'p' + uid();
  const p = { id, slug: '', title: '', category: content.categories[0].id, section: 'main', featured: false, watermark: true, year: String(new Date().getFullYear()), madeFor: '', tris: '', textures: '', description: '', createdAt: new Date().toISOString(), images: [], wireframes: [], _new: true };
  content.projects.unshift(p);
  openEditor(p);
}

function uniqueSlug(base, self) {
  let s = slugify(base); let i = 2;
  while (content.projects.some((p) => p !== self && p.slug === s)) s = `${slugify(base)}-${i++}`;
  return s;
}

function openEditor(p) {
  const dlg = h('dialog', { class: 'editor', 'aria-label': 'Editar trabajo' });
  const close = () => {
    if (!p.title.trim()) p.title = 'Untitled';
    if (!p.slug) p.slug = uniqueSlug(p.title, p);
    dlg.close(); dlg.remove(); render();
  };
  const field = (label, key, attrs = {}) => h('label', { class: 'lbl' + (attrs.wide ? ' span2' : '') }, label,
    h(attrs.area ? 'textarea' : 'input', { class: 'fld', value: p[key] || '', placeholder: attrs.ph || '', oninput: (e) => {
      p[key] = e.target.value;
      if (key === 'title') { head.textContent = p.title || 'Nuevo trabajo'; if (p._new) { p.slug = uniqueSlug(p.title, p); slugIn.value = p.slug; } }
    } }));
  const head = h('h2', {}, p.title || 'Nuevo trabajo');
  const slugIn = h('input', { class: 'fld mono', value: p.slug, oninput: (e) => { p.slug = slugify(e.target.value); }, onblur: (e) => { p.slug = uniqueSlug(e.target.value || p.title, p); e.target.value = p.slug; } });
  const catSel = h('select', { class: 'fld', onchange: (e) => (p.category = e.target.value) }, ...content.categories.map((c) => h('option', { value: c.id, selected: c.id === p.category }, c.label)));
  const secSel = h('select', { class: 'fld', onchange: (e) => (p.section = e.target.value) }, h('option', { value: 'main', selected: p.section === 'main' }, 'Portfolio principal'), h('option', { value: 'more', selected: p.section === 'more' }, 'More work'));
  const check = (label, key, onchange) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!p[key], onchange: (e) => { p[key] = e.target.checked; onchange && onchange(); } }), label);

  const wireBox = h('div');
  const renderWire = () => wireBox.replaceChildren(...(p._wireOn || p.wireframes?.length ? [h('p', { class: 'hint' }, 'Capturas de malla: pueden ser menos que los renders.'), imageList(p, 'wireframes', true)] : []));
  p._wireOn = !!p.wireframes?.length;

  const body = h('div', { class: 'ed-body' },
    h('div', { class: 'grid2' },
      field('Título (en inglés)', 'title', { wide: true }),
      h('label', { class: 'lbl' }, 'Categoría', catSel),
      h('label', { class: 'lbl' }, 'Sección', secSel),
      field('Año', 'year'),
      h('label', { class: 'lbl' }, 'Enlace (ghoustly3d.com/p/…)', slugIn),
      field('Tris (opcional)', 'tris', { ph: '2.4k' }),
      field('Texturas (opcional)', 'textures', { ph: '1K PBR' }),
      field('Made for (opcional)', 'madeFor', { ph: 'Nombre del juego o grupo', wide: true }),
      field('Descripción (opcional)', 'description', { area: true, wide: true })),
    tagsEditor(p),
    h('div', { class: 'list' },
      check('Destacado en la portada (render grande de arriba)', 'featured'),
      check('Mostrar etiqueta «NEW» en la web', 'isNew'),
      check(`Añadir marca de agua «${WATERMARK}» (esquina) — desmárcalo si tus renders ya la llevan`, 'watermark'),
      [...(p.images || []), ...(p.wireframes || [])].some((im) => !im.orig)
        ? h('p', { class: 'hint' }, 'Nota: las imágenes importadas de tu web anterior se quedan como están; la marca de agua solo se aplica a las que subas desde aquí.')
        : null,
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: p._wireOn, onchange: (e) => { p._wireOn = e.target.checked; if (!e.target.checked) p.wireframes = []; renderWire(); } }), 'Este proyecto tiene capturas de malla (wireframe)')),
    h('h3', {}, 'Renders'),
    h('p', { class: 'hint' }, 'La primera imagen es la portada. Arrastra para ordenar. Puedes copiar una imagen y pegarla con Ctrl+V. Se convierten a WebP automáticamente.'),
    imageList(p, 'images', true, true),
    wireBox,
    h('div', { class: 'row', style: { borderTop: '1px solid var(--line)', paddingTop: '14px' } },
      h('button', { class: 'btn danger', type: 'button', onclick: () => {
        if (!confirm(`¿Eliminar «${p.title || 'este trabajo'}»? Podrás recuperarlo desde Historial si ya estaba publicado.`)) return;
        content.projects = content.projects.filter((x) => x !== p); dlg.close(); dlg.remove(); render();
      } }, 'Eliminar trabajo')));
  renderWire();
  dlg.append(h('div', { class: 'ed-head' }, head, h('button', { class: 'btn primary', type: 'button', onclick: close }, 'Listo')), body);
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  document.body.append(dlg);
  dlg.showModal();
}

// Tags: free words in English, used to recommend similar work under each project.
const STARTER_TAGS = { weapon: ['firearm', 'melee'], character: ['monster', 'humanoid'], building: ['building', 'prop'], ugc: ['clothing', 'accessory'] };
function tagsEditor(p) {
  p.tags = p.tags || [];
  const norm = (t) => String(t).trim().toLowerCase().replace(/^#+/, '').replace(/[^a-z0-9 -]/g, '').replace(/\s+/g, ' ').slice(0, 30);
  const chips = h('div', { class: 'tagrow' });
  const sugg = h('div', { class: 'tagrow' });
  const input = h('input', { class: 'fld', placeholder: 'Escribe un tag y pulsa Enter (ej: firearm)', 'aria-label': 'Nuevo tag' });
  const addTag = (t) => { t = norm(t); if (t && !p.tags.includes(t)) p.tags.push(t); draw(); };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(input.value); input.value = ''; } });
  input.addEventListener('blur', () => { if (input.value.trim()) { addTag(input.value); input.value = ''; } });
  const draw = () => {
    chips.replaceChildren(...p.tags.map((t) => h('button', { type: 'button', class: 'tagchip on', 'aria-label': 'Quitar tag ' + t, onclick: () => { p.tags = p.tags.filter((x) => x !== t); draw(); } }, '#' + t + ' ✕')));
    const used = content.projects.filter((x) => x !== p).flatMap((x) => x.tags || []);
    const all = [...new Set([...(STARTER_TAGS[p.category] || []), ...used])].filter((t) => !p.tags.includes(t));
    sugg.replaceChildren(...(all.length ? [h('span', { class: 'hint' }, 'Sugerencias:'), ...all.map((t) => h('button', { type: 'button', class: 'tagchip', onclick: () => addTag(t) }, '+ #' + t))] : []));
  };
  draw();
  return h('div', { class: 'tags-ed' },
    h('span', { class: 'lbl' }, 'Tags (en inglés) — debajo de cada trabajo se recomiendan los que comparten tags'),
    chips, input, sugg);
}

// A sortable list of images with an upload drop zone. key: 'images' | 'wireframes' | (wip uses its own owner)
// The image list that receives Ctrl+V. The last list you touched (or the main one when it opens).
let pasteTarget = null;
document.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.items || [])].filter((it) => it.kind === 'file' && it.type.startsWith('image/')).map((it) => it.getAsFile()).filter(Boolean);
  if (!files.length || !pasteTarget || !pasteTarget.wrap.isConnected) return;
  e.preventDefault();
  pasteTarget.add(files.map((f, i) => (f.name && f.name !== 'image.png' ? f : new File([f], `pasted-${Date.now()}-${i}.png`, { type: f.type }))));
});

async function pasteFromClipboard(add) {
  try {
    const items = await navigator.clipboard.read();
    const files = [];
    for (const it of items) {
      const type = it.types.find((t) => t.startsWith('image/'));
      if (type) files.push(new File([await it.getType(type)], `pasted-${Date.now()}.png`, { type }));
    }
    if (files.length) add(files); else toast('No hay ninguna imagen copiada.');
  } catch (e) {
    toast('Tu navegador no deja leer el portapapeles desde aquí. Prueba con Ctrl+V.');
  }
}

function imageList(owner, key, isProject, primary) {
  owner[key] = owner[key] || [];
  const wrap = h('div', { class: 'imgs' });
  const add = async (files) => {
    for (const f of files) {
      try {
        const entry = await addImage(f, isProject ? owner : null);
        owner[key].push(entry); draw();
      } catch (e) { toast('No se pudo procesar ' + (f.name || 'la imagen') + ': ' + (e?.message || 'formato no compatible')); }
    }
    render();
  };
  const target = { wrap, add };
  if (primary) pasteTarget = target;
  wrap.addEventListener('pointerdown', () => (pasteTarget = target));
  wrap.addEventListener('focusin', () => (pasteTarget = target));
  const draw = () => {
    wrap.replaceChildren(
      ...owner[key].map((im, i) => h('div', { class: 'img', 'data-i': i, style: { backgroundImage: `url("${imgUrl(im.thumb || im.src)}")` } },
        h('span', { class: 'n mono' }, i + 1),
        h('button', { class: 'x', type: 'button', 'aria-label': 'Quitar imagen ' + (i + 1), onclick: () => { owner[key].splice(i, 1); draw(); } }, '✕'))),
      dropZone(add),
      h('button', { class: 'drop paste', type: 'button', onclick: () => { pasteTarget = target; pasteFromClipboard(add); } }, 'Pegar imagen', h('br'), h('span', { class: 'mono' }, 'o Ctrl+V')));
  };
  if (window.Sortable) Sortable.create(wrap, { animation: 150, delay: 180, delayOnTouchOnly: true, draggable: '.img', filter: '.x', preventOnFilter: false,
    onEnd: () => { const order = [...wrap.querySelectorAll('.img')].map((el) => owner[key][+el.dataset.i]); owner[key] = order; draw(); } });
  draw();
  return wrap;
}

function dropZone(onFiles) {
  const input = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true, onchange: (e) => { onFiles([...e.target.files]); e.target.value = ''; } });
  const z = h('button', { class: 'drop', type: 'button', onclick: () => input.click() }, 'Añadir imágenes', h('br'), '(o arrástralas aquí)', input);
  z.addEventListener('dragover', (e) => { e.preventDefault(); z.classList.add('over'); });
  z.addEventListener('dragleave', () => z.classList.remove('over'));
  z.addEventListener('drop', (e) => { e.preventDefault(); z.classList.remove('over'); onFiles([...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'))); });
  return z;
}

// ---------- image processing (in the browser, nothing to pay for) ----------
async function processImage(source, watermark) {
  const bmp = await createImageBitmap(source);
  const scale = Math.min(1, 1920 / bmp.width);
  const w = Math.round(bmp.width * scale), hgt = Math.round(bmp.height * scale);
  const full = canvas(w, hgt);
  const ctx = full.getContext('2d');
  ctx.drawImage(bmp, 0, 0, w, hgt);
  if (watermark) {
    const size = Math.max(14, Math.round(w * 0.016));
    ctx.font = `700 ${size}px "Space Grotesk", system-ui, sans-serif`;
    ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillText(WATERMARK, w - size + 1, hgt - size * 0.8 + 1);
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillText(WATERMARK, w - size, hgt - size * 0.8);
  }
  const tw = Math.min(640, w);
  const thumb = canvas(tw, Math.round(hgt * (tw / w)));
  thumb.getContext('2d').drawImage(full, 0, 0, thumb.width, thumb.height);
  const lq = canvas(24, Math.max(1, Math.round(24 * (hgt / w))));
  lq.getContext('2d').drawImage(full, 0, 0, lq.width, lq.height);
  return {
    full: await toBlob(full, 0.88),
    thumb: await toBlob(thumb, 0.8),
    lqip: lq.toDataURL('image/webp', 0.5),
  };
}
const canvas = (w, hgt) => Object.assign(document.createElement('canvas'), { width: w, height: hgt });
const toBlob = (c, q) => new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('WebP no soportado'))), 'image/webp', q));

// project = null for WIP images (no watermark, no original kept)
async function addImage(file, project) {
  processing++; renderTop();
  try {
    file = new File([await file.arrayBuffer()], file.name || 'image.png', { type: file.type || 'image/png' });
    const wm = !!project?.watermark;
    const r = await processImage(file, wm);
    const key = uid();
    const folder = project ? `images/${project.id}` : 'images/wip';
    const src = `${folder}/${key}.webp`, thumb = `${folder}/${key}-thumb.webp`;
    pending.set(src, { blob: r.full, url: URL.createObjectURL(r.full) });
    pending.set(thumb, { blob: r.thumb, url: URL.createObjectURL(r.thumb) });
    const entry = { src, thumb, lqip: r.lqip };
    if (project) {
      entry.wm = wm;
      if (originalsEnabled) {
        const orig = await compressOriginal(file);
        entry.orig = `originals/${project.id}/${key}.${orig.ext}`;
        pendingOriginals.set(entry.orig, orig.blob);
      }
    }
    return entry;
  } finally { processing--; renderTop(); }
}

// Originals are kept at full resolution as near-lossless WebP (95%): same look, 5-10x lighter than PNG.
async function compressOriginal(file) {
  try {
    const bmp = await createImageBitmap(file);
    const c = canvas(bmp.width, bmp.height);
    c.getContext('2d').drawImage(bmp, 0, 0);
    const blob = await toBlob(c, 0.95);
    if (blob.size < file.size) return { blob, ext: 'webp' };
  } catch (e) { /* fall back to the file as it is */ }
  const ext = (file.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'png';
  return { blob: file, ext: ext.length >= 2 ? ext : 'png' };
}

// When a project's watermark setting changed, rebuild its images from the stored originals.
async function applyWatermarkChanges() {
  let skipped = 0;
  for (const p of content.projects) {
    for (const key of ['images', 'wireframes']) {
      for (let i = 0; i < (p[key] || []).length; i++) {
        const im = p[key][i];
        if (im.wm === undefined || im.wm === !!p.watermark) continue; // undefined = imported image, left as it is
        if (!im.orig) { skipped++; continue; }
        setBusy('Aplicando marca de agua…');
        const src = pendingOriginals.get(im.orig) || (await api('/original?path=' + encodeURIComponent(im.orig)));
        const r = await processImage(src, !!p.watermark);
        const k = uid();
        const folder = `images/${p.id}`;
        const next = { src: `${folder}/${k}.webp`, thumb: `${folder}/${k}-thumb.webp`, lqip: r.lqip, wm: !!p.watermark, orig: im.orig };
        pending.set(next.src, { blob: r.full, url: URL.createObjectURL(r.full) });
        pending.set(next.thumb, { blob: r.thumb, url: URL.createObjectURL(r.thumb) });
        p[key][i] = next;
      }
    }
  }
  return skipped;
}

// ---------- Portada (site settings) ----------
function viewSite(main) {
  const s = content.site;
  const f = (label, key, attrs = {}) => h('label', { class: 'lbl' + (attrs.wide ? ' span2' : '') }, label,
    h(attrs.area ? 'textarea' : 'input', { class: 'fld', type: attrs.type || 'text', value: s[key] ?? '', oninput: (e) => { s[key] = attrs.type === 'number' ? Number(e.target.value) : e.target.value; } }));
  main.append(
    h('section', { class: 'panel' }, h('h2', {}, 'Imagen al compartir el enlace'),
      h('p', { class: 'hint' }, 'La que sale en Discord, X, WhatsApp… al pegar ghoustly3d.com. Ideal 1920×1080 (16:9). Solo se usa la primera. Los enlaces de cada proyecto siguen mostrando su propio render. Discord guarda las vistas previas un tiempo: para ver el cambio al momento, pega el enlace con ?v=2 al final.'),
      imageList(s, 'shareImage', false)),
    h('section', { class: 'panel' }, h('h2', {}, 'Encargos'),
      h('div', { class: 'grid2' }, f('Plazas ocupadas', 'slotsFilled', { type: 'number' }), f('Plazas totales', 'slotsTotal', { type: 'number' })),
      h('p', { class: 'hint' }, 'Cuando las ocupadas llegan al total, la web muestra «Commissions closed» automáticamente.')),
    h('section', { class: 'panel' }, h('h2', {}, 'Presentación (en inglés)'),
      h('div', { class: 'grid2' }, f('Nombre', 'name'), f('Rol', 'role'), f('Frase', 'tagline', { wide: true }), f('Credenciales', 'credentials', { wide: true }),
        f('Mensaje de contacto', 'contactText', { wide: true }), f('Título de la sección WIP', 'wipHeading', { wide: true }))),
    h('section', { class: 'panel' }, h('h2', {}, 'Enlaces'),
      h('div', { class: 'grid2' }, f('Discord (botón de encargo)', 'discordUrl', { wide: true }), f('X / Twitter', 'twitterUrl'), f('ArtStation', 'artstationUrl'))),
    h('section', { class: 'panel' }, h('h2', {}, 'Otros'),
      h('div', { class: 'grid2' }, f('Zona horaria (IANA)', 'timezone'), f('Texto del país', 'timezoneLabel'),
        f('Token de Cloudflare Web Analytics (opcional)', 'analyticsToken', { wide: true }))));
}

// ---------- WIP ----------
function viewWip(main) {
  main.append(h('section', { class: 'panel' }, h('h2', {}, 'Working right now on'),
    h('p', { class: 'hint' }, 'Capturas de lo que estás haciendo ahora. Sin marca de agua. Si no hay ninguna, la sección no aparece.'),
    imageList(content, 'wip', false, true)));
}

// ---------- Clients & reviews ----------
function viewProof(main) {
  content.clients = content.clients || [];
  content.reviews = content.reviews || [];
  const sortList = (el, arr, redraw) => window.Sortable && Sortable.create(el, { animation: 150, handle: '.grip', onEnd: () => {
    const order = [...el.children].map((c) => arr[+c.dataset.i]); arr.splice(0, arr.length, ...order); redraw();
  } });

  // Worked with: each entry is { name, url, icon }. Older entries were plain text: convert them.
  content.clients = content.clients.map((c) => (typeof c === 'string' ? (/^https?:\/\//i.test(c.trim()) ? { name: '', url: c.trim() } : { name: c, url: '' }) : c));
  const clients = h('div', { class: 'list' });
  const fetchPreview = async (c, btn) => {
    if (!c.url) return toast('Pega primero el enlace del juego o grupo.');
    if (btn) { btn.disabled = true; btn.textContent = 'Buscando…'; }
    try {
      const r = await api('/link-preview?url=' + encodeURIComponent(c.url));
      c.url = r.url; if (r.name) c.name = r.name;
      if (r.iconData) {
        const blob = await (await fetch(r.iconData)).blob();
        c.icon = await storeIcon(blob);
      }
      drawClients(); renderTop();
    } catch (e) {
      toast(e.message === 'Not found' ? 'Tu Worker de Cloudflare necesita la versión nueva del código (mira el README).' : e.message, 7000);
      if (btn) { btn.disabled = false; btn.textContent = 'Cargar icono y nombre'; }
    }
  };
  const drawClients = () => {
    clients.replaceChildren(...content.clients.map((c, i) => h('div', { class: 'li', 'data-i': i },
      h('span', { class: 'grip', 'aria-hidden': 'true' }, '⠿'),
      c.icon ? h('img', { class: 'client-ic', src: imgUrl(c.icon), alt: '' }) : h('span', { class: 'client-ic empty', 'aria-hidden': 'true' }),
      h('div', { class: 'grow' },
        h('input', { class: 'fld', value: c.url || '', placeholder: 'Enlace del juego o grupo de Roblox (opcional)', 'aria-label': 'Enlace ' + (i + 1), oninput: (e) => (c.url = e.target.value.trim()) }),
        h('input', { class: 'fld', value: c.name || '', placeholder: 'Nombre que se mostrará', 'aria-label': 'Nombre ' + (i + 1), oninput: (e) => (c.name = e.target.value) }),
        h('div', { class: 'row' },
          h('button', { class: 'btn small', type: 'button', onclick: (e) => fetchPreview(c, e.currentTarget) }, 'Cargar icono y nombre'),
          h('label', { class: 'btn small' }, 'Subir icono', h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: async (e) => {
            const f = e.target.files[0]; if (!f) return;
            c.icon = await storeIcon(f); drawClients(); renderTop();
          } })),
          c.icon ? h('button', { class: 'btn small', type: 'button', onclick: () => { delete c.icon; drawClients(); renderTop(); } }, 'Quitar icono') : null)),
      h('button', { class: 'btn small danger', type: 'button', onclick: () => { content.clients.splice(i, 1); drawClients(); renderTop(); } }, 'Quitar'))));
    sortList(clients, content.clients, drawClients);
  };
  const addInput = h('input', { class: 'fld', placeholder: 'Pega aquí el enlace de un juego o grupo de Roblox y pulsa Añadir', 'aria-label': 'Enlace nuevo' });
  const addClient = async (e) => {
    const url = addInput.value.trim();
    const c = { name: url && !/^https?:/i.test(url) ? url : '', url: /^https?:/i.test(url) ? url : '' };
    content.clients.push(c); addInput.value = ''; drawClients();
    if (c.url) await fetchPreview(c, null);
  };
  addInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addClient(); } });
  const reviews = h('div', { class: 'list' });
  const addShot = async (r, files) => {
    const f = files.find((x) => x.type.startsWith('image/'));
    if (!f) return;
    const blob = await cropImage(f, 2.5);
    if (!blob) return;
    r.shot = await storeShot(blob);
    drawReviews(); renderTop();
  };
  const drawReviews = () => {
    reviews.replaceChildren(...content.reviews.map((r, i) => {
      const target = { wrap: null, add: (files) => addShot(r, files) };
      const fileIn = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: (e) => { addShot(r, [...e.target.files]); e.target.value = ''; } });
      // linked projects (several allowed); older reviews stored a single 'project'
      r.projects = [...new Set([...(r.projects || []), ...(r.project ? [r.project] : [])])];
      delete r.project;
      const projBox = h('div', { class: 'tags-ed' },
        h('span', { class: 'lbl' }, 'Proyectos de este cliente (opcional, puedes añadir varios)'),
        h('div', { class: 'tagrow' }, ...r.projects.map((slug) => {
          const pr = content.projects.find((x) => x.slug === slug);
          return h('button', { type: 'button', class: 'tagchip on', 'aria-label': 'Quitar ' + (pr ? pr.title : slug), onclick: () => { r.projects = r.projects.filter((x) => x !== slug); drawReviews(); renderTop(); } }, (pr ? pr.title : slug + ' (ya no existe)') + ' ✕');
        })),
        h('select', { class: 'fld', 'aria-label': 'Añadir proyecto a la reseña ' + (i + 1), onchange: (e) => {
          if (e.target.value && !r.projects.includes(e.target.value)) r.projects.push(e.target.value);
          drawReviews(); renderTop();
        } },
          h('option', { value: '' }, '+ Añadir proyecto…'),
          ...content.projects.filter((x) => !r.projects.includes(x.slug)).map((x) => h('option', { value: x.slug }, x.title))));
      const li = h('div', { class: 'li', 'data-i': i },
        h('span', { class: 'grip', 'aria-hidden': 'true' }, '⠿'),
        h('div', { class: 'grow' },
          r.shot
            ? h('img', { class: 'rv-shot', src: imgUrl(r.shot.thumb || r.shot.src), alt: 'Captura de la reseña ' + (i + 1) })
            : h('p', { class: 'hint' }, 'Sin captura: se mostrará como texto.'),
          h('div', { class: 'row' },
            h('button', { class: 'btn small', type: 'button', onclick: () => fileIn.click() }, r.shot ? 'Cambiar captura' : 'Subir captura'),
            h('button', { class: 'btn small', type: 'button', onclick: () => { pasteTarget = target; pasteFromClipboard(target.add); } }, 'Pegar captura'),
            r.shot ? h('button', { class: 'btn small', type: 'button', onclick: () => { delete r.shot; drawReviews(); renderTop(); } }, 'Quitar captura') : null,
            fileIn),
          h('textarea', { class: 'fld', value: r.text || '', placeholder: r.shot ? 'Texto de la reseña (opcional, ayuda a Google y a lectores de pantalla)' : 'Lo que dijo el cliente (en inglés)', 'aria-label': 'Texto de la reseña ' + (i + 1), oninput: (e) => (r.text = e.target.value) }),
          h('input', { class: 'fld', value: r.who || '', placeholder: 'Nombre · Juego o grupo', 'aria-label': 'Autor de la reseña ' + (i + 1), oninput: (e) => (r.who = e.target.value) }),
          projBox),
        h('button', { class: 'btn small danger', type: 'button', onclick: () => { content.reviews.splice(i, 1); drawReviews(); renderTop(); } }, 'Quitar'));
      target.wrap = li;
      li.addEventListener('pointerdown', () => (pasteTarget = target));
      return li;
    }));
    sortList(reviews, content.reviews, drawReviews);
  };
  drawClients(); drawReviews();
  main.append(
    h('section', { class: 'panel' }, h('h2', {}, 'Worked with'),
      h('p', { class: 'hint' }, 'Pega el enlace de un juego o grupo de Roblox: el panel trae su icono y su nombre. También puedes escribir solo un nombre (un estudio, por ejemplo) y subir tú el icono. Solo datos reales. Vacío = no aparece.'),
      h('div', { class: 'row' }, h('div', { style: { flex: '1 1 260px' } }, addInput), h('button', { class: 'btn primary', type: 'button', onclick: addClient }, 'Añadir')),
      clients),
    h('section', { class: 'panel' }, h('h2', {}, 'Reseñas'), h('p', { class: 'hint' }, 'Se muestran una a una con flechas, al final de la página. Lo mejor: una captura del mensaje del cliente (con su permiso). Al subirla o pegarla (Ctrl+V tras tocar la reseña) podrás recortarla: todas quedan del mismo tamaño. Puedes enlazar uno o varios proyectos que le hiciste.'), reviews,
      h('button', { class: 'btn', type: 'button', onclick: () => { content.reviews.push({ text: '', who: '' }); drawReviews(); renderTop(); } }, '+ Añadir reseña')));
}

// Crop tool: a frame with a fixed shape (ratio = width / height) you can move and resize. Resolves to a WebP blob, or null if cancelled.
function cropImage(file, ratio) {
  return new Promise(async (resolve) => {
    let bmp;
    try { bmp = await createImageBitmap(file); } catch (e) { toast('No se pudo abrir esa imagen.'); return resolve(null); }
    const W = bmp.width, H = bmp.height;
    const cv = h('canvas', { class: 'crop-cv', 'aria-label': 'Arrastra el marco para elegir la zona; arrastra la esquina para cambiar su tamaño' });
    const dlg = h('dialog', { class: 'editor crop', 'aria-label': 'Recortar captura' });
    const fit = () => Math.min((Math.min(window.innerWidth, 900) - 48) / W, (window.innerHeight * 0.62) / H, 1);
    let sc = fit();
    cv.width = Math.round(W * sc); cv.height = Math.round(H * sc);
    // frame in image pixels
    let fw = Math.min(W, H * ratio), fh = fw / ratio;
    let fx = (W - fw) / 2, fy = (H - fh) / 2;
    const clamp = () => {
      fw = Math.max(40, Math.min(fw, W, H * ratio)); fh = fw / ratio;
      fx = Math.max(0, Math.min(fx, W - fw)); fy = Math.max(0, Math.min(fy, H - fh));
    };
    const draw = () => {
      const x = cv.getContext('2d');
      x.clearRect(0, 0, cv.width, cv.height);
      x.drawImage(bmp, 0, 0, cv.width, cv.height);
      x.fillStyle = 'rgba(0,0,0,0.6)';
      const [rx, ry, rw, rh] = [fx * sc, fy * sc, fw * sc, fh * sc];
      x.fillRect(0, 0, cv.width, ry); x.fillRect(0, ry + rh, cv.width, cv.height - ry - rh);
      x.fillRect(0, ry, rx, rh); x.fillRect(rx + rw, ry, cv.width - rx - rw, rh);
      x.strokeStyle = '#a597ff'; x.lineWidth = 2; x.strokeRect(rx + 1, ry + 1, rw - 2, rh - 2);
      x.fillStyle = '#a597ff'; x.fillRect(rx + rw - 14, ry + rh - 14, 14, 14);
    };
    let mode = null, start = null;
    const pos = (e) => { const b = cv.getBoundingClientRect(); return { x: (e.clientX - b.left) * (cv.width / b.width) / sc, y: (e.clientY - b.top) * (cv.height / b.height) / sc }; };
    cv.addEventListener('pointerdown', (e) => {
      const p = pos(e);
      const grab = 28 / sc;
      if (Math.abs(p.x - (fx + fw)) < grab && Math.abs(p.y - (fy + fh)) < grab) mode = 'resize';
      else if (p.x > fx && p.x < fx + fw && p.y > fy && p.y < fy + fh) mode = 'move';
      else { mode = 'move'; fx = p.x - fw / 2; fy = p.y - fh / 2; clamp(); draw(); }
      start = { p, fx, fy, fw };
      cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener('pointermove', (e) => {
      if (!mode) return;
      const p = pos(e);
      if (mode === 'move') { fx = start.fx + (p.x - start.p.x); fy = start.fy + (p.y - start.p.y); }
      else { fw = Math.max(p.x - fx, (p.y - fy) * ratio); }
      clamp(); draw();
    });
    const end = () => { mode = null; };
    cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
    const zoom = (k) => { const cx = fx + fw / 2, cy = fy + fh / 2; fw *= k; clamp(); fx = cx - fw / 2; fy = cy - fh / 2; clamp(); draw(); };
    const finish = async (ok) => {
      dlg.close(); dlg.remove();
      if (!ok) return resolve(null);
      const ow = Math.min(1200, Math.round(fw)), oh = Math.round(ow / ratio);
      const out = canvas(ow, oh);
      out.getContext('2d').drawImage(bmp, fx, fy, fw, fh, 0, 0, ow, oh);
      resolve(await toBlob(out, 0.9));
    };
    dlg.append(
      h('div', { class: 'ed-head' }, h('h2', {}, 'Recortar captura'), h('button', { class: 'btn', type: 'button', onclick: () => finish(false) }, 'Cancelar'), h('button', { class: 'btn primary', type: 'button', onclick: () => finish(true) }, 'Recortar')),
      h('div', { class: 'ed-body' },
        h('p', { class: 'hint' }, 'Arrastra el marco hasta el mensaje del cliente. Arrastra la esquina (cuadrado morado) o usa − / + para el tamaño. Todas las reseñas quedan con la misma forma.'),
        h('div', { class: 'row' }, h('button', { class: 'btn small', type: 'button', 'aria-label': 'Marco más pequeño', onclick: () => zoom(0.85) }, '−'), h('button', { class: 'btn small', type: 'button', 'aria-label': 'Marco más grande', onclick: () => zoom(1.18) }, '+')),
        cv));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(false); });
    document.body.append(dlg);
    dlg.showModal();
    draw();
  });
}

async function storeShot(blob) {
  const key = uid();
  const src = `images/reviews/${key}.webp`, thumb = `images/reviews/${key}-thumb.webp`;
  const bmp = await createImageBitmap(blob);
  const t = canvas(600, Math.round(600 * bmp.height / bmp.width));
  t.getContext('2d').drawImage(bmp, 0, 0, t.width, t.height);
  const tb = await toBlob(t, 0.85);
  const lq = canvas(25, 10); lq.getContext('2d').drawImage(bmp, 0, 0, 25, 10);
  pending.set(src, { blob, url: URL.createObjectURL(blob) });
  pending.set(thumb, { blob: tb, url: URL.createObjectURL(tb) });
  return { src, thumb, lqip: lq.toDataURL('image/webp', 0.5) };
}

async function storeIcon(blob) {
  const bmp = await createImageBitmap(blob);
  const size = 128;
  const c = canvas(size, size);
  const ctx = c.getContext('2d');
  const sc = Math.max(size / bmp.width, size / bmp.height);
  ctx.drawImage(bmp, (size - bmp.width * sc) / 2, (size - bmp.height * sc) / 2, bmp.width * sc, bmp.height * sc);
  const out = await toBlob(c, 0.9);
  const path = `images/clients/${uid()}.webp`;
  pending.set(path, { blob: out, url: URL.createObjectURL(out) });
  return path;
}

// ---------- History ----------
function viewHistory(main) {
  const box = h('section', { class: 'panel' }, h('h2', {}, 'Historial'), h('p', { class: 'hint' }, 'Cada publicación queda guardada. «Restaurar» vuelve a poner el contenido de esa versión (como una publicación nueva).'), h('p', { class: 'muted' }, 'Cargando…'));
  main.append(box);
  api('/history').then((list) => {
    box.lastChild.remove();
    for (const c of list) {
      box.append(h('div', { class: 'hist' },
        h('div', {}, h('div', {}, c.message), h('div', { class: 'mono muted' }, new Date(c.date).toLocaleString())),
        h('button', { class: 'btn small', type: 'button', onclick: async () => {
          if (dirty() && !confirm('Tienes cambios sin publicar que se perderán. ¿Seguir?')) return;
          if (!confirm('¿Restaurar esta versión?')) return;
          busy = 'Restaurando…'; render();
          try { await api('/restore', { method: 'POST', body: JSON.stringify({ sha: c.sha }) }); busy = ''; await load(); toast('Versión restaurada. Visible en ~1 minuto.'); }
          catch (e) { busy = ''; render(); toast(e.message); }
        } }, 'Restaurar')));
    }
  }).catch((e) => { box.lastChild.textContent = e.message; });
}

// ---------- preview & publish ----------
function openPreview() {
  const draft = clean(content);
  const swap = (im) => im && { ...im, src: imgUrl(im.src), thumb: imgUrl(im.thumb || im.src) };
  draft.projects.forEach((p) => { p.images = (p.images || []).map(swap); p.wireframes = (p.wireframes || []).map(swap); if (!p.slug) p.slug = 'draft'; });
  draft.wip = (draft.wip || []).map(swap);
  try { localStorage.setItem('ghoustly-preview', JSON.stringify(draft)); }
  catch (e) { toast('La vista previa es demasiado grande para el navegador.'); return; }
  window.open(BASE + '?preview=1', '_blank');
}

const toB64 = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = () => rej(new Error('No se pudo leer una imagen. Quítala y vuelve a añadirla.')); r.readAsDataURL(blob); });

function usedPaths(c) {
  const set = new Set();
  const add = (im) => { if (im) { set.add(im.src); if (im.thumb) set.add(im.thumb); if (im.orig) set.add(im.orig); } };
  c.projects.forEach((p) => { (p.images || []).forEach(add); (p.wireframes || []).forEach(add); });
  (c.wip || []).forEach(add);
  (c.clients || []).forEach((x) => { if (x && x.icon) set.add(x.icon); });
  (c.site?.shareImage || []).forEach(add);
  (c.reviews || []).forEach((r) => r && r.shot && add(r.shot));
  return set;
}

async function publish() {
  if (busy) return;
  if (processing) { queued = true; renderTop(); return waitAndPublish(); }
  for (const p of content.projects) { if (!p.title?.trim()) p.title = 'Untitled'; if (!p.slug) p.slug = uniqueSlug(p.title, p); }
  try {
    const skipped = await applyWatermarkChanges();
    if (skipped) toast(`${skipped} imágenes antiguas no tienen original guardado: su marca de agua no se puede cambiar.`, 6000);
    // Publish a snapshot: anything you change from now on stays as "Cambios sin publicar" for next time.
    const snapshot = clean(content);
    publishingJson = JSON.stringify(snapshot);
    const used = usedPaths(snapshot);
    const origs = [...pendingOriginals.keys()].filter((path) => used.has(path));
    const files = [...pending.keys()].filter((path) => used.has(path));

    // 1) originals → private repo, one after another (GitHub rejects simultaneous writes to one repo).
    //    They are small WebP now, so this takes a couple of seconds each. Each one is retried before giving up.
    for (let i = 0; i < origs.length; i++) {
      const path = origs[i];
      setBusy(`Guardando originales ${i + 1}/${origs.length}…`);
      const body = JSON.stringify({ path, data: await toB64(pendingOriginals.get(path)) });
      await retry(() => api('/original', { method: 'POST', body }));
      pendingOriginals.delete(path);
    }

    // 2) web images → public repo, in batches; the last request also carries content.json
    const batches = [[]]; let size = 0;
    for (const path of files) {
      const f = { path, data: await toB64(pending.get(path).blob) };
      if (size + f.data.length > MAX_BATCH && batches.at(-1).length) { batches.push([]); size = 0; }
      batches.at(-1).push(f); size += f.data.length;
    }
    for (let i = 0; i < batches.length; i++) {
      const last = i === batches.length - 1;
      setBusy(batches.length > 1 ? `Publicando ${i + 1}/${batches.length}…` : 'Publicando…');
      const r = await retry(() => api('/publish', { method: 'POST', body: JSON.stringify({
        files: batches[i], contentSha, content: last ? snapshot : undefined,
        message: last ? 'Update portfolio from admin panel' : 'Upload images from admin panel',
      }) }));
      if (r.contentSha) contentSha = r.contentSha;
    }
    files.forEach((path) => pending.delete(path));
    const ids = new Set(snapshot.projects.map((p) => p.id));
    content.projects.forEach((p) => { if (ids.has(p.id)) delete p._new; });
    savedJson = JSON.stringify(snapshot);
    saveDraft();
    setBusy('');
    if (queued && dirty()) { queued = false; toast('Publicado. Ahora publico lo que tenías en cola…'); return waitAndPublish(); }
    queued = false;
    toast(dirty() ? '¡Publicado! Lo que cambiaste mientras guardaba queda pendiente para la próxima vez.' : '¡Publicado! Los cambios se verán en la web en ~1 minuto.', 5000);
  } catch (e) {
    queued = false;
    setBusy('');
    const msg = e?.message || e?.target?.error?.message || String(e);
    if (msg !== 'unauthorized') toast('No se pudo publicar: ' + msg + ' — tus cambios siguen aquí, prueba otra vez.', 8000);
  }
}

// Tries a request up to 3 times (short pauses between) unless the error is final.
async function retry(fn, tries = 3) {
  for (let i = 1; ; i++) {
    try { return await fn(); }
    catch (e) {
      const final = e.message === 'unauthorized' || /cambió desde otro dispositivo|no válido|repetido/i.test(e.message);
      if (final || i >= tries) throw e.name === 'TimeoutError' ? new Error('La conexión tardó demasiado') : e instanceof TypeError ? new Error('No se pudo conectar con el servidor') : e;
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
}

// Waits for images still being converted, then publishes.
async function waitAndPublish() {
  while (processing > 0) await new Promise((r) => setTimeout(r, 300));
  queued = false;
  return publish();
}

// ---------- boot ----------
if (token && API) load().catch(() => renderLogin()); else renderLogin();

// Ghoustly 3D — admin panel. Talks only to the Cloudflare Worker (which holds the GitHub token).
const API = (window.GHOUSTLY_CONFIG?.workerUrl || '').replace(/\/+$/, '');
const BASE = location.pathname.replace(/admin\/.*$/, '');
const WATERMARK = '@Ghoustly3D';
const MAX_BATCH = 12 * 1024 * 1024; // bytes of base64 per request

const app = document.getElementById('app');
let token = sessionStorage.getItem('gh-token') || '';
let content = null;      // draft being edited
let savedJson = '';      // last published version, to detect changes
let contentSha = '';
let originalsEnabled = false;
let tab = 'works';
let busy = '';
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
  render();
}

// ---------- shell ----------
function render() {
  const s = content.site;
  const st = busy ? 'busy' : dirty() ? 'dirty' : '';
  const statusText = busy || (dirty() ? 'Cambios sin publicar' : 'Todo publicado');
  const slot = (d) => () => { s.slotsFilled = Math.max(0, Math.min(Number(s.slotsTotal) || 0, (Number(s.slotsFilled) || 0) + d)); render(); };
  const top = h('div', { class: 'top' },
    h('div', { class: 'top-in' },
      h('span', { class: 'brand' }, 'GHOUSTLY ', h('span', {}, '3D'), ' · Panel'),
      h('span', { class: 'status mono ' + st }, h('i'), statusText),
      h('div', { class: 'top-actions' },
        h('span', { class: 'slots', title: 'Plazas de encargo ocupadas' },
          h('button', { type: 'button', 'aria-label': 'Una plaza menos', onclick: slot(-1) }, '−'),
          h('span', { class: 'mono' }, `${s.slotsFilled}/${s.slotsTotal} plazas`),
          h('button', { type: 'button', 'aria-label': 'Una plaza más', onclick: slot(1) }, '+')),
        h('button', { class: 'btn', type: 'button', onclick: openPreview }, 'Vista previa'),
        h('button', { class: 'btn primary', type: 'button', disabled: !!busy || !dirty(), onclick: publish }, 'Publicar'))),
    h('nav', { class: 'tabs', role: 'tablist' },
      ...[['works', 'Trabajos'], ['site', 'Portada'], ['wip', 'WIP'], ['proof', 'Clientes y reseñas'], ['history', 'Historial']].map(([id, label]) =>
        h('button', { role: 'tab', 'aria-selected': String(tab === id), onclick: () => { tab = id; render(); } }, label))));
  const main = h('main');
  ({ works: viewWorks, site: viewSite, wip: viewWip, proof: viewProof, history: viewHistory })[tab](main);
  app.replaceChildren(top, main);
}
window.addEventListener('beforeunload', (e) => { if (content && dirty()) { e.preventDefault(); e.returnValue = ''; } });

// ---------- Trabajos ----------
function viewWorks(main) {
  const cats = content.categories;
  const byCat = (cid, section) => content.projects.filter((p) => p.category === cid && p.section === section);
  const card = (p) => {
    const cover = p.images?.[0];
    return h('div', { class: 'card', 'data-id': p.id },
      h('div', { class: 'th', style: cover ? { backgroundImage: `url("${imgUrl(cover.thumb || cover.src)}")` } : {} },
        h('div', { class: 'badges mono' }, p.featured ? h('span', {}, '★ Destacado') : null, p.wireframes?.length ? h('span', {}, 'Malla') : null)),
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
    h('div', { class: 'list' },
      check('Destacado en la portada (render grande de arriba)', 'featured'),
      check(`Añadir marca de agua «${WATERMARK}» (esquina) — desmárcalo si tus renders ya la llevan`, 'watermark'),
      [...(p.images || []), ...(p.wireframes || [])].some((im) => !im.orig)
        ? h('p', { class: 'hint' }, 'Nota: las imágenes importadas de tu web anterior se quedan como están; la marca de agua solo se aplica a las que subas desde aquí.')
        : null,
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: p._wireOn, onchange: (e) => { p._wireOn = e.target.checked; if (!e.target.checked) p.wireframes = []; renderWire(); } }), 'Este proyecto tiene capturas de malla (wireframe)')),
    h('h3', {}, 'Renders'),
    h('p', { class: 'hint' }, 'La primera imagen es la portada. Arrastra para ordenar. Se convierten a WebP automáticamente.'),
    imageList(p, 'images', true),
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

// A sortable list of images with an upload drop zone. key: 'images' | 'wireframes' | (wip uses its own owner)
function imageList(owner, key, isProject) {
  owner[key] = owner[key] || [];
  const wrap = h('div', { class: 'imgs' });
  const draw = () => {
    wrap.replaceChildren(
      ...owner[key].map((im, i) => h('div', { class: 'img', 'data-i': i, style: { backgroundImage: `url("${imgUrl(im.thumb || im.src)}")` } },
        h('span', { class: 'n mono' }, i + 1),
        h('button', { class: 'x', type: 'button', 'aria-label': 'Quitar imagen ' + (i + 1), onclick: () => { owner[key].splice(i, 1); draw(); } }, '✕'))),
      dropZone(async (files) => {
        for (const f of files) {
          try {
            const entry = await addImage(f, isProject ? owner : null);
            owner[key].push(entry); draw();
          } catch (e) { toast('No se pudo procesar ' + f.name + ': ' + e.message); }
        }
        render();
      }));
    if (window.Sortable) Sortable.create(wrap, { animation: 150, delay: 180, delayOnTouchOnly: true, draggable: '.img', filter: '.x', preventOnFilter: false,
      onEnd: () => { const order = [...wrap.querySelectorAll('.img')].map((el) => owner[key][+el.dataset.i]); owner[key] = order; draw(); } });
  };
  draw();
  return wrap;
}

function dropZone(onFiles) {
  const input = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true, onchange: (e) => { onFiles([...e.target.files]); e.target.value = ''; } });
  const z = h('button', { class: 'drop', type: 'button', onclick: () => input.click() }, 'Añadir imágenes', h('br'), '(o suéltalas aquí)', input);
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
  busy = 'Procesando imagen…'; render();
  try {
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
        const ext = (file.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
        entry.orig = `originals/${project.id}/${key}.${ext}`;
        pendingOriginals.set(entry.orig, file);
      }
    }
    return entry;
  } finally { busy = ''; }
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
        busy = 'Aplicando marca de agua…'; render();
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
    imageList(content, 'wip', false)));
}

// ---------- Clients & reviews ----------
function viewProof(main) {
  content.clients = content.clients || [];
  content.reviews = content.reviews || [];
  const sortList = (el, arr, redraw) => window.Sortable && Sortable.create(el, { animation: 150, handle: '.grip', onEnd: () => {
    const order = [...el.children].map((c) => arr[+c.dataset.i]); arr.splice(0, arr.length, ...order); redraw();
  } });

  const clients = h('div', { class: 'list' });
  const drawClients = () => {
    clients.replaceChildren(...content.clients.map((c, i) => h('div', { class: 'li', 'data-i': i },
      h('span', { class: 'grip', 'aria-hidden': 'true' }, '⠿'),
      h('div', { class: 'grow' }, h('input', { class: 'fld', value: c, 'aria-label': 'Cliente ' + (i + 1), oninput: (e) => (content.clients[i] = e.target.value) })),
      h('button', { class: 'btn small danger', type: 'button', onclick: () => { content.clients.splice(i, 1); drawClients(); } }, 'Quitar'))));
    sortList(clients, content.clients, drawClients);
  };
  const reviews = h('div', { class: 'list' });
  const drawReviews = () => {
    reviews.replaceChildren(...content.reviews.map((r, i) => h('div', { class: 'li', 'data-i': i },
      h('span', { class: 'grip', 'aria-hidden': 'true' }, '⠿'),
      h('div', { class: 'grow' },
        h('textarea', { class: 'fld', value: r.text, placeholder: 'Lo que dijo el cliente (en inglés)', 'aria-label': 'Reseña ' + (i + 1), oninput: (e) => (r.text = e.target.value) }),
        h('input', { class: 'fld', value: r.who, placeholder: 'Nombre · Juego o grupo', 'aria-label': 'Autor de la reseña ' + (i + 1), oninput: (e) => (r.who = e.target.value) })),
      h('button', { class: 'btn small danger', type: 'button', onclick: () => { content.reviews.splice(i, 1); drawReviews(); } }, 'Quitar'))));
    sortList(reviews, content.reviews, drawReviews);
  };
  drawClients(); drawReviews();
  main.append(
    h('section', { class: 'panel' }, h('h2', {}, 'Worked with'), h('p', { class: 'hint' }, 'Juegos, grupos o estudios con los que has trabajado. Solo datos reales. Vacío = no aparece.'), clients,
      h('button', { class: 'btn', type: 'button', onclick: () => { content.clients.push(''); drawClients(); } }, '+ Añadir')),
    h('section', { class: 'panel' }, h('h2', {}, 'Reseñas'), h('p', { class: 'hint' }, 'Se muestran una a una con flechas. Vacío = no aparece.'), reviews,
      h('button', { class: 'btn', type: 'button', onclick: () => { content.reviews.push({ text: '', who: '' }); drawReviews(); } }, '+ Añadir reseña')));
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

const toB64 = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); });

function usedPaths(c) {
  const set = new Set();
  const add = (im) => { if (im) { set.add(im.src); if (im.thumb) set.add(im.thumb); if (im.orig) set.add(im.orig); } };
  c.projects.forEach((p) => { (p.images || []).forEach(add); (p.wireframes || []).forEach(add); });
  (c.wip || []).forEach(add);
  return set;
}

async function publish() {
  for (const p of content.projects) { if (!p.title?.trim()) p.title = 'Untitled'; if (!p.slug) p.slug = uniqueSlug(p.title, p); }
  try {
    const skipped = await applyWatermarkChanges();
    if (skipped) toast(`${skipped} imágenes antiguas no tienen original guardado: su marca de agua no se puede cambiar.`, 6000);
    const used = usedPaths(content);

    // 1) originals → private repo (one by one, they can be big)
    for (const [path, blob] of pendingOriginals) {
      if (!used.has(path)) continue;
      busy = 'Guardando originales…'; render();
      await api('/original', { method: 'POST', body: JSON.stringify({ path, data: await toB64(blob) }) });
      pendingOriginals.delete(path);
    }

    // 2) images → public repo, in batches; the last request also carries content.json
    const files = [];
    for (const [path, f] of pending) if (used.has(path)) files.push({ path, data: await toB64(f.blob) });
    const batches = [[]]; let size = 0;
    for (const f of files) {
      if (size + f.data.length > MAX_BATCH && batches.at(-1).length) { batches.push([]); size = 0; }
      batches.at(-1).push(f); size += f.data.length;
    }
    for (let i = 0; i < batches.length; i++) {
      const last = i === batches.length - 1;
      busy = batches.length > 1 ? `Publicando ${i + 1}/${batches.length}…` : 'Publicando…'; render();
      const r = await api('/publish', { method: 'POST', body: JSON.stringify({
        files: batches[i], contentSha, content: last ? clean(content) : undefined,
        message: last ? 'Update portfolio from admin panel' : 'Upload images from admin panel',
      }) });
      if (r.contentSha) contentSha = r.contentSha;
    }
    pending.clear();
    content.projects.forEach((p) => delete p._new);
    savedJson = JSON.stringify(clean(content));
    busy = ''; render();
    toast('¡Publicado! Los cambios se verán en la web en ~1 minuto.');
  } catch (e) {
    busy = ''; render();
    if (e.message !== 'unauthorized') toast('No se pudo publicar: ' + e.message, 6000);
  }
}

// ---------- boot ----------
if (token && API) load().catch(() => renderLogin()); else renderLogin();

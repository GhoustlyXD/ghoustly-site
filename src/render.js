// Shared HTML templates. Used by build.mjs (Node) and by the admin preview (browser).
// Every value that comes from content.json goes through esc() before reaching the HTML.

export function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Only allow http(s) links from content; anything else becomes '#'.
export function safeUrl(u) {
  const s = String(u ?? '').trim();
  return /^https?:\/\//i.test(s) ? s : '#';
}

export function asset(base, path) {
  if (!path) return '';
  if (/^(https?:|blob:|data:)/.test(path)) return path;
  return base + String(path).replace(/^\/+/, '');
}

export function projectUrl(base, p) {
  return `${base}p/${encodeURIComponent(p.slug)}/`;
}

const icon = {
  sun: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  moon: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  left: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>',
  right: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
  expand: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  link: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>',
  close: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};

function catOf(content, id) {
  return content.categories.find((c) => c.id === id) || { id, label: id, single: id };
}

// Projects in display order: categories in their saved order, projects in their saved order inside each.
export function orderedProjects(content, section) {
  const out = [];
  for (const c of content.categories) {
    for (const p of content.projects) if (p.section === section && p.category === c.id) out.push(p);
  }
  for (const p of content.projects) if (p.section === section && !out.includes(p)) out.push(p);
  return out;
}

function nameHtml(name) {
  const parts = String(name).trim().split(/\s+/);
  if (parts.length > 1) {
    const last = parts.pop();
    return `${esc(parts.join(' '))} <span class="grad">${esc(last)}</span>`;
  }
  return esc(name);
}

function img(base, im, alt, cls, eager) {
  if (!im) return `<div class="ph ${cls || ''}"></div>`;
  const lq = im.lqip ? ` style="background-image:url('${esc(im.lqip)}')"` : '';
  return `<img class="${cls || ''}" src="${esc(asset(base, im.thumb || im.src))}" alt="${esc(alt)}" ${eager ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async" width="1920" height="1080"${lq}>`;
}

function slots(site) {
  const total = Number(site.slotsTotal) || 0;
  const filled = Number(site.slotsFilled) || 0;
  return { total, filled, open: total === 0 || filled < total };
}

export function head(content, opts) {
  const { base, title, description, image, url } = opts;
  const s = content.site;
  const analytics = s.analyticsToken
    ? `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token": "${esc(s.analyticsToken)}"}'></script>`
    : '';
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(s.name)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
${image ? `<meta property="og:image" content="${esc(image)}">` : ''}
${url ? `<meta property="og:url" content="${esc(url)}">\n<link rel="canonical" href="${esc(url)}">` : ''}
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#09090c">
<script>try{var t=localStorage.getItem('theme');if(t)document.documentElement.dataset.theme=t}catch(e){}</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=JetBrains+Mono:wght@400;500&display=swap">
<link rel="stylesheet" href="${base}assets/styles.css">
<link rel="icon" href="${base}assets/favicon.svg" type="image/svg+xml">
<script type="module" src="${base}assets/site.js"></script>
${analytics}`;
}

function topBar(content) {
  const s = content.site;
  const sl = slots(s);
  const label = sl.open ? 'Commissions open' : 'Commissions closed';
  const count = sl.total ? ` · ${sl.filled}/${sl.total} slots` : '';
  return `<div class="topbar"><span class="dot${sl.open ? '' : ' off'}"></span>${label}${count}
<a href="${esc(safeUrl(s.discordUrl))}" target="_blank" rel="noopener">${sl.open ? 'Request one →' : 'Ask on Discord →'}</a></div>`;
}

function themeBtn() {
  return `<button type="button" class="iconbtn" data-theme-toggle aria-label="Toggle light / dark mode"><span class="when-dark">${icon.sun}</span><span class="when-light">${icon.moon}</span></button>`;
}

function siteHeader(content, base, back) {
  const s = content.site;
  return `<header class="wrap header">
${back ? `<a class="back" href="${base}">${icon.left}All work</a>` : ''}
<a class="logo" href="${base}">${nameHtml(s.name)}</a>
<div class="header-links">
${back ? '' : `<a href="${esc(safeUrl(s.twitterUrl))}" target="_blank" rel="noopener">X / Twitter</a>
<a href="${esc(safeUrl(s.artstationUrl))}" target="_blank" rel="noopener">ArtStation</a>`}
${themeBtn()}
</div>
</header>`;
}

function siteFooter(content) {
  const s = content.site;
  return `<footer class="wrap footer" id="contact">
<div><p class="muted">${esc(s.contactText)}</p>
<a class="talk" href="${esc(safeUrl(s.discordUrl))}" target="_blank" rel="noopener">Let’s talk <span class="accent">→</span></a></div>
<div class="footer-links mono"><a href="${esc(safeUrl(s.twitterUrl))}" target="_blank" rel="noopener">X / Twitter</a><a href="${esc(safeUrl(s.artstationUrl))}" target="_blank" rel="noopener">ArtStation</a></div>
</footer>
<div class="wrap legal mono muted"><span>© ${new Date().getFullYear()} ${esc(s.name)}</span><span data-clock="${esc(s.timezone || 'UTC')}">--:--</span><span>local time (${esc(s.timezoneLabel || '')})</span></div>
<div class="mbar"><span class="mono">${slots(s).total ? `${slots(s).filled}/${slots(s).total} slots` : ''}</span><a class="btn primary" href="${esc(safeUrl(s.discordUrl))}" target="_blank" rel="noopener">Request a commission</a></div>`;
}

function tile(content, base, p, small) {
  const imgs = (p.images || []).map((im) => asset(base, im.thumb || im.src));
  const cat = catOf(content, p.category);
  const n = imgs.length;
  return `<a class="tile${small ? ' small' : ''}" href="${projectUrl(base, p)}" data-cat="${esc(p.category)}" data-created="${esc(p.createdAt || '')}" data-images="${esc(JSON.stringify(imgs))}">
<div class="frame">${img(base, (p.images || [])[0], p.title, 'cover')}
${n > 1 ? `<div class="bars" aria-hidden="true">${'<span></span>'.repeat(n)}</div><span class="chip count mono"><span data-i>1</span> / ${n}</span>` : ''}
${p.isNew ? '<span class="chip new mono">NEW</span>' : ''}
</div>
<div class="tile-cap"><span class="t">${esc(p.title)}</span>${small ? '' : `<span class="mono muted up">${esc(cat.single)}</span>`}</div>
</a>`;
}

// One "Worked with" entry: icon + name, linked to the game or group when there is a link.
function clientHtml(base, c) {
  const inner = `${c.icon ? `<img src="${esc(asset(base, c.icon))}" alt="" width="40" height="40" loading="lazy">` : ''}<span>${esc(c.name || '')}</span>`;
  const href = safeUrl(c.url);
  return href !== '#'
    ? `<a class="client" href="${esc(href)}" target="_blank" rel="noopener">${inner}</a>`
    : `<span class="client">${inner}</span>`;
}

export function homeBody(content, base) {
  const s = content.site;
  const main = orderedProjects(content, 'main');
  const more = orderedProjects(content, 'more');
  const featured = content.projects.filter((p) => p.featured && (p.images || []).length);
  const counts = {};
  for (const p of main) counts[p.category] = (counts[p.category] || 0) + 1;
  const cats = content.categories.filter((c) => counts[c.id]);

  const featuredHtml = featured.length
    ? `<section class="wrap featured" aria-label="Featured work" data-featured>
<div class="feat-stage">
${featured
  .map((p, i) => {
    const im = p.images[0];
    const lq = im.lqip ? ` style="background-image:url('${esc(im.lqip)}')"` : '';
    return `<a class="slide${i === 0 ? ' on' : ''}" href="${projectUrl(base, p)}"${i ? ' aria-hidden="true" tabindex="-1"' : ''}>
<img src="${esc(asset(base, im.src))}" alt="${esc(p.title)}" ${i === 0 ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async" width="1920" height="1080"${lq}>
<div class="cap"><div><div class="mono muted up">${esc(catOf(content, p.category).single)}</div><div class="cap-t">${esc(p.title)}</div></div><span class="accent">View project →</span></div></a>`;
  })
  .join('\n')}
</div>
${featured.length > 1 ? `<div class="dots">${featured.map((p, i) => `<button type="button" aria-label="Show featured ${i + 1}" aria-pressed="${i === 0}"><span></span></button>`).join('')}</div>` : ''}
</section>`
    : '';

  const reviews = (content.reviews || []).filter((r) => r && r.text);
  const clients = (content.clients || []).map((c) => (typeof c === 'string' ? { name: c } : c)).filter((c) => c && (c.name || c.icon));
  const proofHtml =
    clients.length || reviews.length
      ? `<section class="wrap proof line">
${clients.length ? `<div class="clients"><span class="mono muted up">Worked with</span>${clients.map((c) => clientHtml(base, c)).join('')}</div>` : ''}
${
  reviews.length
    ? `<div class="reviews" data-reviews>
${reviews.length > 1 ? `<button type="button" class="iconbtn" data-prev aria-label="Previous review">${icon.left}</button>` : ''}
<div class="review-box" aria-live="polite">${reviews
        .map((r, i) => `<figure class="review${i === 0 ? ' on' : ''}"><blockquote>“${esc(r.text)}”</blockquote><figcaption class="mono muted">— ${esc(r.who)}${reviews.length > 1 ? ` · ${i + 1}/${reviews.length}` : ''}</figcaption></figure>`)
        .join('')}</div>
${reviews.length > 1 ? `<button type="button" class="iconbtn" data-next aria-label="Next review">${icon.right}</button>` : ''}
</div>`
    : ''
}
</section>`
      : '';

  const wip = content.wip || [];
  const wipHtml = wip.length
    ? `<section class="wrap wip line">
<div class="sec-head"><h2 class="up small-h">${esc(s.wipHeading || 'Working right now on')}</h2><span class="mono muted">WIP</span></div>
<div class="wip-grid">${wip.map((im, i) => `<button type="button" class="wip-item" data-zoom-src="${esc(asset(base, im.src))}" aria-label="Open WIP image ${i + 1}">${img(base, im, 'Work in progress', 'cover')}</button>`).join('')}</div>
</section>`
    : '';

  return `${topBar(content)}
${siteHeader(content, base, false)}
<main>
<section class="wrap hero">
<span class="mono up accent eyebrow">${esc(s.role || '3D Artist')}</span>
<h1 class="hero-name">${nameHtml(s.name)}</h1>
<p class="tagline muted">${esc(s.tagline)}</p>
${s.credentials ? `<p class="creds mono muted">${esc(s.credentials)}</p>` : ''}
<div class="cta"><a class="btn primary" href="${esc(safeUrl(s.discordUrl))}" target="_blank" rel="noopener">Request a commission</a><a class="btn ghost" href="#work">View work</a></div>
</section>
${featuredHtml}
${proofHtml}
${wipHtml}
<section class="wrap work line" id="work">
<div class="sec-head"><h2>Selected work</h2><span class="mono muted"><span data-count>${main.length}</span> projects</span></div>
${cats.length > 1 ? `<div class="chips" role="group" aria-label="Filter by category">
<button type="button" class="chipbtn" data-filter="" aria-pressed="true">All <span class="mono">${main.length}</span></button>
${cats.map((c) => `<button type="button" class="chipbtn" data-filter="${esc(c.id)}" aria-pressed="false">${esc(c.label)} <span class="mono">${counts[c.id]}</span></button>`).join('\n')}
</div>` : ''}
<div class="grid">${main.map((p) => tile(content, base, p, false)).join('\n')}</div>
</section>
${
  more.length
    ? `<section class="wrap more line">
<div class="sec-head"><div><h2>More work</h2><p class="muted">Smaller pieces and quick studies.</p></div>
<button type="button" class="btn outline" data-more aria-expanded="false" aria-controls="more-grid">Show ${more.length} more</button></div>
<div class="grid grid-more" id="more-grid" hidden>${more.map((p) => tile(content, base, p, true)).join('\n')}</div>
</section>`
    : ''
}
</main>
${siteFooter(content)}
${zoomDialog()}`;
}

function zoomDialog() {
  return `<dialog class="zoom" aria-label="Full screen image">
<div class="zoom-bar"><span class="mono muted" data-zoom-label>100%</span>
<div class="zoom-btns"><button type="button" class="iconbtn" data-zoom-out aria-label="Zoom out">−</button><button type="button" class="iconbtn" data-zoom-in aria-label="Zoom in">+</button><button type="button" class="iconbtn" data-zoom-close aria-label="Close">${icon.close}</button></div></div>
<div class="zoom-area"><img alt="" data-zoom-img></div>
</dialog>`;
}

const normTag = (t) => String(t).trim().toLowerCase();

// Up to 3 recommendations: shared tags count most, then same category, then main portfolio over "More work".
export function relatedProjects(content, p, n = 3) {
  const mine = new Set((p.tags || []).map(normTag).filter(Boolean));
  const pool = [...orderedProjects(content, 'main'), ...orderedProjects(content, 'more')].filter((x) => x.id !== p.id);
  return pool
    .map((x, i) => {
      const shared = (x.tags || []).map(normTag).filter((t) => mine.has(t)).length;
      const score = shared * 10 + (x.category === p.category ? 5 : 0) + (x.section === 'main' ? 1 : 0);
      return { x, i, score };
    })
    .filter((r) => r.score >= 5)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, n)
    .map((r) => r.x);
}

export function projectBody(content, base, p) {
  const cat = catOf(content, p.category);
  const images = p.images || [];
  const wires = p.wireframes || [];
  const specs = [p.madeFor ? `Made for ${p.madeFor}` : '', p.tris ? `${p.tris} tris` : '', p.textures || ''].filter(Boolean);
  const related = relatedProjects(content, p);
  const relatedTitle = related.length && related.every((x) => x.category === p.category) ? `More ${cat.label}` : 'Similar work';
  const tags = (p.tags || []).filter(Boolean);
  const gallery = (list, mode) =>
    JSON.stringify(list.map((im) => ({ src: asset(base, im.src), lqip: im.lqip || '' })));

  return `${siteHeader(content, base, true)}
<main class="wrap project">
<section class="p-head line">
<div class="p-title-wrap">
<span class="mono up accent">${esc(cat.single)}${p.year ? ` · ${esc(p.year)}` : ''}</span>
<h1 class="p-title">${esc(p.title)}</h1>
${specs.length || tags.length ? `<div class="specs mono">${specs.map((x) => `<span>${esc(x)}</span>`).join('')}${tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join('')}</div>` : ''}
</div>
<div class="p-side">
${p.description ? `<p class="muted">${esc(p.description)}</p>` : ''}
<button type="button" class="btn outline small-btn" data-copy-link>${icon.link}<span>Copy link</span></button>
</div>
</section>

<div class="gallery" data-gallery data-render='${esc(gallery(images))}' data-wire='${esc(gallery(wires))}'>
${wires.length ? `<div class="modes" role="group" aria-label="View mode"><button type="button" data-mode="render" aria-pressed="true">Render · ${images.length}</button><button type="button" data-mode="wire" aria-pressed="false">Wireframe · ${wires.length}</button></div>` : ''}
<div class="stage">
${images[0] ? `<img data-stage src="${esc(asset(base, images[0].src))}" alt="${esc(p.title)}" fetchpriority="high" width="1920" height="1080"${images[0].lqip ? ` style="background-image:url('${esc(images[0].lqip)}')"` : ''}>` : '<div class="ph"></div>'}
${images.length > 1 ? `<button type="button" class="iconbtn nav prev" data-prev aria-label="Previous image">${icon.left}</button><button type="button" class="iconbtn nav next" data-next aria-label="Next image">${icon.right}</button>` : ''}
<span class="chip mono counter" data-counter>1 / ${images.length}</span>
<button type="button" class="iconbtn expand" data-expand aria-label="View full screen">${icon.expand}</button>
</div>
<div class="thumbs" data-thumbs></div>
</div>

${
  related.length
    ? `<section class="related line"><div class="sec-head"><h2>${esc(relatedTitle)}</h2><a class="mono muted" href="${base}#work">All work →</a></div>
<div class="grid">${related.map((x) => tile(content, base, x, false)).join('\n')}</div></section>`
    : ''
}
</main>
${siteFooter(content)}
${zoomDialog()}`;
}

export function page(headHtml, bodyHtml, bodyAttrs = '') {
  return `<!doctype html>
<html lang="en">
<head>
${headHtml}
</head>
<body${bodyAttrs}>
${bodyHtml}
</body>
</html>
`;
}

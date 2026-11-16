// Builds the static site into dist/.  Usage: node build.mjs
// BASE_PATH  — path the site is served from ("/" with a custom domain, "/ghoustly-site/" on github.io).
// SITE_URL   — absolute origin used for share previews (og:image), e.g. https://ghoustly3d.com
import { readFile, writeFile, mkdir, rm, cp, access } from 'node:fs/promises';
import { join } from 'node:path';
import { head, homeBody, projectBody, page, asset } from './src/render.js';

const root = new URL('.', import.meta.url).pathname;
const out = join(root, 'dist');
let base = process.env.BASE_PATH || '/';
if (!base.endsWith('/')) base += '/';
const siteUrl = (process.env.SITE_URL || '').replace(/\/+$/, '');

const exists = (p) => access(p).then(() => true, () => false);
const content = JSON.parse(await readFile(join(root, 'content/content.json'), 'utf8'));
validate(content);

await rm(out, { recursive: true, force: true });
await mkdir(join(out, 'assets'), { recursive: true });

const abs = (path) => (siteUrl ? siteUrl + asset(base, path) : '');
const s = content.site;
const firstFeatured = content.projects.find((p) => p.featured && p.images?.length) || content.projects.find((p) => p.images?.length);

await writeFile(
  join(out, 'index.html'),
  page(
    head(content, {
      base,
      title: `${s.name} — ${s.role || '3D Artist'}`,
      description: s.tagline,
      image: firstFeatured ? abs(firstFeatured.images[0].src) : '',
      url: siteUrl ? siteUrl + base : '',
    }),
    homeBody(content, base)
  )
);

for (const p of content.projects) {
  const dir = join(out, 'p', p.slug);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'index.html'),
    page(
      head(content, {
        base,
        title: `${p.title} — ${s.name}`,
        description: p.description || `${p.title} by ${s.name}. ${s.tagline}`,
        image: p.images?.[0] ? abs(p.images[0].src) : '',
        url: siteUrl ? `${siteUrl}${base}p/${p.slug}/` : '',
      }),
      projectBody(content, base, p)
    )
  );
}

await writeFile(
  join(out, '404.html'),
  page(head(content, { base, title: `Not found — ${s.name}`, description: s.tagline }), `<main class="wrap" style="padding:80px 24px"><h1 class="p-title">Not found</h1><p class="muted" style="margin:16px 0 24px">This page does not exist (anymore).</p><a class="btn primary" href="${base}">Back to the portfolio</a></main>`)
);

for (const f of ['styles.css', 'site.js', 'render.js']) await cp(join(root, 'src', f), join(out, 'assets', f));
await cp(join(root, 'src/favicon.svg'), join(out, 'assets/favicon.svg'));
await cp(join(root, 'images'), join(out, 'images'), { recursive: true });
await cp(join(root, 'admin'), join(out, 'admin'), { recursive: true });
await mkdir(join(out, 'content'), { recursive: true });
await cp(join(root, 'content/content.json'), join(out, 'content/content.json'));
if (await exists(join(root, 'CNAME'))) await cp(join(root, 'CNAME'), join(out, 'CNAME'));
await writeFile(join(out, '.nojekyll'), '');

console.log(`Built ${content.projects.length} project pages into dist/ (base ${base})`);

function validate(c) {
  const slugs = new Set();
  for (const p of c.projects) {
    if (!/^[a-z0-9-]+$/.test(p.slug)) throw new Error(`Invalid slug: ${p.slug}`);
    if (slugs.has(p.slug)) throw new Error(`Duplicate slug: ${p.slug}`);
    slugs.add(p.slug);
  }
}

// Local test environment: serves dist/ and runs the real worker against an in-memory fake GitHub.
// Usage: node build.mjs && node test/dev-server.mjs   → site http://localhost:4173, admin password "test"
import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, extname } from 'node:path';
import worker from '../worker/worker.js';

const root = new URL('..', import.meta.url).pathname;
const dist = join(root, 'dist');
const SITE = 'http://localhost:4173';
const API = 'http://localhost:8787';

// ---- fake GitHub ----
const sha1 = (b) => createHash('sha1').update(b).digest('hex');
const repos = {};
function repo(name) {
  if (!repos[name]) repos[name] = { blobs: {}, trees: {}, commits: {}, head: null, log: [] };
  return repos[name];
}
async function seed() {
  const r = repo('GhoustlyXD/ghoustly-site');
  const text = await readFile(join(root, 'content/content.json'));
  const tree = { 'content/content.json': text };
  const id = sha1('c0'); r.trees[id] = tree; r.commits[id] = { sha: id, tree: id, message: 'Initial', date: new Date().toISOString() };
  r.head = id; r.log.unshift(id);
  repo('GhoustlyXD/ghoustly-originals').head = null;
}
function treeAt(r, ref) {
  const c = r.commits[ref && r.commits[ref] ? ref : r.head];
  return c ? r.trees[c.tree] : {};
}
const jres = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'content-type': 'application/json' } });
async function fakeGitHub(url, init = {}) {
  const u = new URL(url);
  const method = init.method || 'GET';
  const m = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/(.*)$/);
  const r = repo(m[1]);
  const rest = m[2];
  const body = init.body ? JSON.parse(init.body) : null;
  const accept = (init.headers || {}).accept || '';
  if (rest.startsWith('contents/')) {
    const path = decodeURIComponent(rest.slice(9));
    if (method === 'PUT') {
      const t = { ...treeAt(r) }; t[path] = Buffer.from(body.content, 'base64');
      const id = sha1('t' + Math.random()); r.trees[id] = t; r.commits[id] = { sha: id, tree: id, message: body.message, date: new Date().toISOString() }; r.head = id; r.log.unshift(id);
      return jres({ content: { sha: sha1(t[path]) } }, 201);
    }
    const f = treeAt(r, u.searchParams.get('ref'))[path];
    if (!f) return jres({ message: 'Not Found' }, 404);
    if (accept.includes('raw')) return new Response(f, { headers: { 'content-type': 'application/octet-stream' } });
    return jres({ sha: sha1(f) });
  }
  if (rest === 'git/blobs' && method === 'POST') { const b = Buffer.from(body.content, 'base64'); const id = sha1(b); r.blobs[id] = b; return jres({ sha: id }, 201); }
  if (rest.startsWith('git/ref/heads/')) return jres({ object: { sha: r.head } });
  if (rest.startsWith('git/commits/')) { const c = r.commits[rest.slice(12)]; return jres({ sha: c.sha, tree: { sha: c.tree } }); }
  if (rest === 'git/trees' && method === 'POST') {
    const t = { ...r.trees[body.base_tree] };
    for (const e of body.tree) t[e.path] = e.content != null ? Buffer.from(e.content) : r.blobs[e.sha];
    const id = sha1('tree' + Math.random()); r.trees[id] = t; return jres({ sha: id }, 201);
  }
  if (rest === 'git/commits' && method === 'POST') { const id = sha1('commit' + Math.random()); r.commits[id] = { sha: id, tree: body.tree, message: body.message, date: new Date().toISOString() }; return jres({ sha: id }, 201); }
  if (rest.startsWith('git/refs/heads/') && method === 'PATCH') {
    r.head = body.sha; r.log.unshift(body.sha);
    // mirror the published state to disk so a rebuild shows it
    const t = treeAt(r);
    for (const [p, buf] of Object.entries(t)) if (p.startsWith('images/') || p === 'content/content.json') {
      const { mkdir } = await import('node:fs/promises'); const { dirname } = await import('node:path');
      await mkdir(join(dist, dirname(p)), { recursive: true }); await writeFile(join(dist, p), buf);
    }
    return jres({ object: { sha: body.sha } });
  }
  if (rest.startsWith('commits')) {
    return jres(r.log.map((id) => ({ sha: id, commit: { message: r.commits[id].message, author: { date: r.commits[id].date } } })));
  }
  return jres({ message: 'fake: unhandled ' + method + ' ' + rest }, 500);
}
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => (String(url).startsWith('https://api.github.com') ? fakeGitHub(String(url), init) : realFetch(url, init));

const env = { ADMIN_PASSWORD: 'test', TOKEN_SECRET: 'dev-secret-123', GITHUB_TOKEN: 'x', REPO: 'GhoustlyXD/ghoustly-site', BRANCH: 'main', ORIGINALS_REPO: 'GhoustlyXD/ghoustly-originals', ALLOWED_ORIGINS: SITE };

await seed();
await writeFile(join(dist, 'admin/config.js'), `window.GHOUSTLY_CONFIG = { workerUrl: '${API}' };\n`);

http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const request = new Request(API + req.url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : Buffer.concat(chunks) });
  const out = await worker.fetch(request, env);
  res.writeHead(out.status, Object.fromEntries(out.headers));
  res.end(Buffer.from(await out.arrayBuffer()));
}).listen(8787);

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.webp': 'image/webp' };
http.createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, SITE).pathname);
  if (p.endsWith('/')) p += 'index.html';
  try { const b = await readFile(join(dist, p)); res.writeHead(200, { 'content-type': types[extname(p)] || 'application/octet-stream' }); res.end(b); }
  catch { res.writeHead(404); res.end('not found'); }
}).listen(4173);

console.log(`site ${SITE}  ·  admin ${SITE}/admin/  ·  api ${API}  (password: test)`);
export { repos };

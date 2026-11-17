// Ghoustly 3D — admin API (Cloudflare Worker, free plan).
// Secrets (set with `npx wrangler secret put NAME`):
//   ADMIN_PASSWORD  your panel password
//   TOKEN_SECRET    long random string used to sign sessions
//   GITHUB_TOKEN    fine-grained token with "Contents: read & write" on the site repo (+ originals repo)
// Vars (wrangler.toml): REPO, BRANCH, ORIGINALS_REPO (optional), ALLOWED_ORIGINS (comma separated)

const CONTENT_PATH = 'content/content.json';
const SESSION_HOURS = 12;

export default {
  async fetch(req, env) {
    const origin = req.headers.get('origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const cors = {
      'access-control-allow-origin': allowed.includes(origin) ? origin : allowed[0] || '',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization',
      'access-control-max-age': '86400',
      vary: 'origin',
    };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (origin && !allowed.includes(origin)) return json({ error: 'Origin not allowed' }, 403, cors);

    try {
      const url = new URL(req.url);
      const route = `${req.method} ${url.pathname}`;
      if (route === 'POST /login') return await login(req, env, cors);
      if (!(await verify(req, env))) return json({ error: 'Unauthorized' }, 401, cors);
      const gh = github(env);
      switch (route) {
        case 'GET /content': {
          const f = await gh.getFile(env.REPO, CONTENT_PATH);
          return json({ content: JSON.parse(f.text), sha: f.sha, originals: !!env.ORIGINALS_REPO }, 200, cors);
        }
        case 'POST /publish': return json(await publish(gh, env, await req.json()), 200, cors);
        case 'POST /original': {
          if (!env.ORIGINALS_REPO) return json({ error: 'Originals repo not configured' }, 400, cors);
          const { path, data } = await req.json();
          if (!/^originals\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.[a-z0-9]{2,5}$/.test(path)) return json({ error: 'Bad path' }, 400, cors);
          await gh.putFile(env.ORIGINALS_REPO, path, data, 'Store original');
          return json({ ok: true }, 200, cors);
        }
        case 'GET /original': {
          const path = url.searchParams.get('path') || '';
          if (!env.ORIGINALS_REPO || !path.startsWith('originals/') || path.includes('..')) return json({ error: 'Bad path' }, 400, cors);
          const r = await gh.raw(env.ORIGINALS_REPO, path);
          return new Response(r.body, { headers: { ...cors, 'content-type': r.headers.get('content-type') || 'application/octet-stream' } });
        }
        case 'GET /link-preview': return json(await linkPreview(url.searchParams.get('url') || ''), 200, cors);
        case 'GET /history': {
          const list = await gh.req(`/repos/${env.REPO}/commits?path=${CONTENT_PATH}&sha=${env.BRANCH}&per_page=30`);
          return json(list.map((c) => ({ sha: c.sha, message: c.commit.message.split('\n')[0], date: c.commit.author.date })), 200, cors);
        }
        case 'POST /restore': {
          const { sha } = await req.json();
          if (!/^[0-9a-f]{40}$/.test(sha)) return json({ error: 'Bad sha' }, 400, cors);
          const old = await gh.getFile(env.REPO, CONTENT_PATH, sha);
          const cur = await gh.getFile(env.REPO, CONTENT_PATH);
          return json(await publish(gh, env, { content: JSON.parse(old.text), contentSha: cur.sha, files: [], message: `Restore version ${sha.slice(0, 7)}` }), 200, cors);
        }
      }
      return json({ error: 'Not found' }, 404, cors);
    } catch (e) {
      return json({ error: e.message || 'Server error' }, e.status || 500, cors);
    }
  },
};

// ---------- Roblox game / group previews for "Worked with" ----------
// Accepts links like roblox.com/games/123/Name, roblox.com/groups/123/Name or roblox.com/communities/123/Name.
// Returns the official name and icon (as base64, so the panel can convert and store it).
async function linkPreview(raw) {
  let u;
  try { u = new URL(raw.trim()); } catch (e) { throw httpError(400, 'Enlace no válido'); }
  if (!/(^|\.)roblox\.com$/i.test(u.hostname)) throw httpError(400, 'Solo enlaces de roblox.com (juegos o grupos)');
  const game = u.pathname.match(/\/games\/(\d+)/i);
  const group = u.pathname.match(/\/(?:groups|communities)\/(\d+)/i);
  const get = async (api) => {
    const r = await fetch(api, { headers: { accept: 'application/json', 'user-agent': 'ghoustly-admin' } });
    if (!r.ok) throw httpError(502, `Roblox respondió ${r.status}`);
    return r.json();
  };
  let name, icon, link, type;
  if (game) {
    const { universeId } = await get(`https://apis.roblox.com/universes/v1/places/${game[1]}/universe`);
    if (!universeId) throw httpError(404, 'No encontré ese juego');
    const info = await get(`https://games.roblox.com/v1/games?universeIds=${universeId}`);
    name = info.data?.[0]?.name;
    const th = await get(`https://thumbnails.roblox.com/v1/games/icons?universeIds=${universeId}&size=256x256&format=Png&isCircular=false`);
    icon = th.data?.[0]?.imageUrl;
    link = `https://www.roblox.com/games/${game[1]}`; type = 'game';
  } else if (group) {
    const info = await get(`https://groups.roblox.com/v1/groups/${group[1]}`);
    name = info.name;
    const th = await get(`https://thumbnails.roblox.com/v1/groups/icons?groupIds=${group[1]}&size=150x150&format=Png&isCircular=false`);
    icon = th.data?.[0]?.imageUrl;
    link = `https://www.roblox.com/communities/${group[1]}`; type = 'group';
  } else {
    throw httpError(400, 'Pega el enlace completo del juego o grupo (roblox.com/games/… o roblox.com/communities/…)');
  }
  let iconData = null;
  if (icon && /^https:\/\/[a-z0-9.-]*rbxcdn\.com\//i.test(icon)) {
    const r = await fetch(icon);
    if (r.ok) {
      const bytes = new Uint8Array(await r.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      iconData = `data:${r.headers.get('content-type') || 'image/png'};base64,${btoa(bin)}`;
    }
  }
  return { type, name: name || '', url: link, iconData };
}
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

// ---------- auth ----------
async function login(req, env, cors) {
  const { password } = await req.json().catch(() => ({}));
  const ok = typeof password === 'string' && env.ADMIN_PASSWORD && (await safeEqual(password, env.ADMIN_PASSWORD));
  if (!ok) {
    await new Promise((r) => setTimeout(r, 1200)); // slow down guessing
    return json({ error: 'Contraseña incorrecta' }, 401, cors);
  }
  const exp = Date.now() + SESSION_HOURS * 3600e3;
  return json({ token: `${exp}.${await sign(String(exp), env.TOKEN_SECRET)}` }, 200, cors);
}

async function verify(req, env) {
  const m = (req.headers.get('authorization') || '').match(/^Bearer (\d+)\.([A-Za-z0-9_-]+)$/);
  if (!m || Number(m[1]) < Date.now()) return false;
  return safeEqual(m[2], await sign(m[1], env.TOKEN_SECRET));
}

async function sign(msg, secret) {
  if (!secret) throw new Error('TOKEN_SECRET not set');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function safeEqual(a, b) {
  const [x, y] = await Promise.all([a, b].map((s) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));
  const ax = new Uint8Array(x), by = new Uint8Array(y);
  let d = 0;
  for (let i = 0; i < ax.length; i++) d |= ax[i] ^ by[i];
  return d === 0;
}

// ---------- publish: one commit with all files ----------
async function publish(gh, env, { content, contentSha, files = [], message }) {
  const cur = await gh.getFile(env.REPO, CONTENT_PATH);
  if (content && contentSha && cur.sha !== contentSha) {
    const e = new Error('El contenido cambió desde otro dispositivo. Recarga el panel antes de publicar.');
    e.status = 409; throw e;
  }
  const tree = [];
  for (const f of files) {
    if (!/^images\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.webp$/.test(f.path)) throw new Error('Bad file path: ' + f.path);
    const blob = await gh.req(`/repos/${env.REPO}/git/blobs`, { method: 'POST', body: { content: f.data, encoding: 'base64' } });
    tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  if (content) {
    validate(content);
    tree.push({ path: CONTENT_PATH, mode: '100644', type: 'blob', content: JSON.stringify(content, null, 2) + '\n' });
  }
  if (!tree.length) return { contentSha: cur.sha };
  const ref = await gh.req(`/repos/${env.REPO}/git/ref/heads/${env.BRANCH}`);
  const head = await gh.req(`/repos/${env.REPO}/git/commits/${ref.object.sha}`);
  const newTree = await gh.req(`/repos/${env.REPO}/git/trees`, { method: 'POST', body: { base_tree: head.tree.sha, tree } });
  const commit = await gh.req(`/repos/${env.REPO}/git/commits`, { method: 'POST', body: { message: message || 'Update from admin panel', tree: newTree.sha, parents: [head.sha] } });
  await gh.req(`/repos/${env.REPO}/git/refs/heads/${env.BRANCH}`, { method: 'PATCH', body: { sha: commit.sha } });
  const after = await gh.getFile(env.REPO, CONTENT_PATH, commit.sha);
  return { commit: commit.sha, contentSha: after.sha };
}

function validate(c) {
  if (!c || typeof c !== 'object' || !c.site || !Array.isArray(c.projects) || !Array.isArray(c.categories)) throw new Error('Invalid content');
  const slugs = new Set();
  for (const p of c.projects) {
    if (!/^[a-z0-9-]{1,80}$/.test(p.slug || '')) throw new Error(`Enlace no válido: "${p.slug}"`);
    if (slugs.has(p.slug)) throw new Error(`Enlace repetido: "${p.slug}"`);
    slugs.add(p.slug);
  }
  if (JSON.stringify(c).length > 2_000_000) throw new Error('Content too large');
}

// ---------- GitHub API ----------
function github(env) {
  const base = 'https://api.github.com';
  const headers = { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'user-agent': 'ghoustly-admin', 'x-github-api-version': '2022-11-28' };
  const req = async (path, opts = {}) => {
    const r = await fetch(base + path, { method: opts.method || 'GET', headers: { ...headers, ...(opts.body ? { 'content-type': 'application/json' } : {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
    if (!r.ok) { const e = new Error(`GitHub ${r.status}: ${(await r.text()).slice(0, 200)}`); e.status = 502; throw e; }
    return r.json();
  };
  const raw = async (repo, path, ref) => {
    const r = await fetch(`${base}/repos/${repo}/contents/${path}${ref ? `?ref=${ref}` : `?ref=${env.BRANCH}`}`, { headers: { ...headers, accept: 'application/vnd.github.raw' } });
    if (!r.ok) { const e = new Error(`GitHub ${r.status} reading ${path}`); e.status = 502; throw e; }
    return r;
  };
  return {
    req,
    raw,
    async getFile(repo, path, ref) {
      const meta = await req(`/repos/${repo}/contents/${path}?ref=${ref || env.BRANCH}`);
      const text = await (await raw(repo, path, ref)).text();
      return { sha: meta.sha, text };
    },
    async putFile(repo, path, base64, message) {
      let sha;
      try { sha = (await req(`/repos/${repo}/contents/${path}?ref=${env.BRANCH}`)).sha; } catch (e) {}
      return req(`/repos/${repo}/contents/${path}`, { method: 'PUT', body: { message, content: base64, branch: env.BRANCH, ...(sha ? { sha } : {}) } });
    },
  };
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers: { ...headers, 'content-type': 'application/json' } });
}

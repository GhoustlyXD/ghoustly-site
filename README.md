# Ghoustly 3D — portfolio

Web estática en **GitHub Pages** (gratis) con un **panel privado** en `/admin` para cambiar todo sin tocar código.
No usa Supabase, Vercel ni Notion: tus trabajos viven en `content/content.json` y las imágenes en `images/`, dentro de este mismo repositorio.

```
Tú (panel /admin) ──contraseña──▶ Cloudflare Worker (gratis) ──token──▶ GitHub (commit)
                                                                          │
                              GitHub Actions compila la web (~1 min) ◀────┘ ──▶ GitHub Pages
```

- La contraseña y el token de GitHub **solo** están en el Worker, nunca en la web.
- Cada publicación es un commit: el **Historial** del panel puede volver a cualquier versión.
- Las imágenes se convierten a WebP en tu navegador (1920 px + miniatura de 640 px + vista borrosa de carga).
- Los originales sin marca de agua se guardan en un repo **privado** aparte, para poder quitar o poner la marca más tarde.

## Puesta en marcha (una sola vez)

### 1. Repositorios
1. Crea el repo **público** `ghoustly-site` (vacío) y sube este código.
2. Crea el repo **privado** `ghoustly-originals` (vacío). Ahí se guardarán tus originales.
3. En `ghoustly-site` → **Settings → Pages → Build and deployment → Source: GitHub Actions**.

Al primer push la web queda en `https://ghoustlyxd.github.io/ghoustly-site/`.

### 2. Token de GitHub
GitHub → Settings → Developer settings → **Fine-grained tokens → Generate new token**
- Repository access: *Only select repositories* → `ghoustly-site` y `ghoustly-originals`
- Permissions → Repository → **Contents: Read and write**
- Copia el token (empieza por `github_pat_…`). No lo pegues en ningún chat.

### 3. Cloudflare Worker (cuenta gratis en cloudflare.com)
Desde la carpeta `worker/` en tu PC (necesita Node.js):

```bash
npx wrangler login
npx wrangler deploy
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put TOKEN_SECRET
npx wrangler secret put GITHUB_TOKEN
```

- `ADMIN_PASSWORD`: la contraseña del panel (larga, que no uses en otro sitio).
- `TOKEN_SECRET`: cualquier texto aleatorio largo (por ejemplo, 40 letras y números al azar).
- `GITHUB_TOKEN`: el token del paso 2.

`wrangler deploy` te da una dirección tipo `https://ghoustly-admin.TU-USUARIO.workers.dev`.
Ponla en `admin/config.js` (`workerUrl`) y haz commit.

### 4. Probar
Abre `https://ghoustlyxd.github.io/ghoustly-site/admin/`, entra con tu contraseña, cambia algo y pulsa **Publicar**. En ~1 minuto se ve en la web.

## Pasar tu dominio ghoustly3d.com (cuando tú decidas)
1. Crea un archivo `CNAME` en la raíz con una sola línea: `ghoustly3d.com`.
2. En Settings → Pages → Custom domain pon `ghoustly3d.com` y activa *Enforce HTTPS*.
3. En tu proveedor de dominio cambia los DNS a GitHub Pages (registros `A` a `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153` y `CNAME www → ghoustlyxd.github.io`), quitando los de Vercel.
4. En `worker/wrangler.toml` añade `https://ghoustly3d.com` a `ALLOWED_ORIGINS` y vuelve a hacer `npx wrangler deploy`.

## Estadísticas (opcional, gratis y sin cookies)
Cloudflare → Web Analytics → añade el sitio → copia el *token* y pégalo en el panel → Portada → «Token de Cloudflare Web Analytics».

## Para programadores
- `node build.mjs` genera `dist/` (página principal, una página por proyecto en `/p/<enlace>/` con vista previa para Discord/X, 404).
- `node build.mjs && node test/dev-server.mjs` levanta todo en local con un GitHub simulado (contraseña `test`): web en http://localhost:4173, panel en http://localhost:4173/admin/.
- `src/render.js` genera el HTML; lo usan la compilación y la «Vista previa» del panel.
- `admin/vendor/Sortable.min.js`: SortableJS 1.15.2 (MIT) para arrastrar y soltar, también en móvil.

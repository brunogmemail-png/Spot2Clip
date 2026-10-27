// Spot2Clip · mini-servidor (Cloudflare Worker, plano grátis)
// Lê a lista de músicas de uma playlist PÚBLICA do Spotify a partir do link e devolve JSON para o app.
// Usa a página pública de "incorporar" do Spotify (não oficial: pode mudar sem aviso).
//
// Variável opcional (Settings → Variables): ALLOWED_ORIGIN = https://seuusuario.github.io
// Com ela, só o seu site consegue usar este Worker.

const ID_RE = /^[A-Za-z0-9]{22}$/;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const clean = s => String(s == null ? '' : s).replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
const splitArtists = s => clean(s).split(/\s*,\s*/).filter(Boolean);

// procura, em qualquer profundidade, o objeto que contém a chave pedida
function findParent(o, key, depth = 0) {
  if (!o || typeof o !== 'object' || depth > 12) return null;
  if (!Array.isArray(o) && Object.prototype.hasOwnProperty.call(o, key)) return o;
  const vals = Array.isArray(o) ? o : Object.values(o);
  for (const v of vals) {
    const r = findParent(v, key, depth + 1);
    if (r) return r;
  }
  return null;
}

function extractPlaylist(html) {
  const og = (html.match(/<meta property="og:title" content="([^"]*)"/) || [])[1];

  // 1) formato atual: JSON em __NEXT_DATA__
  let m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (m) {
    try {
      const j = JSON.parse(m[1]);
      const p = findParent(j, 'trackList');
      if (p && Array.isArray(p.trackList) && p.trackList.length) {
        const tracks = p.trackList.map(t => ({
          title: clean(t.title),
          artists: splitArtists(t.subtitle),
          durationSec: t.duration ? Math.round(t.duration / 1000) : null,
        })).filter(t => t.title);
        return { name: clean(p.name || p.title || og || 'Playlist'), tracks };
      }
    } catch (e) { /* tenta o formato antigo */ }
  }

  // 2) formato antigo: <script id="resource" type="application/json">
  m = html.match(/<script id="resource"[^>]*>([\s\S]*?)<\/script>/);
  if (m) {
    try {
      const raw = m[1].trim();
      let j;
      try { j = JSON.parse(raw); } catch (e) { j = JSON.parse(decodeURIComponent(raw)); }
      const items = (j.tracks && j.tracks.items) || [];
      const tracks = items.map(it => it.track || it).map(t => ({
        title: clean(t.name),
        artists: (t.artists || []).map(a => clean(a.name)).filter(Boolean),
        durationSec: t.duration_ms ? Math.round(t.duration_ms / 1000) : null,
      })).filter(t => t.title);
      if (tracks.length) return { name: clean(j.name || og || 'Playlist'), tracks };
    } catch (e) { /* sem sorte */ }
  }
  return null;
}

const json = (o, status, headers) => new Response(JSON.stringify(o), { status, headers });

export default {
  async fetch(request, env) {
    const allowed = (env && env.ALLOWED_ORIGIN) || '*';
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': allowed,
      'Vary': 'Origin',
      'Content-Type': 'application/json; charset=utf-8',
    };
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: { ...cors, 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '86400' } });
    }
    if (allowed !== '*' && origin && origin !== allowed) return json({ error: 'origem_nao_permitida' }, 403, cors);

    let id = (new URL(request.url).searchParams.get('playlist') || '').trim();
    const m = id.match(/playlist[\/:]([A-Za-z0-9]{22})/);
    if (m) id = m[1];
    if (!ID_RE.test(id)) return json({ error: 'link_invalido' }, 400, cors);

    let r;
    try {
      r = await fetch('https://open.spotify.com/embed/playlist/' + id, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' },
        cf: { cacheTtl: 300, cacheEverything: true },
      });
    } catch (e) {
      return json({ error: 'spotify_indisponivel' }, 502, cors);
    }
    if (r.status === 404) return json({ error: 'nao_encontrada' }, 404, cors);
    if (!r.ok) return json({ error: 'spotify_' + r.status }, 502, cors);

    const data = extractPlaylist(await r.text());
    if (!data || !data.tracks.length) return json({ error: 'sem_faixas' }, 422, cors);
    return json(data, 200, { ...cors, 'Cache-Control': 'public, max-age=300' });
  },
};

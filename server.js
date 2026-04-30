const express = require('express');
const session = require('express-session');
const { createClient } = require('@supabase/supabase-js');
const admin = require('firebase-admin');

// ─── Twitch stream resolver ────────────────────────────────────────────────────

let _twitchToken = null;
let _tokenExpiry = 0;

async function fetchTwitchAppToken() {
    const clientId = process.env.TWITCH_CLIENT_ID;
    const clientSecret = process.env.TWITCH_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new Error('TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET not set');

    const res = await fetch('https://id.twitch.tv/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            grant_type: 'client_credentials'
        }).toString()
    });
    if (!res.ok) throw new Error(`Twitch OAuth failed: ${res.status}`);
    const data = await res.json();
    if (!data.access_token) throw new Error('No access_token in Twitch OAuth response');
    _twitchToken = data.access_token;
    _tokenExpiry = Date.now() + (data.expires_in - 3600) * 1000;
    console.log('[Twitch] App token refreshed');
    return _twitchToken;
}

async function getTwitchToken() {
    if (_twitchToken && Date.now() < _tokenExpiry) return _twitchToken;
    return fetchTwitchAppToken();
}

// GQL only accepts Twitch's own internal client IDs — the web player's is the standard choice
const TWITCH_GQL_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

async function getTwitchStreamUrl(channel) {
    const gqlRes = await fetch('https://gql.twitch.tv/gql', {
        method: 'POST',
        headers: {
            'Client-ID': TWITCH_GQL_CLIENT_ID,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            operationName: 'PlaybackAccessToken',
            query: `query PlaybackAccessToken($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!) {
  streamPlaybackAccessToken(channelName: $login, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) {
    value
    signature
  }
  videoPlaybackAccessToken(id: $vodID, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) {
    value
    signature
  }
}`,
            variables: {
                isLive: true,
                login: channel,
                isVod: false,
                vodID: '',
                playerType: 'embed'
            }
        })
    });

    if (!gqlRes.ok) {
        const body = await gqlRes.text();
        console.error(`[Twitch] GQL ${gqlRes.status}:`, body.slice(0, 300));
        throw new Error(`Twitch GQL error: ${gqlRes.status}`);
    }
    const gqlData = await gqlRes.json();
    const accessToken = gqlData?.data?.streamPlaybackAccessToken;

    if (!accessToken) {
        const errors = gqlData?.errors?.map(e => e.message).join(', ');
        throw new Error(errors || 'No stream access token — stream may be offline');
    }

    const params = new URLSearchParams({
        client_id: TWITCH_GQL_CLIENT_ID,
        token: accessToken.value,
        sig: accessToken.signature,
        allow_source: 'true',
        allow_audio_only: 'true'
    });

    const m3u8Res = await fetch(
        `https://usher.ttvnw.net/api/channel/hls/${channel}.m3u8?${params}`
    );
    if (m3u8Res.status === 404) throw new Error('Stream is offline');
    if (!m3u8Res.ok) throw new Error(`Usher returned ${m3u8Res.status}`);

    const playlist = await m3u8Res.text();
    const lines = playlist.split('\n');
    const streams = [];

    for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('#EXT-X-STREAM-INF:')) {
            const nameMatch = lines[i].match(/NAME="([^"]+)"/);
            const quality = nameMatch ? nameMatch[1] : 'unknown';
            let j = i + 1;
            while (j < lines.length && lines[j].startsWith('#')) j++;
            if (j < lines.length && lines[j].trim()) {
                streams.push({ quality, url: lines[j].trim() });
            }
        }
    }

    if (streams.length === 0) throw new Error('No streams found in master playlist');
    const best = streams.find(s => /source|chunked/i.test(s.quality)) || streams[0];
    return best.url;
}

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

// ─── Firebase Admin ────────────────────────────────────────────────────────────
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
    });
} else {
    console.warn('[FCM] FIREBASE_SERVICE_ACCOUNT not set — push notifications disabled');
}

async function notifyChannelUpdate() {
    if (!admin.apps.length) return;
    try {
        await admin.messaging().send({
            topic: 'canal_updates',
            data: { type: 'channel_change' }
        });
        console.log('[FCM] channel_change sent to topic canal_updates');
    } catch (e) {
        console.error('[FCM] Error:', e.message);
    }
}

const app = express();
const PORT = process.env.PORT || 3000;

// Supabase
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

// ─── Caché de canales ──────────────────────────────────────────────────────────
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos
let channelsCache = null;
let cacheTimestamp = 0;

async function getChannels() {
    const now = Date.now();
    if (channelsCache && (now - cacheTimestamp) < CACHE_TTL_MS) {
        return channelsCache;
    }
    const { data, error } = await supabase
        .from('channels')
        .select('*')
        .eq('active', true)
        .order('name');
    if (error) throw error;
    channelsCache = data;
    cacheTimestamp = now;
    console.log(`[cache] channels refreshed — ${data.length} canales`);
    return channelsCache;
}

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: process.env.SESSION_SECRET || 'dev-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 8 } // 8 horas
}));

// ─── Auth middleware ───────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
    if (req.session.authenticated) return next();
    res.redirect('/admin/login');
}

// ─── API pública ───────────────────────────────────────────────────────────────

app.get('/channels', async (req, res) => {
    try {
        const data = await getChannels();
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Twitch: GET /stream?channel=radioolavarria
app.get('/stream', async (req, res) => {
    const channel = req.query.channel;
    if (!channel) {
        return res.status(400).json({ error: 'Falta el parámetro channel' });
    }

    try {
        const url = await getTwitchStreamUrl(channel);
        res.json({ url });
    } catch (error) {
        console.error(`[Twitch] Error getting stream for ${channel}:`, error.message);
        res.status(500).json({ error: 'No se pudo obtener el stream', detail: error.message });
    }
});

// YouTube: GET /stream/youtube?channel=CHANNEL_ID
// CHANNEL_ID = el ID del canal de YouTube (empieza con UC...)
app.get('/stream/youtube', async (req, res) => {
    const channelId = req.query.channel;
    if (!channelId) {
        return res.status(400).json({ error: 'Falta el parámetro channel (YouTube Channel ID)' });
    }

    if (!YOUTUBE_API_KEY) {
        return res.status(500).json({ error: 'YOUTUBE_API_KEY no configurada en el servidor' });
    }

    try {
        // 1. Buscar el video en vivo actual del canal via YouTube Data API v3
        const searchUrl = `https://www.googleapis.com/youtube/v3/search?channelId=${channelId}&eventType=live&type=video&part=id&key=${YOUTUBE_API_KEY}`;
        const searchRes = await fetch(searchUrl);
        const searchData = await searchRes.json();

        if (searchData.error) {
            console.error('[YouTube API] Error:', searchData.error.message);
            return res.status(500).json({ error: 'Error consultando YouTube API', detail: searchData.error.message });
        }

        const videoId = searchData.items?.[0]?.id?.videoId;
        console.log(`[YouTube] Channel ${channelId} → videoId: ${videoId || 'none (not live)'}`);
        if (!videoId) {
            return res.status(404).json({ error: 'Canal sin transmisión en vivo actualmente' });
        }

        // 2. Devolver la URL de YouTube — la app extrae el HLS en el dispositivo
        const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
        console.log(`[YouTube] Returning watch URL: ${watchUrl}`);
        res.json({ url: watchUrl });
    } catch (error) {
        console.error('[YouTube] Error:', error.message, '— channel:', channelId);
        res.status(500).json({ error: 'Error obteniendo stream de YouTube', detail: error.message });
    }
});

app.get('/', (req, res) => res.redirect('/admin'));

// ─── Admin: login ──────────────────────────────────────────────────────────────

app.get('/admin/login', (req, res) => {
    if (req.session.authenticated) return res.redirect('/admin');
    res.send(loginPage());
});

app.post('/admin/login', (req, res) => {
    const { password } = req.body;
    if (password === process.env.ADMIN_PASSWORD) {
        req.session.authenticated = true;
        res.redirect('/admin');
    } else {
        res.send(loginPage('Contraseña incorrecta'));
    }
});

app.post('/admin/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/admin/login');
});

// ─── Admin: dashboard ──────────────────────────────────────────────────────────

app.get('/admin', requireAuth, async (req, res) => {
    // El admin siempre ve datos frescos de Supabase (ignora caché)
    const { data: channels } = await supabase
        .from('channels')
        .select('*')
        .order('name');

    res.send(dashboardPage(channels || []));
});

// ─── Admin: CRUD ───────────────────────────────────────────────────────────────

app.post('/admin/channels', requireAuth, async (req, res) => {
    const { name, description, twitch_username, color, source_type, stream_url, active } = req.body;

    const { error } = await supabase.from('channels').insert({
        name,
        description,
        twitch_username: twitch_username || null,
        color: color || '#2E3192',
        source_type: source_type || 'TWITCH',
        stream_url: stream_url || null,
        active: active === 'on'
    });

    if (error) return res.status(500).send(`Error: ${error.message}`);
    channelsCache = null;
    notifyChannelUpdate();
    res.redirect('/admin');
});

app.post('/admin/channels/:id/edit', requireAuth, async (req, res) => {
    const { name, description, twitch_username, color, source_type, stream_url, active } = req.body;

    const { error } = await supabase.from('channels').update({
        name,
        description,
        twitch_username: twitch_username || null,
        color: color || '#2E3192',
        source_type: source_type || 'TWITCH',
        stream_url: stream_url || null,
        active: active === 'on'
    }).eq('id', req.params.id);

    if (error) return res.status(500).send(`Error: ${error.message}`);
    channelsCache = null;
    notifyChannelUpdate();
    res.redirect('/admin');
});

app.post('/admin/channels/:id/delete', requireAuth, async (req, res) => {
    const { error } = await supabase.from('channels').delete().eq('id', req.params.id);
    if (error) return res.status(500).send(`Error: ${error.message}`);
    channelsCache = null;
    notifyChannelUpdate();
    res.redirect('/admin');
});

// ─── HTML ──────────────────────────────────────────────────────────────────────

function loginPage(error = '') {
    return `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>7400TV Admin</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #F5F7FA; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
        .card { background: white; padding: 40px; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,0.08); width: 100%; max-width: 360px; }
        h1 { font-size: 20px; color: #1E293B; margin-bottom: 4px; }
        h1 span { color: #00AEEF; }
        .sub { font-size: 12px; color: #94A3B8; margin-bottom: 28px; }
        label { display: block; font-size: 12px; color: #64748B; margin-bottom: 6px; font-weight: 500; }
        input { width: 100%; padding: 10px 12px; border: 1px solid #E2E8F0; border-radius: 8px; font-size: 14px; outline: none; transition: border 0.2s; }
        input:focus { border-color: #00AEEF; }
        button { width: 100%; padding: 11px; background: #1E2D4A; color: white; border: none; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; margin-top: 16px; }
        button:hover { background: #2a3d63; }
        .error { background: #FEF2F2; color: #DC2626; padding: 10px 12px; border-radius: 8px; font-size: 13px; margin-bottom: 16px; }
    </style>
</head>
<body>
    <div class="card">
        <h1>Conexion <span>7400</span></h1>
        <p class="sub">Panel de administración</p>
        ${error ? `<div class="error">${error}</div>` : ''}
        <form method="POST" action="/admin/login">
            <label>Contraseña</label>
            <input type="password" name="password" autofocus placeholder="••••••••" />
            <button type="submit">Ingresar</button>
        </form>
    </div>
</body>
</html>`;
}

function dashboardPage(channels) {
    const sidebarItems = channels.map((c, i) => `
        <div class="sidebar-item${i === 0 ? ' selected' : ''}" data-id="${esc(c.id)}">
            <div class="sidebar-accent"></div>
            <div class="sidebar-content">
                <div class="dot ${c.active ? 'dot-live' : 'dot-offline'}"></div>
                <div class="sidebar-text">
                    <div class="sidebar-name">${esc(c.name)}</div>
                    <div class="sidebar-desc">${esc(c.description || '')}</div>
                </div>
                <span class="sidebar-badge ${c.active ? 'badge-vivo' : 'badge-offline'}">${c.active ? 'VIVO' : 'OFFLINE'}</span>
            </div>
        </div>`).join('');

    const cards = channels.map(c => {
        const dataAttr = JSON.stringify(c).replace(/&/g,'&amp;').replace(/'/g,'&#39;').replace(/"/g,'&quot;');
        return `
        <div class="card">
            <div class="card-thumb" style="background:${esc(c.color || '#2E3192')}">
                <div class="card-thumb-text">
                    <span class="card-name-big">${esc(c.name)}</span>
                    ${c.description ? `<span class="card-desc-small">${esc(c.description)}</span>` : ''}
                </div>
                ${c.active ? '<span class="badge-live">● En vivo</span>' : ''}
                <div class="card-overlay">
                    <button class="overlay-btn btn-edit" data-channel="${dataAttr}" onclick="openEditFromData(this)">✏ Editar</button>
                    <button class="overlay-btn btn-delete" onclick="deleteChannel('${esc(c.id)}','${esc(c.name)}')">🗑 Eliminar</button>
                </div>
            </div>
            <div class="card-info">
                <div class="card-title">${esc(c.name)}</div>
                <div class="card-subtitle">${esc(c.description || '')}</div>
                <div class="card-meta">
                    <span class="source-badge ${esc((c.source_type||'').toLowerCase())}">${esc(c.source_type || '')}</span>
                    <span class="status-pill ${c.active ? 'status-active' : 'status-inactive'}">${c.active ? 'Activo' : 'Inactivo'}</span>
                </div>
            </div>
        </div>`;
    }).join('');

    return `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>7400TV Admin</title>
    <style>
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #060B14;
            min-height: 100vh;
            display: flex; align-items: center; justify-content: center;
            padding: 16px;
        }

        /* TV frame */
        .tv-frame {
            width: 100%; max-width: 1280px;
            aspect-ratio: 16/9;
            background: #0D1526;
            border-radius: 8px; overflow: hidden;
            display: flex; flex-direction: column;
            box-shadow: 0 0 0 6px #1E293B, 0 0 0 9px #060B14, 0 24px 64px rgba(0,0,0,0.9);
        }

        /* Topbar */
        .topbar {
            background: #131F35; height: 80px; min-height: 80px; flex-shrink: 0;
            display: flex; align-items: center; padding: 0 28px;
            border-bottom: 1px solid #1E2D45;
        }
        .topbar-logo { font-size: 20px; font-weight: 800; color: #E2E8F0; }
        .topbar-logo span { color: #00AEEF; }
        .topbar-spacer { flex: 1; }
        .topbar-label { font-size: 11px; color: #475569; margin-right: 16px; }
        .clock { font-size: 18px; font-weight: 700; color: #CBD5E1; margin-right: 16px; }
        .btn-logout {
            background: none; border: 1px solid #2D3F5A;
            color: #64748B; font-size: 12px; font-family: inherit;
            padding: 6px 14px; border-radius: 6px; cursor: pointer;
        }
        .btn-logout:hover { background: #1E2D45; color: #94A3B8; }

        /* Body */
        .body { flex: 1; display: flex; overflow: hidden; }

        /* Sidebar */
        .sidebar {
            width: 160px; min-width: 160px; background: #111827;
            border-right: 1px solid #1E2D45; overflow-y: auto; flex-shrink: 0;
        }
        .sidebar::-webkit-scrollbar { width: 3px; }
        .sidebar::-webkit-scrollbar-thumb { background: #2D3F5A; }

        .sidebar-item { display: flex; align-items: stretch; cursor: pointer; transition: background 0.15s; }
        .sidebar-item:hover { background: #1A2A42; }
        .sidebar-item.selected { background: #172342; }

        .sidebar-accent { width: 3px; min-width: 3px; background: transparent; transition: background 0.15s; }
        .sidebar-item.selected .sidebar-accent { background: #00AEEF; }

        .sidebar-content { flex: 1; display: flex; align-items: center; gap: 8px; padding: 9px 12px 9px 13px; }
        .dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
        .dot-live { background: #DC2626; }
        .dot-offline { background: #334155; }

        .sidebar-text { flex: 1; min-width: 0; }
        .sidebar-name { font-size: 11px; font-weight: 700; color: #CBD5E1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .sidebar-desc { font-size: 9px; color: #475569; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .sidebar-badge { font-size: 8px; font-weight: 600; padding: 2px 5px; border-radius: 3px; flex-shrink: 0; }
        .badge-vivo { color: #F87171; background: #3B1111; }
        .badge-offline { color: #475569; background: #1E293B; }

        /* Main */
        .main-content { flex: 1; overflow-y: auto; padding: 16px; }
        .main-content::-webkit-scrollbar { width: 4px; }
        .main-content::-webkit-scrollbar-thumb { background: #2D3F5A; border-radius: 2px; }

        .section-label { font-size: 9px; letter-spacing: 0.12em; color: #475569; margin-bottom: 8px; font-weight: 500; }

        .cards-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(148px, 1fr)); }

        /* Channel card */
        .card {
            background: #131F35; border-radius: 8px; margin: 6px; overflow: visible;
            box-shadow: 0 2px 8px rgba(0,0,0,0.4);
            transition: transform 0.15s, box-shadow 0.15s;
            position: relative;
        }
        .card:hover { transform: scale(1.04); box-shadow: 0 6px 24px rgba(0,0,0,0.6); z-index: 2; }

        .card-thumb {
            height: 90px; position: relative;
            display: flex; align-items: center; justify-content: center;
            border-radius: 8px 8px 0 0; overflow: hidden;
        }
        .card-thumb-text { display: flex; flex-direction: column; align-items: center; padding: 8px; text-align: center; }
        .card-name-big { font-size: 18px; font-weight: 700; color: #FFFFFF; letter-spacing: 0.02em; line-height: 1.1; }
        .card-desc-small { font-size: 10px; color: rgba(255,255,255,0.75); margin-top: 2px; }
        .badge-live {
            position: absolute; top: 6px; right: 6px;
            background: #DC2626; color: white;
            font-size: 7px; font-weight: 600; padding: 2px 5px; border-radius: 3px;
        }

        /* Hover overlay with actions */
        .card-overlay {
            position: absolute; inset: 0; border-radius: 8px 8px 0 0;
            background: rgba(0,0,0,0.72);
            display: flex; gap: 8px; align-items: center; justify-content: center;
            opacity: 0; transition: opacity 0.2s;
        }
        .card:hover .card-overlay { opacity: 1; }

        .overlay-btn {
            border: none; border-radius: 6px;
            font-size: 11px; font-weight: 600; font-family: inherit;
            padding: 6px 10px; cursor: pointer; transition: transform 0.1s;
        }
        .overlay-btn:hover { transform: scale(1.06); }
        .btn-edit { background: #E2E8F0; color: #1E293B; }
        .btn-delete { background: #DC2626; color: #FFFFFF; }

        .card-info { padding: 8px; }
        .card-title { font-size: 12px; font-weight: 700; color: #CBD5E1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .card-subtitle { font-size: 9px; color: #475569; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }
        .card-meta { display: flex; align-items: center; justify-content: space-between; margin-top: 5px; }
        .source-badge { font-size: 8px; padding: 2px 5px; border-radius: 3px; font-weight: 600; }
        .source-badge.twitch { background: #2D1F4E; color: #A78BFA; }
        .source-badge.youtube { background: #3B1111; color: #F87171; }
        .status-pill { font-size: 8px; padding: 2px 5px; border-radius: 3px; font-weight: 600; }
        .status-active { background: #052E16; color: #4ADE80; }
        .status-inactive { background: #1E293B; color: #475569; }

        /* Ghost card */
        .card-ghost {
            background: transparent; border: 2px dashed #2D3F5A;
            box-shadow: none; cursor: pointer;
            display: flex; align-items: center; justify-content: center;
            min-height: 140px; opacity: 0.5;
            transition: opacity 0.2s, transform 0.15s, border-color 0.2s;
        }
        .card-ghost:hover { opacity: 1; border-color: #00AEEF; transform: scale(1.04); box-shadow: none; }
        .card-ghost:hover .ghost-plus { color: #00AEEF; }
        .ghost-inner { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 20px; }
        .ghost-plus { font-size: 28px; color: #2D3F5A; line-height: 1; transition: color 0.2s; }
        .ghost-label { font-size: 10px; color: #475569; font-weight: 500; }

        /* Bottombar */
        .bottombar {
            background: #131F35; height: 38px; min-height: 38px; flex-shrink: 0;
            display: flex; align-items: center; padding: 0 24px;
            border-top: 1px solid #1E2D45;
        }
        .hint { flex: 1; font-size: 11px; color: #334155; white-space: nowrap; }
        .bottombar-brand { font-size: 9px; color: #334155; }

        /* Modal */
        .modal-overlay {
            display: none; position: fixed; inset: 0;
            background: rgba(0,0,0,0.7); z-index: 100;
            align-items: center; justify-content: center;
        }
        .modal-overlay.open { display: flex; }
        .modal {
            background: #131F35; border-radius: 12px; padding: 28px;
            width: 100%; max-width: 480px;
            box-shadow: 0 8px 40px rgba(0,0,0,0.6);
            border: 1px solid #1E2D45;
        }
        .modal h3 { font-size: 16px; margin-bottom: 20px; color: #E2E8F0; }
        .field { margin-bottom: 14px; }
        .field label { display: block; font-size: 12px; color: #64748B; font-weight: 500; margin-bottom: 5px; }
        .field input, .field select {
            width: 100%; padding: 9px 12px;
            background: #0D1526; border: 1px solid #2D3F5A; border-radius: 8px;
            font-size: 13px; outline: none; font-family: inherit; color: #CBD5E1;
        }
        .field input:focus, .field select:focus { border-color: #00AEEF; }
        .field select option { background: #0D1526; }
        .field-inline { display: flex; align-items: center; gap: 10px; }
        .field-inline input[type=checkbox] { width: auto; accent-color: #00AEEF; }
        .modal-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px; }
        .btn-cancel { background: #1E2D45; color: #64748B; border: none; padding: 9px 18px; border-radius: 8px; font-size: 13px; cursor: pointer; font-family: inherit; }
        .btn-cancel:hover { background: #243552; }
        .btn-primary { background: #0EA5E9; color: white; border: none; padding: 9px 18px; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; font-family: inherit; }
        .btn-primary:hover { background: #0284C7; }

        /* Color picker */
        .color-swatches { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
        .swatch {
            width: 26px; height: 26px; border-radius: 50%; cursor: pointer;
            border: 2px solid transparent;
            transition: transform 0.1s, border-color 0.1s;
        }
        .swatch:hover { transform: scale(1.18); }
        .swatch.active { border-color: #FFFFFF; box-shadow: 0 0 0 2px #00AEEF; }
        .color-custom-row { display: flex; align-items: center; gap: 8px; }
        .color-custom-row input { flex: 1; }
        .color-preview-box {
            width: 32px; height: 32px; border-radius: 6px; flex-shrink: 0;
            border: 1px solid #2D3F5A;
        }
    </style>
</head>
<body>
    <div class="tv-frame">

        <header class="topbar">
            <div class="topbar-logo">Conexion <span>7400</span></div>
            <div class="topbar-spacer"></div>
            <span class="topbar-label">Panel de administración</span>
            <div class="clock" id="clock">00:00</div>
            <form method="POST" action="/admin/logout" style="margin-left:16px">
                <button class="btn-logout" type="submit">Cerrar sesión</button>
            </form>
        </header>

        <div class="body">
            <nav class="sidebar">
                ${sidebarItems}
            </nav>

            <main class="main-content">
                <div class="section-label">CANALES (${channels.length})</div>
                <div class="cards-grid">
                    ${cards}
                    <div class="card card-ghost" onclick="openNew()" style="margin:6px">
                        <div class="ghost-inner">
                            <span class="ghost-plus">+</span>
                            <span class="ghost-label">Nuevo canal</span>
                        </div>
                    </div>
                </div>
            </main>
        </div>

        <footer class="bottombar">
            <span class="hint">Hover sobre una card → Editar / Eliminar</span>
            <span class="hint"></span>
            <span class="hint"></span>
            <span class="bottombar-brand">Conexion 7400 Multimedios</span>
        </footer>
    </div>

    <div class="modal-overlay" id="overlay">
        <div class="modal">
            <h3 id="modal-title">Nuevo canal</h3>
            <form method="POST" id="modal-form">
                <div class="field">
                    <label>Nombre *</label>
                    <input type="text" name="name" id="f-name" required placeholder="LU32 FM" />
                </div>
                <div class="field">
                    <label>Descripción</label>
                    <input type="text" name="description" id="f-description" placeholder="Radio Olavarría" />
                </div>
                <div class="field">
                    <label>Usuario de Twitch</label>
                    <input type="text" name="twitch_username" id="f-twitch_username" placeholder="radioolavarria" />
                </div>
                <div class="field">
                    <label>YouTube Channel ID <span style="color:#94A3B8;font-weight:400">(si fuente es YouTube)</span></label>
                    <input type="text" name="stream_url" id="f-stream_url" placeholder="UCba3hpU7EFBSk817y9qZkiA" />
                </div>
                <div class="field">
                    <label>Fuente</label>
                    <select name="source_type" id="f-source_type">
                        <option value="TWITCH">Twitch</option>
                        <option value="YOUTUBE">YouTube</option>
                    </select>
                </div>
                <div class="field">
                    <label>Color de card</label>
                    <div class="color-swatches" id="color-swatches"></div>
                    <div class="color-custom-row">
                        <input type="text" name="color" id="f-color" placeholder="#2E3192" oninput="onColorInput(this.value)" />
                        <div class="color-preview-box" id="color-preview"></div>
                    </div>
                </div>
                <div class="field field-inline">
                    <input type="checkbox" name="active" id="f-active" checked />
                    <label for="f-active">Canal activo</label>
                </div>
                <div class="modal-actions">
                    <button type="button" class="btn-cancel" onclick="closeModal()">Cancelar</button>
                    <button type="submit" class="btn-primary">Guardar</button>
                </div>
            </form>
        </div>
    </div>

    <script>
        function tick() {
            const now = new Date();
            document.getElementById('clock').textContent =
                String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0');
        }
        tick(); setInterval(tick, 10000);

        document.querySelectorAll('.sidebar-item').forEach(item => {
            item.addEventListener('click', function() {
                document.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('selected'));
                this.classList.add('selected');
            });
        });

        const PALETTE = [
            '#2E3192','#1E40AF','#2563EB','#0EA5E9',
            '#0891B2','#0D9488','#059669','#16A34A',
            '#7C3AED','#9333EA','#C026D3','#DB2777',
            '#DC2626','#EA580C','#D97706','#CA8A04',
            '#475569','#334155','#1E293B','#0F172A',
        ];

        function buildSwatches(selectedColor) {
            const container = document.getElementById('color-swatches');
            container.innerHTML = PALETTE.map(c => {
                const active = c.toLowerCase() === (selectedColor || '').toLowerCase() ? ' active' : '';
                return \`<div class="swatch\${active}" style="background:\${c}" title="\${c}" onclick="selectColor('\${c}')"></div>\`;
            }).join('');
        }

        function selectColor(color) {
            document.getElementById('f-color').value = color;
            document.getElementById('color-preview').style.background = color;
            buildSwatches(color);
        }

        function onColorInput(val) {
            document.getElementById('color-preview').style.background = val;
            buildSwatches(val);
        }

        function openNew() {
            document.getElementById('modal-title').textContent = 'Nuevo canal';
            document.getElementById('modal-form').action = '/admin/channels';
            document.getElementById('f-name').value = '';
            document.getElementById('f-description').value = '';
            document.getElementById('f-twitch_username').value = '';
            document.getElementById('f-stream_url').value = '';
            document.getElementById('f-source_type').value = 'TWITCH';
            document.getElementById('f-active').checked = true;
            selectColor('#2E3192');
            document.getElementById('overlay').classList.add('open');
        }

        function openEditFromData(btn) {
            const c = JSON.parse(btn.dataset.channel);
            document.getElementById('modal-title').textContent = 'Editar canal';
            document.getElementById('modal-form').action = '/admin/channels/' + c.id + '/edit';
            document.getElementById('f-name').value = c.name || '';
            document.getElementById('f-description').value = c.description || '';
            document.getElementById('f-twitch_username').value = c.twitch_username || '';
            document.getElementById('f-stream_url').value = c.stream_url || '';
            document.getElementById('f-source_type').value = c.source_type || 'TWITCH';
            document.getElementById('f-active').checked = c.active;
            selectColor(c.color || '#2E3192');
            document.getElementById('overlay').classList.add('open');
        }

        function closeModal() { document.getElementById('overlay').classList.remove('open'); }

        function deleteChannel(id, name) {
            if (!confirm('¿Eliminar ' + name + '?')) return;
            const f = document.createElement('form');
            f.method = 'POST';
            f.action = '/admin/channels/' + id + '/delete';
            document.body.appendChild(f);
            f.submit();
        }

        document.getElementById('overlay').addEventListener('click', function(e) {
            if (e.target === this) closeModal();
        });
    </script>
</body>
</html>`;
}

function esc(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ─── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
});

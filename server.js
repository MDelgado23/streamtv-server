const express = require('express');
const session = require('express-session');
const twitch = require('twitch-m3u8');
const { createClient } = require('@supabase/supabase-js');
const ytDlp = require('yt-dlp-exec');

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

const app = express();
const PORT = process.env.PORT || 3000;

// Supabase
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

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
    const { data, error } = await supabase
        .from('channels')
        .select('*')
        .eq('active', true)
        .order('name');

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// Twitch: GET /stream?channel=radioolavarria
app.get('/stream', async (req, res) => {
    const channel = req.query.channel;
    if (!channel) {
        return res.status(400).json({ error: 'Falta el parámetro channel' });
    }

    try {
        const streams = await twitch.getStream(channel);
        const best = streams.find(s => s.quality.includes('source')) || streams[0];
        if (!best) return res.status(404).json({ error: 'No hay streams disponibles' });
        res.json({ url: best.url });
    } catch (error) {
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

        // 2. Extraer URL HLS via yt-dlp
        console.log(`[yt-dlp] Extrayendo URL para videoId: ${videoId}`);
        const result = await ytDlp(`https://www.youtube.com/watch?v=${videoId}`, {
            getUrl: true,
            format: 'best[protocol=m3u8_native]/best',
            noCheckCertificates: true,
            noWarnings: true,
            preferFreeFormats: true,
        });

        const hlsUrl = typeof result === 'string' ? result.trim() : null;
        console.log(`[yt-dlp] URL obtenida: ${hlsUrl ? hlsUrl.substring(0, 80) + '...' : 'null'}`);

        if (!hlsUrl) {
            return res.status(503).json({ error: 'No se pudo obtener la URL HLS del stream' });
        }

        res.json({ url: hlsUrl });
    } catch (error) {
        console.error('[YouTube] Error:', error.message, '— channel:', channelId);
        res.status(500).json({ error: 'Error obteniendo stream de YouTube', detail: error.message });
    }
});

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
    res.redirect('/admin');
});

app.post('/admin/channels/:id/delete', requireAuth, async (req, res) => {
    const { error } = await supabase.from('channels').delete().eq('id', req.params.id);
    if (error) return res.status(500).send(`Error: ${error.message}`);
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
    const rows = channels.map(c => `
        <tr>
            <td>
                <span class="dot" style="background:${c.color}"></span>
                ${c.name}
            </td>
            <td>${c.description || '—'}</td>
            <td>${c.twitch_username || '—'}</td>
            <td><span class="badge ${c.source_type.toLowerCase()}">${c.source_type}</span></td>
            <td><span class="badge ${c.active ? 'active' : 'inactive'}">${c.active ? 'Activo' : 'Inactivo'}</span></td>
            <td class="actions">
                <button class="btn-edit" onclick="openEdit(${JSON.stringify(c).replace(/"/g, '&quot;')})">Editar</button>
                <form method="POST" action="/admin/channels/${c.id}/delete" style="display:inline" onsubmit="return confirm('¿Eliminar ${c.name}?')">
                    <button class="btn-delete" type="submit">Eliminar</button>
                </form>
            </td>
        </tr>`).join('');

    return `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>7400TV Admin</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #F5F7FA; color: #1E293B; }
        header { background: white; padding: 16px 32px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #E8ECF2; }
        h1 { font-size: 18px; } h1 span { color: #00AEEF; }
        .sub { font-size: 11px; color: #94A3B8; }
        .logout { font-size: 12px; color: #94A3B8; cursor: pointer; background: none; border: none; }
        main { padding: 32px; max-width: 1100px; margin: 0 auto; }
        .toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
        .toolbar h2 { font-size: 15px; }
        .btn-primary { background: #1E2D4A; color: white; border: none; padding: 9px 18px; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; }
        .btn-primary:hover { background: #2a3d63; }
        table { width: 100%; background: white; border-radius: 12px; border-collapse: collapse; box-shadow: 0 1px 4px rgba(0,0,0,0.06); }
        th { text-align: left; padding: 12px 16px; font-size: 11px; color: #94A3B8; letter-spacing: 0.08em; border-bottom: 1px solid #F0F2F5; }
        td { padding: 12px 16px; font-size: 13px; border-bottom: 1px solid #F8F9FA; vertical-align: middle; }
        tr:last-child td { border-bottom: none; }
        .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 8px; vertical-align: middle; }
        .badge { font-size: 10px; padding: 3px 8px; border-radius: 4px; font-weight: 600; }
        .badge.twitch { background: #F3EEFF; color: #6441a5; }
        .badge.youtube { background: #FFF0F0; color: #FF0000; }
        .badge.active { background: #F0FDF4; color: #16A34A; }
        .badge.inactive { background: #F8F9FA; color: #94A3B8; }
        .actions { display: flex; gap: 8px; }
        .btn-edit { background: #F0F4FF; color: #1E2D4A; border: none; padding: 5px 12px; border-radius: 6px; font-size: 12px; cursor: pointer; }
        .btn-delete { background: #FEF2F2; color: #DC2626; border: none; padding: 5px 12px; border-radius: 6px; font-size: 12px; cursor: pointer; }
        /* Modal */
        .overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 10; align-items: center; justify-content: center; }
        .overlay.open { display: flex; }
        .modal { background: white; border-radius: 12px; padding: 28px; width: 100%; max-width: 480px; }
        .modal h3 { font-size: 16px; margin-bottom: 20px; }
        .field { margin-bottom: 14px; }
        .field label { display: block; font-size: 12px; color: #64748B; font-weight: 500; margin-bottom: 5px; }
        .field input, .field select { width: 100%; padding: 9px 12px; border: 1px solid #E2E8F0; border-radius: 8px; font-size: 13px; outline: none; }
        .field input:focus, .field select:focus { border-color: #00AEEF; }
        .field.inline { display: flex; align-items: center; gap: 10px; }
        .field.inline label { margin: 0; }
        .modal-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px; }
        .btn-cancel { background: #F5F7FA; color: #64748B; border: none; padding: 9px 18px; border-radius: 8px; font-size: 13px; cursor: pointer; }
        .color-preview { width: 32px; height: 32px; border-radius: 6px; border: 1px solid #E2E8F0; flex-shrink: 0; }
    </style>
</head>
<body>
    <header>
        <div>
            <h1>Conexion <span>7400</span></h1>
            <p class="sub">Panel de administración</p>
        </div>
        <form method="POST" action="/admin/logout">
            <button class="logout" type="submit">Cerrar sesión</button>
        </form>
    </header>

    <main>
        <div class="toolbar">
            <h2>Canales (${channels.length})</h2>
            <button class="btn-primary" onclick="openNew()">+ Nuevo canal</button>
        </div>

        <table>
            <thead>
                <tr>
                    <th>NOMBRE</th>
                    <th>DESCRIPCIÓN</th>
                    <th>TWITCH USER</th>
                    <th>FUENTE</th>
                    <th>ESTADO</th>
                    <th>ACCIONES</th>
                </tr>
            </thead>
            <tbody>
                ${rows.length ? rows : '<tr><td colspan="6" style="text-align:center;color:#94A3B8;padding:32px">Sin canales todavía</td></tr>'}
            </tbody>
        </table>
    </main>

    <!-- Modal nuevo/editar -->
    <div class="overlay" id="overlay">
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
                <div class="field" style="display:flex;gap:10px;align-items:flex-end">
                    <div style="flex:1">
                        <label>Color de card</label>
                        <input type="text" name="color" id="f-color" placeholder="#2E3192" oninput="updatePreview(this.value)" />
                    </div>
                    <div class="color-preview" id="color-preview"></div>
                </div>
                <div class="field inline">
                    <input type="checkbox" name="active" id="f-active" checked style="width:auto" />
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
        function openNew() {
            document.getElementById('modal-title').textContent = 'Nuevo canal';
            document.getElementById('modal-form').action = '/admin/channels';
            document.getElementById('f-name').value = '';
            document.getElementById('f-description').value = '';
            document.getElementById('f-twitch_username').value = '';
            document.getElementById('f-stream_url').value = '';
            document.getElementById('f-source_type').value = 'TWITCH';
            document.getElementById('f-color').value = '#2E3192';
            document.getElementById('f-active').checked = true;
            updatePreview('#2E3192');
            document.getElementById('overlay').classList.add('open');
        }

        function openEdit(c) {
            document.getElementById('modal-title').textContent = 'Editar canal';
            document.getElementById('modal-form').action = '/admin/channels/' + c.id + '/edit';
            document.getElementById('f-name').value = c.name || '';
            document.getElementById('f-description').value = c.description || '';
            document.getElementById('f-twitch_username').value = c.twitch_username || '';
            document.getElementById('f-stream_url').value = c.stream_url || '';
            document.getElementById('f-source_type').value = c.source_type || 'TWITCH';
            document.getElementById('f-color').value = c.color || '#2E3192';
            document.getElementById('f-active').checked = c.active;
            updatePreview(c.color || '#2E3192');
            document.getElementById('overlay').classList.add('open');
        }

        function closeModal() {
            document.getElementById('overlay').classList.remove('open');
        }

        function updatePreview(val) {
            document.getElementById('color-preview').style.background = val;
        }

        document.getElementById('overlay').addEventListener('click', function(e) {
            if (e.target === this) closeModal();
        });
    </script>
</body>
</html>`;
}

// ─── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
});

const express = require('express');
const twitch = require('twitch-m3u8');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/stream', async (req, res) => {
    const channel = req.query.channel;
    if (!channel) {
        return res.status(400).json({ error: 'Falta el parámetro channel' });
    }

    try {
        const streams = await twitch.getStream(channel);

        // Preferimos source, sino el primero disponible
        const best = streams.find(s => s.quality.includes('source')) || streams[0];

        if (!best) {
            return res.status(404).json({ error: 'No hay streams disponibles para este canal' });
        }

        res.json({ url: best.url });
    } catch (error) {
        res.status(500).json({ error: 'No se pudo obtener el stream', detail: error.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
});

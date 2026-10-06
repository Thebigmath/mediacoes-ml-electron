const express = require('express');
const path = require('path');

const app = express();
let httpServer = null;

app.use(express.json({ limit: '1mb' }));

// Seguranca do servidor local (06/10/2026): so as telas do proprio Harvey podem usar.
// - Host: so 127.0.0.1/localhost na porta do app (bloqueia "DNS rebinding" de sites maliciosos)
// - pedidos que ALTERAM algo (POST/PUT/DELETE): recusados se vierem de outro site (Origin
//   diferente ou Sec-Fetch-Site cross-site). Sem isso, uma pagina aberta no PC podia, por exemplo,
//   desconectar uma conta do ML ou disparar analises da IA.
app.use((req, res, next) => {
    const host = String(req.headers.host || '').toLowerCase();
    const porta = httpServer && httpServer.address() ? String(httpServer.address().port) : null;
    const m = host.match(/^(127\.0\.0\.1|localhost)(?::(\d+))?$/);
    if (!m || (porta && m[2] && m[2] !== porta)) return res.status(403).send('Acesso negado.');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        const site = req.headers['sec-fetch-site'];
        if (site && !['same-origin', 'none'].includes(site)) return res.status(403).json({ erro: 'Pedido de outro site bloqueado.' });
        const origin = req.headers.origin;
        if (origin) {
            let ok = false;
            try { ok = new URL(origin).host.toLowerCase() === host; } catch {}
            if (!ok) return res.status(403).json({ erro: 'Pedido de outro site bloqueado.' });
        }
    }
    next();
});
app.use('/api', require('./routes/api'));
app.use(express.static(path.join(__dirname, 'public'), { etag: true, lastModified: true, maxAge: 0 }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));

function start(porta, pronto) {
    const log = require('./lib/log');
    log.iniciar();
    log.info('app', 'APP_INICIO', `Harvey v${require('./package.json').version} na porta ${porta}`);
    httpServer = app.listen(porta, '127.0.0.1', pronto);
    return httpServer;
}
function stop() { if (httpServer) httpServer.close(); }

module.exports = { start, stop };

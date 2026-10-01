const express = require('express');
const path = require('path');

const app = express();
let httpServer = null;

app.use(express.json({ limit: '1mb' }));
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

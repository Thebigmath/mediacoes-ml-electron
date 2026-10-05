// Harvey (app de Mediações do ML) — processo principal do Electron (mesmo molde do Dashboard, app separado).
// Sobe o servidor local na porta 3005, abre a janela, fica na bandeja, avisa mediação nova
// por notificação do Windows e se atualiza sozinho pelo GitHub (Thebigmath/mediacoes-ml-electron).
const { app, BrowserWindow, ipcMain, shell, Notification, Tray, Menu, nativeImage, screen } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');

const PORTA = 3005;
const URL = `http://localhost:${PORTA}`;
let mainWindow = null, painel = null, tray = null, encerrando = false;

if (!app.requestSingleInstanceLock()) app.quit();
else app.on('second-instance', () => mostrarJanela());

const SEGUNDO_PLANO = process.argv.includes('--segundo-plano');
const storagePath = path.join(app.getPath('userData'), 'storage');
fs.mkdirSync(storagePath, { recursive: true });
process.env.STORAGE_PATH = storagePath;
app.setAppUserModelId('com.thebigmath.mediacoes-ml');

const server = require('./server');
const monitor = require('./lib/monitor');
const perguntas = require('./lib/perguntas');

function mostrarJanela() {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show(); mainWindow.focus();
}

perguntas.usarNotificador((titulo, corpo) => {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title: titulo, body: corpo });
    n.on('click', () => { mostrarJanela(); mainWindow?.webContents.send('abrir-aba', 'perguntas'); });
    n.show();
    try { mostrarPainel(); } catch {}   // pergunta nova tambem abre o painel lateral
});
require('./lib/contas').usarAvisoDesconectada((conta, nome) => {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title: `Harvey: a conta ${nome} desconectou do Mercado Livre`, body: 'As mediações e perguntas desta conta pararam de atualizar. Clique para conectar de novo (Configurações).' });
    n.on('click', () => { mostrarJanela(); mainWindow?.webContents.send('abrir-aba', 'config'); });
    n.show();
});
monitor.usarNotificador((titulo, corpo) => {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title: titulo, body: corpo });
    n.on('click', () => mostrarJanela());
    n.show();
});

// ---- painel lateral: lista das mediacoes no canto direito da tela ----
// Aparece depois da primeira busca do dia (se houver mediacao esperando resposta) e sempre que
// chega mediacao nova. O X esconde; volta pela bandeja ou na proxima mediacao nova.
let primeiraBusca = true;
function criarPainel() {
    const area = screen.getPrimaryDisplay().workArea;
    const largura = 340, altura = Math.min(620, Math.round(area.height * 0.7));
    painel = new BrowserWindow({
        width: largura, height: altura, x: area.x + area.width - largura - 12, y: area.y + area.height - altura - 12,
        frame: false, resizable: true, minimizable: false, maximizable: false, alwaysOnTop: true, skipTaskbar: true, show: false,
        title: 'Harvey — mediações', backgroundColor: '#111318',
        webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') },
    });
    painel.loadURL(URL + '/painel.html');
    painel.on('close', (e) => { if (!encerrando) { e.preventDefault(); painel.hide(); } });
}
function mostrarPainel() {
    if (!painel || painel.isDestroyed()) criarPainel();
    painel.webContents.send('recarregar');
    painel.showInactive();   // aparece sem roubar o foco do que a pessoa esta fazendo
}
monitor.usarAoTerminar(({ novas, respostas }) => {
    const esperando = require('./lib/banco').listar().filter(m => ['pendente', 'auditando'].includes(m.status)).length;
    if (painel && !painel.isDestroyed()) painel.webContents.send('recarregar');
    if ((primeiraBusca && esperando) || novas || respostas) mostrarPainel();
    primeiraBusca = false;
});
ipcMain.on('abrir-mediacao', (_, id) => {
    mostrarJanela();
    if (id) mainWindow?.webContents.send('abrir-mediacao', String(id));
});
ipcMain.on('fechar-painel', () => painel?.hide());
ipcMain.on('abrir-aba-pedida', (_, aba) => { mostrarJanela(); if (aba) mainWindow?.webContents.send('abrir-aba', String(aba)); });

// ---- atualizacao automatica ----
// Saida do console fechada (app aberto por um terminal que depois fechou) gerava "write EPIPE" e uma
// janela de erro na verificacao de atualizacao. O log da atualizacao vai para o log do Harvey, nao
// para o console, e erro de escrita no console e ignorado.
for (const s of [process.stdout, process.stderr]) { try { s && s.on('error', () => {}); } catch {} }
process.on('uncaughtException', (e) => {
    if (e && e.code === 'EPIPE') return;
    try { require('./lib/log').erro('app', 'ERRO_INESPERADO', e && e.message || String(e)); } catch {}
    try { require('electron').dialog.showErrorBox('Harvey: erro inesperado', (e && e.stack) || String(e)); } catch {}   // outros erros continuam aparecendo
});
autoUpdater.logger = {
    info: () => {}, debug: () => {},
    warn: (m) => { try { require('./lib/log').aviso('update', 'UPDATE_AVISO', String(m).slice(0, 300)); } catch {} },
    error: (m) => { try { require('./lib/log').erro('update', 'UPDATE_ERRO', String(m).slice(0, 300)); } catch {} },
};
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
let updateReady = false;
autoUpdater.on('update-available', (info) => mainWindow?.webContents.send('update-available', info.version));
autoUpdater.on('update-downloaded', (info) => {
    updateReady = true;
    require('./lib/log').info('update', 'UPDATE', `Versão ${(info && info.version) || ''} baixada, pronta para instalar`);
    mainWindow?.webContents.send('update-downloaded', info && info.version);
    if (Notification.isSupported()) {
        const n = new Notification({ title: `Harvey: atualização ${(info && info.version) || ''} pronta`, body: 'Clique para instalar agora (o app reinicia).' });
        n.on('click', () => { encerrando = true; autoUpdater.quitAndInstall(); });
        n.show();
    }
});
autoUpdater.on('error', () => {});
let ultimaVerificacao = 0;
function verificarUpdate(minMs = 0) {
    if (!app.isPackaged || Date.now() - ultimaVerificacao < minMs) return;
    ultimaVerificacao = Date.now();
    autoUpdater.checkForUpdates().catch(() => {});
}
setInterval(() => verificarUpdate(), 30 * 60 * 1000);
ipcMain.on('install-update', () => { encerrando = true; autoUpdater.quitAndInstall(); });
ipcMain.on('open-external', (_, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });

app.whenReady().then(() => {
    server.start(PORTA, () => {
        mainWindow = new BrowserWindow({
            width: 1400, height: 900, show: false, title: 'Harvey',
            icon: path.join(__dirname, 'public/assets/icon.png'),
            webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') },
        });
        mainWindow.setMenuBarVisibility(false);
        mainWindow.loadURL(URL);
        mainWindow.once('ready-to-show', () => { if (!SEGUNDO_PLANO) mainWindow.show(); setTimeout(() => verificarUpdate(), 5000); });
        mainWindow.on('show', () => verificarUpdate(5 * 60 * 1000));
        mainWindow.webContents.on('did-finish-load', () => { if (updateReady) mainWindow.webContents.send('update-downloaded'); });
        let avisou = false;
        mainWindow.on('close', (e) => {
            if (encerrando) return;
            e.preventDefault(); mainWindow.hide();
            if (!avisou && tray) { avisou = true; tray.displayBalloon({ title: 'Harvey continua rodando', content: 'O monitor de mediações segue ativo na bandeja.', iconType: 'info' }); }
        });
        criarBandeja();
        criarPainel();
        if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: true, args: ['--segundo-plano'] });
        monitor.iniciarAgendador();
        perguntas.iniciar();
    });
});

function criarBandeja() {
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'public/assets/tray.png')));
    tray.setToolTip('Harvey — monitor de mediações ativo');
    tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'Abrir Harvey', click: () => mostrarJanela() },
        { label: 'Mostrar painel de mediações', click: () => mostrarPainel() },
        { label: 'Atualizar mediações agora', click: () => { monitor.sincronizar().catch(() => {}); mostrarPainel(); } },
        { type: 'separator' },
        { label: 'Verificar atualização do app', click: () => { verificarUpdate(); mostrarJanela(); } },
        { label: 'Sair', click: () => { encerrando = true; monitor.pararAgendador(); perguntas.parar(); server.stop(); app.quit(); } },
    ]));
    tray.on('double-click', () => mostrarJanela());
}

app.on('window-all-closed', () => { if (encerrando) { server.stop(); app.quit(); } });
app.on('before-quit', () => { encerrando = true; });

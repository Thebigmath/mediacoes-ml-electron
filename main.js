// Mediações ML — processo principal do Electron (mesmo molde do Dashboard, app separado).
// Sobe o servidor local na porta 3005, abre a janela, fica na bandeja, avisa mediação nova
// por notificação do Windows e se atualiza sozinho pelo GitHub (Thebigmath/mediacoes-ml-electron).
const { app, BrowserWindow, ipcMain, shell, Notification, Tray, Menu, nativeImage } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');

const PORTA = 3005;
const URL = `http://localhost:${PORTA}`;
let mainWindow = null, tray = null, encerrando = false;

if (!app.requestSingleInstanceLock()) app.quit();
else app.on('second-instance', () => mostrarJanela());

const SEGUNDO_PLANO = process.argv.includes('--segundo-plano');
const storagePath = path.join(app.getPath('userData'), 'storage');
fs.mkdirSync(storagePath, { recursive: true });
process.env.STORAGE_PATH = storagePath;
app.setAppUserModelId('com.thebigmath.mediacoes-ml');

const server = require('./server');
const monitor = require('./lib/monitor');

function mostrarJanela() {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show(); mainWindow.focus();
}

monitor.usarNotificador((titulo, corpo) => {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title: titulo, body: corpo });
    n.on('click', () => mostrarJanela());
    n.show();
});

// ---- atualizacao automatica ----
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
let updateReady = false;
autoUpdater.on('update-available', (info) => mainWindow?.webContents.send('update-available', info.version));
autoUpdater.on('update-downloaded', (info) => {
    updateReady = true;
    mainWindow?.webContents.send('update-downloaded', info && info.version);
    if (Notification.isSupported()) {
        const n = new Notification({ title: `Mediações ML: atualização ${(info && info.version) || ''} pronta`, body: 'Clique para instalar agora (o app reinicia).' });
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
            width: 1400, height: 900, show: false, title: 'Mediações ML',
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
            if (!avisou && tray) { avisou = true; tray.displayBalloon({ title: 'Mediações ML continua rodando', content: 'O monitor de mediações segue ativo na bandeja.', iconType: 'info' }); }
        });
        criarBandeja();
        if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: true, args: ['--segundo-plano'] });
        monitor.iniciarAgendador();
    });
});

function criarBandeja() {
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'public/assets/tray.png')));
    tray.setToolTip('Mediações ML — monitor ativo');
    tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'Abrir Mediações ML', click: () => mostrarJanela() },
        { label: 'Atualizar mediações agora', click: () => { monitor.sincronizar().catch(() => {}); mostrarJanela(); } },
        { type: 'separator' },
        { label: 'Verificar atualização do app', click: () => { verificarUpdate(); mostrarJanela(); } },
        { label: 'Sair', click: () => { encerrando = true; monitor.pararAgendador(); server.stop(); app.quit(); } },
    ]));
    tray.on('double-click', () => mostrarJanela());
}

app.on('window-all-closed', () => { if (encerrando) { server.stop(); app.quit(); } });
app.on('before-quit', () => { encerrando = true; });

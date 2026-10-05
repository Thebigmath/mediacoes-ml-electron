const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    onUpdateAvailable: (cb) => ipcRenderer.on('update-available', (_, v) => cb(v)),
    onUpdateDownloaded: (cb) => ipcRenderer.on('update-downloaded', (_, v) => cb(v)),
    installUpdate: () => ipcRenderer.send('install-update'),
    openExternal: (url) => ipcRenderer.send('open-external', url),
    abrirMediacao: (id) => ipcRenderer.send('abrir-mediacao', id),
    abrirAba: (aba) => ipcRenderer.send('abrir-aba-pedida', aba),
    abrirRelatorio: (arquivo) => ipcRenderer.send('abrir-relatorio', arquivo),
    fecharPainel: () => ipcRenderer.send('fechar-painel'),
    onRecarregar: (cb) => ipcRenderer.on('recarregar', () => cb()),
    onAbrirMediacao: (cb) => ipcRenderer.on('abrir-mediacao', (_, id) => cb(id)),
    onAbrirAba: (cb) => ipcRenderer.on('abrir-aba', (_, aba) => cb(aba)),
});

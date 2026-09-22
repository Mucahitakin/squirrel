// Squirrel — Electron ana süreç (sağlamlaştırılmış).
// Her hata görünür bir iletişim kutusuna ve squirrel.log dosyasına yazılır;
// port doluysa 4590-4599 arasında boş port bulunur ya da açık Squirrel'e bağlanılır.
import { app, BrowserWindow, shell, Menu, dialog, screen, nativeImage, ipcMain } from 'electron';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const TOOL_DIR = path.resolve(APP_DIR, '..');
const LOG_FILE = path.join(TOOL_DIR, 'squirrel.log');

function log(...parts) {
  try { fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${parts.join(' ')}\n`); } catch { /* yut */ }
}
function fatal(error) {
  const text = String(error?.stack || error);
  log('FATAL', text);
  try { dialog.showErrorBox('Squirrel açılamadı', text.slice(0, 1500)); } catch { /* GUI yoksa */ }
  app.exit(1);
}
process.on('uncaughtException', fatal);
process.on('unhandledRejection', (reason) => { log('REJECTION', String(reason?.stack || reason)); });

// Tek kopya: ikinci kez açılırsa mevcut pencereye odaklan.
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

// Bir portu yokla: 'free' | 'squirrel' | 'other'
function probe(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/config', timeout: 900 }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body).repo_root !== undefined ? 'squirrel' : 'other'); }
        catch { resolve('other'); }
      });
    });
    req.on('error', () => resolve('free'));
    req.on('timeout', () => { req.destroy(); resolve('other'); });
  });
}

function waitForServer(port, retries = 80) {
  return new Promise((resolve, reject) => {
    const attempt = (left) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/config', timeout: 1000 }, (res) => { res.resume(); resolve(); });
      req.on('error', () => (left <= 0 ? reject(new Error(`sunucu ${port} portunda açılmadı`)) : setTimeout(() => attempt(left - 1), 250)));
      req.on('timeout', () => { req.destroy(); });
    };
    attempt(retries);
  });
}

function createWindow(port) {
  const wa = screen.getPrimaryDisplay().workAreaSize;
  const win = new BrowserWindow({
    width: Math.min(1500, wa.width - 24), height: Math.min(940, wa.height - 24),
    minWidth: 960, minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 14 },
    backgroundColor: '#0a0c10',
    title: 'Squirrel',
    show: false,
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      preload: path.join(APP_DIR, 'preload.cjs'),
    },
  });
  win.once('ready-to-show', () => win.show());
  win.loadURL(`http://localhost:${port}`);
  win.webContents.on('did-fail-load', (_e, code, description) => {
    log('did-fail-load', code, description);
    setTimeout(() => win.loadURL(`http://localhost:${port}`), 600);
  });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  return win;
}

// ---- otomatik güncelleme (GitHub Releases üzerinden) ----
// Windows: yeni sürüm arka planda iner, kullanıcı onayıyla ya da çıkışta kurulur.
// macOS: imzasız uygulamada sessiz kurulum yapılamaz (Apple kısıtı) —
// bildirim gösterilir ve indirme sayfası açılır; imzalama eklenince
// bu dal da tam otomatik kuruluma çevrilebilir.
async function setupAutoUpdate(win) {
  if (!app.isPackaged) return;
  let autoUpdater;
  try {
    const mod = await import('electron-updater');
    autoUpdater = mod.autoUpdater || mod.default?.autoUpdater;
  } catch (error) { log('güncelleyici yüklenemedi:', error.message); return; }
  if (!autoUpdater) return;
  autoUpdater.on('error', (error) => log('güncelleme hatası:', String(error?.message || error)));
  if (process.platform === 'darwin') {
    autoUpdater.autoDownload = false;
    autoUpdater.on('update-available', async (info) => {
      const { response } = await dialog.showMessageBox(win, {
        type: 'info', buttons: ['İndirme sayfasını aç', 'Daha sonra'], defaultId: 0, cancelId: 1,
        message: `Yeni sürüm hazır: Squirrel ${info.version}`,
        detail: 'Yeni sürümü indirip mevcut uygulamanın üzerine sürükleyerek güncelleyebilirsin.',
      });
      if (response === 0) shell.openExternal('https://github.com/Mucahitakin/squirrel/releases/latest');
    });
  } else {
    autoUpdater.on('update-downloaded', async (info) => {
      const { response } = await dialog.showMessageBox(win, {
        type: 'info', buttons: ['Şimdi yeniden başlat', 'Çıkışta kur'], defaultId: 0, cancelId: 1,
        message: `Güncelleme indirildi: Squirrel ${info.version}`,
        detail: 'Yeni sürüm, uygulama yeniden başlatıldığında kurulur.',
      });
      if (response === 0) autoUpdater.quitAndInstall();
    });
  }
  try { await autoUpdater.checkForUpdates(); } catch { /* ağ yok / release yok */ }
  setInterval(() => { autoUpdater.checkForUpdates().catch(() => {}); }, 4 * 60 * 60 * 1000);
}

// Klasör seçme (Ayarlar > Repo klasörü ve Canlı Test > Harness).
ipcMain.handle('squirrel:pick-folder', async (event, title) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, {
    title: title || 'Klasör seç',
    buttonLabel: 'Seç',
    properties: ['openDirectory'],
  });
  return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
});

app.whenReady().then(async () => {
  try {
    log('--- Squirrel başlıyor', app.getVersion(), 'electron', process.versions.electron);
    try {
      const iconFile = path.join(APP_DIR, 'assets', 'squirrel.png');
      if (process.platform === 'darwin' && fs.existsSync(iconFile) && app.dock) {
        app.dock.setIcon(nativeImage.createFromPath(iconFile));
      }
    } catch (error) { log('dock ikonu ayarlanamadı:', error.message); }
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Squirrel', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit', label: 'Çıkış' }] },
      { label: 'Düzen', submenu: [{ role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: 'Görünüm', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { role: 'togglefullscreen' }] },
    ]));

    // Port seçimi: boş port bul ya da zaten açık Squirrel'e bağlan.
    let chosen = null; let reuse = false;
    for (let port = 4590; port <= 4599; port += 1) {
      const stateOfPort = await probe(port);               // eslint-disable-line no-await-in-loop
      if (stateOfPort === 'squirrel') { chosen = port; reuse = true; break; }
      if (stateOfPort === 'free') { chosen = port; break; }
      log(`port ${port} başka bir servis tarafından dolu, sıradakine geçiliyor`);
    }
    if (chosen == null) throw new Error('4590-4599 arasında boş port bulunamadı.');

    if (!reuse) {
      process.env.MMX_TEST_TOOL_PORT = String(chosen);
      process.env.MMX_TEST_TOOL_NO_OPEN = '1';
      // Paketli uygulama ayar/veriyi OS'in userData klasöründe tutar
      // (Windows'ta Program Files, macOS'ta .app içi yazılabilir değildir).
      if (app.isPackaged && !process.env.SQUIRREL_DATA_DIR) {
        process.env.SQUIRREL_DATA_DIR = app.getPath('userData');
      }
      log('sunucu başlatılıyor, port', chosen, 'veri:', process.env.SQUIRREL_DATA_DIR || TOOL_DIR);
      await import('./server.mjs');
      await waitForServer(chosen);
    } else {
      log('açık Squirrel sunucusu bulundu, port', chosen);
    }
    const win = createWindow(chosen);
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(chosen); });
    log('pencere açıldı');
    setupAutoUpdate(win).catch((error) => log('güncelleyici hatası:', error.message));
  } catch (error) { fatal(error); }
});

app.on('window-all-closed', () => app.quit());

// Squirrel — masaüstü köprüsü (Electron preload, sandbox'lı).
// Sayfaya yalnızca dar bir API açılır: yerel klasör/dosya seçme ve kaydetme
// pencereleri. Tarayıcı/sunucu kipinde bu dosya yüklenmez; arayüz elle yol
// girişine düşer.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('squirrelDesktop', {
  pickFolder: (title) => ipcRenderer.invoke('squirrel:pick-folder', String(title || '')),
  pickFile: (title, kind) => ipcRenderer.invoke('squirrel:pick-file', String(title || ''), String(kind || '')),
  saveFile: (title, defaultName) => ipcRenderer.invoke('squirrel:save-file', String(title || ''), String(defaultName || '')),
});

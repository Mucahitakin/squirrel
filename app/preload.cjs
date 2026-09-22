// Squirrel — masaüstü köprüsü (Electron preload, sandbox'lı).
// Sayfaya yalnızca dar bir API açılır: yerel klasör seçme penceresi.
// Tarayıcı/sunucu kipinde bu dosya yüklenmez; arayüz elle yol girişine düşer.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('squirrelDesktop', {
  pickFolder: (title) => ipcRenderer.invoke('squirrel:pick-folder', String(title || '')),
});

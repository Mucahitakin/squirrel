#!/usr/bin/env node
/**
 * Squirrel — LangSmith tarzı yerel test/izleme uygulaması (sunucu girişi).
 *
 * marketing_mix reposunun DIŞINDA yaşar; repoya asla yazmaz, yalnızca okur ve
 * mevcut harness'ı (run-chat-suite.mjs) child process olarak çalıştırır.
 *
 * Kod düzeni (app/lib):
 *   env.mjs      — yollar, .env, gizli anahtar, yapılandırma önbelleği
 *   projects.mjs — projeler ve HMAC imzalı API anahtarları
 *   records.mjs  — jsonl okuma + lite/detay kayıt biçimleri
 *   datasets.mjs — dataset CRUD
 *   archive.mjs  — koşu arşivi + deney karşılaştırma (imza önbellekli)
 *   monitor.mjs  — monitoring toplulaştırması (imza önbellekli)
 *   sse.mjs      — canlı yayın kanalı (ping'li)
 *   runs.mjs     — harness ve generic koşu motorları
 *   routes.mjs   — HTTP yönlendirici (global hata yakalama + statik servis)
 * Arayüz app/ui altında: index.html + styles.css + app.js
 */
import http from 'node:http';
import fs from 'node:fs';
import { PORT, HOST, REPO_ROOT, HARNESS } from './lib/env.mjs';
import { handleRequest } from './lib/routes.mjs';

const server = http.createServer(handleRequest);

// İki kullanım şekli:
//  - Masaüstü: pencereyi Electron açar (npm start); bu sunucu arkada çalışır.
//  - Sunucu/headless: `node app/server.mjs` (SQUIRREL_HOST/PORT/DATA_DIR ile).
server.listen(PORT, HOST, () => {
  console.log(`Squirrel sunucusu hazır: http://${HOST}:${PORT}`);
  console.log(`Repo: ${REPO_ROOT} (${fs.existsSync(HARNESS) ? 'ok' : 'harness yok — bağımsız kip'})`);
  if (HOST !== '127.0.0.1') {
    console.log('UYARI: sunucu dış ağa açık ve arayüzde oturum koruması yok — erişimi VPN ya da reverse proxy (TLS + auth) ile sınırla.');
  }
});

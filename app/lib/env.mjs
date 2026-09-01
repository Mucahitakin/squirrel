// Squirrel — ortam, yol ve yapılandırma sabitleri.
// Tüm modüller yolları ve gizli anahtarları buradan alır; disk okumaları
// mtime imzasıyla önbelleklenir ki her HTTP isteği dosya sistemine inmesin.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TOOL_DIR = path.resolve(APP_DIR, '..');
export const UI_DIR = path.join(APP_DIR, 'ui');
export const ASSETS_DIR = path.join(APP_DIR, 'assets');

// Yazılabilir veri kökü. Paketli uygulamada Electron ana süreci bunu
// işletim sisteminin userData klasörüne ayarlar (Windows'ta Program Files
// salt-okunurdur; macOS'ta da .app içine yazmak doğru değildir).
// Geliştirmede (repo'dan çalıştırma) eskisi gibi proje klasörü kullanılır.
export const DATA_ROOT = process.env.SQUIRREL_DATA_DIR
  ? (fs.mkdirSync(process.env.SQUIRREL_DATA_DIR, { recursive: true }), process.env.SQUIRREL_DATA_DIR)
  : TOOL_DIR;
export const CONFIG_FILE = path.join(DATA_ROOT, 'config.json');
export const DESKTOP_OUT = path.join(os.homedir(), 'Desktop', 'test-sonuclari');
export const PORT = Number(process.env.SQUIRREL_PORT || process.env.MMX_TEST_TOOL_PORT || 4590);
// Varsayılan: yalnız yerel makine. Sunucu/Docker kurulumunda SQUIRREL_HOST=0.0.0.0
// verilir — o durumda erişimi VPN ya da reverse proxy (TLS + auth) ile sınırla.
export const HOST = process.env.SQUIRREL_HOST || '127.0.0.1';

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// ---------- .env (gizli değerler; yazılabilir veri kökünde) ----------
const ENV_FILE = path.join(DATA_ROOT, '.env');
function loadEnvFile() {
  try {
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/u);
      if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
    }
  } catch { /* .env yok */ }
}
loadEnvFile();
// İmza gizli anahtarı: .env'de yoksa üretilir ve .env'e yazılır.
if (!process.env.SQUIRREL_SECRET) {
  process.env.SQUIRREL_SECRET = crypto.randomBytes(32).toString('hex');
  try { fs.appendFileSync(ENV_FILE, `\nSQUIRREL_SECRET=${process.env.SQUIRREL_SECRET}\n`); } catch { /* yut */ }
}
export const SECRET = process.env.SQUIRREL_SECRET;

// ---------- başlangıç yapılandırması ----------
// repo_root gibi değerler açılışta okunur; değişiklik yeniden başlatma ister.
const bootConfig = readJson(CONFIG_FILE, {}) || {};
// Eski (opak) master anahtar geriye dönük uyum için korunur.
if (!bootConfig.api_key) {
  bootConfig.api_key = `sq_${crypto.randomBytes(18).toString('hex')}`;
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(bootConfig, null, 2)); } catch { /* salt-okunur olabilir */ }
}
export const API_KEY = bootConfig.api_key;

export const REPO_ROOT = bootConfig.repo_root
  ? String(bootConfig.repo_root).replace('~', os.homedir())
  : path.join(os.homedir(), 'Desktop', 'marketing_mix');
export const HARNESS = path.join(REPO_ROOT, 'scripts', 'e2e-chat-harness', 'run-chat-suite.mjs');

// Squirrel tek bir projeye bağlı değildir: repo (harness) yapılandırılmışsa
// dataset/çıktı oradan okunur-yazılır; yoksa uygulamanın kendi data/ klasörü
// kullanılır ve uygulama tamamen bağımsız çalışır.
export const DATA_DIR = path.join(DATA_ROOT, 'data');
const repoDatasets = path.join(REPO_ROOT, 'scripts', 'e2e-chat-harness', 'datasets');
export const DATASETS_DIR = fs.existsSync(repoDatasets) ? repoDatasets : path.join(DATA_DIR, 'datasets');
export const OUTPUT_DIR = fs.existsSync(REPO_ROOT)
  ? path.join(REPO_ROOT, 'output', 'e2e-chat')
  : path.join(DATA_DIR, 'output');

// ---------- canlı yapılandırma (mtime önbellekli) ----------
// live_ingest gibi anında geçerli ayarlar buradan okunur; dosya değişmediyse
// disk yerine önbellek döner.
let cfgCache = { sig: null, data: bootConfig };
export function liveConfig() {
  try {
    const stat = fs.statSync(CONFIG_FILE);
    const sig = `${stat.size}:${stat.mtimeMs}`;
    if (cfgCache.sig !== sig) cfgCache = { sig, data: readJson(CONFIG_FILE, {}) || {} };
  } catch { cfgCache = { sig: null, data: {} }; }
  return cfgCache.data;
}

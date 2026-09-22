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
const bootConfig = readJson(CONFIG_FILE, {}) || {};
// Eski (opak) master anahtar geriye dönük uyum için korunur.
if (!bootConfig.api_key) {
  bootConfig.api_key = `sq_${crypto.randomBytes(18).toString('hex')}`;
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(bootConfig, null, 2)); } catch { /* salt-okunur olabilir */ }
}
export const API_KEY = bootConfig.api_key;

// Squirrel tek bir projeye bağlı değildir. Kullanıcı herhangi bir PROJE
// KLASÖRÜ seçebilir; Squirrel orada dataset'leri ve (varsa) projenin kendi
// test betiğini (harness) bulur. Hiçbir klasör seçilmezse uygulama kendi
// data/ klasörüyle tamamen bağımsız çalışır.
export const DATA_DIR = path.join(DATA_ROOT, 'data');

// Tanınan yerleşimler. İlk sıradaki, e2e-chat-harness düzenini kullanan
// projeler (ör. marketing_mix) içindir; geri kalanı genel kurallardır.
const LEGACY_HARNESS = path.join('scripts', 'e2e-chat-harness', 'run-chat-suite.mjs');
const HARNESS_CANDIDATES = [
  LEGACY_HARNESS,
  'squirrel.harness.mjs', 'squirrel.harness.js', 'squirrel.harness.py', 'squirrel.harness.sh',
  path.join('.squirrel', 'harness.mjs'), path.join('.squirrel', 'harness.js'),
  path.join('.squirrel', 'harness.py'), path.join('.squirrel', 'harness.sh'),
];
const DATASET_CANDIDATES = [
  path.join('scripts', 'e2e-chat-harness', 'datasets'),
  'datasets',
  path.join('.squirrel', 'datasets'),
];
export const DATASET_FILES = ['messages.json', 'conversation_dataset.json', 'messages.txt'];

function expandHome(raw) {
  const value = String(raw || '').trim();
  return value.startsWith('~') ? path.join(os.homedir(), value.slice(1)) : value;
}
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

// Klasörün kendisi dataset'leri barındırıyor mu (alt klasörlerinde mesaj dosyası)?
function holdsDatasets(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).some((entry) => entry.isDirectory()
      && DATASET_FILES.some((name) => isFile(path.join(dir, entry.name, name))));
  } catch { return false; }
}

// Seçilen klasörü proje köküne çözer. Her mevcut klasör kabul edilir; yalnız
// bilinen bir düzenin alt klasörü seçildiyse (ör. scripts/) köke çıkılır.
export function findProjectRoot(raw) {
  const picked = path.resolve(expandHome(raw));
  if (!isDir(picked)) return null;
  let dir = picked;
  for (let depth = 0; depth < 4; depth += 1) {
    if (isFile(path.join(dir, LEGACY_HARNESS))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return picked;
}

// Proje yolları canlı (ESM live binding): setProject çağrılınca bu değerleri
// import eden tüm modüller yeniden başlatma gerekmeden yeni yolu görür.
export let REPO_ROOT = '';
export let HARNESS = '';
export let HARNESS_KIND = ''; // 'e2e-chat' (marketing_mix düzeni) | 'custom' | ''
export let DATASETS_DIR = '';
export let OUTPUT_DIR = '';

function resolveScript(root, script) {
  if (!script) return '';
  const abs = path.isAbsolute(expandHome(script)) ? expandHome(script) : path.join(root || '', script);
  return isFile(abs) ? path.resolve(abs) : '';
}

export function setProject(rawRoot, scriptOverride = '') {
  REPO_ROOT = rawRoot && isDir(path.resolve(expandHome(rawRoot))) ? path.resolve(expandHome(rawRoot)) : '';
  HARNESS = resolveScript(REPO_ROOT, scriptOverride)
    || (REPO_ROOT ? (HARNESS_CANDIDATES.map((rel) => path.join(REPO_ROOT, rel)).find(isFile) || '') : '');
  HARNESS_KIND = !HARNESS ? '' : (HARNESS.endsWith(LEGACY_HARNESS) ? 'e2e-chat' : 'custom');
  const repoDatasets = REPO_ROOT
    ? (DATASET_CANDIDATES.map((rel) => path.join(REPO_ROOT, rel)).find(isDir)
      || (holdsDatasets(REPO_ROOT) ? REPO_ROOT : ''))
    : '';
  DATASETS_DIR = repoDatasets || path.join(DATA_DIR, 'datasets');
  // e2e-chat düzeni kendi çıktısını repo/output/e2e-chat'e yazar; geçmiş koşular
  // da orada durur. Diğer tüm projelerin koşuları Squirrel'in kendi verisinde
  // tutulur — kullanıcının reposuna yazılmaz.
  const legacyOut = REPO_ROOT ? path.join(REPO_ROOT, 'output', 'e2e-chat') : '';
  OUTPUT_DIR = legacyOut && (HARNESS_KIND === 'e2e-chat' || isDir(legacyOut)) ? legacyOut : path.join(DATA_DIR, 'output');
  return describeProject();
}

export function describeProject() {
  return {
    repo_root: REPO_ROOT,
    repo_ok: Boolean(REPO_ROOT),
    harness: HARNESS,
    harness_kind: HARNESS_KIND,
    datasets_dir: DATASETS_DIR,
    datasets_in_project: Boolean(REPO_ROOT) && DATASETS_DIR.startsWith(REPO_ROOT),
  };
}
export function harnessOk() { return Boolean(HARNESS) && isFile(HARNESS); }

// Açılış: kullanıcının seçtiği proje. Hiç seçilmediyse bağımsız kipte açılır;
// Squirrel hiçbir projeyi (klasör adına bakarak) kendiliğinden bağlamaz.
setProject(bootConfig.repo_root || '', bootConfig.harness_script || '');

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

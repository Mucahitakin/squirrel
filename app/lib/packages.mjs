// Squirrel — taşınabilir proje paketleri.
// Bir projenin test betiği ve dataset'leri, klasör düzeni korunarak tek bir
// .zip'e paketlenir; başka bir makinede içe aktarılınca Squirrel'in kendi
// veri klasörüne açılır ve orijinal repo olmadan çalışır. Paketler yalnız
// kullanıcının makineleri arasında taşınır — hiçbir yere yüklenmez.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { REPO_ROOT, HARNESS, DATASETS_DIR, DATA_DIR, harnessOk } from './env.mjs';

const run = promisify(execFile);
export const MANIFEST = 'squirrel-project.json';
const PROJECTS_DIR = path.join(DATA_DIR, 'projects');
const SKIP = new Set(['node_modules', '.git', 'output', '.DS_Store', '__pycache__']);

function safeName(raw) {
  return String(raw || 'proje').toLowerCase().replace(/[^a-z0-9-_]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 60) || 'proje';
}
function inside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

async function zipDir(parentDir, name, dest) {
  if (process.platform === 'darwin') {
    await run('ditto', ['-c', '-k', '--norsrc', '--noextattr', '--keepParent', path.join(parentDir, name), dest]);
  } else {
    // Windows 10+ ve Linux'ta yerleşik bsdtar/tar; -a uzantıdan zip biçimini seçer.
    await run('tar', ['-a', '-c', '-f', dest, '-C', parentDir, name]);
  }
}
async function unzip(file, destDir) {
  if (process.platform === 'darwin') await run('ditto', ['-x', '-k', file, destDir]);
  else await run('tar', ['-x', '-f', file, '-C', destDir]);
}

// Etkin projenin betiğini ve dataset'lerini paketler.
export async function exportProject(destRaw = '') {
  if (!REPO_ROOT || !harnessOk()) throw new Error('Paketlemek için önce test betiği olan bir proje seç.');
  const name = safeName(path.basename(REPO_ROOT));
  const harnessDir = path.dirname(HARNESS);
  const parts = new Set();
  // Betik bir alt klasördeyse klasörün tamamı (yan dosyalarıyla), kökteyse yalnız dosya.
  parts.add(path.relative(REPO_ROOT, harnessDir === REPO_ROOT ? HARNESS : harnessDir));
  if (inside(REPO_ROOT, DATASETS_DIR) && DATASETS_DIR !== REPO_ROOT && !inside(harnessDir === REPO_ROOT ? HARNESS : harnessDir, DATASETS_DIR)) {
    parts.add(path.relative(REPO_ROOT, DATASETS_DIR));
  }

  const stage = tmpDir('squirrel-export');
  try {
    const root = path.join(stage, name);
    for (const rel of parts) {
      fs.cpSync(path.join(REPO_ROOT, rel), path.join(root, rel), {
        recursive: true,
        filter: (src) => !SKIP.has(path.basename(src)),
      });
    }
    fs.writeFileSync(path.join(root, MANIFEST), JSON.stringify({
      name,
      harness: path.relative(REPO_ROOT, HARNESS).split(path.sep).join('/'),
      created_at: new Date().toISOString(),
      format: 1,
    }, null, 2));
    const dest = destRaw || path.join(os.homedir(), 'Desktop', `${name}.squirrel.zip`);
    fs.rmSync(dest, { force: true });
    await zipDir(stage, name, dest);
    return { file: dest, size: fs.statSync(dest).size, name };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

function findManifestRoot(dir, depth = 0) {
  if (fs.existsSync(path.join(dir, MANIFEST))) return dir;
  if (depth > 2) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.name.startsWith('__MACOSX')) {
      const found = findManifestRoot(path.join(dir, entry.name), depth + 1);
      if (found) return found;
    }
  }
  return null;
}

// Paketi Squirrel'in veri klasörüne açar; kök yolunu ve betiği döndürür.
// Aynı ad yeniden içe aktarılırsa betik/dataset'ler güncellenir, geçmiş
// koşular (output/) korunur.
export async function importProject(file) {
  if (!file || !fs.existsSync(file) || !/\.zip$/iu.test(file)) throw new Error('Geçerli bir .zip proje paketi seç.');
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
  const incoming = path.join(PROJECTS_DIR, `.incoming-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(incoming);
  try {
    await unzip(file, incoming);
    const root = findManifestRoot(incoming);
    if (!root) throw new Error(`Bu dosya bir Squirrel proje paketi değil (${MANIFEST} yok).`);
    let manifest = {};
    try { manifest = JSON.parse(fs.readFileSync(path.join(root, MANIFEST), 'utf8')); } catch { /* ad klasörden */ }
    const name = safeName(manifest.name || path.basename(root));
    const dest = path.join(PROJECTS_DIR, name);
    if (!inside(PROJECTS_DIR, dest)) throw new Error('Geçersiz paket adı.');
    if (fs.existsSync(dest)) {
      const oldOut = path.join(dest, 'output');
      if (fs.existsSync(oldOut)) fs.renameSync(oldOut, path.join(root, 'output'));
      fs.rmSync(dest, { recursive: true, force: true });
    }
    fs.renameSync(root, dest);
    const harness = manifest.harness ? path.join(dest, ...String(manifest.harness).split('/')) : '';
    return { root: dest, harness: harness && fs.existsSync(harness) ? harness : '' };
  } finally {
    fs.rmSync(incoming, { recursive: true, force: true });
  }
}

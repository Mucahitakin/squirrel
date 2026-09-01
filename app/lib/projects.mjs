// Squirrel — projeler ve HMAC imzalı API anahtarları.
// Anahtar biçimi: sq1.<proje>.<keyId>.<imza24hex>
// İmza SQUIRREL_SECRET ile doğrulanır (JWT mantığı); key_id eşleşmesi
// yenileme (rotate) sonrası eski anahtarın anında düşmesini sağlar.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_ROOT, SECRET, API_KEY, readJson } from './env.mjs';

const PROJECTS_FILE = path.join(DATA_ROOT, 'projects.json');

export function signKey(project, keyId) {
  const sig = crypto.createHmac('sha256', SECRET).update(`${project}.${keyId}`).digest('hex').slice(0, 24);
  return `sq1.${project}.${keyId}.${sig}`;
}

export function parseSignedKey(key) {
  const parts = String(key || '').split('.');
  if (parts.length !== 4 || parts[0] !== 'sq1') return null;
  const [, project, keyId, sig] = parts;
  const expected = crypto.createHmac('sha256', SECRET).update(`${project}.${keyId}`).digest('hex').slice(0, 24);
  if (!crypto.timingSafeEqual(Buffer.from(sig.padEnd(24, '0')), Buffer.from(expected))) return null;
  return { project, keyId };
}

export function loadProjects() {
  let list = readJson(PROJECTS_FILE, null);
  if (!Array.isArray(list)) list = [];
  if (!list.some((project) => project.name === 'default')) {
    list.unshift({ name: 'default', description: 'Harness koşuları', api_key: API_KEY, created_at: new Date().toISOString() });
    saveProjects(list);
  }
  return list;
}

export function saveProjects(list) {
  try { fs.writeFileSync(PROJECTS_FILE, JSON.stringify(list, null, 2)); } catch { /* yut */ }
}

export function createProject(name, description) {
  const safe = String(name || '').trim().toLowerCase().replace(/[^a-z0-9-_]+/gu, '-').slice(0, 40);
  if (!/^[a-z0-9]/u.test(safe)) throw new Error('Geçersiz proje adı.');
  const list = loadProjects();
  if (list.some((project) => project.name === safe)) throw new Error(`'${safe}' zaten var.`);
  const keyId = crypto.randomBytes(6).toString('hex');
  const project = {
    name: safe, description: String(description || ''),
    key_id: keyId,
    api_key: signKey(safe, keyId),
    created_at: new Date().toISOString(),
  };
  list.push(project); saveProjects(list);
  return project;
}

export function projectByKey(key) {
  const parsed = parseSignedKey(key);
  if (parsed) {
    const project = loadProjects().find((entry) => entry.name === parsed.project);
    // key_id eşleşmesi = iptal/yenileme kontrolü (rotate sonrası eski anahtar düşer)
    if (project && project.key_id === parsed.keyId) return project;
    return null;
  }
  // geriye dönük uyum: eski düz anahtarlar depo eşitliğiyle doğrulanır
  return loadProjects().find((project) => project.api_key === key) || null;
}

export function deleteProject(name) {
  const safe = String(name || '').trim();
  if (safe === 'default') throw new Error("'default' projesi silinemez.");
  const list = loadProjects();
  const project = list.find((entry) => entry.name === safe);
  if (!project) throw new Error('Proje bulunamadı.');
  saveProjects(list.filter((entry) => entry.name !== safe));
  return project;
}

export function rotateProjectKey(name) {
  const list = loadProjects();
  const project = list.find((entry) => entry.name === name);
  if (!project) throw new Error('Proje bulunamadı.');
  project.key_id = crypto.randomBytes(6).toString('hex');
  project.api_key = signKey(project.name, project.key_id);
  saveProjects(list);
  return project;
}

export function projectOfRun(runId) {
  const set = String(runId).split('/')[0];
  if (set.startsWith('sdk-')) return set.slice(4);
  if (set.startsWith('gen-')) return set.slice(4);
  return 'default';
}

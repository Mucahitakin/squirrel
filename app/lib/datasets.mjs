// Squirrel — dataset okuma/yazma (repo'daki harness dataset klasörleri).
// Yalnızca DATASETS_DIR altına yazar; yol korumaları her silme/yazmada doğrulanır.
import fs from 'node:fs';
import path from 'node:path';
import { DATASETS_DIR, readJson } from './env.mjs';

function datasetMessagesFile(dir) {
  for (const name of ['messages.json', 'conversation_dataset.json', 'messages.txt']) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

export function listDatasets() {
  if (!fs.existsSync(DATASETS_DIR)) return [];
  return fs.readdirSync(DATASETS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = path.join(DATASETS_DIR, entry.name);
      const cfg = readJson(path.join(dir, 'dataset.json'), {});
      const file = datasetMessagesFile(dir);
      let count = 0; let attachments = 0;
      if (file && file.endsWith('.json')) {
        const items = readJson(file, []);
        if (Array.isArray(items)) {
          count = items.length;
          attachments = items.filter((item) => (item.attachments || []).length).length;
        }
      }
      return { name: entry.name, description: cfg.description || '', count, attachments };
    });
}

export function datasetItems(name) {
  const file = datasetMessagesFile(path.join(DATASETS_DIR, name));
  if (!file || !file.endsWith('.json')) return [];
  const raw = readJson(file, []);
  if (!Array.isArray(raw)) return [];
  return raw.map((item, position) => ({
    index: item.id ?? position + 1,
    category: item.category || null,
    thread: item.conversation_thread_id || null,
    prompt: String(item.prompt ?? item.text ?? ''),
    attachments: (item.attachments || []).map((attachment) => attachment.name),
  }));
}

// ---------- yazma ----------
function datasetFileFor(name) {
  const safe = String(name || '').trim();
  if (!/^[a-z0-9][a-z0-9-_]{1,40}$/iu.test(safe)) throw new Error('Geçersiz set adı (harf/rakam/tire).');
  return { dir: path.join(DATASETS_DIR, safe), safe };
}

export function createDataset(name, description, items = []) {
  const { dir, safe } = datasetFileFor(name);
  if (fs.existsSync(dir)) throw new Error(`'${safe}' zaten var.`);
  const rows = (Array.isArray(items) ? items : []).map((entry, position) => {
    const prompt = String(entry.prompt || '').trim();
    if (!prompt) throw new Error(`Madde ${position + 1}: mesaj metni boş.`);
    const dep = entry.dep != null && entry.dep !== '' ? Number(entry.dep) : null;
    return {
      id: position + 1,
      conversation_thread_id: String(entry.thread || `thread_${position + 1}`).trim(),
      context_dependency: dep != null && dep >= 1 && dep <= position ? dep : null,
      category: String(entry.category || 'Genel').trim(),
      prompt,
      attachments: [],
    };
  });
  fs.mkdirSync(path.join(dir, 'attachments'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'dataset.json'), JSON.stringify({
    description: String(description || ''), locale: 'tr', timeout_seconds: 600,
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'conversation_dataset.json'), JSON.stringify(rows, null, 2));
  return { name: safe, count: rows.length };
}

function readItemsRaw(name) {
  const { dir } = datasetFileFor(name);
  const file = path.join(dir, 'conversation_dataset.json');
  if (!fs.existsSync(file)) throw new Error('Set messages dosyası JSON değil veya yok.');
  const raw = readJson(file, null);
  if (!Array.isArray(raw)) throw new Error('conversation_dataset.json bir liste değil.');
  return { file, raw };
}

function renumber(raw) {
  const map = new Map();
  raw.forEach((item, position) => map.set(item.id, position + 1));
  return raw.map((item, position) => ({
    ...item,
    id: position + 1,
    context_dependency: item.context_dependency != null && map.has(item.context_dependency)
      ? map.get(item.context_dependency) : null,
  }));
}

export function addItem(name, entry) {
  const { file, raw } = readItemsRaw(name);
  const prompt = String(entry.prompt || '').trim();
  if (!prompt) throw new Error('Mesaj metni boş olamaz.');
  const item = {
    id: raw.length + 1,
    conversation_thread_id: String(entry.thread || `thread_x_${raw.length + 1}`).trim(),
    context_dependency: entry.dep ? Number(entry.dep) : null,
    category: String(entry.category || 'Genel').trim(),
    prompt,
    attachments: [],
  };
  if (item.context_dependency != null && (item.context_dependency < 1 || item.context_dependency > raw.length)) {
    throw new Error('Bağlam bağımlılığı mevcut bir madde numarası olmalı.');
  }
  raw.push(item);
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));
  return item;
}

export function deleteItem(name, id) {
  const { file, raw } = readItemsRaw(name);
  const next = renumber(raw.filter((item) => Number(item.id) !== Number(id)));
  if (next.length === raw.length) throw new Error('Madde bulunamadı.');
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
  return next.length;
}

export function deleteDataset(name) {
  const { dir, safe } = datasetFileFor(name);
  if (!fs.existsSync(dir)) throw new Error('Set bulunamadı.');
  if (!path.resolve(dir).startsWith(path.resolve(DATASETS_DIR) + path.sep)) throw new Error('Geçersiz yol.');
  fs.rmSync(dir, { recursive: true, force: true });
  return safe;
}

export function updateItem(name, id, patch) {
  const { file, raw } = readItemsRaw(name);
  const item = raw.find((entry) => Number(entry.id) === Number(id));
  if (!item) throw new Error('Madde bulunamadı.');
  if (patch.prompt !== undefined) {
    const prompt = String(patch.prompt || '').trim();
    if (!prompt) throw new Error('Mesaj metni boş olamaz.');
    item.prompt = prompt;
  }
  if (patch.category !== undefined) item.category = String(patch.category || 'Genel').trim();
  if (patch.thread !== undefined && String(patch.thread).trim()) item.conversation_thread_id = String(patch.thread).trim();
  if (patch.dep !== undefined) {
    const dep = patch.dep === null || patch.dep === '' ? null : Number(patch.dep);
    if (dep != null && (dep < 1 || dep >= Number(id))) throw new Error('Bağımlılık kendinden önceki bir madde olmalı.');
    item.context_dependency = dep;
  }
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));
  return item;
}

export function updateDatasetMeta(name, description) {
  const { dir } = datasetFileFor(name);
  const file = path.join(dir, 'dataset.json');
  const cfg = readJson(file, {}) || {};
  cfg.description = String(description || '');
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
}

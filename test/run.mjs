// Squirrel smoke test koşucusu: mock chat API + Squirrel sunucusunu başlatır,
// e2e-test.mjs'i koşar ve süreçleri kapatır.
//   npm test
// Sunucu tamamen yalıtılmış bir veri klasörü ve sahte ev dizini ile çalışır:
// testler geliştiricinin ayarlarına, projelerine ya da repolarına dokunmaz.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'squirrel-test-'));
const DATA = path.join(SANDBOX, 'data');
const HOME = path.join(SANDBOX, 'home');
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(path.join(HOME, 'Desktop'), { recursive: true });
fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({ repo_root: '' }));

const mock = spawn(process.execPath, [path.join(ROOT, 'test', 'mock-chat.mjs')], { stdio: 'ignore' });
const server = spawn(process.execPath, [path.join(ROOT, 'app', 'server.mjs')], {
  stdio: 'ignore',
  env: { ...process.env, HOME, SQUIRREL_DATA_DIR: DATA, SQUIRREL_PORT: '4591' },
});

await new Promise((resolve) => setTimeout(resolve, 1200));
const test = spawn(process.execPath, [path.join(ROOT, 'test', 'e2e-test.mjs')], {
  stdio: 'inherit',
  env: { ...process.env, SQUIRREL_TEST_SANDBOX: SANDBOX },
});
const code = await new Promise((resolve) => test.on('close', resolve));

mock.kill('SIGTERM');
server.kill('SIGTERM');
fs.rmSync(SANDBOX, { recursive: true, force: true });

process.exit(code ?? 1);

// Squirrel smoke test koşucusu: mock chat API + Squirrel sunucusunu başlatır,
// e2e-test.mjs'i koşar, süreçleri ve test çıktılarını temizler.
//   npm test
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const repoRoot = String(cfg.repo_root || '').replace('~', os.homedir());

const mock = spawn(process.execPath, [path.join(ROOT, 'test', 'mock-chat.mjs')], { stdio: 'ignore' });
const server = spawn(process.execPath, [path.join(ROOT, 'app', 'server.mjs')], {
  stdio: 'ignore',
  env: { ...process.env, MMX_TEST_TOOL_PORT: '4591', MMX_TEST_TOOL_NO_OPEN: '1' },
});

await new Promise((resolve) => setTimeout(resolve, 1200));
const test = spawn(process.execPath, [path.join(ROOT, 'test', 'e2e-test.mjs')], { stdio: 'inherit' });
const code = await new Promise((resolve) => test.on('close', resolve));

mock.kill('SIGTERM');
server.kill('SIGTERM');

// Test koşularının çıktı artıklarını sil (sqtest-* projeleri).
const outputDir = fs.existsSync(repoRoot)
  ? path.join(repoRoot, 'output', 'e2e-chat')
  : path.join(ROOT, 'data', 'output');
for (const name of ['sdk-sqtest-sdk', 'gen-sqtest-gen']) {
  fs.rmSync(path.join(outputDir, name), { recursive: true, force: true });
}
const desktopOut = path.join(os.homedir(), 'Desktop', 'test-sonuclari');
if (fs.existsSync(desktopOut)) {
  for (const name of fs.readdirSync(desktopOut)) {
    if (name.startsWith('sqtest-tmp-')) fs.rmSync(path.join(desktopOut, name), { recursive: true, force: true });
  }
}

process.exit(code ?? 1);

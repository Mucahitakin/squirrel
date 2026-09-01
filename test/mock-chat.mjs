// Sahte chat API — auth tiplerini test etmek için.
import http from 'node:http';

const PORT = 4977;
let issued = 0;
const validTokens = new Set();

function body(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
  });
}
function json(res, code, payload) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

http.createServer(async (req, res) => {
  const b = await body(req);
  if (req.url === '/auth/refresh') {
    if (b.refresh_token !== 'REF-123') return json(res, 401, { error: 'bad refresh token' });
    issued += 1;
    const token = `ACC-${issued}`;
    validTokens.add(token);
    return json(res, 200, { data: { access_token: token } });
  }
  if (req.url === '/chat-key') {
    if (req.headers['x-my-key'] !== 'KEY-42') return json(res, 401, { error: 'bad key' });
    return json(res, 200, { data: { reply: `key-ok: ${b.message}` } });
  }
  if (req.url === '/chat-cookie') {
    if (req.headers.cookie !== '_sid=SID-7') return json(res, 401, { error: 'bad cookie' });
    return json(res, 200, { data: { reply: `cookie-ok: ${b.msg} thread=${b.tid || ''}` } });
  }
  if (req.url === '/chat-refresh') {
    const token = String(req.headers.authorization || '').replace('Bearer ', '');
    // İlk access token tek kullanımlık: 401 dönerek renew akışını tetikler.
    if (!validTokens.has(token)) return json(res, 401, { error: 'expired' });
    if (token === 'ACC-1') validTokens.delete(token);
    return json(res, 200, { data: { reply: `refresh-ok(${token}): ${b.message}` } });
  }
  json(res, 404, { error: 'yok' });
}).listen(PORT, '127.0.0.1', () => console.log(`mock hazır :${PORT}`));

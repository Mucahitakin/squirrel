// Squirrel — SSE yayın kanalı.
// Kopan bağlantılar yazma hatasında düşürülür; 25 sn'de bir yorum satırı
// (ping) gönderilir ki ara katmanlar boştaki bağlantıyı kesmesin.
const clients = new Set();

export function broadcast(type, data) {
  const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(frame); } catch { clients.delete(res); }
  }
}

export function attachStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('event: hello\ndata: {}\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
}

const pingTimer = setInterval(() => {
  for (const res of clients) {
    try { res.write(': ping\n\n'); } catch { clients.delete(res); }
  }
}, 25_000);
pingTimer.unref(); // süreç sadece bu zamanlayıcı için ayakta kalmasın

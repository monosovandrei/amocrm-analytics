const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const root = path.join(__dirname, 'dist');
const port = Number(process.env.PORT || 3000);
const types = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.ico', 'image/x-icon'],
]);

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': status === 200 ? 'public, max-age=3600' : 'no-store',
  });
  res.end(body);
}

http
  .createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const normalized = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    const requested = path.join(root, normalized === '/' ? 'index.html' : normalized);
    const filePath = requested.startsWith(root) && fs.existsSync(requested) ? requested : path.join(root, 'index.html');

    fs.readFile(filePath, (error, data) => {
      if (error) {
        send(res, 404, 'Not found');
        return;
      }
      send(res, 200, data, types.get(path.extname(filePath)) || 'application/octet-stream');
    });
  })
  .listen(port, '0.0.0.0');

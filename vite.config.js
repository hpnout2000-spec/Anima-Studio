import { defineConfig } from 'vite';
import fs from 'fs';
import path from 'path';

function comfygenPersistencePlugin() {
  const middleware = (req, res, next) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    
    if (req.method === 'POST' && url.pathname === '/api/save-settings') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          fs.writeFileSync(path.join(process.cwd(), 'settings.json'), body, 'utf8');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/load-settings') {
      try {
        const filePath = path.join(process.cwd(), 'settings.json');
        if (fs.existsSync(filePath)) {
          const data = fs.readFileSync(filePath, 'utf8');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(data);
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
        }
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/save-tags') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          fs.writeFileSync(path.join(process.cwd(), 'custom_tags.json'), body, 'utf8');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/load-tags') {
      try {
        const filePath = path.join(process.cwd(), 'custom_tags.json');
        if (fs.existsSync(filePath)) {
          const data = fs.readFileSync(filePath, 'utf8');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(data);
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
        }
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    next();
  };

  return {
    name: 'comfygen-persistence',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    }
  };
}

export default defineConfig({
  plugins: [comfygenPersistencePlugin()],
  server: {
    port: 5173,
    host: true,
    strictPort: true,
    watch: {
      ignored: ['**/settings.json', '**/custom_tags.json']
    }
  },
  preview: {
    port: 5173,
    strictPort: true
  }
});

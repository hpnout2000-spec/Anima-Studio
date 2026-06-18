import { defineConfig } from 'vite';
import fs from 'fs';
import path from 'path';
import os from 'os';

function loadGelbooruCredentials() {
  let apiKey = '';
  let userId = '';
  try {
    const filePath = path.join(process.cwd(), 'settings.json');
    if (fs.existsSync(filePath)) {
      const settings = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      apiKey = settings.gelbooru_api_key || '';
      userId = settings.gelbooru_user_id || '';
    }
  } catch (e) {
    console.warn('Failed to load gelbooru credentials from settings.json:', e.message);
  }
  return { apiKey, userId };
}

function comfygenPersistencePlugin() {
  const middleware = (req, res, next) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    
    if (req.method === 'GET' && url.pathname === '/api/gelbooru-extract') {
      const postId = url.searchParams.get('id');
      if (!postId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing post ID' }));
        return;
      }
      
      const { apiKey, userId } = loadGelbooruCredentials();
      
      let apiUrl = `https://gelbooru.com/index.php?page=dapi&s=post&q=index&json=1&id=${postId}`;
      if (apiKey && userId) {
        apiUrl += `&api_key=${apiKey}&user_id=${userId}`;
      }
      
      fetch(apiUrl, {
        headers: {
          'User-Agent': 'VibeChatting/1.0.0 (contact@vibechatting.org)'
        }
      })
        .then(response => {
          if (!response.ok) {
            throw new Error(`Gelbooru returned HTTP ${response.status}`);
          }
          return response.json();
        })
        .then(async data => {
          let post = null;
          if (data && data.post) {
            post = Array.isArray(data.post) ? data.post[0] : data.post;
          } else if (Array.isArray(data) && data.length > 0) {
            post = data[0];
          }
          
          if (!post || !post.tags) {
            throw new Error('Post not found or has no tags');
          }
          
          const tagNames = post.tags.trim().split(/\s+/).filter(Boolean);
          
          let artistTags = new Set();
          if (tagNames.length > 0) {
            try {
              const namesParam = encodeURIComponent(tagNames.join(' '));
              let tagsUrl = `https://gelbooru.com/index.php?page=dapi&s=tag&q=index&json=1&names=${namesParam}`;
              if (apiKey && userId) {
                tagsUrl += `&api_key=${apiKey}&user_id=${userId}`;
              }
              
              const tagsResponse = await fetch(tagsUrl, {
                headers: {
                  'User-Agent': 'VibeChatting/1.0.0 (contact@vibechatting.org)'
                }
              });
              
              if (tagsResponse.ok) {
                const tagsData = await tagsResponse.json();
                const tagsList = Array.isArray(tagsData) ? tagsData : (tagsData && tagsData.tag ? (Array.isArray(tagsData.tag) ? tagsData.tag : [tagsData.tag]) : []);
                tagsList.forEach(t => {
                  if (t && (t.type === '1' || t.type === 1 || String(t.type) === '1')) {
                    artistTags.add(t.name.toLowerCase().trim());
                  }
                });
              }
            } catch (e) {
              console.warn('Failed to resolve Gelbooru tag types:', e.message);
            }
          }
          
          const processedTags = tagNames.map(tag => {
            const cleanTag = tag.trim();
            if (artistTags.has(cleanTag.toLowerCase())) {
              return `@${cleanTag}`;
            }
            return cleanTag;
          });
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            post: post,
            processed_tags: processedTags.join(', ')
          }));
        })
        .catch(err => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        });
      return;
    }
    
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

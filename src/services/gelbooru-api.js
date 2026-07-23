export async function getTagsFromGelbooruUrl(urlStr) {
  let postId;
  try {
    const url = new URL(urlStr);
    postId = url.searchParams.get('id');
    if (!postId) {
      // Fallback for paths like /post/view/12345
      const parts = url.pathname.split('/');
      const viewIdx = parts.indexOf('view');
      if (viewIdx !== -1 && viewIdx + 1 < parts.length) {
         postId = parts[viewIdx + 1];
      }
    }
  } catch (e) {
    throw new Error('Invalid URL format');
  }
  
  if (!postId) throw new Error('Could not extract post ID from URL');
  
  const proxyUrl = `/api/gelbooru-extract?id=${postId}`;
  
  let data = null;
  // 1. Try local dev proxy
  try {
    const response = await fetch(proxyUrl);
    if (response.ok) {
      data = await response.json();
    }
  } catch (err) {
    // Local server proxy unavailable
  }

  // 2. Direct Gelbooru API fallback if local server is not running
  if (!data) {
    const directUrl = `https://gelbooru.com/index.php?page=dapi&s=post&q=index&json=1&id=${postId}`;
    const corsProxies = [
      `https://corsproxy.io/?${encodeURIComponent(directUrl)}`,
      `https://api.allorigins.win/raw?url=${encodeURIComponent(directUrl)}`
    ];

    for (const proxy of corsProxies) {
      try {
        const resp = await fetch(proxy);
        if (resp.ok) {
          data = await resp.json();
          break;
        }
      } catch (e) {
        // continue
      }
    }
  }

  if (!data) throw new Error('Could not fetch Gelbooru post data');

  let post = null;
  if (data && data.post) {
    post = Array.isArray(data.post) ? data.post[0] : data.post;
  } else if (Array.isArray(data) && data.length > 0) {
    post = data[0];
  }
  
  if (!post || !post.tags) {
    throw new Error('Post not found or has no tags');
  }
  
  return data.processed_tags || post.tags;
}

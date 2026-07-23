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
  
  try {
    const response = await fetch(proxyUrl);
    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || `HTTP error! status: ${response.status}`);
    }
    
    const data = await response.json();
    let post = null;
    if (data && data.post) {
      post = Array.isArray(data.post) ? data.post[0] : data.post;
    } else if (Array.isArray(data) && data.length > 0) {
      post = data[0];
    }
    
    if (!post || !post.tags) {
      throw new Error('Post not found or has no tags');
    }
    
    // Return processed comma-separated tags, fallback to space-separated if not present
    return data.processed_tags || post.tags;
  } catch (err) {
    // If CORS or other fetch error, we might try a proxy fallback if needed
    console.error('Gelbooru fetch error:', err);
    throw err;
  }
}

// Album Store to persist generated images and prompts locally using IndexedDB (falling back to localStorage)

const DB_NAME = 'comfygen_db';
const DB_VERSION = 1;
const STORE_NAME = 'album_images';

let db = null;
let albumImages = [];

function initDB() {
  if (db) return Promise.resolve(db);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (e) => {
      const database = e.target.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = (e) => {
      db = e.target.result;
      resolve(db);
    };
    request.onerror = (e) => {
      console.error('IndexedDB open error:', e.target.error);
      reject(e.target.error);
    };
  });
}

function getAllFromDB() {
  return new Promise((resolve, reject) => {
    if (!db) return resolve([]);
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();
    request.onsuccess = () => {
      const results = request.result || [];
      // Sort newest first
      results.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      resolve(results);
    };
    request.onerror = () => {
      reject(request.error);
    };
  });
}

function saveToDB(item) {
  return new Promise((resolve, reject) => {
    if (!db) return resolve();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.put(item);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function deleteFromDB(id) {
  return new Promise((resolve, reject) => {
    if (!db) return resolve();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export const albumStore = {
  async load() {
    try {
      await initDB();
      const items = await getAllFromDB();
      albumImages = items.map(item => {
        let url = item.url;
        if (item.blob) {
          url = URL.createObjectURL(item.blob);
        }
        return {
          id: item.id,
          url: url,
          prompt: item.prompt,
          tags: item.tags || [],
          timestamp: item.timestamp
        };
      });
    } catch (e) {
      console.warn('Failed to load album from IndexedDB, trying localStorage fallback:', e);
      try {
        const saved = localStorage.getItem('comfygen_album');
        if (saved) {
          albumImages = JSON.parse(saved);
        } else {
          albumImages = [];
        }
      } catch (err) {
        albumImages = [];
      }
    }
    return albumImages;
  },

  getAll() {
    return albumImages;
  },

  async save(imageUrl, prompt, tags = []) {
    const id = `img_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const timestamp = new Date().toISOString();
    let blob = null;
    let finalUrl = imageUrl;

    // Fetch the image URL to store the actual binary Blob locally in IndexedDB
    try {
      const response = await fetch(imageUrl);
      if (response.ok) {
        blob = await response.blob();
        // Create an Object URL from the Blob for instant local rendering
        finalUrl = URL.createObjectURL(blob);
      }
    } catch (e) {
      console.warn('Could not fetch image blob to persist in IndexedDB:', e);
    }

    const newImage = {
      id,
      url: finalUrl,
      prompt,
      tags: [...tags],
      timestamp
    };

    // Prepend to active memory list
    albumImages.unshift(newImage);

    // Persist to IndexedDB
    try {
      await initDB();
      await saveToDB({
        id,
        blob,
        prompt,
        tags: [...tags],
        timestamp
      });
    } catch (e) {
      console.error('Failed to save image to IndexedDB:', e);
    }

    // Update localStorage fallback (omit binary data due to size constraints)
    try {
      const fallbackList = albumImages.map(img => ({
        id: img.id,
        url: img.url,
        prompt: img.prompt,
        tags: img.tags,
        timestamp: img.timestamp
      }));
      localStorage.setItem('comfygen_album', JSON.stringify(fallbackList));
    } catch (e) {
      console.warn('Failed to save album to localStorage fallback:', e);
    }

    return newImage;
  },

  delete(id) {
    // Revoke the object URL if it exists
    const imgObj = albumImages.find(img => img.id === id);
    if (imgObj && imgObj.url && imgObj.url.startsWith('blob:')) {
      URL.revokeObjectURL(imgObj.url);
    }

    albumImages = albumImages.filter(img => img.id !== id);

    // Delete from IndexedDB asynchronously
    deleteFromDB(id).catch(e => {
      console.error('Failed to delete image from IndexedDB:', e);
    });

    // Update localStorage fallback
    try {
      const fallbackList = albumImages.map(img => ({
        id: img.id,
        url: img.url,
        prompt: img.prompt,
        tags: img.tags,
        timestamp: img.timestamp
      }));
      localStorage.setItem('comfygen_album', JSON.stringify(fallbackList));
    } catch (e) {}

    return albumImages;
  }
};

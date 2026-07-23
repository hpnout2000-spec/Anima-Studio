// Album Store to persist generated images and prompts locally using IndexedDB (falling back to localStorage)
// Upgraded to version 2 to support saving files directly to a user-specified local folder (File System Access API)
// Support scanning the prompt text on load/save to extract database-matching tags case-insensitively

import { tagsDatabase } from '../data/tags.js';

const DB_NAME = 'comfygen_db';
const DB_VERSION = 2; // Upgraded from 1
const STORE_NAME = 'album_images';

let db = null;
let albumImages = [];
let dirHandle = null;

function initDB() {
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(err => console.warn('Storage persist request failed:', err));
  }

  if (db) return Promise.resolve(db);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (e) => {
      const database = e.target.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
      if (!database.objectStoreNames.contains('storage_handles')) {
        database.createObjectStore('storage_handles');
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

function saveDirHandle(handle) {
  return new Promise((resolve, reject) => {
    if (!db) return reject(new Error('Database not initialized'));
    const tx = db.transaction('storage_handles', 'readwrite');
    const store = tx.objectStore('storage_handles');
    const request = store.put(handle, 'save_directory');
    request.onsuccess = () => {
      dirHandle = handle;
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
}

function loadDirHandle() {
  return new Promise((resolve, reject) => {
    if (!db) return resolve(null);
    const tx = db.transaction('storage_handles', 'readonly');
    const store = tx.objectStore('storage_handles');
    const request = store.get('save_directory');
    request.onsuccess = () => {
      dirHandle = request.result || null;
      resolve(dirHandle);
    };
    request.onerror = () => reject(request.error);
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

function cleanSegment(segment) {
  if (!segment) return '';
  let clean = segment.trim();
  // Strip leading/trailing parentheses, brackets, braces: ( ) [ ] { }
  clean = clean.replace(/^[([{\s]+|[)\]}\s]+$/g, '');
  // Strip attention weight suffix like :1.2 or :2.6
  clean = clean.replace(/:[\d.]+\s*$/, '');
  // Strip outer parentheses again in case they were inside the weight e.g., (hand:1.2)
  clean = clean.replace(/^[([{\s]+|[)\]}\s]+$/g, '');
  return clean.trim();
}

function extractTagsFromPrompt(prompt, existingTags = [], tagLookupMap) {
  if (!prompt || !tagLookupMap) return existingTags;
  
  const uniqueTags = new Set(existingTags.map(t => t.toLowerCase()));
  const resultTags = [...existingTags];

  const segments = prompt.split(',').map(s => s.trim()).filter(Boolean);
  
  for (const segment of segments) {
    const cleaned = cleanSegment(segment);
    const lowerSegment = cleaned.toLowerCase();
    const canonicalTag = tagLookupMap.get(lowerSegment);
    if (canonicalTag) {
      if (!uniqueTags.has(lowerSegment)) {
        uniqueTags.add(lowerSegment);
        resultTags.push(canonicalTag);
      }
    }
  }
  
  return resultTags;
}

export const albumStore = {
  async load() {
    try {
      await initDB();
      await loadDirHandle();
      
      const items = await getAllFromDB();
      
      // Check directory permission
      let hasPermission = false;
      if (dirHandle) {
        try {
          hasPermission = (await dirHandle.queryPermission({ mode: 'readwrite' })) === 'granted';
        } catch (e) {
          console.warn('Failed to query directory permission:', e);
        }
      }

      // Build tag lookup map for fast O(1) case-insensitive check
      const tagLookupMap = new Map();
      try {
        const categories = tagsDatabase.getAllCategories();
        for (const catKey in categories) {
          const tagsList = categories[catKey]?.tags || [];
          for (const tObj of tagsList) {
            if (tObj && tObj.tag) {
              tagLookupMap.set(tObj.tag.toLowerCase(), tObj.tag);
            }
          }
        }
      } catch (err) {
        console.error('Failed to build tag lookup map:', err);
      }

      albumImages = items.map(item => {
        let url = item.url;
        if (item.blob) {
          url = URL.createObjectURL(item.blob);
        }

        const mergedTags = extractTagsFromPrompt(item.prompt, item.tags || [], tagLookupMap);

        const record = {
          id: item.id,
          url: url,
          prompt: item.prompt,
          tags: mergedTags,
          timestamp: item.timestamp,
          parentId: item.parentId || null,
          modificationPrompt: item.modificationPrompt || null,
          loras: item.loras || [],
          filename: item.filename || null,
          isVideo: item.isVideo || !!(item.filename && item.filename.endsWith('.mp4')) || !!(item.url && item.url.includes('.mp4')),
          subPrompts: item.subPrompts || [],
          mainPromptText: item.mainPromptText || null,
          artStyleText: item.artStyleText || null
        };

        // Lazy async load for custom directory files if URL isn't set yet
        if (!url && item.filename && dirHandle && hasPermission) {
          dirHandle.getFileHandle(item.filename).then(h => h.getFile()).then(f => {
            record.url = URL.createObjectURL(f);
          }).catch(e => console.warn(`Could not read file ${item.filename}:`, e));
        }

        return record;
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

  hasDirectory() {
    return !!dirHandle;
  },

  getDirectoryName() {
    return dirHandle ? dirHandle.name : '';
  },

  async checkDirectoryPermission() {
    if (!dirHandle) return false;
    try {
      return (await dirHandle.queryPermission({ mode: 'readwrite' })) === 'granted';
    } catch (e) {
      return false;
    }
  },

  async requestDirectoryPermission() {
    if (!dirHandle) return false;
    try {
      const granted = (await dirHandle.requestPermission({ mode: 'readwrite' })) === 'granted';
      if (granted) {
        await this.load();
      }
      return granted;
    } catch (e) {
      console.error('Failed to request directory permission:', e);
      return false;
    }
  },

  async setSaveDirectory(handle) {
    await initDB();
    await saveDirHandle(handle);
    await this.load();
  },

  async clearSaveDirectory() {
    await initDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('storage_handles', 'readwrite');
      const store = tx.objectStore('storage_handles');
      const request = store.delete('save_directory');
      request.onsuccess = async () => {
        dirHandle = null;
        await this.load();
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
  },

  async save(imageUrl, prompt, tags = [], parentId = null, modificationPrompt = null, loras = [], subPrompts = [], mainPromptText = null, artStyleText = null) {
    const id = `img_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const timestamp = new Date().toISOString();
    let blob = null;
    let finalUrl = imageUrl;
    let filename = null;
    const isVideo = imageUrl && (imageUrl.includes('.mp4') || imageUrl.includes('/video/') || imageUrl.includes('format=mp4') || imageUrl.includes('.webm'));

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

    // Save to custom folder if set & permitted
    if (dirHandle && blob) {
      try {
        const hasPermission = (await dirHandle.queryPermission({ mode: 'readwrite' })) === 'granted' ||
                              (await dirHandle.requestPermission({ mode: 'readwrite' })) === 'granted';
        if (hasPermission) {
          const isVideoBlob = (blob.type && blob.type.includes('video')) || imageUrl.includes('.mp4') || imageUrl.includes('/video/');
          filename = `comfygen_${Date.now()}.${isVideoBlob ? 'mp4' : 'png'}`;
          const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
          const writable = await fileHandle.createWritable();
          await writable.write(blob);
          await writable.close();
          
          // Clear blob to save space on drive C (IndexedDB won't hold the binary data)
          blob = null;
        }
      } catch (err) {
        console.error('Failed to save file to custom folder:', err);
      }
    }

    // Build lookup map to scan prompt tags on save
    const tagLookupMap = new Map();
    try {
      const categories = tagsDatabase.getAllCategories();
      for (const catKey in categories) {
        const tagsList = categories[catKey]?.tags || [];
        for (const tObj of tagsList) {
          if (tObj && tObj.tag) {
            tagLookupMap.set(tObj.tag.toLowerCase(), tObj.tag);
          }
        }
      }
    } catch (err) {
      console.error('Failed to build tag lookup map:', err);
    }

    const mergedTags = extractTagsFromPrompt(prompt, tags || [], tagLookupMap);

    const newImage = {
      id,
      url: finalUrl,
      prompt,
      tags: mergedTags,
      timestamp,
      parentId,
      modificationPrompt,
      loras: loras ? [...loras] : [],
      filename,
      isVideo: isVideo || false,
      subPrompts: subPrompts ? [...subPrompts] : [],
      mainPromptText,
      artStyleText
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
        tags: mergedTags,
        timestamp,
        parentId,
        modificationPrompt,
        loras: loras ? [...loras] : [],
        filename,
        isVideo: isVideo || false,
        subPrompts: subPrompts ? [...subPrompts] : [],
        mainPromptText,
        artStyleText
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
        timestamp: img.timestamp,
        parentId: img.parentId,
        modificationPrompt: img.modificationPrompt,
        loras: img.loras || [],
        filename: img.filename || null,
        subPrompts: img.subPrompts || [],
        mainPromptText: img.mainPromptText || null,
        artStyleText: img.artStyleText || null
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

    // Delete file from custom folder if it exists
    if (imgObj && imgObj.filename && dirHandle) {
      dirHandle.queryPermission({ mode: 'readwrite' }).then(async permission => {
        if (permission === 'granted') {
          try {
            await dirHandle.removeEntry(imgObj.filename);
            console.log(`Deleted file ${imgObj.filename} from custom folder`);
          } catch (e) {
            console.warn(`Could not delete file ${imgObj.filename} from custom folder:`, e);
          }
        }
      });
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
        timestamp: img.timestamp,
        parentId: img.parentId,
        modificationPrompt: img.modificationPrompt,
        loras: img.loras || [],
        filename: img.filename || null,
        subPrompts: img.subPrompts || [],
        mainPromptText: img.mainPromptText || null
      }));
      localStorage.setItem('comfygen_album', JSON.stringify(fallbackList));
    } catch (e) {}

    return albumImages;
  }
};

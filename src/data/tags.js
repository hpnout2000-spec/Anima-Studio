// Default tag database packs
export const defaultTagPacks = {
  pose: {
    name: "Pose",
    tags: [
      { tag: "standing", name: "Standing", description: "Standing pose" },
      { tag: "sitting", name: "Sitting", description: "Sitting pose" },
      { tag: "lying", name: "Lying", description: "Lying down pose" },
      { tag: "portrait", name: "Portrait", description: "Close-up portrait view" },
      { tag: "dynamic pose", name: "Dynamic pose", description: "Active or action pose" }
    ]
  },
  character: {
    name: "Character",
    tags: [
      { tag: "1girl", name: "One girl", description: "One girl" },
      { tag: "1boy", name: "One boy", description: "One boy" },
      { tag: "elf", name: "Elf", description: "Elf character with pointed ears" },
      { tag: "kitsune", name: "Kitsune", description: "Fox girl with ears and tails" },
      { tag: "angel", name: "Angel", description: "Angel character with wings" }
    ]
  },
  background: {
    name: "Background",
    tags: [
      { tag: "forest", name: "Forest", description: "Forest background with trees and sunbeams" },
      { tag: "cyberpunk city", name: "Cyberpunk city", description: "Neon-lit futuristic city streets" },
      { tag: "sky", name: "Sky", description: "Beautiful sky, clouds" },
      { tag: "indoors", name: "Indoors", description: "Inside a room or building" },
      { tag: "fantasy ruins", name: "Fantasy ruins", description: "Ancient stone ruins with overgrown moss" }
    ]
  },
  style: {
    name: "Style",
    tags: [
      { tag: "anime illustration", name: "Anime", description: "Classic high-quality anime style" },
      { tag: "oil painting", name: "Oil painting", description: "Traditional oil painting look" },
      { tag: "watercolor", name: "Watercolor", description: "Soft watercolor painting style" },
      { tag: "concept art", name: "Concept art", description: "Cinematic digital concept art" },
      { tag: "lineart", name: "Lineart", description: "Simple lines with clean colors" }
    ]
  },
  age: {
    name: "Age",
    tags: [
      { tag: "child", name: "Child", description: "Young child character" },
      { tag: "teenager", name: "Teenager", description: "Teenage youth" },
      { tag: "young adult", name: "Young adult", description: "A young adult in their 20s" },
      { tag: "mature adult", name: "Mature adult", description: "A mature adult in their 30s-40s" }
    ]
  },
  hair: {
    name: "Hair",
    tags: [
      { tag: "long hair", name: "Long hair", description: "Long flowing hair" },
      { tag: "short hair", name: "Short hair", description: "Short cropped hair" },
      { tag: "ponytail", name: "Ponytail", description: "Hair tied in a ponytail" },
      { tag: "twintails", name: "Twintails", description: "Twin tails hairstyle" },
      { tag: "blonde hair", name: "Blonde hair", description: "Golden blonde colored hair" },
      { tag: "black hair", name: "Black hair", description: "Dark black colored hair" }
    ]
  },
  expression: {
    name: "Expression",
    tags: [
      { tag: "smiling", name: "Smiling", description: "Happy smiling expression" },
      { tag: "sad", name: "Sad", description: "Sad or melancholy face" },
      { tag: "angry", name: "Angry", description: "Angry or fierce expression" },
      { tag: "blushing", name: "Blushing", description: "Embarrassed blush" },
      { tag: "smirk", name: "Smirk", description: "Confident or playful smirk" }
    ]
  },
  clothing: {
    name: "Clothing",
    tags: [
      { tag: "casual clothes", name: "Casual clothes", description: "T-shirt, jeans, or general casual wear" },
      { tag: "fantasy armor", name: "Fantasy armor", description: "Detailed medieval fantasy armor" },
      { tag: "school uniform", name: "School uniform", description: "Classic student uniform" },
      { tag: "kimono", name: "Kimono", description: "Traditional Japanese kimono" },
      { tag: "cloak", name: "Cloak", description: "Flowing wizard or traveler cloak" },
      { tag: "hanfu", name: "Hanfu", description: "Traditional Chinese robe style clothing", subcategory: "Chinese" },
      { tag: "cheongsam", name: "Cheongsam", description: "Traditional body-hugging Chinese dress", subcategory: "Chinese" },
      { tag: "tang suit", name: "Tang suit", description: "Traditional Chinese jacket style coat", subcategory: "Chinese" }
    ]
  }
};

function cleanCategoryKey(key) {
  return key ? key.trim().toLowerCase().replace(/\s+/g, '_') : '';
}

let activeTagPacks = JSON.parse(JSON.stringify(defaultTagPacks));

export const tagsDatabase = {
  async load() {
    try {
      const resp = await fetch('/api/load-tags');
      if (resp.ok) {
        activeTagPacks = await resp.json();
        console.log('Custom tags successfully loaded from server');
        // Sync with localStorage
        try {
          localStorage.setItem('comfygen_custom_tags', JSON.stringify(activeTagPacks));
        } catch (e) {}
        return activeTagPacks;
      }
    } catch (e) {
      console.log('Server custom tags storage not available, falling back to localStorage');
    }

    try {
      const saved = localStorage.getItem('comfygen_custom_tags');
      if (saved) {
        activeTagPacks = JSON.parse(saved);
      } else {
        activeTagPacks = JSON.parse(JSON.stringify(defaultTagPacks));
      }
    } catch (e) {
      console.warn('Failed to load custom tags from localStorage:', e);
      activeTagPacks = JSON.parse(JSON.stringify(defaultTagPacks));
    }
    return activeTagPacks;
  },

  save() {
    try {
      localStorage.setItem('comfygen_custom_tags', JSON.stringify(activeTagPacks));
    } catch (e) {
      console.error('Failed to save custom tags to localStorage:', e);
    }
    // Asynchronously save to server in the background
    fetch('/api/save-tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(activeTagPacks)
    }).catch(e => console.warn('Failed to save custom tags to server:', e));
  },

  getAllCategories() {
    return activeTagPacks;
  },
  
  getCategoryTags(categoryKey) {
    const cleanKey = cleanCategoryKey(categoryKey);
    return activeTagPacks[cleanKey]?.tags || [];
  },

  addCategory(key, name) {
    const cleanKey = cleanCategoryKey(key);
    if (!cleanKey) return false;
    if (activeTagPacks[cleanKey]) return false;
    
    activeTagPacks[cleanKey] = {
      name: name.trim() || cleanKey,
      tags: [],
      isCustom: true
    };
    this.save();
    return true;
  },

  deleteCategory(key) {
    const cleanKey = cleanCategoryKey(key);
    if (!activeTagPacks[cleanKey]) return false;
    delete activeTagPacks[cleanKey];
    this.save();
    return true;
  },

  importTags(categoryKey, tagsList) {
    const cleanKey = cleanCategoryKey(categoryKey);
    if (!activeTagPacks[cleanKey]) return false;
    
    tagsList.forEach(newTag => {
      if (!newTag.tag) return;
      const idx = activeTagPacks[cleanKey].tags.findIndex(t => t.tag.toLowerCase() === newTag.tag.toLowerCase());
      
      const tagObj = {
        tag: newTag.tag.trim(),
        name: newTag.name ? newTag.name.trim() : newTag.tag.trim(),
        description: newTag.description ? newTag.description.trim() : '',
        subcategory: newTag.subcategory ? newTag.subcategory.trim() : ''
      };
      
      if (newTag.sub_tags && Array.isArray(newTag.sub_tags)) {
        tagObj.sub_tags = newTag.sub_tags.map(st => st.trim());
      }
      
      if (idx !== -1) {
        activeTagPacks[cleanKey].tags[idx] = tagObj;
      } else {
        activeTagPacks[cleanKey].tags.push(tagObj);
      }
    });
    
    this.save();
    return true;
  },

  addTagPack(categoryKey, packName, tagsList) {
    const cleanKey = cleanCategoryKey(categoryKey);
    if (!activeTagPacks[cleanKey]) {
      activeTagPacks[cleanKey] = {
        name: packName,
        tags: [],
        isCustom: true
      };
    }
    
    tagsList.forEach(newTag => {
      const idx = activeTagPacks[cleanKey].tags.findIndex(t => t.tag.toLowerCase() === newTag.tag.toLowerCase());
      const tagObj = {
        tag: newTag.tag.trim(),
        name: newTag.name ? newTag.name.trim() : newTag.tag.trim(),
        description: newTag.description ? newTag.description.trim() : '',
        subcategory: newTag.subcategory ? newTag.subcategory.trim() : ''
      };
      
      if (newTag.sub_tags && Array.isArray(newTag.sub_tags)) {
        tagObj.sub_tags = newTag.sub_tags.map(st => st.trim());
      }

      if (idx !== -1) {
        activeTagPacks[cleanKey].tags[idx] = tagObj;
      } else {
        activeTagPacks[cleanKey].tags.push(tagObj);
      }
    });
    
    this.save();
    return activeTagPacks[cleanKey];
  },

  resetToDefaults() {
    try {
      localStorage.removeItem('comfygen_custom_tags');
    } catch (e) {}
    
    activeTagPacks = JSON.parse(JSON.stringify(defaultTagPacks));

    // Overwrite the server-side custom tags file to reset it too
    fetch('/api/save-tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(activeTagPacks)
    }).catch(e => console.warn('Failed to reset tags on server:', e));

    return activeTagPacks;
  },

  getTagInfo(tagString) {
    for (const catKey in activeTagPacks) {
      const tagObj = activeTagPacks[catKey].tags.find(t => t.tag.toLowerCase() === tagString.toLowerCase());
      if (tagObj) {
        return {
          ...tagObj,
          category: catKey,
          categoryName: activeTagPacks[catKey].name
        };
      }
    }
    return null;
  }
};

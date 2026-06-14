import { settingsStore } from './services/settings-store.js';
import { albumStore } from './services/album-store.js';
import { tagsDatabase } from './data/tags.js';
import { generateImageComfyUI, clearComfyUIMemory, getAvailableLoras } from './services/comfyui-service.js';
import { aiService, parseSuggestions, parseMarkdown } from './services/ai-service.js';
import { initLightbox } from './utils/lightbox.js';

// ─── Application State ─────────────────────────────────────────────
let appState = {
  activeMode: 'simple', // 'simple' or 'advanced'
  activePromptText: '',
  activeTags: [], // List of string tags currently composed
  activeCategory: 'pose', // currently chosen category in Advanced mode
  isGenerating: false,
  generatedImageUrl: null,
  generationAbortController: null,
  chatAbortController: null,
  chatHistory: [], // {role, content} list for the helper chat
  collapsedSubcategories: {}, // key: activeCategory_subName -> boolean
  generationCount: 0, // Track successful generations for VRAM clearing
  lastSurpriseTags: [], // Track tags added by the last "Surprise me" click
  
  // Editor State
  editorActive: false,
  editorSourceUrl: null,
  editorOriginalBlob: null,
  editorMode: 'inpaint', // 'inpaint' or 'img2img'
  brushMode: 'draw', // 'draw' or 'erase'
  brushSize: 20,
  denoise: 0.75,
  isDrawing: false,

  // LoRA State
  loras: [],           // List of user-added LoRAs: { id, name, strength, enabled }
  availableLoras: [],  // List of all LoRA filenames fetched from ComfyUI
  pinnedLoras: []      // List of pinned LoRA names
};

// ─── UI Helper: Toast Notifications ────────────────────────────────
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-notifications-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast-message ${type}`;
  toast.innerHTML = `<span>${message}</span>`;
  container.appendChild(toast);

  // Auto remove toast after 4s
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(15px)';
    toast.style.transition = 'all 0.4s ease';
    setTimeout(() => toast.remove(), 400);
  }, 4000);
}

// ─── Flying Save Animation ─────────────────────────────────────────
function playFlyToAlbumAnimation(imageElement, targetElement, callback) {
  if (!imageElement || !targetElement) {
    if (callback) callback();
    return;
  }

  const srcRect = imageElement.getBoundingClientRect();
  const targetRect = targetElement.getBoundingClientRect();

  const isAlbumOpen = document.getElementById('album-drawer').classList.contains('open');
  const destWidth = isAlbumOpen ? targetRect.width : 36;
  const destHeight = isAlbumOpen ? targetRect.height : 36;
  const destLeft = targetRect.left + (targetRect.width / 2) - destWidth / 2;
  const destTop  = targetRect.top  + (targetRect.height / 2) - destHeight / 2;

  // Create a fixed overlay duplicate of the image at exactly the source position/size
  const clone = document.createElement('img');
  clone.src = imageElement.src;
  clone.className = 'flying-art-clone';

  // Set INITIAL position matching the source image exactly (no transition yet)
  clone.style.transition = 'none';
  clone.style.left   = `${srcRect.left}px`;
  clone.style.top    = `${srcRect.top}px`;
  clone.style.width  = `${srcRect.width}px`;
  clone.style.height = `${srcRect.height}px`;
  clone.style.opacity = '1';
  clone.style.borderRadius = '12px';

  document.body.appendChild(clone);

  // Hide the original image immediately so only the clone is visible/moving
  imageElement.style.opacity = '0';
  imageElement.style.pointerEvents = 'none';

  // Allow browser to paint the clone at initial position before we animate
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      // Now enable transition and move to destination
      clone.style.transition = '';
      clone.style.left        = `${destLeft}px`;
      clone.style.top         = `${destTop}px`;
      clone.style.width       = `${destWidth}px`;
      clone.style.height      = `${destHeight}px`;
      clone.style.opacity     = isAlbumOpen ? '1' : '0';
      clone.style.borderRadius = isAlbumOpen ? '8px' : '50%';
    });
  });

  // Listen for the 'left' transition to finish (guaranteed to change from center to side)
  let callbackFired = false;
  function onTransitionEnd(e) {
    if (e.propertyName !== 'left') return;
    clone.removeEventListener('transitionend', onTransitionEnd);
    if (!callbackFired) {
      callbackFired = true;
      clone.remove();

      // If target card was hidden for the animation, reveal it now instantly without transition
      if (isAlbumOpen && targetElement.classList.contains('just-added-flying')) {
        targetElement.style.transition = 'none';
        targetElement.classList.remove('just-added-flying');
        targetElement.offsetHeight; // force layout reflow
        targetElement.style.transition = '';
      }

      // Restore original image styles for future previews
      imageElement.style.opacity = '';
      imageElement.style.pointerEvents = '';

      if (callback) callback();
    }
  }
  clone.addEventListener('transitionend', onTransitionEnd);

  // Fallback: if transition somehow doesn't fire (e.g., reduced-motion), cleanup anyway
  setTimeout(() => {
    if (!callbackFired) {
      callbackFired = true;
      clone.remove();
      if (isAlbumOpen && targetElement.classList.contains('just-added-flying')) {
        targetElement.style.transition = 'none';
        targetElement.classList.remove('just-added-flying');
        targetElement.offsetHeight;
        targetElement.style.transition = '';
      }
      imageElement.style.opacity = '';
      imageElement.style.pointerEvents = '';
      if (callback) callback();
    }
  }, 1200);
}

// ─── Morphing Preview Animation ────────────────────────────────────
function playMorphPreviewAnimation(previewImg, targetImg, changeState, callback) {
  if (!previewImg || !targetImg) {
    if (changeState) changeState();
    if (callback) callback();
    return;
  }

  // 1. Measure starting position of the live preview element
  const srcRect = previewImg.getBoundingClientRect();

  // 2. Measure the TRUE destination position of the final image by temporarily applying target layout
  const workspace = document.getElementById('main-workspace');
  const loader = document.getElementById('generation-loader');
  const previewArea = document.getElementById('art-preview-area');

  // Save original transition style
  const origWorkspaceTransition = workspace.style.transition;
  
  // Disable transition temporarily
  workspace.style.transition = 'none';
  
  // Apply final target state to get layout
  workspace.classList.remove('generating');
  loader.classList.add('hidden');
  previewArea.classList.remove('hidden');
  
  // Force layout reflow
  workspace.offsetHeight;
  
  // Measure the final destination coordinates
  const destRect = targetImg.getBoundingClientRect();
  
  // Revert back to the initial state immediately
  workspace.classList.add('generating');
  loader.classList.remove('hidden');
  previewArea.classList.add('hidden');
  
  // Force layout reflow to apply the reversion
  workspace.offsetHeight;
  
  // Restore transitions
  workspace.style.transition = origWorkspaceTransition;

  // 3. Create a morphing clone to animate
  const clone = document.createElement('img');
  clone.src = targetImg.src || previewImg.src;
  clone.className = 'morphing-preview-clone';

  // Position clone at start rect (no transition yet)
  clone.style.transition = 'none';
  clone.style.left = `${srcRect.left}px`;
  clone.style.top = `${srcRect.top}px`;
  clone.style.width = `${srcRect.width}px`;
  clone.style.height = `${srcRect.height}px`;
  clone.style.opacity = '1';
  clone.style.borderRadius = '16px';

  document.body.appendChild(clone);

  // Hide the original preview image
  previewImg.style.opacity = '0';

  // 4. Perform the actual permanent layout change
  if (changeState) changeState();

  // Hide the target image during the animation
  targetImg.style.opacity = '0';

  // 5. Animate the clone to destination
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      clone.style.transition = ''; // Restore CSS transition
      clone.style.left = `${destRect.left}px`;
      clone.style.top = `${destRect.top}px`;
      clone.style.width = `${destRect.width}px`;
      clone.style.height = `${destRect.height}px`;
      clone.style.borderRadius = '12px';
    });
  });

  // 6. Listen for the transition to finish
  let callbackFired = false;
  function onTransitionEnd(e) {
    if (e.propertyName !== 'left' && e.propertyName !== 'width') return;
    clone.removeEventListener('transitionend', onTransitionEnd);
    if (!callbackFired) {
      callbackFired = true;
      clone.remove();

      // Restore original opacity of elements
      targetImg.style.opacity = '';
      previewImg.style.opacity = '';

      if (callback) callback();
    }
  }
  clone.addEventListener('transitionend', onTransitionEnd);

  // Fallback cleanup
  setTimeout(() => {
    if (!callbackFired) {
      callbackFired = true;
      clone.remove();
      targetImg.style.opacity = '';
      previewImg.style.opacity = '';
      if (callback) callback();
    }
  }, 800);
}

// ─── DOM Binding & Page Initialization ─────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Load stores
  await settingsStore.load();
  await tagsDatabase.load();
  try {
    await albumStore.load();
  } catch (e) {
    console.error('Failed to load album:', e);
  }

  // Initialize UI values
  initSettingsForm();
  initImageSizeSelector();
  renderAdvancedCategories();
  renderCategoryTags();
  renderActiveTagsChips();
  renderGalleryList();

  // Initialize lightbox zoomer
  initLightbox();

  // Initialize surprise me split button and settings dropdown
  initSurpriseMe();

  // Initialize LoRA Manager
  try {
    const savedPinned = localStorage.getItem('comfygen_pinned_loras');
    if (savedPinned) {
      appState.pinnedLoras = JSON.parse(savedPinned);
    }
    appState.availableLoras = await getAvailableLoras();
  } catch (e) {
    console.error('Failed to initialize LoRAs:', e);
  }

  // Bind Add LoRA Button
  const btnAddLora = document.getElementById('btn-add-lora');
  if (btnAddLora) {
    btnAddLora.addEventListener('click', () => {
      addLoraBlock();
    });
  }

  // Click outside to close custom dropdowns
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.lora-dropdown')) {
      document.querySelectorAll('.lora-dropdown.open').forEach(el => {
        el.classList.remove('open');
      });
    }
  });

  // Click on generated art preview opens lightbox zoomer with prompt details
  const previewImg = document.getElementById('generated-art-img');
  if (previewImg) {
    previewImg.addEventListener('click', () => {
      if (window.openLightbox && previewImg.src) {
        window.openLightbox(previewImg.src, getFinalPrompt(), appState.activeTags);
      }
    });
  }

  // 1. Toggles Bindings (Floating Panels with spring animations)
  const leftMenuDrawer = document.getElementById('left-menu-drawer');
  const btnToggleLeftMenu = document.getElementById('btn-toggle-left-menu');
  const btnCloseLeftMenu = document.getElementById('btn-close-left-menu');

  const settingsDrawer = document.getElementById('settings-drawer');
  const menuBtnSettings = document.getElementById('menu-btn-settings');
  const btnCloseSettings = document.getElementById('btn-close-settings');

  const helpDrawer = document.getElementById('help-drawer');
  const btnToggleHelp = document.getElementById('btn-toggle-help');
  const btnCloseHelp = document.getElementById('btn-close-help');

  const albumDrawer = document.getElementById('album-drawer');
  const btnToggleAlbum = document.getElementById('btn-toggle-album');
  const btnCloseAlbum = document.getElementById('btn-close-album');

  // Left Menu Open/Close
  btnToggleLeftMenu.addEventListener('click', () => {
    leftMenuDrawer.classList.add('open');
  });

  btnCloseLeftMenu.addEventListener('click', (e) => {
    e.stopPropagation();
    leftMenuDrawer.classList.remove('open');
    // Also close settings if menu closes
    settingsDrawer.classList.remove('open');
    document.querySelectorAll('.settings-sub-panel').forEach(p => p.classList.remove('open'));
    document.querySelectorAll('.settings-nav-btn').forEach(b => b.classList.remove('active'));
  });


  // View switching logic
  window.switchView = function(viewName) {
    const mainWorkspace = document.getElementById('main-workspace');
    const albumWorkspace = document.getElementById('album-workspace');
    const btnCreate = document.getElementById('menu-btn-create');
    const btnAlbum = document.getElementById('menu-btn-album');

    if (viewName === 'create') {
      mainWorkspace.classList.remove('hidden');
      albumWorkspace.classList.add('hidden');
      btnCreate.classList.add('active');
      btnAlbum.classList.remove('active');
    } else if (viewName === 'album') {
      mainWorkspace.classList.add('hidden');
      albumWorkspace.classList.remove('hidden');
      btnCreate.classList.remove('active');
      btnAlbum.classList.add('active');
      renderAlbumWorkspace();
    }
  };

  // Left Menu Action buttons bindings
  document.getElementById('menu-btn-create').addEventListener('click', () => {
    leftMenuDrawer.classList.remove('open');
    window.switchView('create');
  });

  document.getElementById('menu-btn-album').addEventListener('click', () => {
    leftMenuDrawer.classList.remove('open');
    window.switchView('album');
  });

  // Settings Open/Close
  menuBtnSettings.addEventListener('click', () => {
    initSettingsForm();
    settingsDrawer.classList.add('open');
  });

  btnCloseSettings.addEventListener('click', () => {
    settingsDrawer.classList.remove('open');
    // Close all sub-panels
    document.querySelectorAll('.settings-sub-panel').forEach(p => p.classList.remove('open'));
    document.querySelectorAll('.settings-nav-btn').forEach(b => b.classList.remove('active'));
  });

  // Settings Sub-Panel Navigation
  document.querySelectorAll('.settings-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const panelId = btn.dataset.panel;
      const targetPanel = document.getElementById(panelId);

      // Deactivate all nav buttons & close all sub-panels except target
      document.querySelectorAll('.settings-nav-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.settings-sub-panel').forEach(p => {
        if (p.id !== panelId) p.classList.remove('open');
      });

      if (targetPanel) {
        btn.classList.add('active');
        targetPanel.classList.add('open');
      }
    });
  });

  // Close sub-panels via their close buttons
  document.querySelectorAll('.btn-close-sub-panel').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const panel = btn.closest('.settings-sub-panel');
      if (panel) panel.classList.remove('open');
      // Remove active from its nav button
      const panelId = panel?.id;
      if (panelId) {
        const navBtn = document.querySelector(`.settings-nav-btn[data-panel="${panelId}"]`);
        if (navBtn) navBtn.classList.remove('active');
      }
    });
  });



  // Help Chat Open/Close
  btnToggleHelp.addEventListener('click', () => {
    helpDrawer.classList.add('open');
  });

  btnCloseHelp.addEventListener('click', (e) => {
    e.stopPropagation();
    helpDrawer.classList.remove('open');
  });

  // Album Open/Close
  btnToggleAlbum.addEventListener('click', () => {
    albumDrawer.classList.add('open');
    renderGalleryList();
  });

  btnCloseAlbum.addEventListener('click', (e) => {
    e.stopPropagation();
    albumDrawer.classList.remove('open');
  });

  // 2. Tabs Bindings (Simple vs Advanced)
  const tabSimple = document.getElementById('tab-mode-simple');
  const tabAdvanced = document.getElementById('tab-mode-advanced');
  const advancedPanel = document.getElementById('advanced-modular-panel');

  tabSimple.addEventListener('click', () => {
    appState.activeMode = 'simple';
    tabSimple.classList.add('active');
    tabAdvanced.classList.remove('active');
    advancedPanel.classList.add('hidden');
  });

  tabAdvanced.addEventListener('click', () => {
    appState.activeMode = 'advanced';
    tabAdvanced.classList.add('active');
    tabSimple.classList.remove('active');
    advancedPanel.classList.remove('hidden');
    renderCategoryTags();
  });

  // 3. Clear tags button
  document.getElementById('btn-clear-tags').addEventListener('click', () => {
    const promptInput = document.getElementById('prompt-text-input');
    if (promptInput) {
      appState.activeTags.forEach(tag => {
        promptInput.value = stripTagFromText(promptInput.value, tag);
      });
    }
    appState.activeTags = [];
    renderActiveTagsChips();
    renderCategoryTags(); // refresh highlights in grid
    showToast('Tags cleared');
  });

  // 4. Generate Art Click
  const btnGenerate = document.getElementById('btn-generate');
  btnGenerate.addEventListener('click', startImageGeneration);

  const btnImprove = document.getElementById('btn-improve-prompt');
  if (btnImprove) {
    btnImprove.addEventListener('click', async () => {
      const promptInput = document.getElementById('prompt-text-input');
      const text = promptInput.value.trim();
      
      btnImprove.disabled = true;
      const originalHtml = btnImprove.innerHTML;
      btnImprove.innerHTML = '<span>Improving...</span>';
      
      try {
        const improved = await aiService.improvePrompt(text, appState.activeTags);
        showImproveConfirmation(improved);
      } catch (err) {
        showToast('Failed to improve prompt', 'error');
      } finally {
        btnImprove.innerHTML = originalHtml;
        btnImprove.disabled = false;
      }
    });
  }

  // Improve Confirmation screen buttons
  const btnImproveBack = document.getElementById('btn-improve-back');
  if (btnImproveBack) {
    btnImproveBack.addEventListener('click', () => {
      showCreationForm();
    });
  }

  const btnImproveGen = document.getElementById('btn-improve-generate');
  if (btnImproveGen) {
    btnImproveGen.addEventListener('click', () => {
      const improvedPreview = document.getElementById('improved-prompt-preview');
      const promptInput = document.getElementById('prompt-text-input');
      if (improvedPreview && promptInput) {
        promptInput.value = improvedPreview.value;
      }
      startImageGeneration();
    });
  }

  // Cancel generation
  const btnCancelGen = document.getElementById('btn-cancel-generation');
  btnCancelGen.addEventListener('click', () => {
    if (appState.generationAbortController) {
      appState.generationAbortController.abort();
      showToast('Generation cancelled', 'info');
    }
  });

  // 5. Post-Generation Buttons
  const btnPostRegen = document.getElementById('btn-post-regenerate');
  const btnPostDelete = document.getElementById('btn-post-delete');
  const btnPostSave = document.getElementById('btn-post-save');

  btnPostDelete.addEventListener('click', () => {
    showToast('Image discarded');
    appState.generatedImageUrl = null;
    showCreationForm();
  });

  btnPostRegen.addEventListener('click', () => {
    startImageGeneration();
  });

  btnPostSave.addEventListener('click', async () => {
    if (!appState.generatedImageUrl) return;

    // Save image to album list (asynchronous)
    const finalPrompt = getFinalPrompt();
    
    // Temporarily disable the button to prevent double clicks during save
    btnPostSave.disabled = true;
    const originalText = btnPostSave.innerHTML;
    btnPostSave.innerHTML = '<span>Saving...</span>';

    try {
      const savedImg = await albumStore.save(appState.generatedImageUrl, finalPrompt, appState.activeTags);
      showToast('Saved to Album!', 'success');

      // Get animated coordinates
      const imgEl = document.getElementById('generated-art-img');
      let targetEl = document.getElementById('btn-toggle-album');
      
      // Check if album sidebar is currently open
      const isAlbumOpen = albumDrawer.classList.contains('open');
      if (isAlbumOpen) {
        // Pre-render the gallery list with the new item hidden (using savedImg.id)
        renderGalleryList(savedImg.id);
        targetEl = document.querySelector('.gallery-item-card.just-added-flying');
        if (!targetEl) {
          targetEl = document.getElementById('gallery-album-grid');
        }
      }

      // Play visual flight
      playFlyToAlbumAnimation(imgEl, targetEl, () => {
        // If the album was not open, render the gallery list normally in background
        if (!isAlbumOpen) {
          renderGalleryList();
        }
        if (window.renderAlbumWorkspace) window.renderAlbumWorkspace();
        appState.generatedImageUrl = null;
        showCreationForm();
      });
    } catch (e) {
      showToast('Failed to save image to album', 'error');
      console.error(e);
    } finally {
      btnPostSave.innerHTML = originalText;
      btnPostSave.disabled = false;
    }
  });

  // 6. Settings Form submit
  document.getElementById('btn-save-settings').addEventListener('click', () => {
    const comUrl = document.getElementById('setting-comfyui-url').value.trim() || 'http://localhost:8188';
    const aiUrl = document.getElementById('setting-ai-url').value.trim() || 'http://localhost:5001';
    const steps = parseInt(document.getElementById('setting-comfyui-steps').value) || 30;
    const cfg = parseFloat(document.getElementById('setting-comfyui-cfg').value) || 4.5;
    const llliteName = document.getElementById('setting-comfyui-lllite-name').value.trim();
    const llliteNameImg2Img = document.getElementById('setting-comfyui-lllite-name-img2img')?.value.trim() || '';
    const llliteStrength = parseFloat(document.getElementById('setting-comfyui-lllite-strength').value) ?? 1.0;
    const currentSettings = settingsStore.get();
    const width = currentSettings.comfyui_width || 832;
    const height = currentSettings.comfyui_height || 1216;
    const neg = document.getElementById('setting-comfyui-negative').value.trim();
    const inst = document.getElementById('setting-ai-instructions').value.trim();
    const freeMemoryInterval = parseInt(document.getElementById('setting-free-memory-interval').value) ?? 3;

    settingsStore.save({
      comfyui_url: comUrl,
      ai_url: aiUrl,
      comfyui_steps: steps,
      comfyui_cfg: cfg,
      comfyui_lllite_name: llliteName,
      comfyui_lllite_name_img2img: llliteNameImg2Img,
      comfyui_lllite_strength: llliteStrength,
      comfyui_width: width,
      comfyui_height: height,
      comfyui_negative_prompt: neg,
      comfyui_free_memory_interval: freeMemoryInterval,
      ai_instructions: inst
    });

    showToast('Configuration saved', 'success');
    settingsDrawer.classList.remove('open');
    document.querySelectorAll('.settings-sub-panel').forEach(p => p.classList.remove('open'));
    document.querySelectorAll('.settings-nav-btn').forEach(b => b.classList.remove('active'));
  });

  const freeMemorySlider = document.getElementById('setting-free-memory-interval');
  if (freeMemorySlider) {
    freeMemorySlider.addEventListener('input', (e) => {
      updateFreeMemoryIntervalText(e.target.value);
    });
  }

  // 7. AI Chat Send message
  const chatInput = document.getElementById('chat-text-input');
  const btnSendChat = document.getElementById('btn-send-chat');

  btnSendChat.addEventListener('click', () => {
    const text = chatInput.value.trim();
    if (!text) return;
    sendChatMessage(text);
  });

  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const text = chatInput.value.trim();
      if (!text) return;
      sendChatMessage(text);
    }
  });

  const btnClearChat = document.getElementById('btn-clear-chat');
  if (btnClearChat) {
    btnClearChat.addEventListener('click', () => {
      if (appState.chatAbortController) {
        appState.chatAbortController.abort();
        appState.chatAbortController = null;
      }
      appState.chatHistory = [];
      const container = document.getElementById('chat-messages-container');
      if (container) {
        container.innerHTML = `
          <div class="system-chat-message">
            What can I help with?
          </div>
        `;
      }
      showToast('Chat history cleared');
    });
  }

  initAddonManager();
  
  // Initialize Image Editor controls
  initImageEditor();
  
  // Post-generation edit button click
  const btnPostEdit = document.getElementById('btn-post-edit');
  if (btnPostEdit) {
    btnPostEdit.addEventListener('click', () => {
      if (appState.generatedImageUrl) {
        enterEditorMode(appState.generatedImageUrl, getFinalPrompt(), appState.activeTags);
      }
    });
  }
  
  // Lightbox edit button click
  const btnLightboxEdit = document.getElementById('btn-lightbox-edit');
  if (btnLightboxEdit) {
    btnLightboxEdit.addEventListener('click', () => {
      const lightboxImg = document.getElementById('lightbox-img');
      const lightboxPrompt = document.getElementById('lightbox-prompt-text');
      if (lightboxImg && lightboxImg.src) {
        const lightbox = document.getElementById('image-lightbox');
        if (lightbox) lightbox.classList.add('hidden');
        enterEditorMode(lightboxImg.src, lightboxPrompt ? lightboxPrompt.textContent : '', appState.activeTags);
      }
    });
  }
});

// ─── Rendering Advanced Mode Categories & Tags ──────────────────────
function renderAdvancedCategories() {
  const bar = document.querySelector('.tags-categories-bar');
  if (!bar) return;

  bar.innerHTML = '';
  const categories = tagsDatabase.getAllCategories();
  
  for (const key in categories) {
    const btn = document.createElement('button');
    btn.className = `category-tab-btn ${appState.activeCategory === key ? 'active' : ''}`;
    btn.textContent = categories[key].name;
    btn.dataset.category = key;
    
    btn.addEventListener('click', () => {
      document.querySelectorAll('.category-tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      appState.activeCategory = key;
      renderCategoryTags();
    });

    bar.appendChild(btn);
  }
}

function renderCategoryTags() {
  const grid = document.getElementById('category-tags-grid');
  if (!grid) return;

  grid.innerHTML = '';
  const tags = tagsDatabase.getCategoryTags(appState.activeCategory);

  // Group tags
  const generalTags = [];
  const subcategoryGroups = {}; // subcategoryName -> Array of tags

  tags.forEach(item => {
    if (item.subcategory && item.subcategory.trim()) {
      const subName = item.subcategory.trim();
      if (!subcategoryGroups[subName]) {
        subcategoryGroups[subName] = [];
      }
      subcategoryGroups[subName].push(item);
    } else {
      generalTags.push(item);
    }
  });

  // Helper to create tag element
  function createTagEl(item) {
    const isSelected = appState.activeTags.includes(item.tag);
    const count = item.sub_tags ? item.sub_tags.length : 0;
    
    const el = document.createElement('div');
    el.className = `grid-tag-item ${isSelected ? 'selected' : ''}`;
    
    let tooltip = item.name || item.tag;
    if (item.description) {
      tooltip += `: ${item.description}`;
    }
    if (count > 0 && item.sub_tags) {
      tooltip += `\nIncludes: ${item.sub_tags.join(', ')}`;
    }
    el.title = tooltip;

    el.innerHTML = `
      <div style="font-weight:600; display:flex; align-items:center; gap:6px;">
        <span>${item.tag}</span>
        ${count > 0 ? `<span class="tag-count-badge">${count}</span>` : ''}
      </div>
    `;

    el.addEventListener('click', () => {
      togglePromptTag(item.tag);
    });

    return el;
  }

  // 1. Render General Tags
  generalTags.forEach(item => {
    grid.appendChild(createTagEl(item));
  });

  // 2. Render Subcategories
  for (const subName in subcategoryGroups) {
    const stateKey = `${appState.activeCategory}_${subName}`;
    const isCollapsed = !!appState.collapsedSubcategories[stateKey];

    // Create Header
    const header = document.createElement('div');
    header.className = `subcategory-header ${isCollapsed ? 'collapsed' : ''}`;
    header.innerHTML = `
      <span class="subcategory-arrow">▼</span>
      <span class="subcategory-title">${subName}</span>
    `;

    // Create Tags Container
    const tagsContainer = document.createElement('div');
    tagsContainer.className = `subcategory-tags-container ${isCollapsed ? 'collapsed' : ''}`;

    subcategoryGroups[subName].forEach(item => {
      tagsContainer.appendChild(createTagEl(item));
    });

    // Toggle logic
    header.addEventListener('click', () => {
      const currentlyCollapsed = tagsContainer.classList.contains('collapsed');
      if (currentlyCollapsed) {
        tagsContainer.classList.remove('collapsed');
        header.classList.remove('collapsed');
        appState.collapsedSubcategories[stateKey] = false;
      } else {
        tagsContainer.classList.add('collapsed');
        header.classList.add('collapsed');
        appState.collapsedSubcategories[stateKey] = true;
      }
    });

    grid.appendChild(header);
    grid.appendChild(tagsContainer);
  }
}

function stripTagFromText(text, tag) {
  if (!text) return '';
  
  // Split tag into words by spaces, hyphens, and underscores
  const words = tag.trim().split(/[\s_-]+/);
  if (words.length === 0 || !words[0]) return text;

  const escapedWords = words.map(w => w.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'));
  
  // Make the last word singular/plural-flexible
  let lastWord = escapedWords[escapedWords.length - 1];
  if (lastWord.toLowerCase().endsWith('ss')) {
    // Keep double s intact (e.g. glass)
  } else if (lastWord.toLowerCase().endsWith('s')) {
    lastWord = lastWord.slice(0, -1) + 's?';
  } else {
    lastWord = lastWord + 's?';
  }
  escapedWords[escapedWords.length - 1] = lastWord;

  // Pattern that allows spaces, hyphens, or underscores between words
  const wordPattern = escapedWords.join('[\\s_-]+');

  // Regex alternation:
  // 1. Matches tag wrapped in parentheses with optional weight, e.g. (tag:1.2) or ((tag))
  // 2. Matches tag itself with lookarounds ensuring it's a distinct word/phrase
  const regex = new RegExp(`(?:\\(+\\s*${wordPattern}\\s*(?::\\s*[0-9.]+\\s*)?\\)+|(?<![a-zA-Z0-9_])${wordPattern}(?![a-zA-Z0-9_]))`, 'gi');
  
  let cleanText = text.replace(regex, '');
  cleanText = cleanText.replace(/,\s*,/g, ',');
  cleanText = cleanText.trim().replace(/^,|,$/g, '').trim();
  return cleanText;
}

function removeActiveTag(tag) {
  const index = appState.activeTags.indexOf(tag);
  if (index !== -1) {
    appState.activeTags.splice(index, 1);
  }
  const promptInput = document.getElementById('prompt-text-input');
  if (promptInput) {
    promptInput.value = stripTagFromText(promptInput.value, tag);
  }
}

function togglePromptTag(tagString) {
  const index = appState.activeTags.indexOf(tagString);
  if (index === -1) {
    appState.activeTags.push(tagString);
    // Strip from prompt input to avoid duplication
    const promptInput = document.getElementById('prompt-text-input');
    if (promptInput) {
      promptInput.value = stripTagFromText(promptInput.value, tagString);
    }
  } else {
    removeActiveTag(tagString);
  }
  renderActiveTagsChips();
  renderCategoryTags(); // refresh highlights
}

function renderActiveTagsChips() {
  const wrapper = document.getElementById('active-tags-list');
  if (!wrapper) return;

  wrapper.innerHTML = '';

  if (appState.activeTags.length === 0) {
    wrapper.innerHTML = `<div class="no-tags-placeholder">No active tags. Use Advanced mode to compose.</div>`;
    return;
  }

  appState.activeTags.forEach(tag => {
    const info = tagsDatabase.getTagInfo(tag);
    const chip = document.createElement('div');
    chip.className = 'tag-chip';
    chip.innerHTML = `
      <span>${tag} ${info ? `(${info.name})` : ''}</span>
      <span class="tag-chip-remove">&times;</span>
    `;

    chip.querySelector('.tag-chip-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      togglePromptTag(tag);
    });

    wrapper.appendChild(chip);
  });
}

// ─── Settings Input Defaults ───────────────────────────────────────
function updateFreeMemoryIntervalText(value) {
  const displayVal = document.getElementById('setting-free-memory-val');
  if (!displayVal) return;
  
  const val = parseInt(value);
  if (val === 0) {
    displayVal.textContent = 'Never (Disabled)';
  } else if (val === 1) {
    displayVal.textContent = 'Every generation';
  } else {
    displayVal.textContent = `Every ${val} generations`;
  }
}

function initSettingsForm() {
  const settings = settingsStore.get();
  document.getElementById('setting-comfyui-url').value = settings.comfyui_url;
  document.getElementById('setting-ai-url').value = settings.ai_url;
  document.getElementById('setting-comfyui-steps').value = settings.comfyui_steps;
  document.getElementById('setting-comfyui-cfg').value = settings.comfyui_cfg;
  document.getElementById('setting-comfyui-lllite-name').value = settings.comfyui_lllite_name || '';
  document.getElementById('setting-comfyui-lllite-strength').value = settings.comfyui_lllite_strength ?? 1.0;
  const llliteImg2ImgEl = document.getElementById('setting-comfyui-lllite-name-img2img');
  if (llliteImg2ImgEl) llliteImg2ImgEl.value = settings.comfyui_lllite_name_img2img || '';
  document.getElementById('setting-comfyui-negative').value = settings.comfyui_negative_prompt;
  
  const freeMemInterval = settings.comfyui_free_memory_interval ?? 3;
  const slider = document.getElementById('setting-free-memory-interval');
  if (slider) {
    slider.value = freeMemInterval;
    updateFreeMemoryIntervalText(freeMemInterval);
  }
  
  const aiInstEl = document.getElementById('setting-ai-instructions');
  if (aiInstEl) {
    aiInstEl.value = settings.ai_instructions || 'You are an expert prompt engineer. Help the user create amazing stylized/non-realistic image generation prompts. Strictly avoid realistic styling, photorealism, and terms like "photorealistic", "realistic", "realism", "8k", "4k", "soft shadows", "ultra detailed textures", "unreal engine", "octane render".';
  }
}

// ─── Image Size Selector Control ───────────────────────────────────
function initImageSizeSelector() {
  const categorySelect = document.getElementById('size-category-select');
  const resolutionsList = document.getElementById('size-resolutions-list');
  const sizeDisplay = document.getElementById('active-size-display');
  if (!categorySelect || !resolutionsList || !sizeDisplay) return;

  const RESOLUTIONS = {
    square: [
      { width: 1024, height: 1024 },
      { width: 1280, height: 1280 },
      { width: 1408, height: 1408 },
      { width: 1512, height: 1512 },
      { width: 1536, height: 1536 }
    ],
    vertical: [
      { width: 896, height: 1152 },
      { width: 1024, height: 1280 },
      { width: 1216, height: 1536 },
      { width: 832, height: 1216 },
      { width: 960, height: 1440 },
      { width: 1024, height: 1536 },
      { width: 768, height: 1344 },
      { width: 832, height: 1472 },
      { width: 864, height: 1536 }
    ],
    album: [
      { width: 1152, height: 896 },
      { width: 1280, height: 1024 },
      { width: 1536, height: 1216 },
      { width: 1216, height: 832 },
      { width: 1440, height: 960 },
      { width: 1536, height: 1024 },
      { width: 1344, height: 768 },
      { width: 1472, height: 832 },
      { width: 1536, height: 864 }
    ]
  };

  const settings = settingsStore.get();
  let currentWidth = settings.comfyui_width || 832;
  let currentHeight = settings.comfyui_height || 1216;

  // Determine which category the current size belongs to
  let currentCategory = 'vertical';
  let isCustomSize = true;

  for (const cat in RESOLUTIONS) {
    const found = RESOLUTIONS[cat].find(r => r.width === currentWidth && r.height === currentHeight);
    if (found) {
      currentCategory = cat;
      isCustomSize = false;
      break;
    }
  }

  if (isCustomSize) {
    // If not found in presets, classify category by aspect ratio
    if (currentWidth === currentHeight) {
      currentCategory = 'square';
    } else if (currentWidth > currentHeight) {
      currentCategory = 'album';
    } else {
      currentCategory = 'vertical';
    }
  }

  // Set initial value in category select
  categorySelect.value = currentCategory;
  updateSizeDisplay(currentWidth, currentHeight);

  // Render resolution list
  function renderResolutions() {
    resolutionsList.innerHTML = '';
    const category = categorySelect.value;
    const presets = RESOLUTIONS[category];

    // If custom size fits the active category, inject it first
    let hasMatchingPreset = presets.some(r => r.width === currentWidth && r.height === currentHeight);
    if (isCustomSize && !hasMatchingPreset) {
      const customLabel = `${currentWidth} × ${currentHeight}`;
      const chip = document.createElement('div');
      chip.className = 'resolution-chip active';
      chip.textContent = customLabel;
      chip.addEventListener('click', () => {
        updateActiveSize(currentWidth, currentHeight);
      });
      resolutionsList.appendChild(chip);
    }

    presets.forEach(res => {
      const chip = document.createElement('div');
      const isActive = res.width === currentWidth && res.height === currentHeight;
      chip.className = `resolution-chip ${isActive ? 'active' : ''}`;
      chip.textContent = `${res.width} × ${res.height}`;

      chip.addEventListener('click', () => {
        // Update selection
        document.querySelectorAll('.resolution-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        isCustomSize = false; // user clicked a preset, so it's not a custom one anymore
        currentWidth = res.width;
        currentHeight = res.height;
        updateActiveSize(res.width, res.height);
      });

      resolutionsList.appendChild(chip);
    });
  }

  function updateActiveSize(width, height) {
    settingsStore.save({
      comfyui_width: width,
      comfyui_height: height
    });
    updateSizeDisplay(width, height);
  }

  function updateSizeDisplay(width, height) {
    sizeDisplay.textContent = `${width} × ${height}`;
  }

  // Handle category change
  categorySelect.addEventListener('change', () => {
    const category = categorySelect.value;
    const presets = RESOLUTIONS[category];
    // Default to the first preset of the new category
    if (presets && presets.length > 0) {
      currentWidth = presets[0].width;
      currentHeight = presets[0].height;
      isCustomSize = false;
      updateActiveSize(currentWidth, currentHeight);
    }
    renderResolutions();
  });

  // Initial render
  renderResolutions();
}

// ─── Gallery Album Render ─────────────────────────────────────────
function renderGalleryList(invisibleImgId = null) {
  const grid = document.getElementById('gallery-album-grid');
  if (!grid) return;

  grid.innerHTML = '';
  const images = albumStore.getAll();

  if (images.length === 0) {
    grid.innerHTML = `
      <div class="empty-gallery-placeholder">
        No saved images yet. Generate art and click "Save to Album"!
      </div>
    `;
    return;
  }

  images.forEach(img => {
    const card = document.createElement('div');
    card.className = 'gallery-item-card';
    if (invisibleImgId && img.id === invisibleImgId) {
      card.classList.add('just-added-flying');
    }
    card.innerHTML = `
      <img src="${img.url}" alt="Saved artwork">
      <div class="gallery-item-overlay">
        <button class="gallery-item-action-btn view-details" title="Use Prompt">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        </button>
        <button class="gallery-item-action-btn edit-saved" title="Edit Image">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
          </svg>
        </button>
        <button class="gallery-item-action-btn view-fullscreen" title="Open Fullscreen">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>
          </svg>
        </button>
        <button class="gallery-item-action-btn delete" title="Delete Saved">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
        </button>
      </div>
    `;

    // Click card (image or overlay background) to open in lightbox zoomer
    card.addEventListener('click', (e) => {
      if (e.target.closest('.gallery-item-action-btn')) return;
      if (window.openLightbox) {
        window.openLightbox(img.url, img.prompt, img.tags);
      }
    });

    // Click check button to restore prompt and active tags
    card.querySelector('.view-details').addEventListener('click', (e) => {
      e.stopPropagation();
      restorePromptFromSaved(img);
      showToast('Loaded prompt & tags from gallery');
    });

    // Click edit button to edit the image
    card.querySelector('.edit-saved').addEventListener('click', (e) => {
      e.stopPropagation();
      document.getElementById('album-drawer').classList.remove('open');
      if (window.switchView) window.switchView('create');
      enterEditorMode(img.url, img.prompt, img.tags);
    });

    // Click fullscreen button
    card.querySelector('.view-fullscreen').addEventListener('click', (e) => {
      e.stopPropagation();
      if (window.openLightbox) {
        window.openLightbox(img.url, img.prompt, img.tags);
      }
    });

    // Click delete to remove from album
    card.querySelector('.delete').addEventListener('click', (e) => {
      e.stopPropagation();
      albumStore.delete(img.id);
      renderGalleryList();
      if (window.renderAlbumWorkspace) window.renderAlbumWorkspace();
      showToast('Artwork removed from album', 'info');
    });

    grid.appendChild(card);
  });
}

// ─── Full-page Album Workspace Render ─────────────────────────────────
window.renderAlbumWorkspace = function() {
  const container = document.getElementById('album-workspace');
  if (!container || container.classList.contains('hidden')) return;

  const images = albumStore.getAll();
  const groupsContainer = document.getElementById('album-workspace-groups');
  const statsLegend = document.getElementById('album-stats-legend');
  const statsChart = document.getElementById('album-stats-chart');
  const statsInner = document.querySelector('.album-stats-chart-inner');
  const btnRandom = document.getElementById('btn-album-random');

  if (images.length === 0) {
    groupsContainer.innerHTML = '<div class="empty-gallery-placeholder">No saved artwork yet. Go to Create and click Save to Album!</div>';
    statsLegend.innerHTML = '';
    statsChart.style.background = 'var(--bg-secondary)';
    if (statsInner) statsInner.innerHTML = `<div><strong>0</strong><br>arts</div>`;
    if (btnRandom) btnRandom.disabled = true;
    return;
  }

  if (btnRandom) {
    btnRandom.disabled = false;
    btnRandom.onclick = () => {
      const randomImg = images[Math.floor(Math.random() * images.length)];
      if (window.openLightbox) window.openLightbox(randomImg.url, randomImg.prompt, randomImg.tags);
    };
  }

  // Calculate tag stats
  const tagCounts = {};
  images.forEach(img => {
    (img.tags || []).forEach(tag => {
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    });
  });

  const sortedTags = Object.keys(tagCounts).map(t => ({ tag: t, count: tagCounts[t] })).sort((a, b) => b.count - a.count);
  
  let topTags = sortedTags.slice(0, 7);
  let otherCount = sortedTags.slice(7).reduce((sum, t) => sum + t.count, 0);
  if (otherCount > 0) {
    topTags.push({ tag: 'Others', count: otherCount });
  }

  const totalTagUses = topTags.reduce((sum, t) => sum + t.count, 0);
  const PALETTE = ['#FF5E62', '#FF9966', '#FFD97D', '#4E65FF', '#92EFFD', '#B185FF', '#2af598', '#f35588'];

  let gradientParts = [];
  let accumPercent = 0;
  statsLegend.innerHTML = '';
  
  if (totalTagUses > 0) {
    topTags.forEach((t, idx) => {
      const pct = (t.count / totalTagUses) * 100;
      const color = PALETTE[idx % PALETTE.length];
      gradientParts.push(`${color} ${accumPercent}% ${accumPercent + pct}%`);
      accumPercent += pct;
      
      const item = document.createElement('div');
      item.className = 'album-stats-legend-item';
      item.innerHTML = `
        <span class="album-legend-color" style="background: ${color};"></span>
        <span class="album-legend-text" title="${t.tag}">${t.tag}</span>
        <span class="album-legend-pct">${pct.toFixed(1)}%</span>
      `;
      statsLegend.appendChild(item);
    });
    statsChart.style.background = `conic-gradient(${gradientParts.join(', ')})`;
  } else {
    statsLegend.innerHTML = '<div class="album-stats-legend-item">No tags used</div>';
    statsChart.style.background = 'var(--bg-secondary)';
  }

  if (statsInner) {
    statsInner.innerHTML = `<div><strong>${images.length}</strong><br>arts</div>`;
  }

  // Group by date
  const now = Date.now();
  const groups = [
    { key: 'hour', title: 'Last Hour', items: [] },
    { key: 'day', title: 'Today', items: [] },
    { key: 'month', title: 'This Month', items: [] },
    { key: 'older', title: 'Older', items: [] }
  ];

  images.forEach(img => {
    const timestamp = img.timestamp ? new Date(img.timestamp).getTime() : now;
    const diff = now - timestamp;
    
    if (diff < 60 * 60 * 1000) {
      groups[0].items.push(img);
    } else if (diff < 24 * 60 * 60 * 1000) {
      groups[1].items.push(img);
    } else if (diff < 30 * 24 * 60 * 60 * 1000) {
      groups[2].items.push(img);
    } else {
      groups[3].items.push(img);
    }
  });

  groupsContainer.innerHTML = '';
  groups.forEach(group => {
    if (group.items.length === 0) return;

    const section = document.createElement('div');
    section.className = 'album-group-section';
    
    const header = document.createElement('div');
    header.className = 'album-group-header';
    header.textContent = group.title;
    section.appendChild(header);

    const grid = document.createElement('div');
    grid.className = 'gallery-grid';
    
    group.items.forEach(img => {
      const card = document.createElement('div');
      card.className = 'gallery-item-card';
      card.innerHTML = `
        <img src="${img.url}" alt="Saved artwork">
        <div class="gallery-item-overlay">
          <button class="gallery-item-action-btn view-details" title="Use Prompt">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          </button>
          <button class="gallery-item-action-btn edit-saved" title="Edit Image">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
            </svg>
          </button>
          <button class="gallery-item-action-btn view-fullscreen" title="Open Fullscreen">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>
            </svg>
          </button>
          <button class="gallery-item-action-btn delete" title="Delete Saved">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>
          </button>
        </div>
      `;

      card.addEventListener('click', (e) => {
        if (e.target.closest('.gallery-item-action-btn')) return;
        if (window.openLightbox) window.openLightbox(img.url, img.prompt, img.tags);
      });

      card.querySelector('.view-details').addEventListener('click', (e) => {
        e.stopPropagation();
        restorePromptFromSaved(img);
        showToast('Loaded prompt & tags from gallery');
      });

      card.querySelector('.edit-saved').addEventListener('click', (e) => {
        e.stopPropagation();
        if (window.switchView) window.switchView('create');
        enterEditorMode(img.url, img.prompt, img.tags);
      });

      card.querySelector('.view-fullscreen').addEventListener('click', (e) => {
        e.stopPropagation();
        if (window.openLightbox) window.openLightbox(img.url, img.prompt, img.tags);
      });

      card.querySelector('.delete').addEventListener('click', (e) => {
        e.stopPropagation();
        albumStore.delete(img.id);
        renderGalleryList();
        if (window.renderAlbumWorkspace) window.renderAlbumWorkspace();
        showToast('Artwork removed from album', 'info');
      });

      grid.appendChild(card);
    });
    section.appendChild(grid);
    groupsContainer.appendChild(section);
  });
}

function restorePromptFromSaved(savedImage) {
  const promptInput = document.getElementById('prompt-text-input');
  
  // Try to separate original tags from description
  let rawText = savedImage.prompt;
  
  // Restore tags
  appState.activeTags = savedImage.tags ? [...savedImage.tags] : [];
  
  // Filter tags out of the prompt text input field if they were appended
  if (savedImage.tags && savedImage.tags.length > 0) {
    savedImage.tags.forEach(t => {
      rawText = stripTagFromText(rawText, t);
    });
  }
  
  promptInput.value = rawText.trim();
  renderActiveTagsChips();
  renderCategoryTags();
}

// ─── ComfyUI Generation Control ───────────────────────────────────
function getFinalPrompt() {
  const promptInput = document.getElementById('prompt-text-input');
  const rawText = promptInput.value.trim();
  
  // Expand combos/sets of tags and deduplicate
  let expandedTags = [];
  appState.activeTags.forEach(tag => {
    const info = tagsDatabase.getTagInfo(tag);
    if (info && info.sub_tags && Array.isArray(info.sub_tags)) {
      expandedTags.push(...info.sub_tags);
    } else {
      expandedTags.push(tag);
    }
  });

  // Deduplicate
  expandedTags = [...new Set(expandedTags)];
  
  const tagsStr = expandedTags.join(', ');
  
  if (tagsStr && rawText) {
    return `${tagsStr}, ${rawText}`;
  } else if (tagsStr) {
    return tagsStr;
  } else {
    return rawText;
  }
}

async function startImageGeneration() {
  const finalPrompt = getFinalPrompt();
  if (!finalPrompt.trim()) {
    showToast('Prompt cannot be empty', 'error');
    return;
  }

  // Setup abort controller
  appState.generationAbortController = new AbortController();
  appState.isGenerating = true;

  // Show loader view
  showLoaderForm();

  const stageText = document.getElementById('loader-stage-text');
  stageText.textContent = 'Waiting in ComfyUI queue...';

  try {
    const activeLoras = appState.loras.filter(l => l.enabled && l.name);
    const imgUrl = await generateImageComfyUI(
      finalPrompt,
      (status) => {
        stageText.textContent = status;
      },
      appState.generationAbortController.signal,
      (previewUrl) => {
        const previewImg = document.getElementById('generation-live-preview');
        if (previewImg) {
          previewImg.src = previewUrl;
          previewImg.classList.remove('hidden');
        }
      },
      null,
      activeLoras
    );

    appState.generatedImageUrl = imgUrl;
    showToast('Image generated successfully!', 'success');
    showArtPreview(imgUrl);

    // Track generation and clear VRAM if interval reached
    appState.generationCount++;
    const settings = settingsStore.get();
    const interval = settings.comfyui_free_memory_interval ?? 3;
    if (interval > 0 && appState.generationCount >= interval) {
      console.log(`Generation count reached interval (${appState.generationCount}/${interval}). Clearing VRAM...`);
      clearComfyUIMemory()
        .then(success => {
          if (success) {
            showToast('Auto-cleared VRAM cache', 'info');
          }
        })
        .catch(e => console.warn('Failed to auto-clear VRAM:', e));
      appState.generationCount = 0;
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      showToast(`Generation failed: ${err.message}`, 'error');
      console.error(err);
      
      // Auto-clear VRAM on failure to recover memory/NaN states
      const settings = settingsStore.get();
      const interval = settings.comfyui_free_memory_interval ?? 3;
      if (interval > 0) {
        console.log('Generation failed. Cleaning VRAM to recover...');
        clearComfyUIMemory()
          .then(success => {
            if (success) {
              showToast('Cleared VRAM memory to recover stability', 'info');
            }
          })
          .catch(e => console.warn('Failed to clear VRAM on error:', e));
        appState.generationCount = 0;
      }
    }
    showCreationForm();
  } finally {
    appState.isGenerating = false;
    appState.generationAbortController = null;
  }
}

// Reset and hide live previews
function resetLivePreview() {
  const previewImg = document.getElementById('generation-live-preview');
  if (previewImg) {
    previewImg.src = '';
    previewImg.classList.add('hidden');
  }
}

// Creation Layout Views toggles
function showLoaderForm() {
  resetLivePreview();
  document.getElementById('main-workspace').classList.add('generating');
  document.getElementById('creation-form-container').classList.add('hidden');
  document.getElementById('improve-confirmation-container').classList.add('hidden');
  document.getElementById('art-preview-area').classList.add('hidden');
  document.getElementById('generation-loader').classList.remove('hidden');
}

function showArtPreview(url) {
  const previewImg = document.getElementById('generation-live-preview');
  const targetImg = document.getElementById('generated-art-img');

  // Pre-load the image to guarantee its size and dimensions are known immediately by the browser
  const tempImg = new Image();
  tempImg.src = url;
  
  const proceedWithTransition = () => {
    targetImg.src = url;
    if (previewImg) {
      previewImg.src = url;
      previewImg.classList.remove('hidden');
    }

    playMorphPreviewAnimation(previewImg, targetImg, () => {
      // changeState callback: perform DOM changes
      document.getElementById('main-workspace').classList.remove('generating');
      document.getElementById('creation-form-container').classList.add('hidden');
      document.getElementById('improve-confirmation-container').classList.add('hidden');
      document.getElementById('generation-loader').classList.add('hidden');
      
      const wrapper = document.getElementById('art-preview-area');
      wrapper.classList.remove('hidden');
    }, () => {
      // final callback after animation finishes
      resetLivePreview();
    });
  };

  if (tempImg.complete) {
    proceedWithTransition();
  } else {
    tempImg.onload = proceedWithTransition;
    tempImg.onerror = proceedWithTransition; // fallback if load fails
  }
}

function showCreationForm() {
  resetLivePreview();
  document.getElementById('main-workspace').classList.remove('generating');
  document.getElementById('generation-loader').classList.add('hidden');
  document.getElementById('art-preview-area').classList.add('hidden');
  document.getElementById('improve-confirmation-container').classList.add('hidden');
  document.getElementById('creation-form-container').classList.remove('hidden');
  
  const promptInput = document.getElementById('prompt-text-input');

  // Clean up last surprise tags if any
  if (appState.lastSurpriseTags && appState.lastSurpriseTags.length > 0) {
    appState.lastSurpriseTags.forEach(tag => {
      const idx = appState.activeTags.indexOf(tag);
      if (idx !== -1) {
        appState.activeTags.splice(idx, 1);
      }
      if (promptInput) {
        promptInput.value = stripTagFromText(promptInput.value, tag);
      }
    });
    appState.lastSurpriseTags = []; // Reset
    renderActiveTagsChips();
    renderCategoryTags();
  }
  
  // Strip active tags from prompt input to prevent duplication or leftover tags
  if (promptInput) {
    appState.activeTags.forEach(tag => {
      promptInput.value = stripTagFromText(promptInput.value, tag);
    });
  }
}

function showImproveConfirmation(improvedText) {
  resetLivePreview();
  document.getElementById('main-workspace').classList.remove('generating');
  document.getElementById('generation-loader').classList.add('hidden');
  document.getElementById('art-preview-area').classList.add('hidden');
  document.getElementById('creation-form-container').classList.add('hidden');
  
  const improvedPreview = document.getElementById('improved-prompt-preview');
  if (improvedPreview) {
    improvedPreview.value = improvedText;
  }
  document.getElementById('improve-confirmation-container').classList.remove('hidden');
}

// ─── AI Help Prompt Assistant Chat Logic ───────────────────────────
async function sendChatMessage(text) {
  const chatInput = document.getElementById('chat-text-input');
  chatInput.value = '';

  // Abort any running chat message request
  if (appState.chatAbortController) {
    appState.chatAbortController.abort();
  }

  appState.chatAbortController = new AbortController();

  // Add User message bubble
  appendChatBubble(text, 'user');

  // Push to history
  appState.chatHistory.push({ role: 'user', content: text });

  // Add Assistant empty thinking bubble
  const assistantBubble = appendChatBubble('Thinking...', 'assistant');

  // Get current text prompt from workspace
  const promptInput = document.getElementById('prompt-text-input');
  const currentPromptText = promptInput ? promptInput.value.trim() : '';

  try {
    await aiService.streamHelpChat(
      appState.chatHistory,
      appState.activeTags,
      currentPromptText,
      appState.chatAbortController.signal,
      (textChunk) => {
        // Stream chunk update (parsing suggestions on chunk is fine, but we parse correctly)
        const parsed = parseSuggestions(textChunk);
        assistantBubble.querySelector('.chat-bubble-text-content').innerHTML = parseMarkdown(parsed.cleanText || '...');
      },
      (finalText) => {
        // Stream completed
        const parsed = parseSuggestions(finalText);
        assistantBubble.querySelector('.chat-bubble-text-content').innerHTML = parseMarkdown(parsed.cleanText);
        
        // Push completed message to state history
        appState.chatHistory.push({ role: 'assistant', content: finalText });

        // If suggestions exist, append interactive acceptance widgets under message
        if (parsed.suggestions && parsed.suggestions.length > 0) {
          appendSuggestionsWidgets(assistantBubble, parsed.suggestions);
        }
      },
      (err) => {
        assistantBubble.querySelector('.chat-bubble-text-content').textContent = `Failed to get assistance: ${err.message}`;
      }
    );
  } catch (err) {
    console.error(err);
  } finally {
    appState.chatAbortController = null;
  }
}

function appendChatBubble(text, sender) {
  const container = document.getElementById('chat-messages-container');
  if (!container) return null;

  const bubbleWrapper = document.createElement('div');
  bubbleWrapper.className = sender === 'user' ? 'user-chat-message' : 'assistant-chat-message';
  
  const textDiv = document.createElement('div');
  textDiv.className = 'chat-bubble-text-content';
  if (sender === 'user') {
    textDiv.textContent = text;
  } else {
    textDiv.innerHTML = parseMarkdown(text);
  }
  bubbleWrapper.appendChild(textDiv);

  container.appendChild(bubbleWrapper);
  
  // Scroll to bottom
  container.scrollTop = container.scrollHeight;
  return bubbleWrapper;
}

function appendSuggestionsWidgets(bubbleElement, suggestions) {
  const container = document.createElement('div');
  container.className = 'chat-suggestions-container';

  suggestions.forEach(sug => {
    const card = document.createElement('div');
    const isAdd = sug.action === 'add';
    card.className = `suggestion-item-card ${isAdd ? 'add-suggestion' : 'remove-suggestion'}`;

    card.innerHTML = `
      <div class="suggestion-tag-info">
        <span class="suggestion-tag-title ${isAdd ? 'add-type' : 'remove-type'}">
          ${isAdd ? '+' : '-'} ${sug.tag}
        </span>
        ${sug.description ? `<span class="suggestion-tag-desc">${sug.description}</span>` : ''}
      </div>
      <div class="suggestion-buttons-row">
        <button class="action-suggest-btn accept">Accept</button>
        <button class="action-suggest-btn reject">Reject</button>
      </div>
    `;

    // Accept suggestion action
    card.querySelector('.accept').addEventListener('click', () => {
      if (isAdd) {
        if (!appState.activeTags.includes(sug.tag)) {
          appState.activeTags.push(sug.tag);
          showToast(`Tag added: ${sug.tag}`);
          // Strip from prompt input to avoid duplication
          const promptInput = document.getElementById('prompt-text-input');
          if (promptInput) {
            promptInput.value = stripTagFromText(promptInput.value, sug.tag);
          }
        }
      } else {
        removeActiveTag(sug.tag);
        showToast(`Tag removed: ${sug.tag}`);
      }
      renderActiveTagsChips();
      renderCategoryTags();
      card.remove(); // Remove widget card
    });

    // Reject suggestion action
    card.querySelector('.reject').addEventListener('click', () => {
      card.remove();
    });

    container.appendChild(card);
  });

  bubbleElement.appendChild(container);
  
  // Re-scroll thread to bottom
  const thread = document.getElementById('chat-messages-container');
  thread.scrollTop = thread.scrollHeight;
}

// ─── Tags Addon & Category Management Controller ───────────────────
function initAddonManager() {
  renderAddonCategories();
  renderAddonImportSelect();

  const fileInput = document.getElementById('addon-import-file');
  const btnChooseFile = document.getElementById('btn-addon-choose-file');
  const fileNameDiv = document.getElementById('addon-chosen-file-name');

  if (btnChooseFile && fileInput) {
    btnChooseFile.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      if (fileInput.files && fileInput.files.length > 0) {
        if (fileInput.files.length === 1) {
          fileNameDiv.textContent = fileInput.files[0].name;
        } else {
          fileNameDiv.textContent = `${fileInput.files.length} files selected`;
        }
      } else {
        fileNameDiv.textContent = 'No file selected';
      }
    });
  }

  const btnAddCategory = document.getElementById('btn-addon-add-category');
  if (btnAddCategory) {
    btnAddCategory.addEventListener('click', () => {
      const keyInput = document.getElementById('addon-category-key');
      const nameInput = document.getElementById('addon-category-name');
      const key = keyInput.value.trim();
      const name = nameInput.value.trim();

      if (!key || !name) {
        showToast('Key and Name are required', 'error');
        return;
      }

      const ok = tagsDatabase.addCategory(key, name);
      if (ok) {
        showToast(`Category "${name}" added`, 'success');
        keyInput.value = '';
        nameInput.value = '';
        
        renderAddonCategories();
        renderAddonImportSelect();
        renderAdvancedCategories();
        renderSurpriseCategories();
      } else {
        showToast('Category already exists or key is invalid', 'error');
      }
    });
  }

  const btnImportJson = document.getElementById('btn-addon-import-json');
  if (btnImportJson) {
    btnImportJson.addEventListener('click', async () => {
      if (!fileInput.files || fileInput.files.length === 0) {
        showToast('Please select one or more JSON files first', 'error');
        return;
      }

      const select = document.getElementById('addon-import-category-select');
      let targetCategory = select.value;

      const readFileAsText = (file) => {
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = (e) => resolve(e.target.result);
          reader.onerror = (e) => reject(e);
          reader.readAsText(file);
        });
      };

      const files = Array.from(fileInput.files);
      let totalSuccessCount = 0;
      let totalFailedCount = 0;
      let totalImportedTags = 0;

      for (const file of files) {
        try {
          const text = await readFileAsText(file);
          const data = JSON.parse(text);
          let importedCount = 0;
          let importSuccess = false;
          
          if (data && typeof data === 'object' && !Array.isArray(data)) {
            // Case 1: Category Pack JSON (optionally with data.tags and/or data.subcategories)
            if (data.category && data.name) {
              const catKey = data.category.trim().toLowerCase();
              const catName = data.name.trim();
              tagsDatabase.addCategory(catKey, catName);
              
              let tagsToImport = [];
              if (Array.isArray(data.tags)) {
                tagsToImport = tagsToImport.concat(data.tags);
              }
              if (Array.isArray(data.subcategories)) {
                data.subcategories.forEach(sub => {
                  if (sub.name && Array.isArray(sub.tags)) {
                    const subTags = sub.tags.map(t => ({
                      ...t,
                      subcategory: sub.name.trim()
                    }));
                    tagsToImport = tagsToImport.concat(subTags);
                  }
                });
              }
              
              if (tagsToImport.length > 0) {
                importSuccess = tagsDatabase.importTags(catKey, tagsToImport);
                importedCount = tagsToImport.length;
              } else {
                importSuccess = true; // category created
              }
              
              if (importSuccess) {
                totalSuccessCount++;
                totalImportedTags += importedCount;
              } else {
                totalFailedCount++;
              }
            } 
            // Case 2: Subcategories List JSON (requires target category in dropdown)
            else if (data.subcategories && Array.isArray(data.subcategories)) {
              if (!targetCategory) {
                showToast(`Please select a target category for the list in "${file.name}"`, 'error');
                totalFailedCount++;
                continue;
              }
              let tagsToImport = [];
              data.subcategories.forEach(sub => {
                if (sub.name && Array.isArray(sub.tags)) {
                  const subTags = sub.tags.map(t => ({
                    ...t,
                    subcategory: sub.name.trim()
                  }));
                  tagsToImport = tagsToImport.concat(subTags);
                }
              });
              
              if (tagsToImport.length > 0) {
                importSuccess = tagsDatabase.importTags(targetCategory, tagsToImport);
                importedCount = tagsToImport.length;
              }
              
              if (importSuccess) {
                totalSuccessCount++;
                totalImportedTags += importedCount;
              } else {
                totalFailedCount++;
              }
            } else {
              showToast(`Invalid JSON format in "${file.name}": missing category key or subcategories`, 'error');
              totalFailedCount++;
            }
          } else if (Array.isArray(data)) {
            // Case 3: Flat tag list
            if (!targetCategory) {
              showToast(`Please select a target category for the list in "${file.name}"`, 'error');
              totalFailedCount++;
              continue;
            }
            const ok = tagsDatabase.importTags(targetCategory, data);
            if (ok) {
              totalSuccessCount++;
              totalImportedTags += data.length;
            } else {
              totalFailedCount++;
            }
          } else {
            showToast(`Invalid JSON tags format in "${file.name}"`, 'error');
            totalFailedCount++;
          }
        } catch (err) {
          showToast(`Failed to parse JSON file "${file.name}"`, 'error');
          totalFailedCount++;
        }
      }

      if (totalSuccessCount > 0) {
        showToast(`Successfully imported ${totalSuccessCount} files (${totalImportedTags} tags total)`, 'success');
      }
      if (totalFailedCount > 0) {
        showToast(`Failed to import ${totalFailedCount} files`, 'error');
      }

      fileInput.value = '';
      fileNameDiv.textContent = 'No file selected';

      renderAddonCategories();
      renderAddonImportSelect();
      renderAdvancedCategories();
      renderCategoryTags();
      renderSurpriseCategories();
    });
  }

  const btnResetTags = document.getElementById('btn-addon-reset-tags');
  if (btnResetTags) {
    btnResetTags.addEventListener('click', () => {
      if (confirm('Are you sure you want to reset all custom tags and categories to defaults?')) {
        const promptInput = document.getElementById('prompt-text-input');
        if (promptInput) {
          appState.activeTags.forEach(tag => {
            promptInput.value = stripTagFromText(promptInput.value, tag);
          });
        }
        tagsDatabase.resetToDefaults();
        showToast('Tags reset to defaults', 'info');
        
        appState.activeCategory = 'pose';
        appState.activeTags = [];

        renderAddonCategories();
        renderAddonImportSelect();
        renderAdvancedCategories();
        renderCategoryTags();
        renderActiveTagsChips();
        renderSurpriseCategories();
      }
    });
  }
}

function renderAddonCategories() {
  const container = document.getElementById('addon-categories-list');
  if (!container) return;

  container.innerHTML = '';
  const categories = tagsDatabase.getAllCategories();
  
  let hasCategories = false;
  for (const key in categories) {
    hasCategories = true;
    const cat = categories[key];
    const isCustom = cat.isCustom;
    const count = cat.tags ? cat.tags.length : 0;

    const row = document.createElement('div');
    row.className = 'addon-category-row';
    row.innerHTML = `
      <div class="addon-cat-details">
        <span class="addon-cat-name">${cat.name}</span>
        <span class="addon-cat-meta">${key} (${count} tags)${isCustom ? ' <span class="custom-badge">custom</span>' : ''}</span>
      </div>
      <button class="btn-addon-delete-cat" data-key="${key}" title="Delete Category">
        &times;
      </button>
    `;

    const btnDel = row.querySelector('.btn-addon-delete-cat');
    btnDel.addEventListener('click', () => {
      if (confirm(`Are you sure you want to delete category "${cat.name}"? This will delete all its tags.`)) {
        tagsDatabase.deleteCategory(key);
        showToast(`Category "${cat.name}" deleted`, 'info');
        
        if (appState.activeCategory === key) {
          appState.activeCategory = 'pose';
        }
        
        const tagsOfCat = cat.tags ? cat.tags.map(t => t.tag) : [];
        const promptInput = document.getElementById('prompt-text-input');
        if (promptInput) {
          tagsOfCat.forEach(tag => {
            promptInput.value = stripTagFromText(promptInput.value, tag);
          });
        }
        appState.activeTags = appState.activeTags.filter(t => !tagsOfCat.includes(t));

        renderAddonCategories();
        renderAddonImportSelect();
        renderAdvancedCategories();
        renderCategoryTags();
        renderActiveTagsChips();
        renderSurpriseCategories();
      }
    });

    container.appendChild(row);
  }

  if (!hasCategories) {
    container.innerHTML = '<div style="font-size:11px; color:var(--text-tertiary); text-align:center; padding: 12px 0;">No active categories</div>';
  }
}

function renderAddonImportSelect() {
  const select = document.getElementById('addon-import-category-select');
  if (!select) return;

  const currentVal = select.value;
  select.innerHTML = '<option value="">-- Select Category or auto-detect --</option>';
  const categories = tagsDatabase.getAllCategories();
  
  for (const key in categories) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = categories[key].name;
    select.appendChild(opt);
  }

  if (categories[currentVal]) {
    select.value = currentVal;
  }
}

// ─── Surprise Me Logic ──────────────────────────────────────────────
function getSurpriseCategories() {
  const settings = settingsStore.get();
  return settings.surprise_me_categories || {};
}

function isCategoryRandomized(categoryKey) {
  const surpriseSettings = getSurpriseCategories();
  if (surpriseSettings[categoryKey] === undefined) {
    return true; // Default to true
  }
  return !!surpriseSettings[categoryKey];
}

function setCategoryRandomized(categoryKey, enabled) {
  const surpriseSettings = { ...getSurpriseCategories() };
  surpriseSettings[categoryKey] = enabled;
  settingsStore.save({ surprise_me_categories: surpriseSettings });
}

function renderSurpriseCategories() {
  const container = document.getElementById('surprise-categories-list');
  if (!container) return;

  container.innerHTML = '';
  const categories = tagsDatabase.getAllCategories();
  
  for (const key in categories) {
    const cat = categories[key];
    const isChecked = isCategoryRandomized(key);
    
    const label = document.createElement('label');
    label.className = 'surprise-category-item';
    label.innerHTML = `
      <input type="checkbox" data-category="${key}" ${isChecked ? 'checked' : ''}>
      <span>${cat.name}</span>
    `;
    
    const checkbox = label.querySelector('input');
    checkbox.addEventListener('change', (e) => {
      setCategoryRandomized(key, e.target.checked);
    });
    
    container.appendChild(label);
  }
}

function initSurpriseMe() {
  renderSurpriseCategories();

  const dropdown = document.getElementById('surprise-settings-dropdown');
  const btnSettings = document.getElementById('btn-surprise-settings');
  const btnSurprise = document.getElementById('btn-surprise-me');

  if (btnSettings && dropdown) {
    btnSettings.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.classList.toggle('hidden');
    });

    document.addEventListener('click', (e) => {
      if (!dropdown.classList.contains('hidden')) {
        const container = document.querySelector('.split-button-container');
        if (container && !container.contains(e.target)) {
          dropdown.classList.add('hidden');
        }
      }
    });
  }

  if (btnSurprise) {
    btnSurprise.addEventListener('click', async () => {
      const categories = tagsDatabase.getAllCategories();
      let addedAny = false;
      const tagsToAdd = [];

      for (const key in categories) {
        if (isCategoryRandomized(key)) {
          const tags = tagsDatabase.getCategoryTags(key);
          if (tags && tags.length > 0) {
            const randomIndex = Math.floor(Math.random() * tags.length);
            const selectedTag = tags[randomIndex].tag;

            if (!appState.activeTags.includes(selectedTag)) {
              tagsToAdd.push(selectedTag);
            }
          }
        }
      }

      if (tagsToAdd.length > 0) {
        appState.lastSurpriseTags = [...tagsToAdd];
        appState.activeTags.push(...tagsToAdd);

        // Strip the newly added active tags from prompt input if already present there
        const promptInput = document.getElementById('prompt-text-input');
        if (promptInput) {
          tagsToAdd.forEach(tag => {
            promptInput.value = stripTagFromText(promptInput.value, tag);
          });
        }

        addedAny = true;
      } else {
        appState.lastSurpriseTags = [];
      }

      if (addedAny) {
        renderActiveTagsChips();
        renderCategoryTags();
      }

      // Generate art immediately with the combined prompt
      startImageGeneration();
    });
  }
}

// ─── Image Editor Controller ───────────────────────────────────────
function enterEditorMode(imageUrl, promptText = '', tagsArray = []) {
  appState.editorActive = true;
  appState.editorSourceUrl = imageUrl;
  appState.editorOriginalBlob = null;

  // Set prompt and tags in standard input fields so the user can edit them
  const promptInput = document.getElementById('prompt-text-input');
  if (promptInput) {
    let cleanPrompt = promptText || '';
    // Strip tags from prompt text input so they only reside in tags list
    if (tagsArray && tagsArray.length > 0) {
      appState.activeTags = [...tagsArray];
      tagsArray.forEach(tag => {
        cleanPrompt = stripTagFromText(cleanPrompt, tag);
      });
    } else {
      appState.activeTags = [];
    }
    promptInput.value = cleanPrompt.trim();
  } else {
    appState.activeTags = tagsArray ? [...tagsArray] : [];
  }
  
  renderActiveTagsChips();
  renderCategoryTags();

  // Hide all screens
  document.getElementById('main-workspace').classList.remove('generating');
  document.getElementById('creation-form-container').classList.add('hidden');
  document.getElementById('improve-confirmation-container').classList.add('hidden');
  document.getElementById('art-preview-area').classList.add('hidden');
  document.getElementById('generation-loader').classList.add('hidden');
  
  // Show editor screen
  const editorContainer = document.getElementById('image-editor-container');
  editorContainer.classList.remove('hidden');

  // Load the image
  const editorImg = document.getElementById('editor-source-img');
  editorImg.src = ''; // reset first
  editorImg.src = imageUrl;

  // Fetch image blob asynchronously
  fetch(imageUrl)
    .then(r => r.blob())
    .then(b => {
      appState.editorOriginalBlob = b;
    })
    .catch(err => {
      console.warn("Failed to fetch image blob for editor:", err);
    });

  showToast('Entered Editor Mode', 'info');
}

function exitEditorMode() {
  appState.editorActive = false;
  appState.editorSourceUrl = null;
  appState.editorOriginalBlob = null;

  // Hide editor screen
  document.getElementById('image-editor-container').classList.add('hidden');
  
  // Return to creation form or preview
  if (appState.generatedImageUrl) {
    showArtPreview(appState.generatedImageUrl);
  } else {
    showCreationForm();
  }
  
  // Clean up canvas drawings
  const canvas = document.getElementById('editor-mask-canvas');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  
  showToast('Exited Editor Mode', 'info');
}

function resizeCanvasToMatchImage() {
  const img = document.getElementById('editor-source-img');
  const canvas = document.getElementById('editor-mask-canvas');
  const wrapper = document.getElementById('editor-canvas-wrapper');
  if (!img || !canvas || !wrapper) return;

  const w = img.clientWidth;
  const h = img.clientHeight;

  if (w > 0 && h > 0) {
    wrapper.style.width = `${w}px`;
    wrapper.style.height = `${h}px`;
    canvas.style.width = '100%';
    canvas.style.height = '100%';
  }
}

// Prepare JPEG blobs of matched sizes for source image and mask
async function prepareEditorBlobs() {
  const img = document.getElementById('editor-source-img');
  const maskCanvas = document.getElementById('editor-mask-canvas');
  
  // Calculate size constrained to maximum 1536px (matching aspect ratio)
  const maxDim = 1536;
  let w = img.naturalWidth || 832;
  let h = img.naturalHeight || 1216;
  if (w > maxDim || h > maxDim) {
    if (w > h) {
      h = Math.round((h * maxDim) / w);
      w = maxDim;
    } else {
      w = Math.round((w * maxDim) / h);
      h = maxDim;
    }
  }
  
  // 1. Export source image to JPEG (3 channels)
  const srcBlob = await new Promise((resolve) => {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    canvas.toBlob(resolve, 'image/jpeg', 0.95);
  });
  
  // 2. Export mask to black-and-white JPEG (3 channels)
  const maskBlob = await new Promise((resolve) => {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(maskCanvas, 0, 0, w, h);
    
    // Perform threshold to ensure absolute black and white
    const imgData = ctx.getImageData(0, 0, w, h);
    const data = imgData.data;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] > 0 && (data[i] > 10 || data[i + 1] > 10 || data[i + 2] > 10)) {
        // Pixel has drawing, set to white
        data[i] = 255;
        data[i + 1] = 255;
        data[i + 2] = 255;
      } else {
        // Unpainted, set to black
        data[i] = 0;
        data[i + 1] = 0;
        data[i + 2] = 0;
      }
      data[i + 3] = 255;
    }
    ctx.putImageData(imgData, 0, 0);
    canvas.toBlob(resolve, 'image/jpeg', 0.95);
  });
  
  return { srcBlob, maskBlob };
}

function initImageEditor() {
  const img = document.getElementById('editor-source-img');
  const canvas = document.getElementById('editor-mask-canvas');
  const cursor = document.getElementById('editor-brush-cursor');

  if (!img || !canvas) return;

  // Resize canvas when image finishes loading
  img.addEventListener('load', () => {
    // Wait for display size calculation
    setTimeout(() => {
      canvas.width = img.naturalWidth || 832;
      canvas.height = img.naturalHeight || 1216;
      resizeCanvasToMatchImage();
    }, 100);
  });

  // Track window resize to keep canvas aligned
  window.addEventListener('resize', () => {
    if (appState.editorActive) {
      resizeCanvasToMatchImage();
    }
  });

  // Helper to get translated coordinates relative to natural image dimensions
  function getCoordinates(e) {
    const rect = canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const x = ((clientX - rect.left) / rect.width) * canvas.width;
    const y = ((clientY - rect.top) / rect.height) * canvas.height;
    return { x, y, clientX, clientY };
  }

  // Mouse / Touch drawing events
  function startDraw(e) {
    if (appState.editorMode === 'img2img') return; // no drawing in global mode
    
    // Prevent scrolling on touches
    if (e.cancelable) e.preventDefault();
    
    appState.isDrawing = true;
    const { x, y } = getCoordinates(e);
    
    const ctx = canvas.getContext('2d');
    ctx.beginPath();
    ctx.moveTo(x, y);
  }

  function drawMove(e) {
    if (appState.editorMode === 'img2img') {
      if (cursor) cursor.style.display = 'none';
      return;
    }

    const { x, y, clientX, clientY } = getCoordinates(e);
    const rect = canvas.getBoundingClientRect();

    // Position circular brush indicator relative to canvas container
    if (cursor) {
      const parentRect = canvas.parentElement.getBoundingClientRect();
      const relativeX = clientX - parentRect.left;
      const relativeY = clientY - parentRect.top;
      cursor.style.left = `${relativeX}px`;
      cursor.style.top = `${relativeY}px`;
      cursor.style.width = `${appState.brushSize}px`;
      cursor.style.height = `${appState.brushSize}px`;
      cursor.style.display = 'block';
    }

    if (!appState.isDrawing) return;

    // Prevent scrolling
    if (e.cancelable) e.preventDefault();

    const ctx = canvas.getContext('2d');
    ctx.lineTo(x, y);
    
    // Scale brush size to natural canvas resolution
    ctx.lineWidth = appState.brushSize * (canvas.width / rect.width);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (appState.brushMode === 'draw') {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = 'rgba(0, 243, 255, 0.5)'; // Glowing neon cyan
    } else {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = 'rgba(0, 0, 0, 1.0)';
    }

    ctx.stroke();
  }

  function stopDraw() {
    appState.isDrawing = false;
  }

  // Bind Mouse events
  canvas.addEventListener('mousedown', startDraw);
  canvas.addEventListener('mousemove', drawMove);
  canvas.addEventListener('mouseup', stopDraw);
  canvas.addEventListener('mouseleave', () => {
    stopDraw();
    if (cursor) cursor.style.display = 'none';
  });

  // Bind Touch events (for mobile / tablet editing)
  canvas.addEventListener('touchstart', startDraw, { passive: false });
  canvas.addEventListener('touchmove', drawMove, { passive: false });
  canvas.addEventListener('touchend', stopDraw);
  canvas.addEventListener('touchcancel', stopDraw);

  // Editor mode selections
  const btnInpaint = document.getElementById('btn-editor-mode-inpaint');
  const btnImg2Img = document.getElementById('btn-editor-mode-img2img');
  const brushControls = document.getElementById('editor-brush-controls');

  if (btnInpaint && btnImg2Img && brushControls) {
    btnInpaint.addEventListener('click', () => {
      appState.editorMode = 'inpaint';
      btnInpaint.classList.add('active');
      btnImg2Img.classList.remove('active');
      brushControls.style.display = 'block';
      const noiseGroup = document.getElementById('editor-add-noise-group');
      if (noiseGroup) noiseGroup.style.display = 'flex';
      
      // Update denoise default for inpainting
      document.getElementById('input-editor-denoise').value = 0.75;
      document.getElementById('editor-denoise-val').textContent = '0.75';
      appState.denoise = 0.75;
      
      // Resize canvas just in case layout shifted
      resizeCanvasToMatchImage();
    });

    btnImg2Img.addEventListener('click', () => {
      appState.editorMode = 'img2img';
      btnImg2Img.classList.add('active');
      btnInpaint.classList.remove('active');
      brushControls.style.display = 'none';
      const noiseGroup = document.getElementById('editor-add-noise-group');
      if (noiseGroup) noiseGroup.style.display = 'none';
      
      // Update denoise default for global img2img
      document.getElementById('input-editor-denoise').value = 0.55;
      document.getElementById('editor-denoise-val').textContent = '0.55';
      appState.denoise = 0.55;
    });
  }

  // Brush Mode drawing/erasing toggle
  const btnBrushDraw = document.getElementById('btn-editor-brush-draw');
  const btnBrushErase = document.getElementById('btn-editor-brush-erase');

  if (btnBrushDraw && btnBrushErase) {
    btnBrushDraw.addEventListener('click', () => {
      appState.brushMode = 'draw';
      btnBrushDraw.classList.add('active');
      btnBrushErase.classList.remove('active');
    });

    btnBrushErase.addEventListener('click', () => {
      appState.brushMode = 'erase';
      btnBrushErase.classList.add('active');
      btnBrushDraw.classList.remove('active');
    });
  }

  // Brush size range slider
  const sliderBrushSize = document.getElementById('input-editor-brush-size');
  const txtBrushSize = document.getElementById('editor-brush-size-val');
  if (sliderBrushSize && txtBrushSize) {
    sliderBrushSize.addEventListener('input', (e) => {
      const size = parseInt(e.target.value);
      appState.brushSize = size;
      txtBrushSize.textContent = `${size}px`;
    });
  }

  // Clear mask button
  const btnClearMask = document.getElementById('btn-editor-clear-mask');
  if (btnClearMask) {
    btnClearMask.addEventListener('click', () => {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      showToast('Mask cleared', 'info');
    });
  }

  // Denoising strength range slider
  const sliderDenoise = document.getElementById('input-editor-denoise');
  const txtDenoise = document.getElementById('editor-denoise-val');
  if (sliderDenoise && txtDenoise) {
    sliderDenoise.addEventListener('input', (e) => {
      const denoise = parseFloat(e.target.value);
      appState.denoise = denoise;
      txtDenoise.textContent = denoise.toFixed(2);
    });
  }

  // Cancel Button
  document.getElementById('btn-editor-cancel').addEventListener('click', () => {
    exitEditorMode();
  });

  // Generate Edit Button
  document.getElementById('btn-editor-generate').addEventListener('click', startImageEditGeneration);
}

async function startImageEditGeneration() {
  // If the editor has its own prompt, use it; otherwise fall back to the main prompt
  const editorPromptEl = document.getElementById('editor-prompt-input');
  const editorPromptText = editorPromptEl ? editorPromptEl.value.trim() : '';
  const finalPrompt = editorPromptText || getFinalPrompt();

  if (!finalPrompt.trim()) {
    showToast('Prompt cannot be empty', 'error');
    return;
  }

  // Show loader view
  showLoaderForm();
  const stageText = document.getElementById('loader-stage-text');
  stageText.textContent = 'Preparing image and mask...';

  try {
    // 1. Export blobs from canvas
    const { srcBlob, maskBlob } = await prepareEditorBlobs();

    // 2. Setup abort controller
    appState.generationAbortController = new AbortController();
    appState.isGenerating = true;

    stageText.textContent = 'Uploading images to ComfyUI...';

    const editParams = {
      sourceImageBlob: srcBlob,
      maskImageBlob: appState.editorMode === 'inpaint' ? maskBlob : null,
      denoise: appState.denoise,
      mode: appState.editorMode,
      addNoise: document.getElementById('input-editor-add-noise')?.checked ?? true
    };

    const activeLoras = appState.loras.filter(l => l.enabled && l.name);
    const imgUrl = await generateImageComfyUI(
      finalPrompt,
      (status) => {
        stageText.textContent = status;
      },
      appState.generationAbortController.signal,
      (previewUrl) => {
        const previewImg = document.getElementById('generation-live-preview');
        if (previewImg) {
          previewImg.src = previewUrl;
          previewImg.classList.remove('hidden');
        }
      },
      editParams,
      activeLoras
    );

    appState.generatedImageUrl = imgUrl;
    appState.editorActive = false; // exit editor active status
    document.getElementById('image-editor-container').classList.add('hidden'); // hide editor
    
    showToast('Image edited successfully!', 'success');
    showArtPreview(imgUrl);

    // Track generation and clear VRAM if interval reached
    appState.generationCount++;
    const settings = settingsStore.get();
    const interval = settings.comfyui_free_memory_interval ?? 3;
    if (interval > 0 && appState.generationCount >= interval) {
      clearComfyUIMemory()
        .then(success => {
          if (success) {
            showToast('Auto-cleared VRAM cache', 'info');
          }
        })
        .catch(e => console.warn('Failed to auto-clear VRAM:', e));
      appState.generationCount = 0;
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      showToast(`Editing failed: ${err.message}`, 'error');
      console.error(err);
      
      // Clean VRAM to recover stability
      const settings = settingsStore.get();
      const interval = settings.comfyui_free_memory_interval ?? 3;
      if (interval > 0) {
        clearComfyUIMemory()
          .then(success => {
            if (success) {
              showToast('Cleared VRAM memory to recover stability', 'info');
            }
          })
          .catch(e => console.warn('Failed to clear VRAM on error:', e));
        appState.generationCount = 0;
      }
    }
    // Return to editor
    document.getElementById('image-editor-container').classList.remove('hidden');
    document.getElementById('main-workspace').classList.remove('generating');
    document.getElementById('generation-loader').classList.add('hidden');
  } finally {
    appState.isGenerating = false;
    appState.generationAbortController = null;
  }
}

// ─── LoRA Management Functions ──────────────────────────────────────
function addLoraBlock() {
  const newLora = {
    id: Date.now() + Math.random(),
    name: '',
    strength: 1.0,
    enabled: true
  };
  appState.loras.push(newLora);
  renderLorasList();
  showToast('LoRA block added');
}

function togglePinLora(name) {
  const idx = appState.pinnedLoras.indexOf(name);
  if (idx === -1) {
    appState.pinnedLoras.push(name);
    showToast(`Pinned ${name} to top`);
  } else {
    appState.pinnedLoras.splice(idx, 1);
    showToast(`Unpinned ${name}`);
  }
  localStorage.setItem('comfygen_pinned_loras', JSON.stringify(appState.pinnedLoras));
  renderLorasList();
}

function renderLorasList() {
  const listContainer = document.getElementById('loras-list');
  if (!listContainer) return;

  listContainer.innerHTML = '';

  appState.loras.forEach(lora => {
    const block = document.createElement('div');
    block.className = `lora-block ${lora.enabled ? '' : 'disabled'}`;
    if (lora.enabled && lora.name) {
      block.classList.add('enabled-glow');
    }

    block.innerHTML = `
      <div class="lora-block-header">
        <div class="lora-dropdown">
          <button class="lora-dropdown-trigger">
            <span>${lora.name || 'Select Lora...'}</span>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
          </button>
          <div class="lora-dropdown-panel">
            <div class="lora-search-wrapper">
              <input type="text" class="lora-search-input" placeholder="Search LoRA...">
            </div>
            <div class="lora-dropdown-items"></div>
          </div>
        </div>
        <div class="lora-block-controls">
          <label class="lora-toggle-switch">
            <input type="checkbox" ${lora.enabled ? 'checked' : ''}>
            <span class="lora-toggle-slider"></span>
          </label>
          <button class="btn-delete-lora" title="Remove Lora">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
      </div>
      <div class="lora-slider-container">
        <div class="lora-slider-header">
          <span>Lora Strength</span>
          <span class="lora-slider-value">${lora.strength > 0 ? '+' : ''}${lora.strength.toFixed(1)}</span>
        </div>
        <input type="range" class="lora-slider" min="-5" max="5" step="0.1" value="${lora.strength}">
      </div>
    `;

    // Dropdown trigger toggle open
    const dropdownEl = block.querySelector('.lora-dropdown');
    const trigger = block.querySelector('.lora-dropdown-trigger');
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = dropdownEl.classList.contains('open');
      document.querySelectorAll('.lora-dropdown.open').forEach(el => el.classList.remove('open'));
      if (!isOpen) {
        dropdownEl.classList.add('open');
        dropdownEl.querySelector('.lora-search-input').focus();
      }
    });

    // Search input typing
    const searchInput = block.querySelector('.lora-search-input');
    searchInput.addEventListener('click', e => e.stopPropagation());
    searchInput.addEventListener('input', () => {
      const text = searchInput.value.toLowerCase();
      const items = block.querySelectorAll('.lora-dropdown-item');
      items.forEach(item => {
        const name = item.dataset.name.toLowerCase();
        if (name.includes(text)) {
          item.style.display = 'flex';
        } else {
          item.style.display = 'none';
        }
      });
    });

    // Populate dropdown items with pinning/sorting logic
    const itemsContainer = block.querySelector('.lora-dropdown-items');
    
    // Sort available loras: pinned ones go first, then alphabetical
    const sortedLoras = [...appState.availableLoras].sort((a, b) => {
      const aPinned = appState.pinnedLoras.includes(a);
      const bPinned = appState.pinnedLoras.includes(b);
      if (aPinned && !bPinned) return -1;
      if (!aPinned && bPinned) return 1;
      return a.localeCompare(b);
    });

    sortedLoras.forEach(name => {
      const isPinned = appState.pinnedLoras.includes(name);
      const isActive = lora.name === name;
      
      const item = document.createElement('div');
      item.className = `lora-dropdown-item ${isActive ? 'active' : ''}`;
      item.dataset.name = name;
      item.innerHTML = `
        <span class="lora-item-name" title="${name}">${name}</span>
        <button class="lora-item-pin ${isPinned ? 'pinned' : ''}" title="${isPinned ? 'Unpin from Top' : 'Pin to Top'}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="17" x2="12" y2="22"></line>
            <path d="M5 17h14v-1.76a2 2 0 0 0-.44-1.24l-2.78-3.48A2 2 0 0 1 15 9.28V4a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v5.28c0 .48-.17.94-.48 1.32l-2.78 3.48c-.28.35-.44.79-.44 1.24V17z"></path>
          </svg>
        </button>
      `;

      // Click to select
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        lora.name = name;
        renderLorasList();
      });

      // Click to pin/unpin
      item.querySelector('.lora-item-pin').addEventListener('click', (e) => {
        e.stopPropagation();
        togglePinLora(name);
      });

      itemsContainer.appendChild(item);
    });

    // Toggle Switch logic
    const toggle = block.querySelector('.lora-toggle-switch input');
    toggle.addEventListener('change', () => {
      lora.enabled = toggle.checked;
      if (lora.enabled) {
        block.classList.remove('disabled');
        if (lora.name) block.classList.add('enabled-glow');
      } else {
        block.classList.add('disabled');
        block.classList.remove('enabled-glow');
      }
    });

    // Slider input change
    const slider = block.querySelector('.lora-slider');
    const valDisplay = block.querySelector('.lora-slider-value');
    slider.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      lora.strength = val;
      valDisplay.textContent = val > 0 ? `+${val.toFixed(1)}` : val.toFixed(1);
    });

    // Delete block logic
    const btnDelete = block.querySelector('.btn-delete-lora');
    btnDelete.addEventListener('click', () => {
      appState.loras = appState.loras.filter(l => l.id !== lora.id);
      renderLorasList();
      showToast('LoRA block removed');
    });

    listContainer.appendChild(block);
  });
}



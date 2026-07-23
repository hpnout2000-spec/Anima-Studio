import { settingsStore } from './services/settings-store.js';
import { albumStore } from './services/album-store.js';
import { tagsDatabase } from './data/tags.js';
import { generateImageComfyUI, clearComfyUIMemory, getAvailableLoras, getLoraActivationTags } from './services/comfyui-service.js';
import { aiService, parseSuggestions, parseMarkdown } from './services/ai-service.js';
import { initLightbox } from './utils/lightbox.js';
import { getTagsFromGelbooruUrl } from './services/gelbooru-api.js';

// ─── Application State ─────────────────────────────────────────────
let appState = {
  activeMode: 'simple', // 'simple' or 'advanced'
  activePromptText: '',
  subPrompts: [], // List of { id, label, text }
  lastFocusedEditor: null,
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
  lastGenerationMode: null, // Track if last generation was 'creation' or 'editor'
  lastGenerationWasSurprise: false,
  tagWeights: {}, // Map of tag -> weight (e.g. 1.5, 0.5)
  knownCharTriggers: new Set(), // Track character triggers with commas
  
  // Editor State
  editorActive: false,
  editorSourceUrl: null,
  editorOriginalBlob: null,
  editorSourceImageId: null, // Track lineage
  editorMode: 'inpaint', // 'inpaint' or 'img2img'
  editProMode: 'global',  // 'global', 'details' or 'custom'
  editProCustomSettings: {
    resizeMethod: 'keep-proportion-64',
    paddingWidth: 64,
    improvedPrompt: true,
    negPromptFix: true,
    denoiseCap: true,
    noiseMask: true
  },
  editorOriginalPrompt: '',
  artistTagToggle: false,
  artistTagValue: null,
  brushSettingsCollapsed: true,
  brushMode: 'draw', // 'draw' or 'sketch'
  sketchColor: '#ff0000',
  brushSize: 20,
  denoise: 0.60,
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
    toast.style.animation = 'toastExit var(--ios-duration-normal) var(--ios-ease-accelerate) forwards';
    setTimeout(() => toast.remove(), 350);
  }, 4000);
}

function setDrawerBackdrop(active) {
  const backdrop = document.getElementById('drawer-backdrop');
  if (!backdrop) return;
  
  if (active) {
    backdrop.classList.add('active');
  } else {
    backdrop.classList.remove('active');
  }
}

let loaderActiveTimeout = null;
let loaderExitTimeout = null;

function smoothUpdateLoaderText(text) {
  const stageTextContainer = document.getElementById('loader-stage-text');
  if (!stageTextContainer) return;

  // Find the currently visible span
  const currentSpan = stageTextContainer.querySelector('.stage-text-span.active') ||
                      stageTextContainer.querySelector('.stage-text-span.stage-text-entering');

  // ── Progress bar ──────────────────────────────────────────────────
  let percent = 0;
  const match = text.match(/Step\s+(\d+)\s*\/\s*(\d+)/i);
  if (match) {
    const val = parseInt(match[1], 10), max = parseInt(match[2], 10);
    if (max > 0) percent = (val / max) * 100;
  } else if (text === 'Image ready!') {
    percent = 100;
  } else if (/Decoding|Saving image|Finalizing/.test(text)) {
    percent = 95;
  } else if (text === 'Running KSampler...') {
    percent = 5;
  }
  const progressBar = document.getElementById('loader-progress-bar');
  if (progressBar) progressBar.style.width = `${percent}%`;

  if (currentSpan && currentSpan.textContent === text) return;

  // ── Step-to-step: update in-place, no animation ───────────────────
  const stepRegex = /^Generating:\s*Step\s+\d+\/\d+$/i;
  if (currentSpan && stepRegex.test(currentSpan.textContent) && stepRegex.test(text)) {
    currentSpan.textContent = text;
    return;
  }

  // ── Cancel pending timers ─────────────────────────────────────────
  clearTimeout(loaderActiveTimeout);
  clearTimeout(loaderExitTimeout);

  // Remove any stale animating spans
  stageTextContainer.querySelectorAll('.stage-text-span.stage-text-exiting').forEach(el => el.remove());

  // ── 1. Snapshot old span → switch to exiting state ───────────────
  if (currentSpan) {
    currentSpan.className = 'stage-text-span stage-text-exiting';
    // Set initial wipe position (matches @property initial-value: -20%)
    currentSpan.style.setProperty('--loader-wipe-pos', '-20%');
  }

  // ── 2. Create new span in entering state ──────────────────────────
  const newSpan = document.createElement('span');
  newSpan.className = 'stage-text-span stage-text-entering';
  newSpan.textContent = text;
  // Set initial wipe position explicitly so transition has a from-value
  newSpan.style.setProperty('--loader-wipe-pos', '-35%');
  stageTextContainer.appendChild(newSpan);

  // ── 3. On next frame: animate both simultaneously ─────────────────
  // The old span exits immediately; the new span enters after a short
  // stagger delay so there is a visible gap of empty space between them.
  const ENTER_DELAY = 160; // ms — gap duration between exit start and enter start

  requestAnimationFrame(() => {
    // Force the browser to register both initial states
    newSpan.getBoundingClientRect();

    // Old span: starts exiting immediately
    if (currentSpan) {
      currentSpan.style.setProperty('--loader-wipe-pos', '100%');
      loaderExitTimeout = setTimeout(() => currentSpan.remove(), 700);
    }

    // New span: starts entering after ENTER_DELAY
    // During this delay the old text is fading out and there is empty space
    setTimeout(() => {
      newSpan.style.setProperty('--loader-wipe-pos', '100%');
    }, ENTER_DELAY);

    // Settle to stable .active state after enter animation completes
    loaderActiveTimeout = setTimeout(() => {
      newSpan.className = 'stage-text-span active';
      newSpan.style.removeProperty('--loader-wipe-pos');
    }, ENTER_DELAY + 580);
  });
}

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
  
  // position calculations for transform translate
  const destX = targetRect.left + (targetRect.width / 2) - destWidth / 2;
  const destY = targetRect.top + (targetRect.height / 2) - destHeight / 2;

  // Create overlay clone
  const clone = document.createElement('img');
  clone.src = imageElement.src;
  clone.className = 'flying-art-clone';

  // Set initial position via transform (fixed coordinate space)
  clone.style.transition = 'none';
  clone.style.left = '0px';
  clone.style.top = '0px';
  clone.style.transform = `translate(${srcRect.left}px, ${srcRect.top}px)`;
  clone.style.width = `${srcRect.width}px`;
  clone.style.height = `${srcRect.height}px`;
  clone.style.opacity = '1';
  clone.style.borderRadius = '12px';

  document.body.appendChild(clone);

  imageElement.style.opacity = '0';
  imageElement.style.pointerEvents = 'none';

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      clone.style.transition = '';
      // Move using transform translate
      clone.style.transform = `translate(${destX}px, ${destY}px)`;
      clone.style.width = `${destWidth}px`;
      clone.style.height = `${destHeight}px`;
      clone.style.opacity = isAlbumOpen ? '1' : '0';
      clone.style.borderRadius = isAlbumOpen ? '8px' : '50%';
    });
  });

  let callbackFired = false;
  let transitionEnded = false;
  let targetImgDecoded = false;

  function finishAnimation() {
    if (!transitionEnded || !targetImgDecoded) return;
    if (!callbackFired) {
      callbackFired = true;
      clone.remove();
      
      if (isAlbumOpen && targetElement.classList.contains('just-added-flying')) {
        targetElement.style.transition = 'none';
        targetElement.classList.remove('just-added-flying');
        targetElement.offsetHeight; // force reflow
        targetElement.style.transition = '';
      }
      
      imageElement.style.opacity = '';
      imageElement.style.pointerEvents = '';
      
      if (callback) callback();
    }
  }

  // Listen to transform transition end
  function onTransitionEnd(e) {
    if (e.propertyName !== 'transform') return;
    clone.removeEventListener('transitionend', onTransitionEnd);
    transitionEnded = true;
    finishAnimation();
  }
  clone.addEventListener('transitionend', onTransitionEnd);

  // Wait for target image to decode
  const targetImg = targetElement.querySelector('img');
  if (isAlbumOpen && targetImg) {
    const checkDecode = () => {
      if (typeof targetImg.decode === 'function') {
        targetImg.decode()
          .then(() => {
            targetImgDecoded = true;
            finishAnimation();
          })
          .catch(() => {
            targetImgDecoded = true;
            finishAnimation();
          });
      } else {
        targetImgDecoded = true;
        finishAnimation();
      }
    };

    if (targetImg.complete) {
      checkDecode();
    } else {
      targetImg.addEventListener('load', checkDecode, { once: true });
      targetImg.addEventListener('error', () => {
        targetImgDecoded = true;
        finishAnimation();
      }, { once: true });
    }
  } else {
    targetImgDecoded = true;
  }

  // Fallback cleanup at 700ms (500ms anim + 200ms buffer)
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
  }, 700);
}

// ─── Morphing Preview Animation ────────────────────────────────────
function playMorphPreviewAnimation(previewImg, targetImg, changeState, callback) {
  if (!previewImg || !targetImg) {
    if (changeState) changeState();
    if (callback) callback();
    return;
  }

  const srcRect = previewImg.getBoundingClientRect();
  const workspace = document.getElementById('main-workspace');
  const loader = document.getElementById('generation-loader');
  const previewArea = document.getElementById('art-preview-area');

  const origWorkspaceTransition = workspace.style.transition;
  workspace.style.transition = 'none';
  
  workspace.classList.remove('generating');
  loader.classList.add('hidden');
  previewArea.classList.remove('hidden');
  
  workspace.offsetHeight;
  
  const destRect = targetImg.getBoundingClientRect();
  
  workspace.classList.add('generating');
  loader.classList.remove('hidden');
  previewArea.classList.add('hidden');
  
  workspace.offsetHeight;
  workspace.style.transition = origWorkspaceTransition;

  const clone = document.createElement('img');
  clone.src = targetImg.src || previewImg.src;
  clone.className = 'morphing-preview-clone';

  clone.style.transition = 'none';
  clone.style.left = '0px';
  clone.style.top = '0px';
  clone.style.transform = `translate(${srcRect.left}px, ${srcRect.top}px)`;
  clone.style.width = `${srcRect.width}px`;
  clone.style.height = `${srcRect.height}px`;
  clone.style.opacity = '1';
  clone.style.borderRadius = '16px';

  document.body.appendChild(clone);

  previewImg.style.opacity = '0';

  if (changeState) changeState();

  targetImg.style.opacity = '0';

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      clone.style.transition = '';
      clone.style.transform = `translate(${destRect.left}px, ${destRect.top}px)`;
      clone.style.width = `${destRect.width}px`;
      clone.style.height = `${destRect.height}px`;
      clone.style.borderRadius = '12px';
    });
  });

  let callbackFired = false;
  const finishAnimation = () => {
    if (callbackFired) return;
    callbackFired = true;
    clone.remove();
    targetImg.style.opacity = '';
    previewImg.style.opacity = '';
    if (callback) callback();
  };
  
  clone.addEventListener('transitionend', (e) => {
    if (e.propertyName === 'transform' || e.propertyName === 'width') {
      finishAnimation();
    }
  });
  
  // Safety net: 700ms (500ms animation + 200ms buffer)
  setTimeout(finishAnimation, 700);
}

// ─── DOM Binding & Page Initialization ─────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Load stores
  await settingsStore.load();
  await tagsDatabase.load();
  
  // Prevent browser navigation on accidental drag/drop of images/files anywhere on the page.
  // The editor handles its own drops; at window level we block everything else.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  try {
    await albumStore.load();
    const savedImages = albumStore.getAll() || [];
    savedImages.forEach(img => {
      if (Array.isArray(img.tags)) {
        img.tags.forEach(t => {
          if (t && t.includes(',')) {
            appState.knownCharTriggers.add(t);
          }
        });
      }
    });
  } catch (e) {
    console.error('Failed to load album:', e);
  }

  // Initialize UI values
  initSettingsForm();
  initPromptEditor();
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

  // Bind Toggle All Subcategories Button
  const btnToggleAll = document.getElementById('btn-toggle-all-subcategories');
  if (btnToggleAll) {
    btnToggleAll.addEventListener('click', () => {
      const grid = document.getElementById('category-tags-grid');
      if (!grid) return;
      const containers = grid.querySelectorAll('.subcategory-tags-container');
      const headers = grid.querySelectorAll('.subcategory-header');
      
      let hasExpanded = false;
      containers.forEach(c => {
        if (!c.classList.contains('collapsed')) {
          hasExpanded = true;
        }
      });
      
      const shouldCollapse = hasExpanded;
      
      const tags = tagsDatabase.getCategoryTags(appState.activeCategory);
      const subnames = new Set();
      tags.forEach(item => {
        if (item.subcategory && item.subcategory.trim()) {
          subnames.add(item.subcategory.trim());
        }
      });
      
      subnames.forEach(subName => {
        const stateKey = `${appState.activeCategory}_${subName}`;
        appState.collapsedSubcategories[stateKey] = shouldCollapse;
      });
      
      containers.forEach(c => {
        if (shouldCollapse) {
          c.classList.add('collapsed');
        } else {
          c.classList.remove('collapsed');
        }
      });
      headers.forEach(h => {
        if (shouldCollapse) {
          h.classList.add('collapsed');
        } else {
          h.classList.remove('collapsed');
        }
      });
      
      btnToggleAll.textContent = shouldCollapse ? 'Expand All' : 'Collapse All';
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
        window.openLightbox(previewImg.src, getFinalPrompt(), appState.activeTags, null);
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

  // Click on backdrop — close all active drawers
  const backdrop = document.getElementById('drawer-backdrop');
  if (backdrop) {
    backdrop.addEventListener('click', () => {
      // Close all open drawers (except album-drawer)
      document.querySelectorAll('.floating-drawer.open').forEach(d => {
        if (d.id !== 'album-drawer') {
          d.classList.remove('open');
        }
      });
      document.querySelectorAll('.settings-sub-panel.open').forEach(p => {
        p.classList.remove('open');
      });
      document.querySelectorAll('.settings-nav-btn').forEach(b => {
        b.classList.remove('active');
      });
      setDrawerBackdrop(false);
    });
  }

  // Left Menu Open/Close
  btnToggleLeftMenu.addEventListener('click', () => {
    leftMenuDrawer.classList.add('open');
    setDrawerBackdrop(true);
  });

  btnCloseLeftMenu.addEventListener('click', (e) => {
    e.stopPropagation();
    leftMenuDrawer.classList.remove('open');
    setDrawerBackdrop(false);
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
    setDrawerBackdrop(false);
    window.switchView('create');
  });

  document.getElementById('menu-btn-album').addEventListener('click', () => {
    leftMenuDrawer.classList.remove('open');
    setDrawerBackdrop(false);
    window.switchView('album');
  });

  // Settings Open/Close
  menuBtnSettings.addEventListener('click', () => {
    initSettingsForm();
    settingsDrawer.classList.add('open');
    setDrawerBackdrop(true);
  });

  btnCloseSettings.addEventListener('click', () => {
    settingsDrawer.classList.remove('open');
    setDrawerBackdrop(false);
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
    setDrawerBackdrop(true);
  });

  btnCloseHelp.addEventListener('click', (e) => {
    e.stopPropagation();
    helpDrawer.classList.remove('open');
    setDrawerBackdrop(false);
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

  // Helper to toggle fields when Web Reference tab is active/inactive
  function toggleWorkspaceFieldsForWebref(hide) {
    const selectors = [
      '.prompt-section-label',
      '.prompt-input-container',
      '.prompt-preview-container',
      '.image-size-container',
      '#loras-wrapper',
      '.creation-actions'
    ];
    selectors.forEach(selector => {
      const el = document.querySelector(selector);
      if (el) {
        if (hide) {
          el.classList.add('hidden');
        } else {
          el.classList.remove('hidden');
        }
      }
    });
  }

  // 2. Tabs Bindings (Simple vs Advanced vs Web Reference vs Style Explorer vs Character Explorer)
  const tabSimple = document.getElementById('tab-mode-simple');
  const tabAdvanced = document.getElementById('tab-mode-advanced');
  const tabWebref = document.getElementById('tab-mode-webref');
  const tabStyleExplorer = document.getElementById('tab-mode-style-explorer');
  const tabCharExplorer = document.getElementById('tab-mode-char-explorer');
  
  const advancedPanel = document.getElementById('advanced-modular-panel');
  const webrefPanel = document.getElementById('webref-modular-panel');
  const styleExplorerPanel = document.getElementById('style-explorer-modular-panel');
  const charExplorerPanel = document.getElementById('char-explorer-modular-panel');

  function updateModeUI() {
    const addPromptsCont = document.getElementById('additional-prompts-container');
    const btnAddPromptField = document.getElementById('btn-add-prompt-field');
    
    if (appState.activeMode === 'advanced') {
      if (addPromptsCont) addPromptsCont.classList.remove('hidden');
      if (btnAddPromptField) btnAddPromptField.classList.remove('hidden');
    } else {
      if (addPromptsCont) addPromptsCont.classList.add('hidden');
      if (btnAddPromptField) btnAddPromptField.classList.add('hidden');
    }
  }

  function hideAllPanels() {
    advancedPanel.classList.add('hidden');
    if (webrefPanel) webrefPanel.classList.add('hidden');
    if (styleExplorerPanel) styleExplorerPanel.classList.add('hidden');
    if (charExplorerPanel) charExplorerPanel.classList.add('hidden');
  }

  function deactivateAllTabs() {
    tabSimple.classList.remove('active');
    tabAdvanced.classList.remove('active');
    if (tabWebref) tabWebref.classList.remove('active');
    if (tabStyleExplorer) tabStyleExplorer.classList.remove('active');
    if (tabCharExplorer) tabCharExplorer.classList.remove('active');
  }

  tabSimple.addEventListener('click', () => {
    appState.activeMode = 'simple';
    deactivateAllTabs();
    tabSimple.classList.add('active');
    hideAllPanels();
    toggleWorkspaceFieldsForWebref(false);
    updateModeUI();
    updateHiddenTextarea();
  });

  tabAdvanced.addEventListener('click', () => {
    appState.activeMode = 'advanced';
    deactivateAllTabs();
    tabAdvanced.classList.add('active');
    hideAllPanels();
    advancedPanel.classList.remove('hidden');
    renderCategoryTags();
    toggleWorkspaceFieldsForWebref(false);
    updateModeUI();
    updateHiddenTextarea();
  });

  if (tabWebref && webrefPanel) {
    tabWebref.addEventListener('click', () => {
      appState.activeMode = 'webref';
      deactivateAllTabs();
      tabWebref.classList.add('active');
      hideAllPanels();
      webrefPanel.classList.remove('hidden');
      toggleWorkspaceFieldsForWebref(true);
      updateModeUI();
      updateHiddenTextarea();
    });
  }

  if (tabStyleExplorer && styleExplorerPanel) {
    tabStyleExplorer.addEventListener('click', () => {
      appState.activeMode = 'style-explorer';
      deactivateAllTabs();
      tabStyleExplorer.classList.add('active');
      hideAllPanels();
      styleExplorerPanel.classList.remove('hidden');
      toggleWorkspaceFieldsForWebref(false);
      updateModeUI();
      updateHiddenTextarea();
      initStyleExplorer();
    });
  }

  if (tabCharExplorer && charExplorerPanel) {
    tabCharExplorer.addEventListener('click', () => {
      appState.activeMode = 'char-explorer';
      deactivateAllTabs();
      tabCharExplorer.classList.add('active');
      hideAllPanels();
      charExplorerPanel.classList.remove('hidden');
      toggleWorkspaceFieldsForWebref(false);
      updateModeUI();
      updateHiddenTextarea();
      initCharExplorer();
    });
  }

  // Web Reference Extract functionality
  const btnWebrefPaste = document.getElementById('btn-webref-paste');
  const btnWebrefExtract = document.getElementById('btn-webref-extract');
  const inputWebrefUrl = document.getElementById('webref-url-input');

  if (btnWebrefPaste) {
    btnWebrefPaste.addEventListener('click', async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (text) inputWebrefUrl.value = text;
      } catch (err) {
        showToast('Failed to read clipboard', 'error');
      }
    });
  }

  if (btnWebrefExtract) {
    btnWebrefExtract.addEventListener('click', async () => {
      const url = inputWebrefUrl.value.trim();
      if (!url) {
        showToast('Please enter a valid URL', 'warning');
        return;
      }
      
      btnWebrefExtract.disabled = true;
      const originalHtml = btnWebrefExtract.innerHTML;
      btnWebrefExtract.innerHTML = '<span>Extracting...</span>';
      
      try {
        const tags = await getTagsFromGelbooruUrl(url);
        if (tags) {
          const promptInput = document.getElementById('prompt-text-input');
          if (promptInput) {
            // Append the tags
            const currentPrompt = promptInput.value.trim();
            promptInput.value = currentPrompt ? currentPrompt + ', ' + tags : tags;
          }
          showToast('Tags successfully extracted!', 'success');
          // Switch to simple mode
          tabSimple.click();
        }
      } catch (err) {
        showToast('Failed to extract tags: ' + err.message, 'error');
        console.error(err);
      } finally {
        btnWebrefExtract.innerHTML = originalHtml;
        btnWebrefExtract.disabled = false;
      }
    });
  }

  // 3. Clear tags button
  const btnClearTags = document.getElementById('btn-clear-tags');
  if (btnClearTags) {
    btnClearTags.addEventListener('click', () => {
      const promptInput = document.getElementById('prompt-text-input');
      if (promptInput) {
        appState.activeTags.forEach(tag => {
          promptInput.value = stripTagFromText(promptInput.value, tag);
        });
      }
      appState.activeTags = [];
      appState.tagWeights = {};
      renderActiveTagsChips();
      renderCategoryTags(); // refresh highlights in grid
      showToast('Tags cleared');
    });
  }

  // 4. Generate Art Click
  const btnGenerate = document.getElementById('btn-generate');
  btnGenerate.addEventListener('click', () => {
    appState.lastGenerationWasSurprise = false;
    startImageGeneration();
  });

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
  const btnPostSaveGenSurprise = document.getElementById('btn-post-save-generate-surprise');
  const btnPostSurpriseAgain = document.getElementById('btn-post-surprise-again');

  if (btnPostSaveGenSurprise) {
    btnPostSaveGenSurprise.addEventListener('click', async () => {
      if (!appState.generatedImageUrl) return;
      btnPostSaveGenSurprise.disabled = true;
      const originalText = btnPostSaveGenSurprise.innerHTML;
      btnPostSaveGenSurprise.innerHTML = '<span>Saving...</span>';
      try {
        const finalPrompt = getFinalPrompt();
        const { subPrompts, mainPromptText, artStyleText } = getPromptSaveData();
        await albumStore.save(appState.generatedImageUrl, finalPrompt, appState.activeTags, appState.editorSourceImageId, null, appState.loras, subPrompts, mainPromptText, artStyleText);
        showToast('Saved to Album!', 'success');
        appState.lastGenerationWasSurprise = true;
        startImageGeneration();
      } catch (err) {
        showToast('Failed to save image', 'error');
      } finally {
        btnPostSaveGenSurprise.innerHTML = originalText;
        btnPostSaveGenSurprise.disabled = false;
      }
    });
  }

  if (btnPostSurpriseAgain) {
    btnPostSurpriseAgain.addEventListener('click', () => {
      const btnSurprise = document.getElementById('btn-surprise-me');
      if (btnSurprise) btnSurprise.click();
    });
  }

  btnPostDelete.addEventListener('click', () => {
    showToast('Image discarded');
    appState.generatedImageUrl = null;
    
    if (appState.lastGenerationMode === 'editor') {
      document.getElementById('art-preview-area').classList.add('hidden');
      document.getElementById('image-editor-container').classList.remove('hidden');
      appState.editorActive = true;
    } else {
      showCreationForm();
    }
  });

  btnPostRegen.addEventListener('click', () => {
    if (appState.lastGenerationMode === 'editor') {
      startImageEditGeneration();
    } else {
      startImageGeneration();
    }
  });

  const btnPostGenMore = document.getElementById('btn-post-generate-more');
  if (btnPostGenMore) {
    btnPostGenMore.addEventListener('click', () => {
      if (appState.generatedImageUrl && window.generateMoreFromVideo) {
        window.generateMoreFromVideo(appState.generatedImageUrl, getFinalPrompt(), window.videoState ? window.videoState.sourceImageId : null);
      }
    });
  }

  btnPostSave.addEventListener('click', async () => {
    if (!appState.generatedImageUrl) return;

    // Save image to album list (asynchronous)
    const finalPrompt = getFinalPrompt();
    
    // Temporarily disable the button to prevent double clicks during save
    btnPostSave.disabled = true;
    const originalText = btnPostSave.innerHTML;
    btnPostSave.innerHTML = '<span>Saving...</span>';

    try {
      let parentId = appState.editorSourceImageId;
      let modPrompt = appState.lastGenerationMode === 'editor' ? appState.lastEditPrompt : null;

      if (appState.isVideoGeneration) {
        if (window.videoState && window.videoState.sourceImageId) {
          parentId = window.videoState.sourceImageId;
        }
        modPrompt = `Video Gen: ${finalPrompt}`;
      }

      const { subPrompts, mainPromptText, artStyleText } = getPromptSaveData();
      const savedImg = await albumStore.save(appState.generatedImageUrl, finalPrompt, appState.activeTags, parentId, modPrompt, appState.loras, subPrompts, mainPromptText, artStyleText);
      showToast('Saved to Album!', 'success');

      // Get animated coordinates
      const imgEl = (appState.isVideoGeneration && document.getElementById('generated-video-player')) 
        ? document.getElementById('generated-video-player') 
        : document.getElementById('generated-art-img');
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
    const sampler = document.getElementById('setting-comfyui-sampler').value || 'er_sde';
    const scheduler = document.getElementById('setting-comfyui-scheduler').value || 'simple';
    const llliteName = document.getElementById('setting-comfyui-lllite-name').value.trim();
    const llliteNameImg2Img = document.getElementById('setting-comfyui-lllite-name-img2img')?.value.trim() || '';
    const llliteStrength = parseFloat(document.getElementById('setting-comfyui-lllite-strength').value) ?? 1.0;
    const currentSettings = settingsStore.get();
    const width = currentSettings.comfyui_width || 832;
    const height = currentSettings.comfyui_height || 1216;
    const posPrefix = document.getElementById('setting-comfyui-positive-prefix').value.trim();
    const neg = document.getElementById('setting-comfyui-negative').value.trim();
    const inst = document.getElementById('setting-ai-instructions').value.trim();
    const freeMemoryInterval = parseInt(document.getElementById('setting-free-memory-interval').value) ?? 3;
    const gelKey = document.getElementById('setting-gelbooru-api-key')?.value.trim() || '';
    const gelUid = document.getElementById('setting-gelbooru-user-id')?.value.trim() || '';
    const unetName = document.getElementById('setting-comfyui-unet-name')?.value || 'anima_baseV10.safetensors';

    const modelSettings = { ...currentSettings.model_settings };
    modelSettings[unetName] = {
      comfyui_steps: steps,
      comfyui_cfg: cfg,
      comfyui_sampler: sampler,
      comfyui_scheduler: scheduler,
      comfyui_lllite_name: llliteName,
      comfyui_lllite_strength: llliteStrength,
      comfyui_lllite_name_img2img: llliteNameImg2Img,
      comfyui_positive_prompt_prefix: posPrefix,
      comfyui_negative_prompt: neg,
      comfyui_free_memory_interval: freeMemoryInterval
    };

    settingsStore.save({
      comfyui_url: comUrl,
      ai_url: aiUrl,
      comfyui_unet_name: unetName,
      comfyui_steps: steps,
      comfyui_cfg: cfg,
      comfyui_sampler: sampler,
      comfyui_scheduler: scheduler,
      comfyui_lllite_name: llliteName,
      comfyui_lllite_name_img2img: llliteNameImg2Img,
      comfyui_lllite_strength: llliteStrength,
      comfyui_width: width,
      comfyui_height: height,
      comfyui_positive_prompt_prefix: posPrefix,
      comfyui_negative_prompt: neg,
      comfyui_free_memory_interval: freeMemoryInterval,
      ai_instructions: inst,
      gelbooru_api_key: gelKey,
      gelbooru_user_id: gelUid,
      model_settings: modelSettings
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

  // Storage Directory Picker Event Listeners
  const btnSelectFolder = document.getElementById('btn-select-save-folder');
  const btnClearFolder = document.getElementById('btn-clear-save-folder');

  if (btnSelectFolder) {
    btnSelectFolder.addEventListener('click', async () => {
      if (typeof window.showDirectoryPicker !== 'function') {
        showToast('Your browser does not support local directory access. Please use Chrome or Edge.', 'error');
        return;
      }
      try {
        const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
        await albumStore.setSaveDirectory(handle);
        showToast(`Save directory set to ${handle.name}`, 'success');
        updateStorageSettingsUI();
        if (window.renderAlbumWorkspace) window.renderAlbumWorkspace();
      } catch (err) {
        if (err.name !== 'AbortError') {
          console.error(err);
          showToast('Failed to select directory', 'error');
        }
      }
    });
  }

  if (btnClearFolder) {
    btnClearFolder.addEventListener('click', async () => {
      try {
        await albumStore.clearSaveDirectory();
        showToast('Reset save folder to default browser storage', 'success');
        updateStorageSettingsUI();
        if (window.renderAlbumWorkspace) window.renderAlbumWorkspace();
      } catch (err) {
        console.error(err);
        showToast('Failed to clear directory', 'error');
      }
    });
  }

  // Model Management Event Listeners
  const btnAddModel = document.getElementById('btn-add-model');
  const btnRenameModel = document.getElementById('btn-rename-model');
  const btnDeleteModel = document.getElementById('btn-delete-model');
  const addModelInput = document.getElementById('setting-add-model-input');
  const selectUnetName = document.getElementById('setting-comfyui-unet-name');

  if (selectUnetName) {
    selectUnetName.addEventListener('change', () => {
      const oldModel = selectUnetName.dataset.previousModel;
      const newModel = selectUnetName.value;
      if (oldModel && oldModel !== newModel) {
        saveModelSpecificSettings(oldModel);
      }
      loadModelSpecificSettings(newModel);
      selectUnetName.dataset.previousModel = newModel;
    });
  }

  if (btnAddModel && addModelInput) {
    btnAddModel.addEventListener('click', () => {
      const name = addModelInput.value.trim();
      if (!name) {
        showToast('Model name cannot be empty', 'error');
        return;
      }
      const settings = settingsStore.get();
      const models = settings.comfyui_unet_models ? [...settings.comfyui_unet_models] : ['anima_baseV10.safetensors'];
      
      if (models.includes(name)) {
        showToast('Model already exists', 'warning');
        return;
      }
      
      models.push(name);
      
      const updatedModelSettings = { ...settings.model_settings };
      updatedModelSettings[name] = {
        comfyui_steps: settings.comfyui_steps,
        comfyui_cfg: settings.comfyui_cfg,
        comfyui_sampler: settings.comfyui_sampler,
        comfyui_scheduler: settings.comfyui_scheduler,
        comfyui_lllite_name: settings.comfyui_lllite_name,
        comfyui_lllite_strength: settings.comfyui_lllite_strength,
        comfyui_lllite_name_img2img: settings.comfyui_lllite_name_img2img,
        comfyui_positive_prompt_prefix: settings.comfyui_positive_prompt_prefix,
        comfyui_negative_prompt: settings.comfyui_negative_prompt,
        comfyui_free_memory_interval: settings.comfyui_free_memory_interval
      };

      settingsStore.save({
        comfyui_unet_models: models,
        comfyui_unet_name: name,
        model_settings: updatedModelSettings
      });
      
      addModelInput.value = '';
      renderModelsDropdown();
      loadModelSpecificSettings(name);
      showToast(`Model "${name}" added`, 'success');
    });
    
    addModelInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        btnAddModel.click();
      }
    });
  }
  
  if (btnRenameModel) {
    btnRenameModel.addEventListener('click', () => {
      const select = document.getElementById('setting-comfyui-unet-name');
      if (!select) return;
      
      const currentModel = select.value;
      if (!currentModel) {
        showToast('No model selected to rename', 'warning');
        return;
      }
      
      const newName = prompt('Enter new name for the model:', currentModel);
      if (newName === null) return; // User cancelled
      
      const trimmed = newName.trim();
      if (!trimmed) {
        showToast('Model name cannot be empty', 'error');
        return;
      }
      
      const settings = settingsStore.get();
      const models = settings.comfyui_unet_models ? [...settings.comfyui_unet_models] : ['anima_baseV10.safetensors'];
      
      const idx = models.indexOf(currentModel);
      if (idx === -1) {
        showToast('Selected model not found', 'error');
        return;
      }
      
      if (models.includes(trimmed) && trimmed !== currentModel) {
        showToast('A model with this name already exists', 'warning');
        return;
      }
      
      models[idx] = trimmed;
      const modelSettings = { ...settings.model_settings };
      if (modelSettings[currentModel]) {
        modelSettings[trimmed] = modelSettings[currentModel];
        delete modelSettings[currentModel];
      }
      const updateData = { comfyui_unet_models: models, model_settings: modelSettings };
      if (settings.comfyui_unet_name === currentModel) {
        updateData.comfyui_unet_name = trimmed;
      }
      
      settingsStore.save(updateData);
      renderModelsDropdown();
      if (settings.comfyui_unet_name === currentModel) {
        loadModelSpecificSettings(trimmed);
      }
      showToast(`Model renamed to "${trimmed}"`, 'success');
    });
  }
  
  if (btnDeleteModel) {
    btnDeleteModel.addEventListener('click', () => {
      const select = document.getElementById('setting-comfyui-unet-name');
      if (!select) return;
      
      const currentModel = select.value;
      if (!currentModel) {
        showToast('No model selected to delete', 'warning');
        return;
      }
      
      if (!confirm(`Are you sure you want to delete "${currentModel}"?`)) {
        return;
      }
      
      const settings = settingsStore.get();
      let models = settings.comfyui_unet_models ? [...settings.comfyui_unet_models] : ['anima_baseV10.safetensors'];
      
      models = models.filter(m => m !== currentModel);
      
      let nextModel = 'anima_baseV10.safetensors';
      if (models.length > 0) {
        nextModel = models[0];
      } else {
        models = ['anima_baseV10.safetensors'];
      }
      
      const modelSettings = { ...settings.model_settings };
      delete modelSettings[currentModel];

      settingsStore.save({
        comfyui_unet_models: models,
        comfyui_unet_name: nextModel,
        model_settings: modelSettings
      });
      
      renderModelsDropdown();
      loadModelSpecificSettings(nextModel);
      showToast(`Model "${currentModel}" deleted`, 'info');
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
    btnPostEdit.addEventListener('click', async () => {
      if (!appState.generatedImageUrl) return;

      btnPostEdit.disabled = true;
      const originalText = btnPostEdit.innerHTML;
      btnPostEdit.innerHTML = '<span>Saving...</span>';

      try {
        const finalPrompt = getFinalPrompt();
        const modPrompt = appState.lastGenerationMode === 'editor' ? appState.lastEditPrompt : null;
        const { subPrompts, mainPromptText, artStyleText } = getPromptSaveData();
        const savedImg = await albumStore.save(appState.generatedImageUrl, finalPrompt, appState.activeTags, appState.editorSourceImageId, modPrompt, appState.loras, subPrompts, mainPromptText, artStyleText);
        showToast('Saved to Album!', 'success');

        renderGalleryList();
        if (window.renderAlbumWorkspace) window.renderAlbumWorkspace();

        enterEditorMode(savedImg.url, savedImg.prompt, savedImg.tags, savedImg.id);
      } catch (err) {
        showToast('Failed to save image to album', 'error');
        console.error(err);
      } finally {
        btnPostEdit.innerHTML = originalText;
        btnPostEdit.disabled = false;
      }
    });
  }
  
  // Lightbox edit button click
  const btnLightboxEdit = document.getElementById('btn-lightbox-edit');
  if (btnLightboxEdit) {
    btnLightboxEdit.addEventListener('click', () => {
      const lightboxImg = document.getElementById('lightbox-img');
      const lightboxPrompt = document.getElementById('lightbox-prompt-text');
      const lightbox = document.getElementById('image-lightbox');
      const imageId = lightbox ? lightbox.dataset.imageId : null;
      if (lightboxImg && lightboxImg.src) {
        if (lightbox) lightbox.classList.add('hidden');
        enterEditorMode(lightboxImg.src, lightboxPrompt ? lightboxPrompt.textContent : '', appState.activeTags, imageId);
      }
    });
  }
});

// ─── Rendering Advanced Mode Categories & Tags ──────────────────────
function renderAdvancedCategories() {
  const bar = document.querySelector('.tags-categories-bar');
  if (!bar) return;

  bar.innerHTML = '';

  // Inner scrollable container for the category tab buttons
  const tabsScroll = document.createElement('div');
  tabsScroll.className = 'category-tabs-scroll';

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

    tabsScroll.appendChild(btn);
  }

  bar.appendChild(tabsScroll);

  // Expand/Collapse button — direct child of bar, NOT inside the scrollable area
  const advancedPanel = document.getElementById('advanced-modular-panel');
  const isExpanded = advancedPanel && advancedPanel.classList.contains('expanded');
  const expandBtn = document.createElement('button');
  expandBtn.id = 'btn-expand-tags';
  expandBtn.className = 'expand-tab-btn';
  expandBtn.textContent = isExpanded ? 'Collapse ▴' : 'Expand ▾';
  expandBtn.title = isExpanded ? 'Collapse tags panel' : 'Expand tags panel';
  expandBtn.addEventListener('click', () => {
    if (advancedPanel) {
      advancedPanel.classList.toggle('expanded');
      const nowExpanded = advancedPanel.classList.contains('expanded');
      expandBtn.textContent = nowExpanded ? 'Collapse ▴' : 'Expand ▾';
      expandBtn.title = nowExpanded ? 'Collapse tags panel' : 'Expand tags panel';
    }
  });
  bar.appendChild(expandBtn);
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

  // Update Toggle All Button text and visibility
  const btnToggleAll = document.getElementById('btn-toggle-all-subcategories');
  if (btnToggleAll) {
    const hasSubcategories = Object.keys(subcategoryGroups).length > 0;
    if (!hasSubcategories) {
      btnToggleAll.style.display = 'none';
    } else {
      btnToggleAll.style.display = 'inline-block';
      let hasExpanded = false;
      for (const subName in subcategoryGroups) {
        const stateKey = `${appState.activeCategory}_${subName}`;
        const isCollapsed = appState.collapsedSubcategories[stateKey] !== false;
        if (!isCollapsed) {
          hasExpanded = true;
          break;
        }
      }
      btnToggleAll.textContent = hasExpanded ? 'Collapse All' : 'Expand All';
    }
  }

  // Helper to create tag element
  function createTagEl(item) {
    const isSelected = appState.activeTags.includes(item.tag);
    const count = item.sub_tags ? item.sub_tags.length : 0;
    
    const el = document.createElement('div');
    el.className = `grid-tag-item ${isSelected ? 'selected' : ''}`;
    el.dataset.tagValue = item.tag;
    el.setAttribute('draggable', 'true');
    
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

    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', item.tag);
      e.dataTransfer.setData('source', 'tags-grid');
      e.dataTransfer.effectAllowed = 'copy';
    });

    return el;
  }

  // 1. Render General Tags
  generalTags.forEach(item => {
    grid.appendChild(createTagEl(item));
  });

  // Add Custom tag button
  const addBtn = document.createElement('div');
  addBtn.className = 'grid-tag-item add-tag-btn-manual';
  addBtn.style.borderStyle = 'dashed';
  addBtn.style.borderColor = 'var(--text-accent)';
  addBtn.style.color = 'var(--text-accent)';
  addBtn.style.display = 'inline-flex';
  addBtn.style.alignItems = 'center';
  addBtn.style.justifyContent = 'center';
  addBtn.style.fontWeight = '600';
  addBtn.style.cursor = 'pointer';
  addBtn.title = 'Add new custom tag to this category';
  addBtn.innerHTML = `
    <div style="display:flex; align-items:center; gap:6px;">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" style="width: 12px; height: 12px;">
        <line x1="12" y1="5" x2="12" y2="19"></line>
        <line x1="5" y1="12" x2="19" y2="12"></line>
      </svg>
      <span>Add Tag</span>
    </div>
  `;
  addBtn.addEventListener('click', async () => {
    const newTag = prompt('Enter new tag name (e.g. detailed eyes):');
    if (newTag) {
      const cleanTag = newTag.trim();
      if (cleanTag) {
        const success = tagsDatabase.importTags(appState.activeCategory, [{
          tag: cleanTag,
          name: cleanTag
        }]);
        if (success) {
          showToast(`Tag "${cleanTag}" added!`, 'success');
          renderCategoryTags();
          togglePromptTag(cleanTag);
        } else {
          showToast('Failed to add tag', 'error');
        }
      }
    }
  });
  grid.appendChild(addBtn);

  // 2. Render Subcategories
  for (const subName in subcategoryGroups) {
    const stateKey = `${appState.activeCategory}_${subName}`;
    const isCollapsed = appState.collapsedSubcategories[stateKey] !== false; // collapsed by default!

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

      // Update toggle all button text
      if (btnToggleAll) {
        let hasExpanded = false;
        const containers = grid.querySelectorAll('.subcategory-tags-container');
        containers.forEach(c => {
          if (!c.classList.contains('collapsed')) {
            hasExpanded = true;
          }
        });
        btnToggleAll.textContent = hasExpanded ? 'Collapse All' : 'Expand All';
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
  const editor = appState.lastFocusedEditor || document.getElementById('prompt-input-editor');
  if (editor) {
    const existingPills = Array.from(editor.querySelectorAll('.prompt-tag-pill'));
    const foundPill = existingPills.find(pill => pill.dataset.tag.toLowerCase() === tag.toLowerCase());
    if (foundPill) {
      foundPill.remove();
      updateHiddenTextarea();
      updateCategoryTagsHighlights();
    }
  }
}
function togglePromptTag(tagString) {
  let editor;
  if (tagString.startsWith('@')) {
    editor = document.getElementById('art-style-input-editor');
  } else {
    editor = appState.lastFocusedEditor || document.getElementById('prompt-input-editor');
    if (editor && editor.id === 'art-style-input-editor') {
      editor = document.getElementById('prompt-input-editor');
    }
  }
  if (!editor) return;
  
  const existingPills = Array.from(editor.querySelectorAll('.prompt-tag-pill'));
  const foundPill = existingPills.find(pill => pill.dataset.tag.toLowerCase() === tagString.toLowerCase());
  
  if (foundPill) {
    foundPill.remove();
  } else {
    const pill = createTagPillElement(tagString);
    if (tagString.startsWith('@') && document.activeElement !== editor) {
      editor.appendChild(pill);
      editor.appendChild(document.createTextNode(' '));
    } else {
      insertNodeAtCursor(pill);
    }
  }
  
  updateHiddenTextarea();
  updateCategoryTagsHighlights();
}
function updateCategoryTagsHighlights() {
  const grid = document.getElementById('category-tags-grid');
  if (grid) {
    const tagItems = grid.querySelectorAll('.grid-tag-item');
    tagItems.forEach(el => {
      const tag = el.dataset.tagValue;
      if (appState.activeTags.includes(tag)) {
        el.classList.add('selected');
      } else {
        el.classList.remove('selected');
      }
    });
  }

  // Synchronize highlights with Style Explorer and Character Explorer
  if (typeof updateStyleExplorerHighlights === 'function') {
    updateStyleExplorerHighlights();
  }
  if (typeof updateCharExplorerHighlights === 'function') {
    updateCharExplorerHighlights();
  }
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
    
    if (!appState.tagWeights) appState.tagWeights = {};
    const weight = appState.tagWeights[tag] !== undefined ? appState.tagWeights[tag] : 1.0;
    
    chip.innerHTML = `
      <div class="tag-weight-controls" style="display: inline-flex; align-items: center; background: rgba(0, 0, 0, 0.2); border-radius: 10px; margin-right: 6px; padding: 2px 4px;">
        <button class="btn-tag-weight-dec" type="button" style="border: none; background: none; color: var(--text-tertiary); cursor: pointer; padding: 0 4px; font-size: 10px; font-weight: bold; line-height: 1;">-</button>
        <span class="tag-weight-val" style="font-size: 10px; font-weight: 600; min-width: 18px; text-align: center; color: var(--text-accent);">${weight.toFixed(1)}</span>
        <button class="btn-tag-weight-inc" type="button" style="border: none; background: none; color: var(--text-tertiary); cursor: pointer; padding: 0 4px; font-size: 10px; font-weight: bold; line-height: 1;">+</button>
      </div>
      <span>${tag} ${info ? `(${info.name})` : ''}</span>
      <span class="tag-chip-remove" style="margin-left: 4px;">&times;</span>
    `;

    chip.querySelector('.btn-tag-weight-dec').addEventListener('click', (e) => {
      e.stopPropagation();
      if (!appState.tagWeights) appState.tagWeights = {};
      let w = appState.tagWeights[tag] !== undefined ? appState.tagWeights[tag] : 1.0;
      w = Math.max(0.5, w - 0.5);
      appState.tagWeights[tag] = w;
      renderActiveTagsChips();
    });

    chip.querySelector('.btn-tag-weight-inc').addEventListener('click', (e) => {
      e.stopPropagation();
      if (!appState.tagWeights) appState.tagWeights = {};
      let w = appState.tagWeights[tag] !== undefined ? appState.tagWeights[tag] : 1.0;
      w = Math.min(4.0, w + 0.5);
      appState.tagWeights[tag] = w;
      renderActiveTagsChips();
    });

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

async function updateStorageSettingsUI() {
  const statusTitle = document.getElementById('folder-status-title');
  const statusBadge = document.getElementById('folder-status-badge');
  const statusPath = document.getElementById('folder-status-path');
  const btnClear = document.getElementById('btn-clear-save-folder');

  if (!statusTitle) return;

  const hasDir = albumStore.hasDirectory();
  if (hasDir) {
    const dirName = albumStore.getDirectoryName();
    const hasPermission = await albumStore.checkDirectoryPermission();
    
    statusTitle.innerText = `Saving to local folder`;
    statusTitle.style.color = 'var(--text-accent)';
    statusPath.innerText = `Folder: ${dirName}`;
    
    if (hasPermission) {
      statusBadge.innerText = 'Authorized';
      statusBadge.style.background = 'rgba(46, 204, 113, 0.2)';
      statusBadge.style.color = '#2ecc71';
    } else {
      statusBadge.innerText = 'Need Access';
      statusBadge.style.background = 'rgba(230, 126, 34, 0.2)';
      statusBadge.style.color = '#e67e22';
    }
    
    if (btnClear) btnClear.style.display = 'block';
  } else {
    statusTitle.innerText = `Using browser database (Drive C)`;
    statusTitle.style.color = 'var(--text-secondary)';
    statusPath.innerText = `-`;
    statusBadge.innerText = 'Default';
    statusBadge.style.background = 'rgba(255, 255, 255, 0.1)';
    statusBadge.style.color = 'var(--text-tertiary)';
    if (btnClear) btnClear.style.display = 'none';
  }
}

function saveModelSpecificSettings(modelName) {
  if (!modelName) return;
  const stepsEl = document.getElementById('setting-comfyui-steps');
  const cfgEl = document.getElementById('setting-comfyui-cfg');
  const samplerEl = document.getElementById('setting-comfyui-sampler');
  const schedulerEl = document.getElementById('setting-comfyui-scheduler');
  const llliteNameEl = document.getElementById('setting-comfyui-lllite-name');
  const llliteStrengthEl = document.getElementById('setting-comfyui-lllite-strength');
  const llliteNameImg2ImgEl = document.getElementById('setting-comfyui-lllite-name-img2img');
  const posPrefixEl = document.getElementById('setting-comfyui-positive-prefix');
  const negEl = document.getElementById('setting-comfyui-negative');
  const freeMemIntervalEl = document.getElementById('setting-free-memory-interval');

  const steps = stepsEl ? (parseInt(stepsEl.value) || 30) : 30;
  const cfg = cfgEl ? (parseFloat(cfgEl.value) || 4.5) : 4.5;
  const sampler = samplerEl ? (samplerEl.value || 'euler') : 'euler';
  const scheduler = schedulerEl ? (schedulerEl.value || 'normal') : 'normal';
  const llliteName = llliteNameEl ? llliteNameEl.value.trim() : '';
  const llliteStrength = llliteStrengthEl ? (parseFloat(llliteStrengthEl.value) ?? 1.0) : 1.0;
  const llliteNameImg2Img = llliteNameImg2ImgEl ? llliteNameImg2ImgEl.value.trim() : '';
  const posPrefix = posPrefixEl ? posPrefixEl.value.trim() : 'Masterpiece, good quality';
  const neg = negEl ? negEl.value.trim() : 'lowres, bad anatomy, worst quality, blurry, watermark';
  const freeMemoryInterval = freeMemIntervalEl ? (parseInt(freeMemIntervalEl.value) ?? 3) : 3;

  const currentSettings = settingsStore.get();
  const modelSettings = { ...currentSettings.model_settings };
  modelSettings[modelName] = {
    comfyui_steps: steps,
    comfyui_cfg: cfg,
    comfyui_sampler: sampler,
    comfyui_scheduler: scheduler,
    comfyui_lllite_name: llliteName,
    comfyui_lllite_strength: llliteStrength,
    comfyui_lllite_name_img2img: llliteNameImg2Img,
    comfyui_positive_prompt_prefix: posPrefix,
    comfyui_negative_prompt: neg,
    comfyui_free_memory_interval: freeMemoryInterval,
    comfyui_width: currentSettings.comfyui_width ?? 832,
    comfyui_height: currentSettings.comfyui_height ?? 1216,
    comfyui_aspect_ratio: currentSettings.comfyui_aspect_ratio ?? '1:1 (Square)',
    comfyui_megapixels: currentSettings.comfyui_megapixels ?? 1.0,
    comfyui_multiple: currentSettings.comfyui_multiple ?? 16
  };

  settingsStore.save({
    model_settings: modelSettings
  });
}

function loadModelSpecificSettings(modelName) {
  if (!modelName) return;
  const currentSettings = settingsStore.get();
  const modelData = currentSettings.model_settings?.[modelName] || {};

  const steps = modelData.comfyui_steps ?? currentSettings.comfyui_steps ?? 30;
  const cfg = modelData.comfyui_cfg ?? currentSettings.comfyui_cfg ?? 4.5;
  const sampler = modelData.comfyui_sampler ?? currentSettings.comfyui_sampler ?? 'euler';
  const scheduler = modelData.comfyui_scheduler ?? currentSettings.comfyui_scheduler ?? 'normal';
  const llliteName = modelData.comfyui_lllite_name ?? currentSettings.comfyui_lllite_name ?? '';
  const llliteStrength = modelData.comfyui_lllite_strength ?? currentSettings.comfyui_lllite_strength ?? 1.0;
  const llliteNameImg2Img = modelData.comfyui_lllite_name_img2img ?? currentSettings.comfyui_lllite_name_img2img ?? '';
  const posPrefix = modelData.comfyui_positive_prompt_prefix ?? currentSettings.comfyui_positive_prompt_prefix ?? 'Masterpiece, good quality';
  const neg = modelData.comfyui_negative_prompt ?? currentSettings.comfyui_negative_prompt ?? 'lowres, bad anatomy, worst quality, blurry, watermark';
  const freeMemoryInterval = modelData.comfyui_free_memory_interval ?? currentSettings.comfyui_free_memory_interval ?? 3;
  const width = modelData.comfyui_width ?? currentSettings.comfyui_width ?? 832;
  const height = modelData.comfyui_height ?? currentSettings.comfyui_height ?? 1216;
  const aspectRatio = modelData.comfyui_aspect_ratio ?? currentSettings.comfyui_aspect_ratio ?? '1:1 (Square)';
  const megapixels = modelData.comfyui_megapixels ?? currentSettings.comfyui_megapixels ?? 1.0;
  const multiple = modelData.comfyui_multiple ?? currentSettings.comfyui_multiple ?? 16;

  const stepsEl = document.getElementById('setting-comfyui-steps');
  if (stepsEl) stepsEl.value = steps;

  const cfgEl = document.getElementById('setting-comfyui-cfg');
  if (cfgEl) cfgEl.value = cfg;

  const samplerEl = document.getElementById('setting-comfyui-sampler');
  if (samplerEl) samplerEl.value = sampler;

  const schedulerEl = document.getElementById('setting-comfyui-scheduler');
  if (schedulerEl) schedulerEl.value = scheduler;

  const llliteNameEl = document.getElementById('setting-comfyui-lllite-name');
  if (llliteNameEl) llliteNameEl.value = llliteName;

  const llliteStrengthEl = document.getElementById('setting-comfyui-lllite-strength');
  if (llliteStrengthEl) llliteStrengthEl.value = llliteStrength;

  const llliteNameImg2ImgEl = document.getElementById('setting-comfyui-lllite-name-img2img');
  if (llliteNameImg2ImgEl) llliteNameImg2ImgEl.value = llliteNameImg2Img;

  const posPrefixEl = document.getElementById('setting-comfyui-positive-prefix');
  if (posPrefixEl) posPrefixEl.value = posPrefix;

  const negEl = document.getElementById('setting-comfyui-negative');
  if (negEl) negEl.value = neg;

  const freeMemIntervalEl = document.getElementById('setting-free-memory-interval');
  if (freeMemIntervalEl) {
    freeMemIntervalEl.value = freeMemoryInterval;
    updateFreeMemoryIntervalText(freeMemoryInterval);
  }

  settingsStore.save({
    comfyui_unet_name: modelName,
    comfyui_steps: steps,
    comfyui_cfg: cfg,
    comfyui_sampler: sampler,
    comfyui_scheduler: scheduler,
    comfyui_lllite_name: llliteName,
    comfyui_lllite_strength: llliteStrength,
    comfyui_lllite_name_img2img: llliteNameImg2Img,
    comfyui_positive_prompt_prefix: posPrefix,
    comfyui_negative_prompt: neg,
    comfyui_free_memory_interval: freeMemoryInterval,
    comfyui_width: width,
    comfyui_height: height,
    comfyui_aspect_ratio: aspectRatio,
    comfyui_megapixels: megapixels,
    comfyui_multiple: multiple
  });

  if (syncResolutionSelectorUI) {
    syncResolutionSelectorUI();
  }
}

function renderModelsDropdown() {
  const settings = settingsStore.get();
  const select = document.getElementById('setting-comfyui-unet-name');
  if (!select) return;
  
  const models = settings.comfyui_unet_models || ['anima_baseV10.safetensors'];
  const currentModel = settings.comfyui_unet_name || 'anima_baseV10.safetensors';
  
  select.innerHTML = '';
  models.forEach(model => {
    const opt = document.createElement('option');
    opt.value = model;
    opt.textContent = model;
    select.appendChild(opt);
  });
  
  if (models.includes(currentModel)) {
    select.value = currentModel;
  } else if (models.length > 0) {
    select.value = models[0];
  }
  
  select.dataset.previousModel = select.value;
}

function initSettingsForm() {
  const settings = settingsStore.get();
  renderModelsDropdown();
  document.getElementById('setting-comfyui-url').value = settings.comfyui_url;
  document.getElementById('setting-ai-url').value = settings.ai_url;
  document.getElementById('setting-comfyui-steps').value = settings.comfyui_steps;
  document.getElementById('setting-comfyui-cfg').value = settings.comfyui_cfg;
  if(document.getElementById('setting-comfyui-sampler')) {
    document.getElementById('setting-comfyui-sampler').value = settings.comfyui_sampler || 'er_sde';
  }
  if(document.getElementById('setting-comfyui-scheduler')) {
    document.getElementById('setting-comfyui-scheduler').value = settings.comfyui_scheduler || 'simple';
  }
  document.getElementById('setting-comfyui-lllite-name').value = settings.comfyui_lllite_name || '';
  document.getElementById('setting-comfyui-lllite-strength').value = settings.comfyui_lllite_strength ?? 1.0;
  const llliteImg2ImgEl = document.getElementById('setting-comfyui-lllite-name-img2img');
  if (llliteImg2ImgEl) llliteImg2ImgEl.value = settings.comfyui_lllite_name_img2img || '';
  const posPrefixEl = document.getElementById('setting-comfyui-positive-prefix');
  if (posPrefixEl) posPrefixEl.value = settings.comfyui_positive_prompt_prefix !== undefined ? settings.comfyui_positive_prompt_prefix : 'Masterpiece, good quality';
  document.getElementById('setting-comfyui-negative').value = settings.comfyui_negative_prompt !== undefined ? settings.comfyui_negative_prompt : 'lowres, bad anatomy, worst quality, blurry, watermark';
  
  const freeMemInterval = settings.comfyui_free_memory_interval ?? 3;
  const slider = document.getElementById('setting-free-memory-interval');
  if (slider) {
    slider.value = freeMemInterval;
    updateFreeMemoryIntervalText(freeMemInterval);
  }
  
  const aiInstEl = document.getElementById('setting-ai-instructions');
  if (aiInstEl) {
    aiInstEl.value = settings.ai_instructions || 'You are Anima Studio AI Assistant, an expert art director helping the user generate pictures using the Anima diffusion model. Help the user create amazing stylized/non-realistic image generation prompts. Avoid realistic styling/photorealism. Guide the user to use natural language descriptions for scenes, poses, and actions instead of lists of raw tags. Help them structure prompts in the Anima model\'s preferred tag order: [quality/meta/year/safety tags] [1girl/1boy/1other etc] [character] [series] [artist] [general tags/natural description]. Keep all suggestions suited for stylized anime art/drawings.';
  }
  
  const gelKeyEl = document.getElementById('setting-gelbooru-api-key');
  if (gelKeyEl) {
    gelKeyEl.value = settings.gelbooru_api_key || '';
  }
  const gelUidEl = document.getElementById('setting-gelbooru-user-id');
  if (gelUidEl) {
    gelUidEl.value = settings.gelbooru_user_id || '';
  }
  updateStorageSettingsUI();
}

// ─── Image Size Selector Control ───────────────────────────────────
let syncResolutionSelectorUI = null;

function initImageSizeSelector() {
  const btnOpenResolution = document.getElementById('btn-open-resolution');
  const btnCloseResolution = document.getElementById('btn-close-resolution');
  const drawer = document.getElementById('resolution-selector-drawer');
  
  const sizeDisplay = document.getElementById('active-size-display');
  const valWidth = document.getElementById('resolution-val-width');
  const valHeight = document.getElementById('resolution-val-height');
  
  const aspectDec = document.getElementById('btn-aspect-dec');
  const aspectInc = document.getElementById('btn-aspect-inc');
  const aspectValText = document.getElementById('param-val-aspect');
  
  const mpDec = document.getElementById('btn-megapixels-dec');
  const mpInc = document.getElementById('btn-megapixels-inc');
  const mpValText = document.getElementById('param-val-megapixels');
  
  const multDec = document.getElementById('btn-multiple-dec');
  const multInc = document.getElementById('btn-multiple-inc');
  const multValText = document.getElementById('param-val-multiple');
  
  const batchDec = document.getElementById('btn-batch-dec');
  const batchInc = document.getElementById('btn-batch-inc');
  const batchValText = document.getElementById('batch-size-display');

  if (!btnOpenResolution || !drawer) return;

  const ASPECT_RATIOS = [
    { name: '1:1 (Square)', ratio: 1.0 },
    { name: '3:2 (Photo)', ratio: 1.5 },
    { name: '4:3 (Standard)', ratio: 1.3333 },
    { name: '16:9 (Widescreen)', ratio: 1.7778 },
    { name: '21:9 (Cinematic)', ratio: 2.3333 },
    { name: '2:3 (Portrait)', ratio: 0.6667 },
    { name: '3:4 (Portrait)', ratio: 0.75 },
    { name: '9:16 (Portrait)', ratio: 0.5625 },
    { name: '9:21 (Portrait)', ratio: 0.4286 }
  ];

  const MULTIPLES = [8, 16, 32, 64];

  let aspectIndex = 0;
  let megapixelsVal = 1.0;
  let multipleVal = 16;
  let batchSizeVal = 1;

  syncResolutionSelectorUI = function() {
    const settings = settingsStore.get();
    megapixelsVal = parseFloat(settings.comfyui_megapixels) || 1.0;
    multipleVal = parseInt(settings.comfyui_multiple) || 16;
    batchSizeVal = parseInt(settings.comfyui_batch_size) || 1;
    
    const aspectName = settings.comfyui_aspect_ratio || '1:1 (Square)';
    const idx = ASPECT_RATIOS.findIndex(a => a.name === aspectName);
    aspectIndex = idx !== -1 ? idx : 0;
    
    const sizeStr = `${settings.comfyui_width || 832} × ${settings.comfyui_height || 1216}`;
    if (sizeDisplay) sizeDisplay.textContent = sizeStr;
    const drawerSizeDisplay = document.getElementById('drawer-active-size-display');
    if (drawerSizeDisplay) drawerSizeDisplay.textContent = sizeStr;
    if (valWidth) valWidth.textContent = settings.comfyui_width || 832;
    if (valHeight) valHeight.textContent = settings.comfyui_height || 1216;
    
    if (aspectValText) aspectValText.textContent = ASPECT_RATIOS[aspectIndex].name;
    if (mpValText) mpValText.textContent = megapixelsVal.toFixed(2);
    if (multValText) multValText.textContent = multipleVal;
    if (batchValText) batchValText.textContent = batchSizeVal;
  };

  function calculateAndSaveSize() {
    const ratioObj = ASPECT_RATIOS[aspectIndex];
    const targetPixels = megapixelsVal * 1024 * 1024;
    let h = Math.sqrt(targetPixels / ratioObj.ratio);
    let w = h * ratioObj.ratio;
    
    w = Math.round(w / multipleVal) * multipleVal;
    h = Math.round(h / multipleVal) * multipleVal;
    
    settingsStore.save({
      comfyui_width: w,
      comfyui_height: h,
      comfyui_aspect_ratio: ratioObj.name,
      comfyui_megapixels: megapixelsVal,
      comfyui_multiple: multipleVal
    });
    
    const sizeStr = `${w} × ${h}`;
    if (sizeDisplay) sizeDisplay.textContent = sizeStr;
    const drawerSizeDisplay = document.getElementById('drawer-active-size-display');
    if (drawerSizeDisplay) drawerSizeDisplay.textContent = sizeStr;
    
    if (valWidth) valWidth.textContent = w;
    if (valHeight) valHeight.textContent = h;
  }

  function openResolutionDrawer() {
    const btnRect = btnOpenResolution.getBoundingClientRect();
    const computedStyle = window.getComputedStyle(btnOpenResolution);
    const btnRadius = computedStyle.borderRadius;

    // 1. Measure natural height of the drawer content when constrained to button width
    const targetWidth = btnRect.width;
    drawer.style.transition = 'none';
    drawer.style.width = `${targetWidth}px`;
    drawer.style.height = 'auto';
    // Add open class temporarily to measure if needed, but it's display:flex anyway
    const targetHeight = drawer.offsetHeight;

    // 2. Snap drawer to the exact button position & size
    drawer.style.top = `${btnRect.top}px`;
    drawer.style.left = `${btnRect.left}px`;
    drawer.style.width = `${btnRect.width}px`;
    drawer.style.height = `${btnRect.height}px`;
    drawer.style.borderRadius = btnRadius;
    
    // Hide the button to create illusion that it transforms
    btnOpenResolution.style.transition = 'opacity 0.1s ease';
    btnOpenResolution.style.opacity = '0';
    btnOpenResolution.style.pointerEvents = 'none';

    // Force reflow so the browser applies the start position without transition
    void drawer.offsetHeight;

    // 3. Add open class and remove inline transition to allow CSS transitions
    drawer.style.transition = '';
    drawer.classList.add('open');

    // 4. Calculate target position: anchored to bottom of button
    let targetTop = btnRect.bottom - targetHeight;
    // If expanding upwards goes off-screen top, anchor to top of button instead
    if (targetTop < 12) {
      targetTop = btnRect.top;
    }

    drawer.style.top = `${targetTop}px`;
    drawer.style.left = `${btnRect.left}px`;
    drawer.style.width = `${targetWidth}px`;
    drawer.style.height = `${targetHeight}px`;
    drawer.style.borderRadius = '16px'; // slightly more rounded for the large panel

    if (window.setDrawerBackdrop) window.setDrawerBackdrop(true);
  }

  function closeResolutionDrawer() {
    const btnRect = btnOpenResolution.getBoundingClientRect();
    const computedStyle = window.getComputedStyle(btnOpenResolution);
    const btnRadius = computedStyle.borderRadius;

    drawer.style.transition = '';

    // Collapse back to button's exact position and size
    drawer.style.top = `${btnRect.top}px`;
    drawer.style.left = `${btnRect.left}px`;
    drawer.style.width = `${btnRect.width}px`;
    drawer.style.height = `${btnRect.height}px`;
    drawer.style.borderRadius = btnRadius;

    drawer.classList.remove('open');
    if (window.setDrawerBackdrop) window.setDrawerBackdrop(false);

    // Restore button when animation finishes (starting crossfade at 280ms)
    setTimeout(() => {
      if (!drawer.classList.contains('open')) {
        btnOpenResolution.style.transition = 'opacity 0.1s ease';
        btnOpenResolution.style.opacity = '1';
        btnOpenResolution.style.pointerEvents = 'auto';
      }
    }, 280); // matches the start of drawer opacity fadeout!
  }

  btnOpenResolution.addEventListener('click', (e) => {
    e.stopPropagation();
    openResolutionDrawer();
  });

  if (btnCloseResolution) {
    btnCloseResolution.addEventListener('click', (e) => {
      e.stopPropagation();
      closeResolutionDrawer();
    });
  }

  // Close on backdrop click (clicks outside the drawer)
  document.addEventListener('click', (e) => {
    if (drawer.classList.contains('open') && !drawer.contains(e.target) && e.target !== btnOpenResolution && !btnOpenResolution.contains(e.target)) {
      closeResolutionDrawer();
    }
  });

  aspectDec.addEventListener('click', () => {
    aspectIndex = (aspectIndex - 1 + ASPECT_RATIOS.length) % ASPECT_RATIOS.length;
    if (aspectValText) aspectValText.textContent = ASPECT_RATIOS[aspectIndex].name;
    calculateAndSaveSize();
  });
  aspectInc.addEventListener('click', () => {
    aspectIndex = (aspectIndex + 1) % ASPECT_RATIOS.length;
    if (aspectValText) aspectValText.textContent = ASPECT_RATIOS[aspectIndex].name;
    calculateAndSaveSize();
  });

  mpDec.addEventListener('click', () => {
    megapixelsVal = Math.max(0.2, megapixelsVal - 0.05);
    if (mpValText) mpValText.textContent = megapixelsVal.toFixed(2);
    calculateAndSaveSize();
  });
  mpInc.addEventListener('click', () => {
    megapixelsVal = Math.min(4.0, megapixelsVal + 0.05);
    if (mpValText) mpValText.textContent = megapixelsVal.toFixed(2);
    calculateAndSaveSize();
  });

  multDec.addEventListener('click', () => {
    const idx = MULTIPLES.indexOf(multipleVal);
    const newIdx = (idx - 1 + MULTIPLES.length) % MULTIPLES.length;
    multipleVal = MULTIPLES[newIdx];
    if (multValText) multValText.textContent = multipleVal;
    calculateAndSaveSize();
  });
  multInc.addEventListener('click', () => {
    const idx = MULTIPLES.indexOf(multipleVal);
    const newIdx = (idx + 1) % MULTIPLES.length;
    multipleVal = MULTIPLES[newIdx];
    if (multValText) multValText.textContent = multipleVal;
    calculateAndSaveSize();
  });

  batchDec.addEventListener('click', () => {
    if (batchSizeVal > 1) {
      batchSizeVal--;
      if (batchValText) batchValText.textContent = batchSizeVal;
      settingsStore.save({ comfyui_batch_size: batchSizeVal });
    }
  });
  batchInc.addEventListener('click', () => {
    if (batchSizeVal < 8) {
      batchSizeVal++;
      if (batchValText) batchValText.textContent = batchSizeVal;
      settingsStore.save({ comfyui_batch_size: batchSizeVal });
    }
  });

  const btnBatchClose = document.getElementById('btn-batch-close');
  if (btnBatchClose) {
    btnBatchClose.addEventListener('click', () => {
      showCreationForm();
    });
  }

  syncResolutionSelectorUI();
}

// ─── Lineage Helper ──────────────────────────────────────────────────
window.hasLineage = function(imgId) {
  const images = albumStore.getAll();
  // Image has lineage if it has a parent or if it is a parent
  return images.some(img => img.id === imgId && img.parentId) || 
         images.some(img => img.parentId === imgId);
}

let galleryIntersectionObserver = null;

function createGalleryItemCard(img, invisibleImgId = null) {
  const card = document.createElement('div');
  card.className = 'gallery-item-card';
  if (invisibleImgId && img.id === invisibleImgId) {
    card.classList.add('just-added-flying');
    card.classList.add('no-entry-anim');
  }
  const isVideo = img.isVideo || (img.url && (img.url.includes('.mp4') || img.url.includes('/video/')));
  const mediaTag = isVideo 
    ? `<video src="${img.url}" preload="metadata" loop muted playsinline style="width:100%; height:100%; object-fit:cover; pointer-events:none;"></video>` 
    : `<img src="${img.url}" alt="Saved artwork" loading="lazy">`;

  card.innerHTML = `
    ${mediaTag}
    <div class="gallery-item-overlay">
      <button class="gallery-item-action-btn view-details" title="Copy Prompt">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
        </svg>
      </button>
      ${!isVideo ? `
      <button class="gallery-item-action-btn edit-saved" title="Edit Image">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
        </svg>
      </button>
      ` : ''}
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
      ${window.hasLineage(img.id) ? `
      <button class="gallery-item-action-btn view-lineage" title="View Lineage Tree">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path>
          <path d="M3 3v5h5"></path>
        </svg>
      </button>
      ` : ''}
    </div>
  `;

  // Click card (image or overlay background) to open in lightbox zoomer
  card.addEventListener('click', (e) => {
    if (e.target.closest('.gallery-item-action-btn')) return;
    if (window.openLightbox) {
      window.openLightbox(img.url, img.prompt, img.tags, img.id, img.isVideo || false);
    }
  });

  // Click check button to restore prompt and active tags
  card.querySelector('.view-details').addEventListener('click', (e) => {
    e.stopPropagation();
    restorePromptFromSaved(img);
    showToast('Loaded prompt & tags from gallery');
  });

  // Click edit button to edit the image
  const editBtn = card.querySelector('.edit-saved');
  if (editBtn) {
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      document.getElementById('album-drawer').classList.remove('open');
      if (window.switchView) window.switchView('create');
      enterEditorMode(img.url, img.prompt, img.tags, img.id);
    });
  }

  // Click send-to-video button to generate video from artwork
  const sendToVidBtn = card.querySelector('.send-to-video');
  if (sendToVidBtn) {
    sendToVidBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      document.getElementById('album-drawer').classList.remove('open');
      if (window.sendImageToVideoGen) {
        window.sendImageToVideoGen(img.url, img.prompt, img.id);
      }
    });
  }

  // Click fullscreen button
  card.querySelector('.view-fullscreen').addEventListener('click', (e) => {
    e.stopPropagation();
    if (window.openLightbox) {
      window.openLightbox(img.url, img.prompt, img.tags, img.id, img.isVideo || false);
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

  const lineageBtn = card.querySelector('.view-lineage');
  if (lineageBtn) {
    lineageBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (window.openLineageTree) window.openLineageTree(img.id);
    });
  }

  return card;
}

// ─── Gallery Album Render ─────────────────────────────────────────
function renderGalleryList(invisibleImgId = null) {
  const grid = document.getElementById('gallery-album-grid');
  if (!grid) return;

  grid.innerHTML = '';
  if (galleryIntersectionObserver) {
    galleryIntersectionObserver.disconnect();
    galleryIntersectionObserver = null;
  }

  const images = albumStore.getAll();

  if (images.length === 0) {
    grid.innerHTML = `
      <div class="empty-gallery-placeholder">
        No saved images yet. Generate art and click "Save to Album"!
      </div>
    `;
    return;
  }

  const BATCH_SIZE = 24;
  let renderedCount = 0;

  function loadNextBatch() {
    const nextBatch = images.slice(renderedCount, renderedCount + BATCH_SIZE);
    if (nextBatch.length === 0) return;

    const oldSentinel = grid.querySelector('.gallery-sentinel');
    if (oldSentinel) oldSentinel.remove();

    nextBatch.forEach(img => {
      const card = createGalleryItemCard(img, invisibleImgId);
      grid.appendChild(card);
    });

    renderedCount += nextBatch.length;

    if (renderedCount < images.length) {
      const remainingItems = images.length - renderedCount;
      const cols = 2;
      const estimatedRowHeight = 150;
      const estimatedHeight = Math.ceil(remainingItems / cols) * estimatedRowHeight;

      const sentinel = document.createElement('div');
      sentinel.className = 'gallery-sentinel';
      sentinel.style.gridColumn = '1 / -1';
      sentinel.style.height = `${Math.max(20, estimatedHeight)}px`;
      grid.appendChild(sentinel);

      if (!galleryIntersectionObserver) {
        galleryIntersectionObserver = new IntersectionObserver((entries) => {
          if (entries[0].isIntersecting) {
            loadNextBatch();
          }
        }, { root: grid.parentElement || null, rootMargin: '300px' });
      }
      galleryIntersectionObserver.observe(sentinel);
    }
  }

  loadNextBatch();
}

// ─── Full-page Album Workspace Render ─────────────────────────────────
window.renderAlbumWorkspace = async function() {
  const container = document.getElementById('album-workspace');
  if (!container || container.classList.contains('hidden')) return;

  // Handle directory permission banner
  const permissionBanner = document.getElementById('album-dir-permission-banner');
  const btnGrantPermission = document.getElementById('btn-grant-album-permission');
  
  if (permissionBanner) {
    const hasDir = albumStore.hasDirectory();
    const hasPermission = hasDir ? await albumStore.checkDirectoryPermission() : true;
    
    if (hasDir && !hasPermission) {
      permissionBanner.style.display = 'flex';
      if (btnGrantPermission) {
        btnGrantPermission.onclick = async () => {
          const granted = await albumStore.requestDirectoryPermission();
          if (granted) {
            showToast('Access to directory granted', 'success');
            window.renderAlbumWorkspace();
          }
        };
      }
    } else {
      permissionBanner.style.display = 'none';
    }
  }

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
      if (window.openLightbox) window.openLightbox(randomImg.url, randomImg.prompt, randomImg.tags, randomImg.id);
    };
  }

  // Calculate tag stats
  console.log("Album render workspace images count:", images.length);
  console.log("Album images details:", images.map(img => ({ id: img.id, tags: img.tags, prompt: img.prompt, filename: img.filename })));
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

  // Track which images are children of other images in this album
  const allIds = new Set(images.map(i => i.id));
  const childrenCountMap = {}; // parentId -> count
  images.forEach(img => {
    if (img.parentId && allIds.has(img.parentId)) {
      childrenCountMap[img.parentId] = (childrenCountMap[img.parentId] || 0) + 1;
    }
  });

  const isGroupMode = document.getElementById('toggle-group-lineage')?.checked;

  // In group mode, hide direct children from the date groups (they'll appear under parent)
  const hiddenChildIds = new Set();
  if (isGroupMode) {
    images.forEach(img => {
      if (img.parentId && allIds.has(img.parentId)) {
        hiddenChildIds.add(img.id);
      }
    });
  }

  // Build a helper to create a gallery card for an image
  function buildCard(img, isChild = false) {
    const card = document.createElement('div');
    card.className = 'gallery-item-card' + (isChild ? ' child-card' : '');
    card.dataset.imgId = img.id;

    const childCount = childrenCountMap[img.id] || 0;
    // In badge we'll want total descendants, but childrenCountMap is only direct children.
    // We use it as a quick check; the badge text is set after buildCard via collectDescendants if needed.
    const badgeHtml = (isGroupMode && childCount > 0)
      ? `<div class="edits-badge" data-root="${img.id}">…</div>`
      : '';

    if (isGroupMode && childCount > 0) card.classList.add('has-children');

    const isVideo = img.isVideo || (img.url && (img.url.includes('.mp4') || img.url.includes('/video/') || (img.filename && img.filename.endsWith('.mp4'))));
    const mediaTag = isVideo 
      ? `<video src="${img.url}" preload="metadata" loop muted playsinline style="width:100%; height:100%; object-fit:cover; pointer-events:none;"></video>` 
      : `<img src="${img.url}" alt="Saved artwork" loading="lazy">`;

    card.innerHTML = `
      ${mediaTag}
      ${badgeHtml}
      <div class="gallery-item-overlay">
        <button class="gallery-item-action-btn view-details" title="Copy Prompt">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          </svg>
        </button>
        ${!isVideo ? `
        <button class="gallery-item-action-btn edit-saved" title="Edit Image">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
          </svg>
        </button>
        ` : ''}
        <button class="gallery-item-action-btn send-to-video" title="Animate Video (Wan 2.2)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polygon points="23 7 16 12 23 17 23 7"/>
            <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
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
        ${window.hasLineage(img.id) ? `
        <button class="gallery-item-action-btn view-lineage" title="View Lineage Tree">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path>
            <path d="M3 3v5h5"></path>
          </svg>
        </button>
        ` : ''}
      </div>
    `;

    card.addEventListener('click', (e) => {
      if (e.target.closest('.gallery-item-action-btn')) return;
      // In group mode, clicking a parent with children toggles its children
      if (isGroupMode && childCount > 0) {
        toggleChildCards(img.id, card);
        return;
      }
      if (window.openLightbox) window.openLightbox(img.url, img.prompt, img.tags, img.id, img.isVideo || false);
    });

    card.querySelector('.view-details').addEventListener('click', (e) => {
      e.stopPropagation();
      restorePromptFromSaved(img);
      showToast('Loaded prompt & tags from gallery');
    });

    const editBtn = card.querySelector('.edit-saved');
    if (editBtn) {
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (window.switchView) window.switchView('create');
        enterEditorMode(img.url, img.prompt, img.tags, img.id);
      });
    }

    const sendToVidBtn = card.querySelector('.send-to-video');
    if (sendToVidBtn) {
      sendToVidBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (window.sendImageToVideoGen) window.sendImageToVideoGen(img.url, img.prompt, img.id);
      });
    }

    card.querySelector('.view-fullscreen').addEventListener('click', (e) => {
      e.stopPropagation();
      if (window.openLightbox) window.openLightbox(img.url, img.prompt, img.tags, img.id, img.isVideo || false);
    });

    card.querySelector('.delete').addEventListener('click', (e) => {
      e.stopPropagation();
      albumStore.delete(img.id);
      renderGalleryList();
      renderAlbumWorkspace();
      showToast('Artwork removed from album', 'info');
    });

    const lineageBtn = card.querySelector('.view-lineage');
    if (lineageBtn) {
      lineageBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (window.openLineageTree) window.openLineageTree(img.id);
      });
    }

    return card;
  }

  // Build children-by-parent map for fast lookup
  const childrenByParent = {}; // parentId -> [child img, ...]
  images.forEach(img => {
    if (img.parentId && allIds.has(img.parentId)) {
      if (!childrenByParent[img.parentId]) childrenByParent[img.parentId] = [];
      childrenByParent[img.parentId].push(img);
    }
  });

  // Recursively collect all descendants of a given id (BFS, preserves order)
  function collectDescendants(rootId) {
    const result = [];
    const queue = [...(childrenByParent[rootId] || [])];
    while (queue.length > 0) {
      const item = queue.shift();
      result.push(item);
      const grandchildren = childrenByParent[item.id] || [];
      queue.push(...grandchildren);
    }
    return result;
  }

  // Toggle children visibility when clicking a parent card (shows/hides all descendants)
  function toggleChildCards(rootId, parentCard) {
    const grid = parentCard.closest('.gallery-grid');
    if (!grid) return;
    const childCards = grid.querySelectorAll(`.child-card[data-root-id="${rootId}"]`);
    const isExpanded = parentCard.dataset.expanded === 'true';
    parentCard.dataset.expanded = isExpanded ? 'false' : 'true';
    childCards.forEach((cc, i) => {
      if (isExpanded) {
        cc.classList.remove('visible');
        setTimeout(() => cc.classList.add('hidden-child'), 300);
      } else {
        cc.classList.remove('hidden-child');
        requestAnimationFrame(() => {
          setTimeout(() => cc.classList.add('visible'), i * 40);
        });
      }
    });
  }

  // Group by date — skip ALL descendants in group mode (they appear under root ancestor)
  const now = Date.now();
  const groups = [
    { key: 'hour', title: 'Last Hour', items: [] },
    { key: 'day', title: 'Today', items: [] },
    { key: 'month', title: 'This Month', items: [] },
    { key: 'older', title: 'Older', items: [] }
  ];

  images.forEach(img => {
    if (isGroupMode && hiddenChildIds.has(img.id)) return;
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
    
    const BATCH_SIZE = 24;
    let renderedCount = 0;

    function renderNextGroupBatch() {
      const batch = group.items.slice(renderedCount, renderedCount + BATCH_SIZE);
      if (batch.length === 0) return;

      const oldSentinel = grid.querySelector('.group-sentinel');
      if (oldSentinel) oldSentinel.remove();

      batch.forEach(img => {
        const card = buildCard(img, false);
        grid.appendChild(card);

        // In group mode, insert ALL descendants (not just direct children) after the root
        if (isGroupMode && childrenByParent[img.id]) {
          const allDescendants = collectDescendants(img.id);
          // Update badge with real total count
          const badge = card.querySelector('.edits-badge');
          if (badge) {
            const n = allDescendants.length;
            badge.textContent = `${n} edit${n !== 1 ? 's' : ''}`;
          }
          allDescendants.forEach((descendant) => {
            const childCard = buildCard(descendant, true);
            childCard.dataset.rootId = img.id; // link to root ancestor for toggle
            childCard.classList.add('hidden-child');
            grid.appendChild(childCard);
          });
        }
      });

      renderedCount += batch.length;

      if (renderedCount < group.items.length) {
        const remainingItems = group.items.length - renderedCount;
        const gridWidth = grid.clientWidth || 800;
        const cols = Math.max(1, Math.floor(gridWidth / 180));
        const estimatedHeight = Math.ceil(remainingItems / cols) * 180;

        const sentinel = document.createElement('div');
        sentinel.className = 'group-sentinel';
        sentinel.style.gridColumn = '1 / -1';
        sentinel.style.height = `${Math.max(20, estimatedHeight)}px`;
        grid.appendChild(sentinel);

        const observer = new IntersectionObserver((entries) => {
          if (entries[0].isIntersecting) {
            observer.disconnect();
            renderNextGroupBatch();
          }
        }, { rootMargin: '300px' });
        observer.observe(sentinel);
      }
    }

    renderNextGroupBatch();

    section.appendChild(grid);
    groupsContainer.appendChild(section);
  });
}

// Listen for toggle-group-lineage changes
document.addEventListener('DOMContentLoaded', () => {
  const groupToggle = document.getElementById('toggle-group-lineage');
  if (groupToggle) {
    groupToggle.addEventListener('change', () => {
      window.renderAlbumWorkspace();
    });
  }
});

function getPromptSaveData() {
  const mainPromptText = getEditorTextRepresentation(document.getElementById('prompt-input-editor'));
  const artStyleText = getEditorTextRepresentation(document.getElementById('art-style-input-editor'));
  const subPrompts = appState.subPrompts.map(sp => ({
    id: sp.id,
    label: sp.label,
    text: sp.text
  }));
  return { subPrompts, mainPromptText, artStyleText };
}

function restorePromptFromSaved(savedImage) {
  const promptInput = document.getElementById('prompt-text-input');
  
  let rawText = '';
  if (savedImage.mainPromptText !== undefined && savedImage.mainPromptText !== null) {
    rawText = savedImage.mainPromptText;
  } else {
    rawText = savedImage.prompt || '';
  }
  
  // Restore tags
  appState.activeTags = savedImage.tags ? [...savedImage.tags] : [];
  if (savedImage.tagWeights) {
    appState.tagWeights = JSON.parse(JSON.stringify(savedImage.tagWeights));
  } else {
    appState.tagWeights = {};
  }
  
  // Register any saved tags containing commas as known character triggers
  appState.activeTags.forEach(t => {
    if (t && t.includes(',')) {
      appState.knownCharTriggers.add(t);
    }
  });
  
  // Filter out the Positive Prompt Prefix from the restored prompt description
  const prefixInput = document.getElementById('setting-comfyui-positive-prefix');
  const prefixStr = prefixInput ? prefixInput.value.trim() : '';
  if (prefixStr) {
    prefixStr.split(',').forEach(p => {
      const cleanP = p.trim();
      if (cleanP) {
        rawText = stripTagFromText(rawText, cleanP);
      }
    });
  }
  
  // Restore sub-prompts
  appState.subPrompts = savedImage.subPrompts ? JSON.parse(JSON.stringify(savedImage.subPrompts)) : [];
  renderSubPrompts();
  
  if (promptInput) {
    isUpdatingFromEditor = true;
    try {
      if (savedImage.artStyleText !== undefined && savedImage.artStyleText !== null) {
        syncValueToEditor(rawText, document.getElementById('prompt-input-editor'));
        syncValueToEditor(savedImage.artStyleText, document.getElementById('art-style-input-editor'));
      } else {
        splitAndSyncValueToEditors(rawText);
      }
    } finally {
      isUpdatingFromEditor = false;
    }
    // Update raw input value
    const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
    descriptor.set.call(promptInput, rawText);
  }
  
  renderCategoryTags();

  // Restore LoRAs
  if (savedImage.loras && Array.isArray(savedImage.loras)) {
    appState.loras = JSON.parse(JSON.stringify(savedImage.loras));
  } else {
    appState.loras = [];
  }
  renderLorasList();

  // Auto-switch to Advanced tab if there are sub-prompts
  if (appState.subPrompts && appState.subPrompts.length > 0) {
    const tabAdvanced = document.getElementById('tab-mode-advanced');
    if (tabAdvanced) {
      tabAdvanced.click();
    }
  }
}

function getFinalPrompt() {
  if (window.videoState && window.videoState.engineMode === 'img2vid') {
    const p1 = document.getElementById('video-prompt-setting')?.value.trim() || '';
    const p2 = document.getElementById('video-prompt-action')?.value.trim() || '';
    const p3 = document.getElementById('video-prompt-camera')?.value.trim() || '';
    const combined = [p1, p2, p3].filter(Boolean).join(', ');
    if (combined) return combined;
    if (window.videoState && window.videoState.lastCombinedPrompt) return window.videoState.lastCombinedPrompt;
  }

  const mainEditor = document.getElementById('prompt-input-editor');
  if (!mainEditor) {
    const promptInput = document.getElementById('prompt-text-input');
    return promptInput ? promptInput.value.trim() : '';
  }
  
  const editors = [mainEditor];
  if (appState.activeMode === 'advanced') {
    const subEditors = document.querySelectorAll('.sub-prompt-input-editor');
    subEditors.forEach(el => editors.push(el));
  }
  
  const parts = [];
  for (const editor of editors) {
    if (!editor) continue;
    const list = getEditorContentList(editor);
    for (const item of list) {
      if (item.type === 'text') {
        const txt = item.text.trim();
        if (txt) parts.push(txt);
      } else if (item.type === 'tag') {
        const tag = item.tag;
        const weight = item.weight !== undefined ? item.weight : 1.0;
        const info = tagsDatabase.getTagInfo(tag);
        
        let expanded = [];
        if (info && info.sub_tags && Array.isArray(info.sub_tags)) {
          info.sub_tags.forEach(subTag => {
            if (weight !== 1.0) {
              expanded.push(`(${subTag}:${weight.toFixed(1)})`);
            } else {
              expanded.push(subTag);
            }
          });
        } else {
          if (weight !== 1.0) {
            expanded.push(`(${tag}:${weight.toFixed(1)})`);
          } else {
            expanded.push(tag);
          }
        }
        parts.push(expanded.join(', '));
      }
    }
  }

  // Collect from art-style-input-editor
  const artStyleEditor = document.getElementById('art-style-input-editor');
  const artStyleParts = [];
  if (artStyleEditor) {
    const list = getEditorContentList(artStyleEditor);
    for (const item of list) {
      if (item.type === 'text') {
        const txt = item.text.trim();
        if (txt) artStyleParts.push(txt);
      } else if (item.type === 'tag') {
        const tag = item.tag;
        const weight = item.weight !== undefined ? item.weight : 1.0;
        const info = tagsDatabase.getTagInfo(tag);
        
        let expanded = [];
        if (info && info.sub_tags && Array.isArray(info.sub_tags)) {
          info.sub_tags.forEach(subTag => {
            if (weight !== 1.0) {
              expanded.push(`(${subTag}:${weight.toFixed(1)})`);
            } else {
              expanded.push(subTag);
            }
          });
        } else {
          if (weight !== 1.0) {
            expanded.push(`(${tag}:${weight.toFixed(1)})`);
          } else {
            expanded.push(tag);
          }
        }
        artStyleParts.push(expanded.join(', '));
      }
    }
  }
  
  const prefixInput = document.getElementById('setting-comfyui-positive-prefix');
  const prefixStr = prefixInput ? prefixInput.value.trim() : '';
  
  let finalParts = [];
  if (prefixStr) finalParts.push(prefixStr);
  
  let result = parts.join(', ');
  result = result.replace(/,\s*,/g, ',');
  result = result.replace(/\.\s*,/g, '.');
  result = result.replace(/,\s*\./g, '.');
  result = result.replace(/\s+/g, ' ');
  result = result.trim().replace(/^,|,$/g, '').trim();
  
  if (result) finalParts.push(result);

  let artStyleResult = artStyleParts.join(', ');
  artStyleResult = artStyleResult.replace(/,\s*,/g, ',');
  artStyleResult = artStyleResult.replace(/\.\s*,/g, '.');
  artStyleResult = artStyleResult.replace(/,\s*\./g, '.');
  artStyleResult = artStyleResult.replace(/\s+/g, ' ');
  artStyleResult = artStyleResult.trim().replace(/^,|,$/g, '').trim();

  if (artStyleResult) finalParts.push(artStyleResult);
  
  return finalParts.join(', ');
}
async function startImageGeneration() {
  appState.lastGenerationMode = 'creation';
  appState.isVideoGeneration = false;
  appState.editorSourceImageId = null; // Clear lineage for fresh generation
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
  
  const settings = settingsStore.get();
  const batchSize = settings.comfyui_batch_size || 1;
  setupBatchLoaderBoxes(batchSize);

  smoothUpdateLoaderText('Waiting in ComfyUI queue...');

  try {
    const activeLoras = appState.loras.filter(l => l.enabled && l.name);
    let previewsHistory = [];
    const imgUrls = await generateImageComfyUI(
      finalPrompt,
      (status) => {
        smoothUpdateLoaderText(status);
      },
      appState.generationAbortController.signal,
      (previewUrl) => {
        const previewImg = document.getElementById('generation-live-preview');
        if (previewImg) {
          previewImg.src = previewUrl;
          previewImg.classList.remove('hidden');
        }

        // Add preview to history
        previewsHistory.push(previewUrl);
        if (previewsHistory.length > batchSize + 5) {
          previewsHistory.shift();
        }

        // Update other batch boxes with lagged previews
        for (let i = 2; i <= batchSize; i++) {
          const imgEl = document.getElementById(`batch-box-preview-img-${i}`);
          if (imgEl) {
            const lag = i - 1;
            const historyIdx = previewsHistory.length - 1 - lag;
            const urlToShow = historyIdx >= 0 ? previewsHistory[historyIdx] : previewsHistory[0];
            if (urlToShow) {
              imgEl.src = urlToShow;
              imgEl.classList.remove('hidden');
            }
          }
        }
      },
      null,
      activeLoras
    );

    if (batchSize >= 2 && Array.isArray(imgUrls)) {
      appState.generatedImageUrl = imgUrls[0];
      appState.batchGeneratedImageUrls = imgUrls;
      appState.isBatchPreviewActive = true;
      showToast('Images generated successfully!', 'success');
      showBatchArtPreview(imgUrls);
    } else {
      const finalUrl = Array.isArray(imgUrls) ? imgUrls[0] : imgUrls;
      appState.generatedImageUrl = finalUrl;
      appState.batchGeneratedImageUrls = null;
      appState.isBatchPreviewActive = false;
      showToast('Image generated successfully!', 'success');
      showArtPreview(finalUrl);
    }

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
  const videoFormContainer = document.getElementById('video-form-container');
  if (videoFormContainer) videoFormContainer.classList.add('hidden');
  const editorContainer = document.getElementById('image-editor-container');
  if (editorContainer) {
    editorContainer.classList.add('hidden');
  }
  document.getElementById('generation-loader').classList.remove('hidden');

  // Reset progress bar width
  const progressBar = document.getElementById('loader-progress-bar');
  if (progressBar) {
    progressBar.style.width = '0%';
  }
  // Reset stage text container to single initial active span
  const stageTextContainer = document.getElementById('loader-stage-text');
  if (stageTextContainer) {
    stageTextContainer.innerHTML = '<span class="stage-text-span active">Waiting in ComfyUI queue...</span>';
  }
}

function showArtPreview(url) {
  const finalUrl = Array.isArray(url) ? url[0] : url;
  const previewImg = document.getElementById('generation-live-preview');
  const targetImg = document.getElementById('generated-art-img');

  if (targetImg) {
    targetImg.onclick = null; // Clear batch-specific click handler to prevent closure bugs
  }

  // Pre-load the image to guarantee its size and dimensions are known immediately by the browser
  const tempImg = new Image();
  tempImg.src = finalUrl;
  
  const proceedWithTransition = () => {
    targetImg.src = finalUrl;
    if (previewImg) {
      previewImg.src = finalUrl;
      previewImg.classList.remove('hidden');
    }

    playMorphPreviewAnimation(previewImg, targetImg, () => {
      // changeState callback: perform DOM changes
      const mainWorkspace = document.getElementById('main-workspace');
      mainWorkspace.classList.remove('generating');
      mainWorkspace.classList.remove('batch-preview'); // Ensure single image view layout
      
      const videoPlayer = document.getElementById('generated-video-player');
      if (videoPlayer) {
        videoPlayer.pause();
        videoPlayer.classList.add('hidden');
      }
      if (targetImg) targetImg.classList.remove('hidden');

      const btnGenMore = document.getElementById('btn-post-generate-more');
      if (btnGenMore) btnGenMore.classList.add('hidden');

      document.getElementById('creation-form-container').classList.add('hidden');
      document.getElementById('improve-confirmation-container').classList.add('hidden');
      document.getElementById('generation-loader').classList.add('hidden');
      
      const wrapper = document.getElementById('art-preview-area');
      if (wrapper) {
        wrapper.classList.remove('hidden');
        
        // Restore global actions bar and hide batch box 1 local actions
        const globalActions = wrapper.querySelector('.post-gen-actions-bar');
        if (globalActions) globalActions.classList.remove('hidden');
        
        const localActionsWrap = document.getElementById('batch-box-1-actions');
        if (localActionsWrap) localActionsWrap.classList.add('hidden');
      }
      
      const surpriseActions = document.getElementById('post-gen-surprise-actions');
      if (surpriseActions) {
        if (appState.lastGenerationWasSurprise) {
          surpriseActions.classList.remove('hidden');
        } else {
          surpriseActions.classList.add('hidden');
        }
      }

      // Clear extra batch boxes
      const container = document.getElementById('batch-boxes-container');
      if (container) {
        while (container.children.length > 1) {
          container.removeChild(container.lastChild);
        }
      }
      
      // Hide global batch close footer
      const footer = document.getElementById('batch-actions-footer');
      if (footer) {
        footer.classList.add('hidden');
      }
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

// ─── Batch Art Preview Rendering Helpers ─────────────────────────────
function setupBatchLoaderBoxes(batchSize) {
  const container = document.getElementById('batch-boxes-container');
  if (!container) return;
  
  // Keep only main-workspace as the first child
  while (container.children.length > 1) {
    container.removeChild(container.lastChild);
  }
  
  if (batchSize < 2) return;
  
  // Create N-1 generating boxes
  for (let i = 2; i <= batchSize; i++) {
    const box = document.createElement('div');
    box.className = 'batch-preview-box generating';
    box.id = `batch-box-${i}`;
    box.innerHTML = `
      <img class="batch-box-preview-img hidden" id="batch-box-preview-img-${i}" alt="Generating live preview">
      <div class="loader-circle-spinner" style="width: 40px; height: 40px; border-width: 4px; border-top-color: var(--accent-secondary, #06b6d4) !important;"></div>
      <div class="batch-box-title">Image #${i}</div>
    `;
    container.appendChild(box);
    
    // Smoothly animate the width slide-in
    requestAnimationFrame(() => {
      box.classList.add('active');
    });
  }
}

function createBatchActionsHTML(url, index) {
  return `
    <button type="button" class="batch-action-btn edit-btn" data-url="${url}" data-index="${index}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 14px; height: 14px;">
        <path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
      </svg>
      <span>Edit</span>
    </button>
    <button type="button" class="batch-action-btn save-btn" data-url="${url}" data-index="${index}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 14px; height: 14px;">
        <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
        <polyline points="17 21 17 13 7 13 7 21"/>
        <polyline points="7 3 7 8 15 8"/>
      </svg>
      <span>Save</span>
    </button>
  `;
}

function wireBatchActionButtons(container, url, index) {
  const saveBtn = container.querySelector('.save-btn');
  const editBtn = container.querySelector('.edit-btn');
  
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      const span = saveBtn.querySelector('span');
      const origHtml = saveBtn.innerHTML;
      span.textContent = 'Saving...';
      try {
        const finalPrompt = getFinalPrompt();
        const { subPrompts, mainPromptText, artStyleText } = getPromptSaveData();
        await albumStore.save(url, finalPrompt, appState.activeTags, appState.editorSourceImageId, null, appState.loras, subPrompts, mainPromptText, artStyleText);
        showToast('Saved to Album!', 'success');
        
        saveBtn.innerHTML = `
          <svg viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2" style="width: 14px; height: 14px;">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
          <span>Saved</span>
        `;
        saveBtn.classList.add('saved');
        
        renderGalleryList();
        if (window.renderAlbumWorkspace) window.renderAlbumWorkspace();
      } catch (err) {
        showToast('Failed to save image', 'error');
        saveBtn.innerHTML = origHtml;
        saveBtn.disabled = false;
      }
    });
  }
  
  if (editBtn) {
    editBtn.addEventListener('click', async () => {
      editBtn.disabled = true;
      const span = editBtn.querySelector('span');
      const origHtml = editBtn.innerHTML;
      span.textContent = 'Saving...';
      try {
        const finalPrompt = getFinalPrompt();
        const { subPrompts, mainPromptText, artStyleText } = getPromptSaveData();
        const savedImg = await albumStore.save(url, finalPrompt, appState.activeTags, appState.editorSourceImageId, null, appState.loras, subPrompts, mainPromptText, artStyleText);
        showToast('Saved & opening editor...', 'success');
        
        renderGalleryList();
        if (window.renderAlbumWorkspace) window.renderAlbumWorkspace();
        
        enterEditorMode(savedImg.url, savedImg.prompt, savedImg.tags, savedImg.id);
      } catch (err) {
        showToast('Failed to enter editor', 'error');
      } finally {
        editBtn.innerHTML = origHtml;
        editBtn.disabled = false;
      }
    });
  }
}

function showBatchArtPreview(urls) {
  const container = document.getElementById('batch-boxes-container');
  if (!container) return;

  // 1. Prepare main-workspace for batch preview
  const mainWorkspace = document.getElementById('main-workspace');
  mainWorkspace.classList.remove('generating');
  mainWorkspace.classList.add('batch-preview');
  
  // Hide loader and show art-preview-area in main-workspace
  document.getElementById('generation-loader').classList.add('hidden');
  const previewArea = document.getElementById('art-preview-area');
  previewArea.classList.remove('hidden');
  
  // Hide global buttons and show local ones
  const globalActions = previewArea.querySelector('.post-gen-actions-bar');
  if (globalActions) globalActions.classList.add('hidden');
  
  const surpriseActions = document.getElementById('post-gen-surprise-actions');
  if (surpriseActions) surpriseActions.classList.add('hidden');
  
  // Set main image src
  const videoPlayer = document.getElementById('generated-video-player');
  if (videoPlayer) {
    videoPlayer.pause();
    videoPlayer.classList.add('hidden');
  }
  const mainImg = document.getElementById('generated-art-img');
  if (mainImg) mainImg.classList.remove('hidden');
  mainImg.src = urls[0];
  mainImg.style.cursor = 'zoom-in';
  mainImg.onclick = null; // Clear to let global listener handle it dynamically!

  // Build/Update local buttons container for main workspace box
  let localActionsWrap = document.getElementById('batch-box-1-actions');
  localActionsWrap.className = 'batch-box-actions';
  localActionsWrap.classList.remove('hidden');
  localActionsWrap.innerHTML = createBatchActionsHTML(urls[0], 1);
  wireBatchActionButtons(localActionsWrap, urls[0], 1);

  // 2. Populate extra preview boxes
  for (let i = 2; i <= urls.length; i++) {
    const box = document.getElementById(`batch-box-${i}`);
    if (box) {
      box.className = 'batch-preview-box completed active';
      const imgUrl = urls[i - 1];
      box.innerHTML = `
        <div class="batch-box-canvas">
          <img src="${imgUrl}" class="batch-box-img">
        </div>
        <div class="batch-box-actions">
          ${createBatchActionsHTML(imgUrl, i)}
        </div>
      `;
      
      const imgEl = box.querySelector('.batch-box-img');
      imgEl.onclick = () => {
        if (window.openLightbox) {
          window.openLightbox(imgUrl, getFinalPrompt(), appState.activeTags, null);
        }
      };
      
      const actionsWrap = box.querySelector('.batch-box-actions');
      wireBatchActionButtons(actionsWrap, imgUrl, i);
    }
  }

  // 3. Show global footer close button
  const footer = document.getElementById('batch-actions-footer');
  if (footer) {
    footer.classList.remove('hidden');
  }
}

function showCreationForm() {
  resetLivePreview();
  const mainWorkspace = document.getElementById('main-workspace');
  mainWorkspace.classList.remove('generating');
  mainWorkspace.classList.remove('batch-preview');
  
  appState.isBatchPreviewActive = false;
  appState.batchGeneratedImageUrls = null;

  // Clear extra batch boxes
  const container = document.getElementById('batch-boxes-container');
  if (container) {
    while (container.children.length > 1) {
      container.removeChild(container.lastChild);
    }
  }
  
  const footer = document.getElementById('batch-actions-footer');
  if (footer) {
    footer.classList.add('hidden');
  }

  // Restore global buttons visibility
  const previewArea = document.getElementById('art-preview-area');
  if (previewArea) {
    const globalActions = previewArea.querySelector('.post-gen-actions-bar');
    if (globalActions) globalActions.classList.remove('hidden');
    
    const localActionsWrap = document.getElementById('batch-box-1-actions');
    if (localActionsWrap) localActionsWrap.classList.add('hidden');
  }

  document.getElementById('generation-loader').classList.add('hidden');
  document.getElementById('art-preview-area').classList.add('hidden');
  document.getElementById('improve-confirmation-container').classList.add('hidden');
  
  if (window.videoState && window.videoState.engineMode === 'img2vid') {
    document.getElementById('creation-form-container').classList.add('hidden');
    document.getElementById('video-form-container').classList.remove('hidden');
  } else {
    document.getElementById('video-form-container').classList.add('hidden');
    document.getElementById('creation-form-container').classList.remove('hidden');
  }
  
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
        appState.tagWeights = {};

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
      // Remove previously added surprise tags first
      if (appState.lastSurpriseTags && appState.lastSurpriseTags.length > 0) {
        appState.lastSurpriseTags.forEach(tag => {
          const index = appState.activeTags.indexOf(tag);
          if (index !== -1) {
            appState.activeTags.splice(index, 1);
          }
        });
        appState.lastSurpriseTags = [];
      }

      const categories = tagsDatabase.getAllCategories();
      let addedAny = true; // We always render tag chips/highlights if we removed past surprise tags
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

      appState.lastGenerationWasSurprise = true;
      // Generate art immediately with the combined prompt
      startImageGeneration();
    });
  }
}

// Извлечь artist tag из промпта (первый @-prefixed токен в начале)
function extractArtistTag(prompt) {
  if (!prompt) return null;
  // Ищем @tag в начале строки (после опциональных пробелов/запятых)
  // Тэг может содержать буквы, цифры, _, -, .
  const match = prompt.match(/^\s*@([A-Za-z0-9_\-.]+)/);
  if (match) {
    return '@' + match[1];
  }
  // Fallback: искать @tag в любом месте (приоритет — первый найденный)
  const fallbackMatch = prompt.match(/@([A-Za-z0-9_\-.]+)/);
  if (fallbackMatch) {
    return '@' + fallbackMatch[1];
  }
  return null;
}

// Обновить тэг артиста рядом с Add artist tag
function updateArtistTagInfo() {
  const displayEl = document.getElementById('artist-tag-display');
  if (!displayEl) return;
  
  displayEl.className = 'artist-tag-pill'; // Reset classes
  
  if (appState.artistTagToggle) {
    if (appState.artistTagValue) {
      displayEl.classList.add('found');
      displayEl.textContent = appState.artistTagValue;
    } else {
      displayEl.classList.add('not-found');
      displayEl.textContent = 'not found';
    }
  } else {
    if (appState.artistTagValue) {
      displayEl.classList.add('inactive');
      displayEl.textContent = appState.artistTagValue;
    } else {
      displayEl.classList.add('hidden');
      displayEl.textContent = '';
    }
  }
}

// ─── Image Editor Controller ───────────────────────────────────────
function enterEditorMode(imageUrl, promptText = '', tagsArray = [], sourceImageId = null) {
  appState.editorActive = true;
  appState.editorSourceUrl = imageUrl;
  appState.editorSourceImageId = sourceImageId;

  // Restore LoRAs from the source image if it has them
  // Also resolve the clean prompt text (without prefix) to avoid prefix duplication on save
  let cleanPromptText = promptText || '';
  if (sourceImageId) {
    const savedImg = albumStore.getAll().find(img => img.id === sourceImageId);
    if (savedImg) {
      if (savedImg.loras && Array.isArray(savedImg.loras)) {
        appState.loras = JSON.parse(JSON.stringify(savedImg.loras));
      } else {
        appState.loras = [];
      }
      renderLorasList();

      // Use mainPromptText (editor-only, no prefix) if available;
      // otherwise strip the prefix from the full prompt to prevent duplication
      if (savedImg.mainPromptText !== undefined && savedImg.mainPromptText !== null) {
        cleanPromptText = savedImg.mainPromptText;
      } else {
        // Strip prefix tokens the same way restorePromptFromSaved does
        const prefixInput = document.getElementById('setting-comfyui-positive-prefix');
        const prefixStr = prefixInput ? prefixInput.value.trim() : '';
        if (prefixStr) {
          prefixStr.split(',').forEach(p => {
            const cleanP = p.trim();
            if (cleanP) {
              cleanPromptText = stripTagFromText(cleanPromptText, cleanP);
            }
          });
        }
      }
    }
  }
  appState.editorOriginalBlob = null;

  // СОХРАНИТЬ оригинальный промпт для извлечения artist tag
  appState.editorOriginalPrompt = cleanPromptText;
  
  // Извлечь artist tag заранее (если есть)
  appState.artistTagValue = extractArtistTag(appState.editorOriginalPrompt);
  
  // СКИНУТЬ состояние тумблера при входе
  appState.artistTagToggle = false;
  const toggleEl = document.getElementById('toggle-artist-tag');
  if (toggleEl) toggleEl.checked = false;
  updateArtistTagInfo();

  // Set prompt and tags in standard input fields so the user can edit them
  appState.tagWeights = {};
  const promptInput = document.getElementById('prompt-text-input');
  if (promptInput) {
    appState.activeTags = tagsArray ? [...tagsArray] : [];
    promptInput.value = cleanPromptText.trim();
  } else {
    appState.activeTags = tagsArray ? [...tagsArray] : [];
  }
  
  renderCategoryTags();

  // Hide all screens
  document.getElementById('main-workspace').classList.remove('generating');
  // Hide all screens
  const mainWorkspace = document.getElementById('main-workspace');
  mainWorkspace.classList.remove('generating');
  mainWorkspace.classList.remove('batch-preview'); // Temporarily remove batch layout class
  
  // Hide other batch boxes in the grid
  const otherBoxes = document.querySelectorAll('#batch-boxes-container .batch-preview-box');
  otherBoxes.forEach(box => {
    box.style.display = 'none';
  });

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

  // Safeguard: ensure layout is settled after CSS transitions (e.g. removing .hidden)
  setTimeout(() => {
    if (appState.editorActive) resizeCanvasToMatchImage();
  }, 400);
}

function exitEditorMode() {
  appState.editorActive = false;
  appState.editorSourceUrl = null;
  appState.editorOriginalBlob = null;

  // Hide editor screen
  document.getElementById('image-editor-container').classList.add('hidden');
  
  // Return to creation form or preview
  if (appState.isBatchPreviewActive && appState.batchGeneratedImageUrls) {
    const mainWorkspace = document.getElementById('main-workspace');
    mainWorkspace.classList.add('batch-preview'); // Restore batch layout class
    
    // Restore visibility of other batch boxes
    const otherBoxes = document.querySelectorAll('#batch-boxes-container .batch-preview-box');
    otherBoxes.forEach(box => {
      box.style.display = '';
    });

    showBatchArtPreview(appState.batchGeneratedImageUrls);
  } else if (appState.generatedImageUrl) {
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
  const sketchCanvas = document.getElementById('editor-sketch-canvas');
  const wrapper = document.getElementById('editor-canvas-wrapper');
  const col = document.querySelector('.editor-canvas-column');
  if (!img || !canvas || !sketchCanvas || !wrapper || !col) return;

  const natW = img.naturalWidth;
  const natH = img.naturalHeight;
  if (!natW || !natH) return;

  const colStyles = window.getComputedStyle(col);
  const availW = col.clientWidth - parseFloat(colStyles.paddingLeft) - parseFloat(colStyles.paddingRight);
  const availH = col.clientHeight - parseFloat(colStyles.paddingTop) - parseFloat(colStyles.paddingBottom);

  const ratio = Math.min(availW / natW, availH / natH);
  
  // Downscale or upscale to fit available area
  const finalW = Math.round(natW * ratio);
  const finalH = Math.round(natH * ratio);

  if (finalW > 0 && finalH > 0) {
    wrapper.style.width = `${finalW}px`;
    wrapper.style.height = `${finalH}px`;
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    sketchCanvas.style.width = '100%';
    sketchCanvas.style.height = '100%';
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
  
  // 1. Export source image to JPEG (3 channels) + sketch layer
  const srcBlob = await new Promise((resolve) => {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    
    // Draw sketch layer over the source image if available
    const sketchCanvas = document.getElementById('editor-sketch-canvas');
    if (sketchCanvas) {
      const enhanceInput = document.getElementById('input-editor-enhance-sketch');
      const shouldEnhance = enhanceInput ? enhanceInput.checked : true;

      if (shouldEnhance) {
        // Create an offscreen canvas to process the sketch
        const offCanvas = document.createElement('canvas');
        offCanvas.width = w;
        offCanvas.height = h;
        const offCtx = offCanvas.getContext('2d');
        
        // 1. Draw sketch with Gaussian Blur
        offCtx.filter = 'blur(6px)';
        offCtx.drawImage(sketchCanvas, 0, 0, w, h);
        offCtx.filter = 'none';
        
        // 2. Add digital noise only to the painted areas
        offCtx.globalCompositeOperation = 'source-atop';
        const imgData = offCtx.getImageData(0, 0, w, h);
        const data = imgData.data;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] > 0) { // If pixel is not fully transparent
            const noise = (Math.random() - 0.5) * 60; // Random value between -30 and +30
            data[i] = Math.min(255, Math.max(0, data[i] + noise));
            data[i+1] = Math.min(255, Math.max(0, data[i+1] + noise));
            data[i+2] = Math.min(255, Math.max(0, data[i+2] + noise));
          }
        }
        offCtx.putImageData(imgData, 0, 0);
        
        // Draw the processed sketch onto the main image
        ctx.drawImage(offCanvas, 0, 0, w, h);
      } else {
        ctx.drawImage(sketchCanvas, 0, 0, w, h);
      }
    }
    
    canvas.toBlob(resolve, 'image/jpeg', 0.95);
  });
  
  // 2. Export mask with feathered edge to PNG
  const maskBlob = await new Promise((resolve) => {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    
    // 1. Black background
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, w, h);
    
    // 2. Apply blur to the mask BEFORE drawing - creates a feathered edge
    //    Radius ~1.2% of the smaller dimension of the image
    const featherRadius = Math.max(2, Math.round(Math.min(w, h) * 0.012));
    ctx.filter = `blur(${featherRadius}px)`;
    ctx.drawImage(maskCanvas, 0, 0, w, h);
    ctx.filter = 'none';
    
    // 3. Normalization: from color mask (cyan) to grayscale
    //    Preserve gradient, not hard threshold!
    const imgData = ctx.getImageData(0, 0, w, h);
    const data = imgData.data;
    for (let i = 0; i < data.length; i += 4) {
      // Use maximum channel as brightness (cyan -> white)
      const brightness = Math.max(data[i], data[i + 1], data[i + 2]);
      // Gamma correction for smoother transition
      const normalized = brightness / 255;
      const feathered = Math.pow(normalized, 1.5) * 255;
      data[i] = feathered;
      data[i + 1] = feathered;
      data[i + 2] = feathered;
      data[i + 3] = 255;
    }
    ctx.putImageData(imgData, 0, 0);
    
    canvas.toBlob(resolve, 'image/png'); // PNG!
  });
  
  return { srcBlob, maskBlob };
}

function initImageEditor() {
  const img = document.getElementById('editor-source-img');
  const canvas = document.getElementById('editor-mask-canvas');
  const cursor = document.getElementById('editor-brush-cursor');

  if (!img || !canvas) return;

  // Add artist tag toggle handler
  const artistTagToggle = document.getElementById('toggle-artist-tag');
  if (artistTagToggle) {
    artistTagToggle.addEventListener('change', () => {
      appState.artistTagToggle = artistTagToggle.checked;
      updateArtistTagInfo();
      
      if (artistTagToggle.checked && !appState.artistTagValue) {
        showToast('No @-tag found in original prompt', 'info');
      } else if (artistTagToggle.checked) {
        showToast(`Artist tag enabled: ${appState.artistTagValue}`, 'success');
      }
    });
  }

  // Resize canvas when image finishes loading
  img.addEventListener('load', () => {
    // Wait for display size calculation
    setTimeout(() => {
      canvas.width = img.naturalWidth || 832;
      canvas.height = img.naturalHeight || 1216;
      const sketchCanvas = document.getElementById('editor-sketch-canvas');
      if (sketchCanvas) {
        sketchCanvas.width = canvas.width;
        sketchCanvas.height = canvas.height;
      }
      resizeCanvasToMatchImage();
    }, 100);
  });
  
  // Disable context menu to allow right-click erasing
  const wrapper = document.getElementById('editor-canvas-wrapper');
  if (wrapper) {
    wrapper.addEventListener('contextmenu', (e) => e.preventDefault());
  }

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
    if (appState.editorMode === 'img2img' && appState.brushMode !== 'sketch') return; // only sketch allowed in global mode
    
    // Prevent scrolling on touches
    if (e.cancelable) e.preventDefault();
    
    appState.isDrawing = true;
    const { x, y } = getCoordinates(e);
    
    const activeCanvas = appState.brushMode === 'sketch' ? document.getElementById('editor-sketch-canvas') : canvas;
    const ctx = activeCanvas.getContext('2d');
    ctx.beginPath();
    ctx.moveTo(x, y);
  }

  function drawMove(e) {
    if (appState.editorMode === 'img2img' && appState.brushMode !== 'sketch') {
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

    const activeCanvas = appState.brushMode === 'sketch' ? document.getElementById('editor-sketch-canvas') : canvas;
    const ctx = activeCanvas.getContext('2d');
    ctx.lineTo(x, y);
    
    // Scale brush size to natural canvas resolution
    ctx.lineWidth = appState.brushSize * (canvas.width / rect.width);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const isErase = e.buttons === 2 || e.button === 2;

    if (isErase) {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = 'rgba(0, 0, 0, 1.0)';
    } else {
      ctx.globalCompositeOperation = 'source-over';
      if (appState.brushMode === 'sketch') {
        ctx.strokeStyle = appState.sketchColor;
      } else {
        ctx.strokeStyle = 'rgba(0, 243, 255, 1.0)'; // Glowing neon cyan
      }
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
  const btnEditPro = document.getElementById('btn-editor-mode-edit-pro');
  const brushControls = document.getElementById('editor-brush-controls');

  if (btnInpaint && btnImg2Img && btnEditPro && brushControls) {
    const btnBrushDraw = document.getElementById('btn-editor-brush-draw');
    const btnBrushSketch = document.getElementById('btn-editor-brush-sketch');
    const paletteGroup = document.getElementById('editor-color-palette');

    btnInpaint.addEventListener('click', () => {
      appState.editorMode = 'inpaint';
      btnInpaint.classList.add('active');
      btnImg2Img.classList.remove('active');
      btnEditPro.classList.remove('active');
      brushControls.style.display = 'block';
      if (btnBrushDraw) btnBrushDraw.style.display = ''; // Restore default display
      
      // ПОКАЗАТЬ ползунок denoise, СКРЫТЬ пресеты
      const denoiseRow = document.querySelector('.editor-denoise-row');
      const presetsRow = document.getElementById('img2img-denoise-presets');
      if (denoiseRow) denoiseRow.style.display = '';
      if (presetsRow) presetsRow.style.display = 'none';
      
      // СКРЫТЬ переключатель Edit Pro и кастомные настройки
      const editProSwitcher = document.getElementById('edit-pro-mode-switcher');
      if (editProSwitcher) editProSwitcher.style.display = 'none';
      const customSettingsPanel = document.getElementById('edit-pro-custom-settings');
      if (customSettingsPanel) customSettingsPanel.style.display = 'none';

      // Update denoise default for inpainting
      document.getElementById('input-editor-denoise').value = 0.50;
      document.getElementById('editor-denoise-val').textContent = '0.50';
      appState.denoise = 0.50;

      setBrushSettingsCollapsed(true);
      
      // Resize canvas just in case layout shifted
      resizeCanvasToMatchImage();
    });

    btnImg2Img.addEventListener('click', () => {
      appState.editorMode = 'img2img';
      btnImg2Img.classList.add('active');
      btnInpaint.classList.remove('active');
      btnEditPro.classList.remove('active');
      brushControls.style.display = 'block'; // Keep brush controls visible
      
      // Force sketch mode for global edit
      appState.brushMode = 'sketch';
      if (btnBrushSketch) btnBrushSketch.classList.add('active');
      if (btnBrushDraw) {
        btnBrushDraw.classList.remove('active');
        btnBrushDraw.style.display = 'none'; // Hide mask drawing
      }
      applyBrushModeVisibility();
      setBrushSettingsCollapsed(true);
      
      // СКРЫТЬ ползунок denoise, ПОКАЗАТЬ пресеты
      const denoiseRow = document.querySelector('.editor-denoise-row');
      const presetsRow = document.getElementById('img2img-denoise-presets');
      if (denoiseRow) denoiseRow.style.display = 'none';
      if (presetsRow) presetsRow.style.display = 'flex';
      
      // СКРЫТЬ переключатель Edit Pro и кастомные настройки
      const editProSwitcher = document.getElementById('edit-pro-mode-switcher');
      if (editProSwitcher) editProSwitcher.style.display = 'none';
      const customSettingsPanel = document.getElementById('edit-pro-custom-settings');
      if (customSettingsPanel) customSettingsPanel.style.display = 'none';

      // Установить Medium по умолчанию
      appState.denoise = 0.50;
      const mediumBtn = presetsRow?.querySelector('[data-denoise="0.50"]');
      presetsRow?.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
      if (mediumBtn) mediumBtn.classList.add('active');
      
      // Синхронизировать скрытый слайдер (на случай переключения в inpaint)
      const slider = document.getElementById('input-editor-denoise');
      const display = document.getElementById('editor-denoise-val');
      if (slider) slider.value = 0.50;
      if (display) display.textContent = '0.50';
    });

    btnEditPro.addEventListener('click', () => {
      appState.editorMode = 'edit-pro';
      btnEditPro.classList.add('active');
      btnInpaint.classList.remove('active');
      btnImg2Img.classList.remove('active');
      
      // Hide brush controls entirely since this method is prompt-based
      brushControls.style.display = 'none';
      
      // ПОКАЗАТЬ переключатель Global/Details
      const editProSwitcher = document.getElementById('edit-pro-mode-switcher');
      if (editProSwitcher) editProSwitcher.style.display = 'flex';
      
      // ПОКАЗАТЬ/СКРЫТЬ кастомные настройки в зависимости от выбранного режима
      const customSettingsPanel = document.getElementById('edit-pro-custom-settings');
      if (customSettingsPanel) {
        customSettingsPanel.style.display = appState.editProMode === 'custom' ? 'block' : 'none';
      }

      // СКРЫТЬ пресеты img2img и ползунок
      const denoiseRow = document.querySelector('.editor-denoise-row');
      const presetsRow = document.getElementById('img2img-denoise-presets');
      if (denoiseRow) denoiseRow.style.display = 'none';
      if (presetsRow) presetsRow.style.display = 'none';
      
      // Edit Pro denoise = 1.0
      document.getElementById('input-editor-denoise').value = 1.0;
      document.getElementById('editor-denoise-val').textContent = '1.0';
      appState.denoise = 1.0;
    });
  }

  // Img2Img denoise presets handler
  const presetButtons = document.querySelectorAll('.preset-btn[data-mode="img2img"]');
  presetButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const denoise = parseFloat(btn.dataset.denoise);
      appState.denoise = denoise;
      
      // Update UI
      presetButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      
      // Синхронизировать скрытый слайдер (на случай переключения в inpaint)
      const slider = document.getElementById('input-editor-denoise');
      const display = document.getElementById('editor-denoise-val');
      if (slider) slider.value = denoise;
      if (display) display.textContent = denoise.toFixed(2);
    });
  });

  // Edit Pro mode switcher
  const editProModeBtns = document.querySelectorAll('.edit-pro-mode-btn');
  const customSettingsPanel = document.getElementById('edit-pro-custom-settings');
  editProModeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.editMode;
      appState.editProMode = mode;
      
      // Update UI
      editProModeBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      if (customSettingsPanel) {
        customSettingsPanel.style.display = mode === 'custom' ? 'block' : 'none';
      }
    });
  });

  // Bind Custom Edit Pro Settings change events
  const customResizeMethod = document.getElementById('custom-edit-resize-method');
  const customPaddingWidth = document.getElementById('custom-edit-padding-width');
  const customImprovedPrompt = document.getElementById('custom-edit-improved-prompt');
  const customNegPromptFix = document.getElementById('custom-edit-neg-prompt-fix');
  const customDenoiseCap = document.getElementById('custom-edit-denoise-cap');
  const customNoiseMask = document.getElementById('custom-edit-noise-mask');

  if (customResizeMethod) {
    customResizeMethod.addEventListener('change', () => {
      appState.editProCustomSettings.resizeMethod = customResizeMethod.value;
    });
  }
  if (customPaddingWidth) {
    customPaddingWidth.addEventListener('change', () => {
      appState.editProCustomSettings.paddingWidth = parseInt(customPaddingWidth.value, 10);
    });
  }
  if (customImprovedPrompt) {
    customImprovedPrompt.addEventListener('change', () => {
      appState.editProCustomSettings.improvedPrompt = customImprovedPrompt.checked;
    });
  }
  if (customNegPromptFix) {
    customNegPromptFix.addEventListener('change', () => {
      appState.editProCustomSettings.negPromptFix = customNegPromptFix.checked;
    });
  }
  if (customDenoiseCap) {
    customDenoiseCap.addEventListener('change', () => {
      appState.editProCustomSettings.denoiseCap = customDenoiseCap.checked;
    });
  }
  if (customNoiseMask) {
    customNoiseMask.addEventListener('change', () => {
      appState.editProCustomSettings.noiseMask = customNoiseMask.checked;
    });
  }

  // Brush Mode drawing/sketch toggle
  const btnBrushDraw = document.getElementById('btn-editor-brush-draw');
  const btnBrushSketch = document.getElementById('btn-editor-brush-sketch');
  const paletteGroup = document.getElementById('editor-color-palette');
  const brushSettingsContent = document.getElementById('editor-brush-settings-content');
  const brushCollapseArrow = document.getElementById('brush-collapse-arrow');

  // Helper: показать/скрыть настройки кисти
  function setBrushSettingsCollapsed(collapsed) {
    appState.brushSettingsCollapsed = collapsed;
    if (brushSettingsContent) {
      brushSettingsContent.classList.toggle('collapsed', collapsed);
    }
    if (brushCollapseArrow) {
      brushCollapseArrow.classList.toggle('collapsed', collapsed);
    }
  }

  // Helper: применить видимость палитры в зависимости от режима
  function applyBrushModeVisibility() {
    if (paletteGroup) {
      paletteGroup.style.display = appState.brushMode === 'sketch' ? 'block' : 'none';
    }
  }

  if (btnBrushDraw && btnBrushSketch) {
    btnBrushDraw.addEventListener('click', () => {
      if (appState.brushMode === 'draw') {
        // Уже активен — свернуть/развернуть настройки
        setBrushSettingsCollapsed(!appState.brushSettingsCollapsed);
      } else {
        // Переключиться в режим draw + показать настройки
        appState.brushMode = 'draw';
        btnBrushDraw.classList.add('active');
        btnBrushSketch.classList.remove('active');
        applyBrushModeVisibility();
        setBrushSettingsCollapsed(false);
      }
    });

    btnBrushSketch.addEventListener('click', () => {
      if (appState.brushMode === 'sketch') {
        // Уже активен — свернуть/развернуть настройки
        setBrushSettingsCollapsed(!appState.brushSettingsCollapsed);
      } else {
        // Переключиться в режим sketch + показать настройки
        appState.brushMode = 'sketch';
        btnBrushSketch.classList.add('active');
        btnBrushDraw.classList.remove('active');
        applyBrushModeVisibility();
        setBrushSettingsCollapsed(false);
      }
    });
  }

  // Клик по заголовку "Brush Controls" тоже сворачивает/разворачивает
  const brushHeader = document.querySelector('.editor-brush-header');
  if (brushHeader) {
    brushHeader.addEventListener('click', (e) => {
      // Не реагировать, если клик был по кнопкам Draw Mask / Sketch
      if (e.target.closest('.editor-toggle-btn')) return;
      setBrushSettingsCollapsed(!appState.brushSettingsCollapsed);
    });
  }

  // Color Palette setup
  const swatches = document.querySelectorAll('.color-swatch');
  const inputSketchColor = document.getElementById('input-editor-sketch-color');
  
  function updateSketchColor(color) {
    appState.sketchColor = color;
    swatches.forEach(s => s.classList.remove('active'));
    swatches.forEach(s => {
      if (s.dataset.color === color) s.classList.add('active');
    });
    if (inputSketchColor && inputSketchColor.value !== color) {
      inputSketchColor.value = color;
    }
  }

  swatches.forEach(swatch => {
    swatch.addEventListener('click', (e) => {
      const color = e.target.dataset.color;
      updateSketchColor(color);
    });
  });

  if (inputSketchColor) {
    inputSketchColor.addEventListener('input', (e) => {
      updateSketchColor(e.target.value);
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

  // Clear active layer button
  const btnClearMask = document.getElementById('btn-editor-clear-mask');
  if (btnClearMask) {
    btnClearMask.addEventListener('click', () => {
      const activeCanvas = appState.brushMode === 'sketch' ? document.getElementById('editor-sketch-canvas') : canvas;
      if (activeCanvas) {
        const ctx = activeCanvas.getContext('2d');
        ctx.clearRect(0, 0, activeCanvas.width, activeCanvas.height);
        showToast(appState.brushMode === 'sketch' ? 'Sketch cleared' : 'Mask cleared', 'info');
      }
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
  appState.lastGenerationMode = 'editor';
  // If the editor has its own prompt, use it; otherwise fall back to the main prompt
  const editorPromptEl = document.getElementById('editor-prompt-input');
  const editorPromptText = editorPromptEl ? editorPromptEl.value.trim() : '';
  let finalPrompt = editorPromptText || getFinalPrompt();
  
  // НОВОЕ: добавить artist tag, если тумблер включён и тэг найден
  if (appState.artistTagToggle && appState.artistTagValue) {
    finalPrompt = `${finalPrompt}, ${appState.artistTagValue}`;
  }
  
  // Save the prompt used for this edit so we can store it as modificationPrompt on save
  appState.lastEditPrompt = finalPrompt;

  if (!finalPrompt.trim()) {
    showToast('Prompt cannot be empty', 'error');
    return;
  }

  // Show loader view
  showLoaderForm();
  smoothUpdateLoaderText('Preparing image and mask...');

  try {
    // 1. Export blobs from canvas
    const { srcBlob, maskBlob } = await prepareEditorBlobs();

    // 2. Setup abort controller
    appState.generationAbortController = new AbortController();
    appState.isGenerating = true;

    smoothUpdateLoaderText('Uploading images to ComfyUI...');

    const editParams = {
      sourceImageBlob: srcBlob,
      maskImageBlob: appState.editorMode === 'inpaint' ? maskBlob : null,
      denoise: appState.denoise,
      mode: appState.editorMode,
      editProMode: appState.editProMode || 'global',
      customSettings: appState.editProMode === 'custom' ? appState.editProCustomSettings : null
    };

    const activeLoras = appState.loras.filter(l => l.enabled && l.name);
    const imgUrl = await generateImageComfyUI(
      finalPrompt,
      (status) => {
        smoothUpdateLoaderText(status);
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

    const finalUrl = Array.isArray(imgUrl) ? imgUrl[0] : imgUrl;
    appState.generatedImageUrl = finalUrl;
    appState.editorActive = false; // exit editor active status
    document.getElementById('image-editor-container').classList.add('hidden'); // hide editor
    
    showToast('Image edited successfully!', 'success');
    showArtPreview(finalUrl);

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

async function handleCopyLoraTag(loraName, btnElement) {
  if (!loraName) return;
  
  const originalContent = btnElement.innerHTML;
  btnElement.innerHTML = `
    <svg class="animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px; height:12px; margin-right:4px;">
      <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" stroke-dasharray="32" stroke-dashoffset="16" fill="none"></circle>
    </svg>
    <span>Loading...</span>
  `;
  btnElement.disabled = true;

  try {
    const tags = await getLoraActivationTags(loraName);
    
    if (tags && tags.length > 0) {
      const promptInput = document.getElementById('prompt-text-input');
      if (promptInput) {
        let currentPrompt = promptInput.value.trim();
        
        const newTagsToInsert = tags.filter(tag => {
          const escapedTag = tag.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
          const regex = new RegExp(`\\b${escapedTag}\\b`, 'i');
          return !regex.test(currentPrompt);
        });

        if (newTagsToInsert.length > 0) {
          const tagsStr = newTagsToInsert.join(', ');
          if (currentPrompt) {
            promptInput.value = `${tagsStr}, ${currentPrompt}`;
          } else {
            promptInput.value = tagsStr;
          }
          promptInput.dispatchEvent(new Event('input'));
          showToast(`Added tags: ${tagsStr}`, 'success');
        } else {
          showToast('Tags already present in prompt', 'info');
        }
      }
    } else {
      showToast('No activation tags found in LoRA metadata', 'info');
    }
  } catch (err) {
    console.error('Failed to get LoRA activation tags:', err);
    showToast('Failed to retrieve LoRA tags', 'error');
  } finally {
    btnElement.innerHTML = originalContent;
    btnElement.disabled = false;
  }
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
          ${lora.name ? `
          <button class="btn-copy-lora-tag" data-lora-name="${lora.name}" title="Insert activation tags to prompt">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px; height:12px; margin-right:4px;">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
            <span>Copy tag</span>
          </button>
          ` : ''}
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

    // Copy tag button logic
    const btnCopyTag = block.querySelector('.btn-copy-lora-tag');
    if (btnCopyTag) {
      btnCopyTag.addEventListener('click', (e) => {
        e.stopPropagation();
        handleCopyLoraTag(lora.name, btnCopyTag);
      });
    }

    listContainer.appendChild(block);
  });
}
// ─── Image Lineage Tree Overlay ───────────────────────────────────────
window.openLineageTree = function(startImgId) {
  const overlay = document.getElementById('lineage-tree-overlay');
  const nodesWrapper = document.getElementById('lineage-nodes-wrapper');
  const svgCanvas = document.getElementById('lineage-svg-canvas');
  overlay.classList.remove('hidden');

  const images = albumStore.getAll();
  const imagesMap = {};
  images.forEach(img => imagesMap[img.id] = img);

  // Find root
  let rootId = startImgId;
  while(imagesMap[rootId] && imagesMap[rootId].parentId && imagesMap[imagesMap[rootId].parentId]) {
    rootId = imagesMap[rootId].parentId;
  }

  // Build tree
  const childrenMap = {};
  images.forEach(img => {
    if (img.parentId) {
      if (!childrenMap[img.parentId]) childrenMap[img.parentId] = [];
      childrenMap[img.parentId].push(img);
    }
  });

  // Calculate layout
  const nodeWidth = 150;
  const nodeHeight = 250;
  const gapX = 450;
  const gapY = 200;
  
  let currentY = 50;

  const positions = {};
  function traverse(id, depth) {
    const node = imagesMap[id];
    if (!node) return 0;
    const children = childrenMap[id] || [];
    let childYSum = 0;
    
    if (children.length === 0) {
      positions[id] = { x: depth * gapX + 50, y: currentY };
      currentY += gapY;
      return positions[id].y;
    }

    children.forEach(child => {
      childYSum += traverse(child.id, depth + 1);
    });

    const y = childYSum / children.length;
    positions[id] = { x: depth * gapX + 50, y: y };
    return y;
  }

  traverse(rootId, 0);

  nodesWrapper.innerHTML = '';
  svgCanvas.innerHTML = '';

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  Object.keys(positions).forEach(id => {
    const pos = positions[id];
    const node = imagesMap[id];
    
    minX = Math.min(minX, pos.x);
    minY = Math.min(minY, pos.y);
    maxX = Math.max(maxX, pos.x + nodeWidth);
    maxY = Math.max(maxY, pos.y + nodeHeight);

    const nodeEl = document.createElement('div');
    nodeEl.className = 'tree-node ' + (id === startImgId ? 'active' : '');
    nodeEl.style.left = pos.x + 'px';
    nodeEl.style.top = pos.y + 'px';
    const isVideoNode = node.url && (node.url.endsWith('.mp4') || node.url.includes('/video/') || (node.filename && node.filename.endsWith('.mp4')) || (node.url.includes('filename=') && node.url.includes('.mp4')));
    const mediaHtml = isVideoNode
      ? `<video src="${node.url}" autoplay loop muted playsinline style="width:100%; height:100%; object-fit:cover; pointer-events:none;"></video>`
      : `<img src="${node.url}" alt="Lineage Image" />`;

    nodeEl.innerHTML = mediaHtml;

    nodeEl.onclick = () => {
      if (window.openLightbox) {
        window.openLightbox(node.url, node.prompt, node.tags, node.id, isVideoNode);
      }
    };

    nodesWrapper.appendChild(nodeEl);
  });

  const svgNS = "http://www.w3.org/2000/svg";
  
  Object.keys(childrenMap).forEach(parentId => {
    if (!positions[parentId]) return;
    const pPos = positions[parentId];
    
    childrenMap[parentId].forEach(child => {
      if (!positions[child.id]) return;
      const cPos = positions[child.id];
      
      const startX = pPos.x + nodeWidth;
      const startY = pPos.y + nodeHeight / 2 - 40; // center roughly on image
      const endX = cPos.x;
      const endY = cPos.y + nodeHeight / 2 - 40;
      
      const path = document.createElementNS(svgNS, 'path');
      path.setAttribute('class', 'tree-link');
      const cx1 = startX + (endX - startX) / 2;
      const cx2 = startX + (endX - startX) / 2;
      path.setAttribute('d', `M ${startX} ${startY} C ${cx1} ${startY}, ${cx2} ${endY}, ${endX} ${endY}`);
      svgCanvas.appendChild(path);

      if (child.modificationPrompt) {
        // SVG foreign object for text box
        const fo = document.createElementNS(svgNS, 'foreignObject');
        const midX = (startX + endX) / 2;
        const midY = (startY + endY) / 2;
        fo.setAttribute('x', midX - 100);
        fo.setAttribute('y', midY - 25);
        fo.setAttribute('width', 200);
        fo.setAttribute('height', 500); // large height so expanding contents are not cropped by SVG
        fo.setAttribute('class', 'tree-prompt-foreign');
        
        fo.innerHTML = `<div class="tree-prompt-box"><span>${child.modificationPrompt}</span></div>`;
        svgCanvas.appendChild(fo);

        const box = fo.querySelector('.tree-prompt-box');
        box.onclick = (e) => {
          e.stopPropagation();
          box.classList.toggle('expanded');
        };
      }
    });
  });

  // Adjust SVG canvas size
  svgCanvas.style.width = (maxX + 300) + 'px';
  svgCanvas.style.height = (maxY + 300) + 'px';
  nodesWrapper.style.width = (maxX + 300) + 'px';
  nodesWrapper.style.height = (maxY + 300) + 'px';
  
  // Center view on start node
  const startPos = positions[startImgId];
  const overlayRect = overlay.getBoundingClientRect();
  
  currentZoom = 1;
  currentPanX = (overlayRect.width / 2) - (startPos.x + nodeWidth/2);
  currentPanY = (overlayRect.height / 2) - (startPos.y + nodeHeight/2);
  updateTransform();
}

let currentZoom = 1;
let currentPanX = 0;
let currentPanY = 0;
let isPanning = false;
let startX, startY;

const lineageContainer = document.getElementById('lineage-container');
const svgCanvas = document.getElementById('lineage-svg-canvas');
const nodesWrapper = document.getElementById('lineage-nodes-wrapper');

function updateTransform() {
  const transform = `translate(${currentPanX}px, ${currentPanY}px) scale(${currentZoom})`;
  if (svgCanvas) svgCanvas.style.transform = transform;
  if (nodesWrapper) nodesWrapper.style.transform = transform;
}

if (lineageContainer) {
  lineageContainer.addEventListener('mousedown', (e) => {
    if (e.target.closest('.tree-node') || e.target.closest('.tree-prompt-box')) return;
    isPanning = true;
    startX = e.clientX - currentPanX;
    startY = e.clientY - currentPanY;
    lineageContainer.style.cursor = 'grabbing';
  });

  window.addEventListener('mousemove', (e) => {
    if (!isPanning) return;
    currentPanX = e.clientX - startX;
    currentPanY = e.clientY - startY;
    updateTransform();
  });

  window.addEventListener('mouseup', () => {
    isPanning = false;
    lineageContainer.style.cursor = 'grab';
  });

  lineageContainer.addEventListener('wheel', (e) => {
    e.preventDefault();
    const zoomIntensity = 0.1;
    const delta = e.deltaY > 0 ? -zoomIntensity : zoomIntensity;
    const oldZoom = currentZoom;
    currentZoom = Math.min(Math.max(0.2, currentZoom + delta), 3);
    
    const rect = lineageContainer.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    
    currentPanX = mouseX - (mouseX - currentPanX) * (currentZoom / oldZoom);
    currentPanY = mouseY - (mouseY - currentPanY) * (currentZoom / oldZoom);
    
    updateTransform();
  });

  document.getElementById('lineage-close').addEventListener('click', () => {
    document.getElementById('lineage-tree-overlay').classList.add('hidden');
  });

  document.getElementById('btn-lineage-zoom-out').addEventListener('click', () => {
    currentZoom = Math.max(0.2, currentZoom - 0.2);
    updateTransform();
  });
  document.getElementById('btn-lineage-zoom-in').addEventListener('click', () => {
    currentZoom = Math.min(3, currentZoom + 0.2);
    updateTransform();
  });
  document.getElementById('btn-lineage-zoom-reset').addEventListener('click', () => {
    currentZoom = 1;
    currentPanX = 0;
    currentPanY = 0;
    updateTransform();
  });
}

/* ──────────────────────────────────────────────────────────────────
   Inline Prompt Editor, Helpers, and Drag-and-Drop Controller
   ────────────────────────────────────────────────────────────────── */

let isUpdatingFromEditor = false;

function initPromptEditor() {
  const promptInput = document.getElementById('prompt-text-input');
  const editor = document.getElementById('prompt-input-editor');
  const artStyleEditor = document.getElementById('art-style-input-editor');
  if (!promptInput || !editor) return;

  const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
  
  Object.defineProperty(promptInput, 'value', {
    get() {
      return descriptor.get.call(this);
    },
    set(val) {
      descriptor.set.call(this, val);
      if (!isUpdatingFromEditor) {
        splitAndSyncValueToEditors(val);
      }
    }
  });

  splitAndSyncValueToEditors(promptInput.value);

  editor.addEventListener('input', () => {
    updateHiddenTextarea();
    updateCategoryTagsHighlights();
  });

  editor.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    document.execCommand('insertText', false, text);
  });

  editor.addEventListener('focus', () => {
    appState.lastFocusedEditor = editor;
  });

  if (artStyleEditor) {
    artStyleEditor.addEventListener('input', () => {
      updateHiddenTextarea();
      updateCategoryTagsHighlights();
    });

    artStyleEditor.addEventListener('paste', (e) => {
      e.preventDefault();
      const text = e.clipboardData.getData('text/plain');
      document.execCommand('insertText', false, text);
    });

    artStyleEditor.addEventListener('focus', () => {
      appState.lastFocusedEditor = artStyleEditor;
    });

    bindEditorDragAndDrop(artStyleEditor);
  }

  // Default focused editor is the main editor
  appState.lastFocusedEditor = editor;

  // Bind Add Prompt Field button
  const btnAddPromptField = document.getElementById('btn-add-prompt-field');
  if (btnAddPromptField) {
    btnAddPromptField.addEventListener('click', () => {
      appState.subPrompts.push({
        id: `sub_prompt_${Date.now()}`,
        label: `Character ${appState.subPrompts.length + 1}`,
        text: ''
      });
      renderSubPrompts();
      updateHiddenTextarea();
      
      // Focus the newly added editor
      const container = document.getElementById('additional-prompts-container');
      if (container) {
        const lastItem = container.lastElementChild;
        if (lastItem) {
          const subEditor = lastItem.querySelector('.sub-prompt-input-editor');
          if (subEditor) {
            subEditor.focus();
            appState.lastFocusedEditor = subEditor;
          }
        }
      }
    });
  }

  // Bind tag drag-and-drop from grid to the main editor!
  bindEditorDragAndDrop(editor);

  dragController.init();
}

function splitAndSyncValueToEditors(val) {
  const mainEditor = document.getElementById('prompt-input-editor');
  const artStyleEditor = document.getElementById('art-style-input-editor');
  
  if (!artStyleEditor) {
    syncValueToEditor(val, mainEditor);
    return;
  }
  
  const parts = val.split(/(,|\.(?!\d))/);
  let currentText = "";
  const mainTokens = [];
  const artTokens = [];
  
  for (const part of parts) {
    if (part === ',' || part === '.') {
      const trimmed = currentText.trim();
      if (trimmed) {
        if (trimmed.includes('@')) {
          artTokens.push(trimmed + part);
        } else {
          mainTokens.push(trimmed + part);
        }
      }
      currentText = "";
    } else {
      currentText += part;
    }
  }
  if (currentText.trim()) {
    const trimmed = currentText.trim();
    if (trimmed.includes('@')) {
      artTokens.push(trimmed);
    } else {
      mainTokens.push(trimmed);
    }
  }
  
  const mainVal = mainTokens.join(' ').replace(/\s+/g, ' ').trim();
  const artVal = artTokens.join(' ').replace(/\s+/g, ' ').trim();
  
  syncValueToEditor(mainVal, mainEditor);
  syncValueToEditor(artVal, artStyleEditor);
}

function getEditorContentList(editor = document.getElementById('prompt-input-editor')) {
  if (!editor) return [];
  
  const list = [];
  editor.childNodes.forEach(node => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent;
      if (text) {
        list.push({ type: 'text', text });
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.classList.contains('prompt-tag-pill')) {
        list.push({
          type: 'tag',
          tag: node.dataset.tag,
          weight: parseFloat(node.dataset.weight || 1.0)
        });
      } else {
        const text = node.textContent;
        if (text) {
          list.push({ type: 'text', text });
        }
      }
    }
  });
  return list;
}

function getEditorTextRepresentation(editor = document.getElementById('prompt-input-editor')) {
  if (!editor) return '';
  
  const parts = [];
  editor.childNodes.forEach((node, idx) => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent);
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.classList.contains('prompt-tag-pill')) {
        const tag = node.dataset.tag;
        const weight = parseFloat(node.dataset.weight || 1.0);
        let tagStr = tag;
        if (weight !== 1.0) {
          tagStr = `(${tag}:${weight.toFixed(1)})`;
        }
        
        // Prevent sticking to the previous node
        if (idx > 0) {
          const prev = editor.childNodes[idx - 1];
          const prevText = prev.textContent || '';
          if (prev.nodeType === Node.ELEMENT_NODE && prev.classList.contains('prompt-tag-pill')) {
            parts.push(', ');
          } else if (prev.nodeType === Node.TEXT_NODE && prevText.trim() && !prevText.trim().endsWith(',') && !prevText.trim().endsWith('.')) {
            parts.push(', ');
          }
        }
        
        parts.push(tagStr);
      } else {
        parts.push(node.textContent);
      }
    }
  });
  return parts.join('');
}

function updateHiddenTextarea() {
  const promptInput = document.getElementById('prompt-text-input');
  if (promptInput) {
    isUpdatingFromEditor = true;
    try {
      const mainEditor = document.getElementById('prompt-input-editor');
      const artStyleEditor = document.getElementById('art-style-input-editor');
      const editors = [mainEditor];
      if (appState.activeMode === 'advanced') {
        const subEditors = document.querySelectorAll('.sub-prompt-input-editor');
        subEditors.forEach(el => editors.push(el));
      }
      if (artStyleEditor) {
        editors.push(artStyleEditor);
      }
      
      const textParts = [];
      const allTags = [];
      const allWeights = {};
      
      editors.forEach(editor => {
        if (!editor) return;
        const editorText = getEditorTextRepresentation(editor);
        if (editorText.trim()) {
          textParts.push(editorText.trim());
        }
        
        // Sync back to appState.subPrompts to keep active sub-prompts in sync during programmatic updates
        if (editor !== mainEditor && editor !== artStyleEditor) {
          const parentItem = editor.closest('.sub-prompt-item');
          if (parentItem) {
            const subId = parentItem.dataset.id;
            const subPromptObj = appState.subPrompts.find(sp => sp.id === subId);
            if (subPromptObj) {
              subPromptObj.text = editorText;
            }
          }
        }
        
        const list = getEditorContentList(editor);
        list.forEach(item => {
          if (item.type === 'tag') {
            allTags.push(item.tag);
            allWeights[item.tag] = item.weight;
          }
        });
      });
      
      const combinedText = textParts.join(', ');
      
      const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
      descriptor.set.call(promptInput, combinedText);
      
      appState.activeTags = allTags;
      appState.tagWeights = allWeights;
    } finally {
      isUpdatingFromEditor = false;
    }
  }
}

function createTagPillElement(tag, weight = 1.0) {
  const pill = document.createElement('span');
  pill.className = 'prompt-tag-pill';
  pill.setAttribute('contenteditable', 'false');
  pill.dataset.tag = tag;
  pill.dataset.weight = weight;
  
  pill.innerHTML = `
    <span class="tag-weight-controls">
      <button class="btn-tag-weight-dec" type="button">-</button>
      <span class="tag-weight-val">${weight.toFixed(1)}</span>
      <button class="btn-tag-weight-inc" type="button">+</button>
    </span>
    <span class="tag-text">${tag}</span>
    <span class="tag-chip-remove">&times;</span>
  `;
  
  pill.querySelector('.btn-tag-weight-dec').addEventListener('click', (e) => {
    e.stopPropagation();
    let w = parseFloat(pill.dataset.weight || 1.0);
    w = Math.max(0.5, w - 0.5);
    pill.dataset.weight = w;
    pill.querySelector('.tag-weight-val').textContent = w.toFixed(1);
    updateHiddenTextarea();
  });
  
  pill.querySelector('.btn-tag-weight-inc').addEventListener('click', (e) => {
    e.stopPropagation();
    let w = parseFloat(pill.dataset.weight || 1.0);
    w = Math.min(4.0, w + 0.5);
    pill.dataset.weight = w;
    pill.querySelector('.tag-weight-val').textContent = w.toFixed(1);
    updateHiddenTextarea();
  });
  
  pill.querySelector('.tag-chip-remove').addEventListener('click', (e) => {
    e.stopPropagation();
    pill.remove();
    updateHiddenTextarea();
    updateCategoryTagsHighlights();
  });
  
  return pill;
}

function insertNodeAtCursor(node) {
  const sel = window.getSelection();
  const editor = appState.lastFocusedEditor || document.getElementById('prompt-input-editor');
  if (!editor) return;
  
  if (sel.getRangeAt && sel.rangeCount) {
    let range = sel.getRangeAt(0);
    if (editor.contains(range.commonAncestorContainer)) {
      range.deleteContents();
      range.insertNode(node);
      range = range.cloneRange();
      range.setStartAfter(node);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      return;
    }
  }
  editor.appendChild(node);
}

function bindEditorDragAndDrop(editor) {
  if (!editor) return;
  
  editor.addEventListener('dragover', (e) => {
    // Only accept drag if it contains text or source from tags grid
    if (e.dataTransfer.types.includes('source') || e.dataTransfer.effectAllowed === 'copy') {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  });
  
  editor.addEventListener('drop', (e) => {
    const source = e.dataTransfer.getData('source');
    const tag = e.dataTransfer.getData('text/plain');
    
    if (tag && source === 'tags-grid') {
      e.preventDefault();
      
      let range = null;
      if (document.caretRangeFromPoint) {
        range = document.caretRangeFromPoint(e.clientX, e.clientY);
      } else if (e.rangeParent) {
        range = document.createRange();
        range.setStart(e.rangeParent, e.rangeOffset);
        range.collapse(true);
      }
      
      const pill = createTagPillElement(tag);
      
      if (range && editor.contains(range.commonAncestorContainer)) {
        range.deleteContents();
        range.insertNode(pill);
        
        // Insert comma and space after the pill
        const afterText = document.createTextNode(', ');
        range.setStartAfter(pill);
        range.collapse(true);
        range.insertNode(afterText);
        
        range.setStartAfter(afterText);
        range.collapse(true);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      } else {
        // Fallback: append at the end
        if (editor.childNodes.length > 0) {
          // Check if last child is already a space/comma
          const lastChild = editor.lastChild;
          const lastText = lastChild.textContent || '';
          if (!lastText.trim().endsWith(',') && !lastText.trim().endsWith('.')) {
            editor.appendChild(document.createTextNode(', '));
          }
        }
        editor.appendChild(pill);
      }
      
      appState.lastFocusedEditor = editor;
      updateHiddenTextarea();
      updateCategoryTagsHighlights();
    }
  });
}

function renderSubPrompts() {
  const container = document.getElementById('additional-prompts-container');
  if (!container) return;
  
  container.innerHTML = '';
  
  appState.subPrompts.forEach((subPrompt, index) => {
    const item = document.createElement('div');
    item.className = 'sub-prompt-item prompt-input-container';
    item.dataset.id = subPrompt.id;
    
    item.innerHTML = `
      <div class="sub-prompt-header">
        <input type="text" class="sub-prompt-label-input" value="${subPrompt.label}" placeholder="Label (e.g. Character 1)">
        <div class="sub-prompt-controls">
          <button type="button" class="btn-sub-prompt-up sub-prompt-control-btn" title="Move Up">▲</button>
          <button type="button" class="btn-sub-prompt-down sub-prompt-control-btn" title="Move Down">▼</button>
          <button type="button" class="btn-sub-prompt-remove sub-prompt-control-btn" title="Remove Field">✕</button>
        </div>
      </div>
      <div class="sub-prompt-input-editor prompt-input-editor" contenteditable="true" placeholder="Enter prompt part..."></div>
    `;
    
    const editor = item.querySelector('.sub-prompt-input-editor');
    const labelInput = item.querySelector('.sub-prompt-label-input');
    
    // Populate the editor content
    if (subPrompt.text) {
      syncValueToEditor(subPrompt.text, editor);
    }
    
    // Listeners for Label Input
    labelInput.addEventListener('input', () => {
      subPrompt.label = labelInput.value;
    });
    
    // Listeners for Editor
    editor.addEventListener('input', () => {
      subPrompt.text = getEditorTextRepresentation(editor);
      updateHiddenTextarea();
      updateCategoryTagsHighlights();
    });
    
    editor.addEventListener('paste', (e) => {
      e.preventDefault();
      const text = e.clipboardData.getData('text/plain');
      document.execCommand('insertText', false, text);
    });
    
    // Listeners for Focus: set this editor as lastFocusedEditor!
    editor.addEventListener('focus', () => {
      appState.lastFocusedEditor = editor;
    });
    
    // Reorder/Delete Listeners
    item.querySelector('.btn-sub-prompt-up').addEventListener('click', (e) => {
      e.stopPropagation();
      moveSubPrompt(index, -1);
    });
    
    item.querySelector('.btn-sub-prompt-down').addEventListener('click', (e) => {
      e.stopPropagation();
      moveSubPrompt(index, 1);
    });
    
    item.querySelector('.btn-sub-prompt-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      removeSubPrompt(index);
    });
    
    // Bind Drag-and-Drop tag reordering!
    if (dragController && typeof dragController.bindEditor === 'function') {
      dragController.bindEditor(editor);
    }
    
    // Bind tag drag-and-drop from grid!
    bindEditorDragAndDrop(editor);
    
    container.appendChild(item);
  });
}

function moveSubPrompt(index, direction) {
  const newIndex = index + direction;
  if (newIndex < 0 || newIndex >= appState.subPrompts.length) return;
  
  // Swap in array
  const temp = appState.subPrompts[index];
  appState.subPrompts[index] = appState.subPrompts[newIndex];
  appState.subPrompts[newIndex] = temp;
  
  renderSubPrompts();
  updateHiddenTextarea();
}

function removeSubPrompt(index) {
  const item = appState.subPrompts[index];
  const container = document.getElementById('additional-prompts-container');
  if (container) {
    const el = container.querySelector(`[data-id="${item.id}"] .sub-prompt-input-editor`);
    if (el && appState.lastFocusedEditor === el) {
      appState.lastFocusedEditor = null;
    }
  }
  
  appState.subPrompts.splice(index, 1);
  renderSubPrompts();
  updateHiddenTextarea();
  updateCategoryTagsHighlights();
}

function parseManuallyEnteredText(text) {
  if (!text) return [];
  const parts = text.split(/(,|\.(?!\d))/);
  const result = [];
  let currentText = "";
  
  for (const part of parts) {
    if (part === ',' || part === '.') {
      if (currentText.trim()) {
        result.push({
          type: 'text_tag',
          text: currentText.trim(),
          delimiter: part
        });
      } else if (result.length > 0) {
        result[result.length - 1].delimiter = part;
      }
      currentText = "";
    } else {
      currentText += part;
    }
  }
  if (currentText.trim()) {
    result.push({
      type: 'text_tag',
      text: currentText.trim(),
      delimiter: ','
    });
  }
  return result;
}

function getDragModePillsList(editor = document.getElementById('prompt-input-editor')) {
  if (!editor) return [];
  
  const pillsList = [];
  editor.childNodes.forEach(node => {
    if (node.nodeType === Node.TEXT_NODE) {
      const parsed = parseManuallyEnteredText(node.textContent);
      parsed.forEach(item => {
        pillsList.push({
          type: 'text_tag',
          text: item.text,
          delimiter: item.delimiter,
          sourceNode: node
        });
      });
    } else if (node.nodeType === Node.ELEMENT_NODE && node.classList.contains('prompt-tag-pill')) {
      pillsList.push({
        type: 'tag',
        tag: node.dataset.tag,
        weight: parseFloat(node.dataset.weight || 1.0),
        sourceNode: node
      });
    }
  });
  
  // ── Consolidation pass ──────────────────────────────────────────
  // If syncValueToEditor didn't group sub_tags back into a composed pill
  // (e.g. they appear as multiple text_tag pills), we re-group them here.
  if (!tagsDatabase || !tagsDatabase.getTagInfo) return pillsList;
  
  // Build map: sorted-subTags-key -> { tag, subTagsLength }
  // Scan all database categories instead of just activeTags
  const subTagMap = new Map();
  const allCategories = tagsDatabase.getAllCategories();
  for (const catKey in allCategories) {
    const category = allCategories[catKey];
    if (category && Array.isArray(category.tags)) {
      category.tags.forEach(tagObj => {
        if (tagObj.sub_tags && Array.isArray(tagObj.sub_tags) && tagObj.sub_tags.length > 0) {
          const key = tagObj.sub_tags.map(s => s.toLowerCase().trim()).join('\x00');
          subTagMap.set(key, { tag: tagObj.tag, len: tagObj.sub_tags.length });
        }
      });
    }
  }
  
  if (subTagMap.size === 0) return pillsList;
  
  const consolidated = [];
  let i = 0;
  while (i < pillsList.length) {
    const pill = pillsList[i];
    
    if (pill.type === 'tag') {
      consolidated.push(pill);
      i++;
      continue;
    }
    
    // Try to match window of consecutive text_tags against any sub_tag group
    let matched = false;
    for (const [key, { tag, len }] of subTagMap) {
      if (i + len > pillsList.length) continue;
      const window = pillsList.slice(i, i + len);
      if (!window.every(p => p.type === 'text_tag')) continue;
      
      const windowKey = window.map(p => {
        const t = p.text.trim();
        const wm = t.match(/^\(\s*(.+?)\s*:[0-9.\s]+\)$/);
        return (wm ? wm[1].trim() : t).toLowerCase();
      }).join('\x00');
      
      if (windowKey === key) {
        // Determine weight: check if first text has weight notation
        let weight = appState.tagWeights?.[tag] ?? 1.0;
        const firstText = window[0].text.trim();
        const wm = firstText.match(/^\(\s*.+?\s*:\s*([0-9.]+)\s*\)$/);
        if (wm) weight = parseFloat(wm[1]);
        
        consolidated.push({
          type: 'tag',
          tag,
          weight,
          sourceNode: window[0].sourceNode
        });
        i += len;
        matched = true;
        break;
      }
    }
    
    if (!matched) {
      consolidated.push(pill);
      i++;
    }
  }
  
  return consolidated;
}

function syncValueToEditor(val, editor = document.getElementById('prompt-input-editor')) {
  if (!editor) return;
  
  editor.innerHTML = '';
  
  const tags = appState.activeTags || [];
  const normalizedTags = tags.map(t => t.toLowerCase().trim());

  // Build reverse lookup: list of composed tag groups sorted by length descending (longest matched first)
  const subTagGroups = [];

  // 1. Add active tags containing commas
  tags.forEach(activeTag => {
    if (activeTag.includes(',')) {
      const parts = activeTag.split(',').map(s => s.toLowerCase().trim());
      if (parts.length > 1) {
        const key = parts.join(',');
        subTagGroups.push({ key, tag: activeTag, len: parts.length });
      }
    }
  });

  // 2. Add known character triggers containing commas
  if (appState.knownCharTriggers) {
    appState.knownCharTriggers.forEach(trigger => {
      if (trigger.includes(',')) {
        const parts = trigger.split(',').map(s => s.toLowerCase().trim());
        if (parts.length > 1) {
          const key = parts.join(',');
          if (!subTagGroups.some(g => g.key === key)) {
            subTagGroups.push({ key, tag: trigger, len: parts.length });
          }
        }
      }
    });
  }

  // 3. Add database tags with sub_tags
  const allCategories = tagsDatabase.getAllCategories();
  for (const catKey in allCategories) {
    const category = allCategories[catKey];
    if (category && Array.isArray(category.tags)) {
      category.tags.forEach(tagObj => {
        if (tagObj.sub_tags && Array.isArray(tagObj.sub_tags) && tagObj.sub_tags.length > 0) {
          const key = tagObj.sub_tags.map(s => s.toLowerCase().trim()).join(',');
          if (!subTagGroups.some(g => g.key === key)) {
            subTagGroups.push({ key, tag: tagObj.tag, len: tagObj.sub_tags.length });
          }
        }
      });
    }
  }
  subTagGroups.sort((a, b) => b.len - a.len);

  // Also collect all direct database tags to match them
  const dbTags = [];
  for (const catKey in allCategories) {
    const category = allCategories[catKey];
    if (category && Array.isArray(category.tags)) {
      category.tags.forEach(tagObj => {
        dbTags.push(tagObj.tag);
      });
    }
  }
  const normalizedDbTags = dbTags.map(t => t.toLowerCase().trim());
  
  const parts = val.split(/(,|\.(?!\d))/);
  let currentText = "";
  
  // Helper: try to match currentText (and optionally consume following parts) as a composed tag
  function tryFlushAsTag(text, delimiter) {
    const trimmed = text.trim();
    if (!trimmed) return false;

    const weightMatch = trimmed.match(/^\s*\(\s*(.+?)\s*:\s*([0-9.]+)\s*\)\s*$/);
    let tagCandidate = trimmed;
    let parsedWeight = 1.0;
    
    if (weightMatch) {
      tagCandidate = weightMatch[1].trim();
      parsedWeight = parseFloat(weightMatch[2]);
    }

    const lowerCandidate = tagCandidate.toLowerCase();
    
    // Check if it's in the active tags or the entire database
    let originalTag = null;
    const directIdx = normalizedTags.indexOf(lowerCandidate);
    if (directIdx !== -1) {
      originalTag = tags[directIdx];
    } else {
      const dbIdx = normalizedDbTags.indexOf(lowerCandidate);
      if (dbIdx !== -1) {
        originalTag = dbTags[dbIdx];
        if (!appState.activeTags.includes(originalTag)) {
          appState.activeTags.push(originalTag);
        }
      }
    }

    if (originalTag) {
      let weight = parsedWeight;
      if (!weightMatch && appState.tagWeights && appState.tagWeights[originalTag] !== undefined) {
        weight = appState.tagWeights[originalTag];
      }
      if (!appState.tagWeights) appState.tagWeights = {};
      appState.tagWeights[originalTag] = weight;
      const pill = createTagPillElement(originalTag, weight);
      editor.appendChild(pill);
      if (delimiter) editor.appendChild(document.createTextNode(delimiter));
      return true;
    }
    return false;
  }

  // We accumulate raw comma-separated tokens to check multi-token sub_tag groups
  // Strategy: split by comma and check windows of tokens against subTagIndex
  const tokens = [];
  for (const part of parts) {
    if (part === ',' || part === '.') {
      tokens.push({ text: currentText, delim: part });
      currentText = "";
    } else {
      currentText += part;
    }
  }
  if (currentText !== "") {
    tokens.push({ text: currentText, delim: null });
  }

  let i = 0;
  while (i < tokens.length) {
    const { text, delim } = tokens[i];
    const trimmed = text.trim();

    // Try to match a multi-token sub_tag group by checking database entries (longest first)
    let matched = false;
    for (const group of subTagGroups) {
      const len = group.len;
      if (i + len > tokens.length) continue;
      
      const window = tokens.slice(i, i + len);
      const windowKey = window.map(t => {
        const wt = t.text.trim();
        const wm = wt.match(/^\s*\(\s*(.+?)\s*:\s*[0-9.]+\s*\)\s*$/);
        return (wm ? wm[1] : wt).toLowerCase();
      }).join(',');

      if (windowKey === group.key) {
        const parentTag = group.tag;
        
        // Ensure this tag is active
        if (!appState.activeTags.includes(parentTag)) {
          appState.activeTags.push(parentTag);
        }

        // Extract weight from first token if it has one
        const firstTrimmed = window[0].text.trim();
        const wm = firstTrimmed.match(/^\s*\(\s*(.+?)\s*:\s*([0-9.]+)\s*\)\s*$/);
        let weight = wm ? parseFloat(wm[2]) : 1.0;
        if (!wm && appState.tagWeights && appState.tagWeights[parentTag] !== undefined) {
          weight = appState.tagWeights[parentTag];
        }
        if (!appState.tagWeights) appState.tagWeights = {};
        appState.tagWeights[parentTag] = weight;
        const pill = createTagPillElement(parentTag, weight);
        editor.appendChild(pill);
        const lastDelim = window[window.length - 1].delim;
        if (lastDelim) editor.appendChild(document.createTextNode(lastDelim + ' '));
        i += len;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // Try single-token direct or weighted match
    if (trimmed && tryFlushAsTag(trimmed, delim)) {
      if (delim) editor.appendChild(document.createTextNode(' '));
      i++;
      continue;
    }

    // Otherwise emit as raw text
    editor.appendChild(document.createTextNode(text + (delim || '')));
    i++;
  }
  
  normalizeEditorTextNodes(editor);
  updateCategoryTagsHighlights();
}

function normalizeEditorTextNodes(editor) {
  editor.normalize();
  editor.childNodes.forEach(node => {
    if (node.nodeType === Node.TEXT_NODE) {
      let txt = node.textContent;
      txt = txt.replace(/,\s*,/g, ',');
      txt = txt.replace(/\.\s*,/g, '.');
      txt = txt.replace(/,\s*\./g, '.');
      txt = txt.replace(/\s+/g, ' ');
      node.textContent = txt;
    }
  });
}

function placeCursorAtEnd(el) {
  el.focus();
  if (typeof window.getSelection != "undefined" &&
      typeof document.createRange != "undefined") {
    var range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

function rebuildEditorFromPills(editor = document.getElementById('prompt-input-editor')) {
  if (!editor) return;
  
  const pills = Array.from(editor.querySelectorAll('.drag-pill'));
  editor.innerHTML = '';
  
  for (let i = 0; i < pills.length; i++) {
    const pill = pills[i];
    const type = pill.dataset.type;
    const isLast = (i === pills.length - 1);
    
    if (type === 'tag') {
      const tag = pill.dataset.tag;
      const weight = parseFloat(pill.dataset.weight || 1.0);
      const tagPill = createTagPillElement(tag, weight);
      editor.appendChild(tagPill);
      
      if (!isLast) {
        editor.appendChild(document.createTextNode(', '));
      }
    } else if (type === 'text_tag') {
      let text = pill.dataset.text;
      let delimiter = pill.dataset.delimiter || ',';
      
      if (!isLast) {
        text += delimiter + ' ';
      }
      editor.appendChild(document.createTextNode(text));
    }
  }
  
  normalizeEditorTextNodes(editor);
  updateHiddenTextarea();
  updateCategoryTagsHighlights();
}

function getLayoutRect(el) {
  const prevTransform = el.style.transform;
  const prevTransition = el.style.transition;
  el.style.transform = 'none';
  el.style.transition = 'none';
  const rect = el.getBoundingClientRect();
  el.style.transform = prevTransform;
  el.style.transition = prevTransition;
  return rect;
}

function getDragAfterElement(container, y, x) {
  const pills = [...container.querySelectorAll('.drag-pill:not(.dragging)')];
  if (pills.length === 0) return null;

  // 1. Measure all pills' layout positions
  const items = pills.map(pill => {
    const box = getLayoutRect(pill);
    return {
      element: pill,
      box,
      cx: box.left + box.width / 2,
      cy: box.top + box.height / 2
    };
  });

  // 2. Group pills into rows based on vertical center coordinates
  // (if cy is within 15px of a row's average cy, they belong to the same row)
  const rows = [];
  items.sort((a, b) => a.cy - b.cy);
  items.forEach(item => {
    let placed = false;
    for (const row of rows) {
      const avgCy = row.reduce((sum, r) => sum + r.cy, 0) / row.length;
      if (Math.abs(item.cy - avgCy) < 15) {
        row.push(item);
        placed = true;
        break;
      }
    }
    if (!placed) {
      rows.push([item]);
    }
  });

  // 3. Find the row that is vertically closest to the cursor
  let bestRow = null;
  let bestRowDist = Number.POSITIVE_INFINITY;
  rows.forEach(row => {
    const avgCy = row.reduce((sum, r) => sum + r.cy, 0) / row.length;
    const dist = Math.abs(y - avgCy);
    if (dist < bestRowDist) {
      bestRowDist = dist;
      bestRow = row;
    }
  });

  // 4. Within that row, find the horizontally closest pill
  let best = null;
  let bestDist = Number.POSITIVE_INFINITY;
  if (bestRow) {
    bestRow.forEach(item => {
      const dist = Math.abs(x - item.cx);
      if (dist < bestDist) {
        bestDist = dist;
        best = item.element;
      }
    });
  }

  return best;
}

let dragController = {
  isDragging: false,
  draggedElement: null,
  startMouseX: 0,
  startMouseY: 0,
  mouseDownTimer: null,
  activeEditor: null,
  
  bindEditor(editor) {
    if (!editor) return;
    
    editor.addEventListener('dragstart', (e) => e.preventDefault());
    
    editor.addEventListener('mousedown', (e) => {
      if (e.target.classList.contains('tag-chip-remove') || 
          e.target.closest('.tag-weight-controls')) {
        return;
      }
      
      this.activeEditor = editor;
      const target = e.target;
      this.startMouseX = e.clientX;
      this.startMouseY = e.clientY;
      
      const tagPill = target.closest('.prompt-tag-pill');
      
      this.mouseDownTimer = setTimeout(() => {
        this.startDragMode(e, tagPill || target);
      }, 200);
      
      const onMouseMove = (moveEvent) => {
        const dx = moveEvent.clientX - this.startMouseX;
        const dy = moveEvent.clientY - this.startMouseY;
        const dist = Math.hypot(dx, dy);
        
        if (dist > 5) {
          if (tagPill) {
            clearTimeout(this.mouseDownTimer);
            this.startDragMode(e, tagPill);
            window.removeEventListener('mousemove', onMouseMove);
          } else {
            if (!this.isDragging) {
              clearTimeout(this.mouseDownTimer);
              window.removeEventListener('mousemove', onMouseMove);
            }
          }
        }
      };
      
      const onMouseUp = () => {
        clearTimeout(this.mouseDownTimer);
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
      };
      
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    });
  },
  
  init() {
    const editor = document.getElementById('prompt-input-editor');
    if (editor) this.bindEditor(editor);
  },
  
  startDragMode(mouseDownEvent, clickedElement) {
    if (this.isDragging) return;
    
    const editor = this.activeEditor || document.getElementById('prompt-input-editor');
    if (!editor) return;
    
    const clientX = mouseDownEvent.clientX;
    const clientY = mouseDownEvent.clientY;
    
    // Capture click offset relative to the clicked element in the OLD layout BEFORE it shifts!
    let clickOffsetX = 0;
    let clickOffsetY = 0;
    if (clickedElement) {
      const tagPill = clickedElement.closest ? clickedElement.closest('.prompt-tag-pill') : null;
      const element = tagPill || (clickedElement.nodeType === Node.ELEMENT_NODE ? clickedElement : clickedElement.parentNode);
      if (element && typeof element.getBoundingClientRect === 'function') {
        const oldRect = element.getBoundingClientRect();
        clickOffsetX = clientX - oldRect.left;
        clickOffsetY = clientY - oldRect.top;
      }
    }
    
    const pillsList = getDragModePillsList(editor);
    if (pillsList.length === 0) return;
    
    // ⚠️ Capture editorChild BEFORE clearing editor.innerHTML
    // After innerHTML='', the clicked element is detached and parentNode becomes null
    let editorChild = clickedElement;
    while (editorChild && editorChild.parentNode !== editor) {
      editorChild = editorChild.parentNode;
    }

    this.isDragging = true;
    editor.classList.add('drag-mode');
    editor.setAttribute('contenteditable', 'false');
    
    editor.innerHTML = '';
    
    pillsList.forEach((item, idx) => {
      const pillEl = document.createElement('div');
      pillEl.className = 'drag-pill';
      pillEl.dataset.index = idx;
      
      if (item.type === 'tag') {
        pillEl.classList.add('drag-pill-added');
        pillEl.dataset.type = 'tag';
        pillEl.dataset.tag = item.tag;
        pillEl.dataset.weight = item.weight;
        pillEl.textContent = item.tag;
      } else if (item.type === 'text_tag') {
        pillEl.classList.add('drag-pill-text');
        pillEl.dataset.type = 'text_tag';
        pillEl.dataset.text = item.text;
        pillEl.dataset.delimiter = item.delimiter;
        pillEl.textContent = item.text;
      }
      
      editor.appendChild(pillEl);
    });
    
    const renderedPills = Array.from(editor.querySelectorAll('.drag-pill'));
    const candidatePills = renderedPills.filter(pill => {
      const idx = parseInt(pill.dataset.index);
      return pillsList[idx] && pillsList[idx].sourceNode === editorChild;
    });
    
    let clickedPillElement = null;
    if (candidatePills.length === 1) {
      clickedPillElement = candidatePills[0];
    } else if (candidatePills.length > 1) {
      let closestPillDist = Number.MAX_VALUE;
      candidatePills.forEach(pill => {
        const rect = pill.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const dist = Math.hypot(clientX - cx, clientY - cy);
        if (dist < closestPillDist) {
          closestPillDist = dist;
          clickedPillElement = pill;
        }
      });
    }
    
    if (!clickedPillElement) {
      let closestPillDist = Number.MAX_VALUE;
      renderedPills.forEach(pill => {
        const rect = pill.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const dist = Math.hypot(clientX - cx, clientY - cy);
        if (dist < closestPillDist) {
          closestPillDist = dist;
          clickedPillElement = pill;
        }
      });
    }
    
    if (!clickedPillElement) {
      clickedPillElement = renderedPills[0];
    }
    
    this.draggedElement = clickedPillElement;
    this.draggedElement.classList.add('dragging');
    
    // Create Ghost Element
    this.ghostElement = this.draggedElement.cloneNode(true);
    this.ghostElement.className = this.draggedElement.className.replace('dragging', '').replace('drag-pill ', '');
    this.ghostElement.classList.add('drag-pill-ghost');
    
    const rect = this.draggedElement.getBoundingClientRect();
    // Use the exact mouse coordinates relative to the clicked element in the old layout
    this.ghostOffsetX = clickOffsetX;
    this.ghostOffsetY = clickOffsetY;
    
    // Set left and top to 0 and position using hardware-accelerated 3D translations
    this.ghostElement.style.left = '0px';
    this.ghostElement.style.top = '0px';
    this.ghostElement.style.transform = `translate3d(${clientX - this.ghostOffsetX}px, ${clientY - this.ghostOffsetY}px, 0) scale(1.05)`;
    document.body.appendChild(this.ghostElement);
    
    let transformFrameId = null;
    
    const onDragMove = (e) => {
      e.preventDefault();
      
      if (this.ghostElement) {
        if (transformFrameId) {
          cancelAnimationFrame(transformFrameId);
        }
        transformFrameId = requestAnimationFrame(() => {
          if (this.ghostElement) {
            const x = e.clientX - this.ghostOffsetX;
            const y = e.clientY - this.ghostOffsetY;
            this.ghostElement.style.transform = `translate3d(${x}px, ${y}px, 0) scale(1.05)`;
          }
        });
      }
      
      const overElement = getDragAfterElement(editor, e.clientY, e.clientX);
      if (!overElement || overElement === this.draggedElement) return;
      
      // Use DOM index comparison for directional swap
      const pills = Array.from(editor.querySelectorAll('.drag-pill'));
      const draggedIdx = pills.indexOf(this.draggedElement);
      const overIdx = pills.indexOf(overElement);
      if (draggedIdx === -1 || overIdx === -1 || draggedIdx === overIdx) return;
      
      const box = getLayoutRect(overElement);
      const midX = box.left + box.width / 2;
      const midY = box.top + box.height / 2;
      
      // Record positions before move (for FLIP animation)
      const firstRects = new Map();
      pills.forEach(p => firstRects.set(p, p.getBoundingClientRect()));
      
      let moved = false;
      
      // Directional rule: only swap when moving in the correct direction.
      // This naturally prevents ping-pong without needing dead zones.
      if (draggedIdx < overIdx) {
        // Dragged is BEFORE target → only move right if cursor is past target's center
        if (e.clientX > midX || e.clientY > midY + box.height * 0.5) {
          editor.insertBefore(this.draggedElement, overElement.nextSibling);
          moved = true;
        }
      } else {
        // Dragged is AFTER target → only move left if cursor is before target's center
        if (e.clientX < midX || e.clientY < midY - box.height * 0.5) {
          editor.insertBefore(this.draggedElement, overElement);
          moved = true;
        }
      }
      
      if (moved) {
        pills.forEach(p => {
          if (p === this.draggedElement) return;
          const first = firstRects.get(p);
          const last = p.getBoundingClientRect();
          const dx = first.left - last.left;
          const dy = first.top - last.top;
          if (dx || dy) {
            p.style.transition = 'none';
            p.style.transform = `translate(${dx}px, ${dy}px)`;
          }
        });
        
        requestAnimationFrame(() => {
          pills.forEach(p => {
            if (p === this.draggedElement) return;
            if (p.style.transform) {
              p.style.transition = 'transform 0.2s cubic-bezier(0.2, 0, 0, 1)';
              p.style.transform = '';
            }
          });
        });
      }
    };
    
    const onDragEnd = (e) => {
      window.removeEventListener('mousemove', onDragMove);
      window.removeEventListener('mouseup', onDragEnd);
      
      if (transformFrameId) {
        cancelAnimationFrame(transformFrameId);
        transformFrameId = null;
      }
      
      if (this.draggedElement) {
        this.draggedElement.classList.remove('dragging');
      }
      if (this.ghostElement) {
        this.ghostElement.remove();
        this.ghostElement = null;
      }
      
      this.isDragging = false;
      this.draggedElement = null;
      
      editor.classList.remove('drag-mode');
      editor.setAttribute('contenteditable', 'true');
      
      rebuildEditorFromPills(editor);
      placeCursorAtEnd(editor);
    };
    
    window.addEventListener('mousemove', onDragMove);
    window.addEventListener('mouseup', onDragEnd);
  }
};

// ─── Style Explorer Controller ─────────────────────────────────────
let styleExplorerState = {
  loaded: false,
  loading: false,
  items: [],
  filteredItems: [],
  currentPage: 0,
  itemsPerPage: 60,
  searchTerm: '',
  sortBy: 'works_desc'
};

async function initStyleExplorer() {
  if (styleExplorerState.loaded) {
    updateStyleExplorerHighlights();
    return;
  }
  if (styleExplorerState.loading) return;

  styleExplorerState.loading = true;
  const statusEl = document.getElementById('style-explorer-status');
  if (statusEl) statusEl.innerHTML = 'Loading artist styles database from GitHub Pages...';

  try {
    const rawData = await loadStyleExplorerData();
    styleExplorerState.items = rawData.map(item => ({
      artist: item.name,
      image: `https://cdn.jsdelivr.net/gh/ThetaCursed/Anima-Assets@main/base-images/${item.p}/${item.id}.webp`,
      worksCount: item.post_count,
      id: String(item.id),
      uniqueness: item.uniqueness_score
    }));
    styleExplorerState.loaded = true;
    styleExplorerState.loading = false;

    setupStyleExplorerListeners();
    applyStyleExplorerFilters();
  } catch (err) {
    console.error(err);
    styleExplorerState.loading = false;
    if (statusEl) {
      statusEl.innerHTML = `
        <div class="style-explorer-error-container">
          <div class="style-explorer-error-title">Database Connection Error</div>
          <div class="style-explorer-error-desc">Could not fetch styles from thetacursed.github.io. Check your network or try again.</div>
          <button id="btn-style-explorer-retry" class="btn-secondary-action" style="padding: 6px 16px; border-radius: 20px; font-size:12px;">Retry</button>
        </div>
      `;
      const retryBtn = document.getElementById('btn-style-explorer-retry');
      if (retryBtn) {
        retryBtn.addEventListener('click', () => {
          initStyleExplorer();
        });
      }
    }
  }
}

async function loadStyleExplorerData() {
  if (window.galleryData) {
    return window.galleryData;
  }
  const response = await fetch('https://thetacursed.github.io/Anima-Style-Explorer/app/data.js');
  if (!response.ok) {
    throw new Error('Failed to load database from thetacursed.github.io');
  }
  const text = await response.text();
  const startIdx = text.indexOf('[');
  const endIdx = text.lastIndexOf(']');
  if (startIdx === -1 || endIdx === -1) {
    throw new Error('Invalid database format');
  }
  const jsonText = text.substring(startIdx, endIdx + 1);
  const data = JSON.parse(jsonText);
  window.galleryData = data; // Cache it globally
  return data;
}

function setupStyleExplorerListeners() {
  const searchInput = document.getElementById('style-explorer-search');
  const sortSelect = document.getElementById('style-explorer-sort');
  const clearBtn = document.getElementById('btn-style-explorer-clear-search');
  const loadMoreBtn = document.getElementById('btn-style-explorer-load-more');

  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      styleExplorerState.searchTerm = e.target.value.trim().toLowerCase();
      if (clearBtn) {
        clearBtn.style.display = styleExplorerState.searchTerm ? 'block' : 'none';
      }
      applyStyleExplorerFilters();
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      if (searchInput) searchInput.value = '';
      clearBtn.style.display = 'none';
      styleExplorerState.searchTerm = '';
      applyStyleExplorerFilters();
    });
  }

  if (sortSelect) {
    sortSelect.addEventListener('change', (e) => {
      styleExplorerState.sortBy = e.target.value;
      applyStyleExplorerFilters();
    });
  }

  if (loadMoreBtn) {
    loadMoreBtn.addEventListener('click', () => {
      renderStyleExplorerPage(styleExplorerState.currentPage + 1);
    });
  }
}

function applyStyleExplorerFilters() {
  let list = [...styleExplorerState.items];

  // Search filter
  if (styleExplorerState.searchTerm) {
    const q = styleExplorerState.searchTerm;
    list = list.filter(item => item.artist.toLowerCase().includes(q));
  }

  // Sort
  const sortBy = styleExplorerState.sortBy;
  if (sortBy === 'name_asc') {
    list.sort((a, b) => a.artist.localeCompare(b.artist));
  } else if (sortBy === 'name_desc') {
    list.sort((a, b) => b.artist.localeCompare(a.artist));
  } else if (sortBy === 'works_desc') {
    list.sort((a, b) => b.worksCount - a.worksCount);
  } else if (sortBy === 'works_asc') {
    list.sort((a, b) => a.worksCount - b.worksCount);
  } else if (sortBy === 'uniqueness_desc') {
    list.sort((a, b) => (b.uniqueness || 0) - (a.uniqueness || 0));
  } else if (sortBy === 'random') {
    // Fisher-Yates shuffle algorithm
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
  }

  // Always pin active artists to the top
  const selectedArtists = list.filter(item => isTagInPrompt('@' + item.artist));
  const unselectedArtists = list.filter(item => !isTagInPrompt('@' + item.artist));
  const finalList = [...selectedArtists, ...unselectedArtists];

  styleExplorerState.filteredItems = finalList;
  
  const statusEl = document.getElementById('style-explorer-status');
  if (statusEl) {
    statusEl.innerHTML = `Found <span class="style-count-number" style="font-weight:600; color:var(--text-accent);">${list.length.toLocaleString('en-US')}</span> artist styles.`;
  }

  // Clear grid and render first page
  const gridEl = document.getElementById('style-explorer-grid');
  if (gridEl) gridEl.innerHTML = '';
  renderStyleExplorerPage(0);
}

function renderStyleExplorerPage(pageIndex) {
  styleExplorerState.currentPage = pageIndex;
  const start = pageIndex * styleExplorerState.itemsPerPage;
  const end = Math.min(start + styleExplorerState.itemsPerPage, styleExplorerState.filteredItems.length);
  
  const gridEl = document.getElementById('style-explorer-grid');
  if (!gridEl) return;

  const fragment = document.createDocumentFragment();

  for (let i = start; i < end; i++) {
    const item = styleExplorerState.filteredItems[i];
    const card = document.createElement('div');
    card.className = 'style-explorer-card';
    card.dataset.artist = item.artist;
    card.setAttribute('draggable', 'false');
    
    // Check if currently selected in prompt
    const isSelected = isTagInPrompt('@' + item.artist);
    if (isSelected) {
      card.classList.add('selected');
    }

    card.innerHTML = `
      <div class="style-explorer-card-img-wrapper">
        <img class="style-explorer-card-img" src="${item.image}" alt="${item.artist}" loading="lazy" draggable="false">
      </div>
      <div class="style-explorer-card-badge">✓</div>
      <div class="style-explorer-card-info">
        <div class="style-explorer-card-name">${item.artist}</div>
        <div class="style-explorer-card-details">
          <span class="style-explorer-card-works">${item.worksCount.toLocaleString('en-US')}</span>
          ${item.uniqueness !== undefined ? `<span class="style-explorer-card-uniqueness">${item.uniqueness.toFixed(1)}</span>` : ''}
        </div>
      </div>
    `;

    card.addEventListener('click', (e) => {
      e.stopPropagation();
      const artistTag = '@' + item.artist;
      togglePromptTag(artistTag);
      // Pin active artists to top without re-sorting/re-shuffling
      pinActiveArtistsToTop();
    });

    fragment.appendChild(card);
  }

  gridEl.appendChild(fragment);

  // Toggle load more visibility
  const loadMoreCont = document.getElementById('style-explorer-load-more-container');
  if (loadMoreCont) {
    loadMoreCont.style.display = end < styleExplorerState.filteredItems.length ? 'block' : 'none';
  }
}

// Re-pins active artists to top of filteredItems without re-sorting or re-loading.
function pinActiveArtistsToTop() {
  const current = styleExplorerState.filteredItems;
  if (!current || current.length === 0) return;
  const selected = current.filter(item => isTagInPrompt('@' + item.artist));
  const unselected = current.filter(item => !isTagInPrompt('@' + item.artist));
  styleExplorerState.filteredItems = [...selected, ...unselected];
  // Re-render the current page in-place (no grid wipe, no reload)
  const gridEl = document.getElementById('style-explorer-grid');
  if (gridEl) gridEl.innerHTML = '';
  renderStyleExplorerPage(styleExplorerState.currentPage);
}

function updateStyleExplorerHighlights() {
  const gridEl = document.getElementById('style-explorer-grid');
  if (!gridEl) return;

  const cards = gridEl.querySelectorAll('.style-explorer-card');
  cards.forEach(card => {
    const artist = card.dataset.artist;
    const isSelected = isTagInPrompt('@' + artist);
    if (isSelected) {
      card.classList.add('selected');
    } else {
      card.classList.remove('selected');
    }
  });
}

// ─── Character Explorer Controller ──────────────────────────────────
let charExplorerState = {
  items: [],
  total: 0,
  currentPage: 1,
  totalPages: 1,
  searchTerm: '',
  sortBy: 'popular',
  loading: false,
  loaded: false
};

let charSearchTimeout = null;

async function initCharExplorer() {
  if (charExplorerState.loaded) {
    updateCharExplorerHighlights();
    return;
  }
  
  charExplorerState.loaded = true;
  setupCharExplorerListeners();
  fetchAndRenderCharExplorerPage();
}

async function performLiveCharSearch(query, sort, page) {
  let apiSort = 'count';
  if (sort === 'name_asc' || sort === 'name_desc') {
    apiSort = 'name';
  } else if (sort === 'random') {
    apiSort = 'random';
  }
  
  const seedParam = sort === 'random' ? `&seed=${Math.random()}` : '';
  const queryParam = `q=${encodeURIComponent(query)}&sort=${apiSort}&page=${page}${seedParam}`;
  
  // 1. Try local server proxy first
  try {
    const localResp = await fetch(`/api/char-search?${queryParam}`);
    if (localResp.ok) {
      return await localResp.json();
    }
  } catch (e) {
    // Local proxy server unavailable (e.g., static hosting on GitHub Pages)
  }

  // 2. Try direct Animadex API
  const directUrl = `https://animadex.net/api/characters/search?${queryParam}`;
  try {
    const directResp = await fetch(directUrl);
    if (directResp.ok) {
      return await directResp.json();
    }
  } catch (e) {
    // Direct request blocked or failed
  }

  // 3. Fallback: Public CORS proxies for static web environments
  const corsProxies = [
    `https://corsproxy.io/?${encodeURIComponent(directUrl)}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(directUrl)}`
  ];

  for (const proxy of corsProxies) {
    try {
      const proxyResp = await fetch(proxy);
      if (proxyResp.ok) {
        return await proxyResp.json();
      }
    } catch (e) {
      // Continue to next proxy
    }
  }

  throw new Error('API request failed');
}

async function fetchAndRenderCharExplorerPage() {
  if (charExplorerState.loading) return;
  charExplorerState.loading = true;

  const statusEl = document.getElementById('char-explorer-status');
  const gridEl = document.getElementById('char-explorer-grid');
  
  if (charExplorerState.currentPage === 1 && gridEl) {
    gridEl.innerHTML = '';
  }
  
  if (statusEl) {
    statusEl.innerHTML = charExplorerState.currentPage === 1 
      ? 'Searching Animadex catalog...' 
      : 'Loading more characters...';
  }

  try {
    const data = await performLiveCharSearch(
      charExplorerState.searchTerm,
      charExplorerState.sortBy,
      charExplorerState.currentPage
    );

    charExplorerState.total = data.total || 0;
    charExplorerState.totalPages = data.pages || 1;
    
    const newItems = (data.results || []).map(item => {
      return {
        name: item.name,
        copyright: item.copyright_name || item.copyright || '',
        worksCount: item.count || 0,
        trigger: item.trigger || `${item.name}${item.copyright ? ', ' + item.copyright : ''}`,
        image: item.thumb_url || `https://blobs.animadex.net/Outputs/thumbs/${encodeURIComponent(item.copyright ? `${item.name}, ${item.copyright}` : item.name)}.webp`
      };
    });

    if (charExplorerState.sortBy === 'name_desc') {
      newItems.sort((a, b) => b.name.localeCompare(a.name));
    }

    charExplorerState.items = charExplorerState.items.concat(newItems);
    
    renderCharExplorerCards(newItems);

    if (statusEl) {
      statusEl.innerHTML = `Found <span class="style-count-number" style="font-weight:600; color:var(--text-accent);">${charExplorerState.total.toLocaleString('en-US')}</span> characters on Animadex.net.`;
    }

    const loadMoreCont = document.getElementById('char-explorer-load-more-container');
    if (loadMoreCont) {
      loadMoreCont.style.display = charExplorerState.currentPage < charExplorerState.totalPages ? 'block' : 'none';
    }
  } catch (err) {
    console.error(err);
    if (statusEl) {
      statusEl.innerHTML = `
        <div class="style-explorer-error-container">
          <div class="style-explorer-error-title">Search Connection Error</div>
          <div class="style-explorer-error-desc">Could not connect to Animadex.net. Please check your internet connection.</div>
          <button id="btn-char-explorer-retry" class="btn-secondary-action" style="padding: 6px 16px; border-radius: 20px; font-size:12px;">Retry</button>
        </div>
      `;
      const retryBtn = document.getElementById('btn-char-explorer-retry');
      if (retryBtn) {
        retryBtn.onclick = () => {
          fetchAndRenderCharExplorerPage();
        };
      }
    }
  } finally {
    charExplorerState.loading = false;
  }
}

function setupCharExplorerListeners() {
  const searchInput = document.getElementById('char-explorer-search');
  const sortSelect = document.getElementById('char-explorer-sort');
  const clearBtn = document.getElementById('btn-char-explorer-clear-search');
  const loadMoreBtn = document.getElementById('btn-char-explorer-load-more');

  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      const val = e.target.value.trim();
      if (clearBtn) {
        clearBtn.style.display = val ? 'block' : 'none';
      }
      
      clearTimeout(charSearchTimeout);
      charSearchTimeout = setTimeout(() => {
        charExplorerState.searchTerm = val;
        charExplorerState.currentPage = 1;
        charExplorerState.items = [];
        fetchAndRenderCharExplorerPage();
      }, 300);
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      if (searchInput) searchInput.value = '';
      clearBtn.style.display = 'none';
      charExplorerState.searchTerm = '';
      charExplorerState.currentPage = 1;
      charExplorerState.items = [];
      fetchAndRenderCharExplorerPage();
    });
  }

  if (sortSelect) {
    sortSelect.addEventListener('change', (e) => {
      charExplorerState.sortBy = e.target.value;
      charExplorerState.currentPage = 1;
      charExplorerState.items = [];
      fetchAndRenderCharExplorerPage();
    });
  }

  if (loadMoreBtn) {
    loadMoreBtn.addEventListener('click', () => {
      charExplorerState.currentPage++;
      fetchAndRenderCharExplorerPage();
    });
  }
}

function renderCharExplorerCards(items) {
  const gridEl = document.getElementById('char-explorer-grid');
  if (!gridEl) return;

  const fragment = document.createDocumentFragment();

  items.forEach(item => {
    const card = document.createElement('div');
    card.className = 'style-explorer-card';
    card.dataset.charTrigger = item.trigger;
    card.setAttribute('draggable', 'false');
    
    // Check if currently selected in prompt
    const isSelected = isTagInPrompt(item.trigger);
    if (isSelected) {
      card.classList.add('selected');
    }

    const escapedName = encodeURIComponent(item.name.substring(0, 3));
    card.innerHTML = `
      <div class="style-explorer-card-img-wrapper">
        <img class="style-explorer-card-img" src="${item.image}" alt="${item.name}" loading="lazy" draggable="false" onerror="this.onerror=null; this.src='https://placehold.co/130x190/1c1c1e/ffffff?text=${escapedName}'">
      </div>
      <div class="style-explorer-card-badge">✓</div>
      <div class="style-explorer-card-info">
        <div class="style-explorer-card-name">${item.name}</div>
        <div class="style-explorer-card-details">
          <span class="style-explorer-card-works" style="color:var(--text-secondary); font-size:11px; max-width:80px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${item.copyright || 'Original'}">${item.copyright || 'Original'}</span>
          ${item.worksCount > 0 ? `<span class="style-explorer-card-works">${item.worksCount.toLocaleString('en-US')}</span>` : ''}
        </div>
      </div>
    `;

    card.addEventListener('click', (e) => {
      e.stopPropagation();
      // Register the trigger so syncValueToEditor can reassemble it
      if (item.trigger && item.trigger.includes(',')) {
        appState.knownCharTriggers.add(item.trigger);
      }
      togglePromptTag(item.trigger);
      updateCharExplorerHighlights();
    });

    fragment.appendChild(card);
  });

  gridEl.appendChild(fragment);
}

function updateCharExplorerHighlights() {
  const gridEl = document.getElementById('char-explorer-grid');
  if (!gridEl) return;

  const cards = gridEl.querySelectorAll('.style-explorer-card');
  cards.forEach(card => {
    const trigger = card.dataset.charTrigger;
    const isSelected = isTagInPrompt(trigger);
    if (isSelected) {
      card.classList.add('selected');
    } else {
      card.classList.remove('selected');
    }
  });
}


function isTagInPrompt(tagString) {
  const editorId = tagString.startsWith('@') ? 'art-style-input-editor' : 'prompt-input-editor';
  const editor = document.getElementById(editorId);
  if (!editor) return false;
  const existingPills = Array.from(editor.querySelectorAll('.prompt-tag-pill'));
  return existingPills.some(pill => pill.dataset.tag.toLowerCase() === tagString.toLowerCase());
}

/* ════════════════════════════════════════════════════════════════════
   VIDEO GENERATION CONTROLLER (Wan 2.2 img2vid)
   ════════════════════════════════════════════════════════════════════ */
let videoState = {
  engineMode: 'txt2img', // 'txt2img' or 'img2vid'
  initialImageBlob: null,
  initialImageUrl: null,
  initialWidth: 0,
  initialHeight: 0,
  megapixels: 0.4,
  steps: 4,
  cfg: 1.0,
  durationSec: 5,
  calculatedWidth: 624,
  calculatedHeight: 624
};
window.videoState = videoState;

function initEngineSliderSwitch() {
  const btnTxt2Img = document.getElementById('btn-engine-txt2img');
  const btnImg2Vid = document.getElementById('btn-engine-img2vid');
  const pill = document.getElementById('top-engine-slider-pill');
  const txt2imgTabs = document.getElementById('txt2img-mode-tabs');
  const creationForm = document.getElementById('creation-form-container');
  const videoForm = document.getElementById('video-form-container');

  if (!btnTxt2Img || !btnImg2Vid || !pill) return;

  function setEngineMode(mode) {
    videoState.engineMode = mode;
    if (mode === 'txt2img') {
      pill.classList.remove('right');
      pill.classList.add('left');
      btnTxt2Img.classList.add('active');
      btnImg2Vid.classList.remove('active');
      
      if (txt2imgTabs) txt2imgTabs.classList.remove('hidden');
      if (creationForm) creationForm.classList.remove('hidden');
      if (videoForm) videoForm.classList.add('hidden');
    } else {
      pill.classList.remove('left');
      pill.classList.add('right');
      btnImg2Vid.classList.add('active');
      btnTxt2Img.classList.remove('active');

      if (txt2imgTabs) txt2imgTabs.classList.add('hidden');
      if (creationForm) creationForm.classList.add('hidden');
      if (videoForm) videoForm.classList.remove('hidden');
    }
  }

  btnTxt2Img.addEventListener('click', () => setEngineMode('txt2img'));
  btnImg2Vid.addEventListener('click', () => setEngineMode('img2vid'));

  window.setEngineMode = setEngineMode;
}

function calculateVideoDimensions() {
  const mp = videoState.megapixels || 0.4;
  let origW = videoState.initialWidth || 624;
  let origH = videoState.initialHeight || 624;

  const ar = origW / origH;
  const targetPixels = mp * 1000000;

  let height = Math.sqrt(targetPixels / ar);
  let width = height * ar;

  // Round to nearest multiple of 16 as required by Wan 2.2
  width = Math.max(256, Math.round(width / 16) * 16);
  height = Math.max(256, Math.round(height / 16) * 16);

  videoState.calculatedWidth = width;
  videoState.calculatedHeight = height;

  const badge = document.getElementById('video-calculated-res-badge');
  if (badge) badge.textContent = `${width} × ${height}`;

  const mpValText = document.getElementById('video-mp-val');
  if (mpValText) mpValText.textContent = `${mp.toFixed(2)} MP`;
}

function updateVideoDurationUI() {
  const sec = videoState.durationSec || 5;
  const frames = sec * 16 + 1; // 16 fps standard
  
  const secText = document.getElementById('video-duration-sec-val');
  if (secText) secText.textContent = `${sec}s`;

  const framesBadge = document.getElementById('video-frames-count-badge');
  if (framesBadge) framesBadge.textContent = `${frames} frames`;
}

function initVideoFormController() {
  const dropzone = document.getElementById('video-initial-image-dropzone');
  const fileInput = document.getElementById('video-initial-file-input');
  const emptyState = document.getElementById('video-initial-empty-state');
  const previewWrapper = document.getElementById('video-initial-preview-wrapper');
  const imgPreview = document.getElementById('video-initial-img-preview');
  const btnRemove = document.getElementById('btn-remove-video-initial-img');
  const dimBadge = document.getElementById('video-initial-dimensions-badge');

  const inputCfg = document.getElementById('setting-video-cfg');
  const inputSteps = document.getElementById('setting-video-steps');
  const stepsValText = document.getElementById('video-steps-val');
  const cfgValText = document.getElementById('video-cfg-val');
  const negWrapper = document.getElementById('video-negative-prompt-wrapper');
  const rangeMp = document.getElementById('input-video-megapixels');
  const rangeDuration = document.getElementById('input-video-duration');
  const btnGenerateVid = document.getElementById('btn-generate-video');

  if (!dropzone || !fileInput) return;

  // File loading helper
  async function loadInitialImage(fileOrBlob, url = null) {
    videoState.initialImageBlob = fileOrBlob;
    const srcUrl = url || URL.createObjectURL(fileOrBlob);
    videoState.initialImageUrl = srcUrl;

    imgPreview.src = srcUrl;
    emptyState.classList.add('hidden');
    previewWrapper.classList.remove('hidden');

    const img = new Image();
    img.onload = () => {
      videoState.initialWidth = img.naturalWidth;
      videoState.initialHeight = img.naturalHeight;
      dimBadge.textContent = `${img.naturalWidth} × ${img.naturalHeight}`;
      calculateVideoDimensions();
    };
    img.src = srcUrl;
  }

  dropzone.addEventListener('click', (e) => {
    if (e.target.closest('#btn-remove-video-initial-img')) return;
    fileInput.click();
  });

  fileInput.addEventListener('change', (e) => {
    if (fileInput.files && fileInput.files[0]) {
      loadInitialImage(fileInput.files[0]);
    }
  });

  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });

  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));

  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      loadInitialImage(e.dataTransfer.files[0]);
    }
  });

  if (btnRemove) {
    btnRemove.addEventListener('click', (e) => {
      e.stopPropagation();
      videoState.initialImageBlob = null;
      videoState.initialImageUrl = null;
      videoState.initialWidth = 0;
      videoState.initialHeight = 0;
      imgPreview.src = '';
      emptyState.classList.remove('hidden');
      previewWrapper.classList.add('hidden');
      fileInput.value = '';
    });
  }

  // Steps listener
  if (inputSteps) {
    inputSteps.addEventListener('input', () => {
      const val = parseInt(inputSteps.value) || 4;
      videoState.steps = val;
      if (stepsValText) stepsValText.textContent = val;
    });
  }

  // CFG listener & conditional Negative prompt visibility
  if (inputCfg) {
    inputCfg.addEventListener('input', () => {
      const val = parseFloat(inputCfg.value) || 1.0;
      videoState.cfg = val;
      if (cfgValText) cfgValText.textContent = val.toFixed(1);

      if (val > 1.0) {
        negWrapper.classList.remove('hidden');
      } else {
        negWrapper.classList.add('hidden');
      }
    });
  }

  // Megapixels range & preset chips
  if (rangeMp) {
    rangeMp.addEventListener('input', () => {
      videoState.megapixels = parseFloat(rangeMp.value) || 0.4;
      document.querySelectorAll('.mp-preset-chip').forEach(chip => {
        const chipMp = parseFloat(chip.dataset.mp);
        if (Math.abs(chipMp - videoState.megapixels) < 0.02) {
          chip.classList.add('active');
        } else {
          chip.classList.remove('active');
        }
      });
      calculateVideoDimensions();
    });
  }

  document.querySelectorAll('.mp-preset-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.mp-preset-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      const mp = parseFloat(chip.dataset.mp);
      videoState.megapixels = mp;
      if (rangeMp) rangeMp.value = mp;
      calculateVideoDimensions();
    });
  });

  // Duration listener
  if (rangeDuration) {
    rangeDuration.addEventListener('input', () => {
      videoState.durationSec = parseInt(rangeDuration.value) || 5;
      updateVideoDurationUI();
    });
  }

  // Video Generation trigger
  if (btnGenerateVid) {
    btnGenerateVid.addEventListener('click', async () => {
      if (!videoState.initialImageBlob) {
        showToast('Please select or upload an initial image for video generation!', 'error');
        return;
      }

      // Combine 3 prompt fields
      const p1 = document.getElementById('video-prompt-setting')?.value.trim() || '';
      const p2 = document.getElementById('video-prompt-action')?.value.trim() || '';
      const p3 = document.getElementById('video-prompt-camera')?.value.trim() || '';
      
      const combinedPromptParts = [p1, p2, p3].filter(Boolean);
      const combinedPrompt = combinedPromptParts.join(', ');

      if (!combinedPrompt) {
        showToast('Please describe your video in at least one prompt field!', 'error');
        return;
      }

      const negPrompt = (videoState.cfg > 1.0)
        ? (document.getElementById('video-prompt-negative')?.value.trim() || '')
        : '';

      const lengthFrames = videoState.durationSec * 16 + 1;

      // Morph main workspace to loader view
      showLoaderForm();

      appState.generationAbortController = new AbortController();

      try {
        const result = await import('./services/comfyui-service.js').then(m => m.generateVideoComfyUI(
          combinedPrompt,
          negPrompt,
          videoState.initialImageBlob,
          {
            width: videoState.calculatedWidth,
            height: videoState.calculatedHeight,
            length: lengthFrames,
            steps: videoState.steps,
            cfg: videoState.cfg
          },
          (statusText, pct) => {
            smoothUpdateLoaderText(statusText);
            if (pct !== undefined) {
              const progressBar = document.getElementById('loader-progress-bar');
              if (progressBar) progressBar.style.width = `${pct}%`;
            }
          },
          appState.generationAbortController.signal
        ));

        if (result && (result.videoUrl || result.imageUrl)) {
          const mediaUrl = result.videoUrl || result.imageUrl;
          appState.generatedImageUrl = mediaUrl;
          appState.isVideoGeneration = true;
          showToast('Video generated successfully!', 'success');
          showVideoPreview(mediaUrl, combinedPrompt);
        } else {
          showCreationForm();
        }
      } catch (err) {
        showCreationForm();
        if (err.name !== 'AbortError') {
          showToast(`Video generation failed: ${err.message}`, 'error');
        }
      }
    });
  }

function showVideoPreview(videoUrl, promptText) {
  const mainWorkspace = document.getElementById('main-workspace');
  const loader = document.getElementById('generation-loader');
  const previewArea = document.getElementById('art-preview-area');
  const imgElement = document.getElementById('generated-art-img');
  const videoPlayer = document.getElementById('generated-video-player');

  mainWorkspace.classList.remove('generating');
  mainWorkspace.classList.remove('batch-preview');

  document.getElementById('creation-form-container').classList.add('hidden');
  document.getElementById('video-form-container').classList.add('hidden');
  document.getElementById('improve-confirmation-container').classList.add('hidden');
  if (loader) loader.classList.add('hidden');

  if (previewArea) previewArea.classList.remove('hidden');

  const lowerUrl = (videoUrl || '').toLowerCase();
  const isVideoFormat = lowerUrl.includes('.mp4') || lowerUrl.includes('.webm') || lowerUrl.includes('.gif') || lowerUrl.includes('format=mp4') || lowerUrl.includes('/video/');

  const btnGenMore = document.getElementById('btn-post-generate-more');
  if (isVideoFormat) {
    if (imgElement) imgElement.classList.add('hidden');
    if (videoPlayer) {
      videoPlayer.src = videoUrl;
      videoPlayer.classList.remove('hidden');
      videoPlayer.play().catch(err => console.warn('Autoplay prevented:', err));
    }
    if (btnGenMore) btnGenMore.classList.remove('hidden');
  } else {
    if (videoPlayer) videoPlayer.classList.add('hidden');
    if (imgElement) {
      imgElement.src = videoUrl;
      imgElement.classList.remove('hidden');
    }
    if (btnGenMore) btnGenMore.classList.add('hidden');
  }
}

  // Global helper to extract last frame of video and continue video generation
  window.generateMoreFromVideo = async function(videoUrl, promptText = '', videoId = null) {
    window.switchView('create');
    window.setEngineMode('img2vid');

    videoState.sourceImageId = videoId || null;
    showToast('Extracting last video frame...', 'info');

    try {
      const video = document.createElement('video');
      video.crossOrigin = 'anonymous';
      video.src = videoUrl;
      
      await new Promise((resolve, reject) => {
        video.onloadedmetadata = () => {
          video.currentTime = Math.max(0, video.duration - 0.1);
        };
        video.onseeked = () => resolve();
        video.onerror = (e) => reject(e);
      });

      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth || 624;
      canvas.height = video.videoHeight || 624;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
      const frameUrl = URL.createObjectURL(blob);

      await loadInitialImage(blob, frameUrl);

      if (promptText) {
        const field1 = document.getElementById('video-prompt-setting');
        if (field1) field1.value = promptText;
      }

      showToast('Last frame loaded into Video Generator!', 'success');
      const videoFormWrapper = document.getElementById('video-form-container');
      if (videoFormWrapper) videoFormWrapper.scrollIntoView({ behavior: 'smooth' });
    } catch (err) {
      console.error('Failed to extract video frame:', err);
      showToast('Failed to extract last frame from video', 'error');
    }
  };

  // Global helper to send artwork from Album to Video Generation
  window.sendImageToVideoGen = async function(imageUrl, promptText = '', imageId = null) {
    window.switchView('create');
    window.setEngineMode('img2vid');

    videoState.sourceImageId = imageId || null;

    showToast('Loading image into Video Generator...', 'info');

    try {
      const resp = await fetch(imageUrl);
      const blob = await resp.blob();
      await loadInitialImage(blob, imageUrl);

      // Pre-fill positive prompt field 1 if prompt text exists
      if (promptText) {
        const field1 = document.getElementById('video-prompt-setting');
        if (field1) field1.value = promptText;
      }

      // Scroll to video workspace smoothly
      const videoFormWrapper = document.getElementById('video-form-container');
      if (videoFormWrapper) {
        videoFormWrapper.scrollIntoView({ behavior: 'smooth' });
      }
    } catch (e) {
      showToast('Failed to transfer image to Video Generator', 'error');
    }
  };
}

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', () => {
  initEngineSliderSwitch();
  initVideoFormController();
});


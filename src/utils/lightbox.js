/* ════════════════════════════════════════════════════════════════════
   Lightbox — Fullscreen Image Viewer with Zooming and Drag-Panning
   ════════════════════════════════════════════════════════════════════ */

let scale = 1.0;
let offsetX = 0;
let offsetY = 0;
let isDragging = false;
let startX = 0;
let startY = 0;

let lightboxEl = null;
let imgEl = null;
let contentEl = null;

export function initLightbox() {
  lightboxEl = document.getElementById('image-lightbox');
  imgEl = document.getElementById('lightbox-img');
  contentEl = document.getElementById('lightbox-content');
  const closeBtn = document.getElementById('lightbox-close');
  const zoomInBtn = document.getElementById('btn-lightbox-zoom-in');
  const zoomOutBtn = document.getElementById('btn-lightbox-zoom-out');
  const zoomResetBtn = document.getElementById('btn-lightbox-zoom-reset');

  if (!lightboxEl || !imgEl || !contentEl) {
    console.warn('Lightbox elements not found in index.html');
    return;
  }

  // Bind global function so inline HTML event handlers or other files can call it
  window.openLightbox = openLightbox;

  // 1. Drag Panning listeners
  contentEl.addEventListener('mousedown', (e) => {
    if (scale <= 1.0) return; // Only pan when zoomed in
    e.preventDefault();
    isDragging = true;
    startX = e.clientX - offsetX;
    startY = e.clientY - offsetY;
    contentEl.classList.add('dragging');
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    offsetX = e.clientX - startX;
    offsetY = e.clientY - startY;
    updateTransform();
  });

  window.addEventListener('mouseup', () => {
    isDragging = false;
    contentEl.classList.remove('dragging');
  });

  contentEl.addEventListener('mouseleave', () => {
    isDragging = false;
    contentEl.classList.remove('dragging');
  });

  // 2. Mouse Wheel Zoom centered towards cursor
  contentEl.addEventListener('wheel', (e) => {
    e.preventDefault();
    const zoomFactor = 0.15;
    const delta = -e.deltaY;
    const oldScale = scale;

    scale = Math.min(Math.max(scale + (delta > 0 ? zoomFactor : -zoomFactor) * scale, 1.0), 5.0);

    if (scale === 1.0) {
      offsetX = 0;
      offsetY = 0;
    } else {
      // Zoom towards cursor location
      const mouseX = e.clientX - (window.innerWidth / 2);
      const mouseY = e.clientY - (window.innerHeight / 2);

      offsetX -= mouseX * (scale / oldScale - 1);
      offsetY -= mouseY * (scale / oldScale - 1);
    }

    updateTransform();
  });

  // 3. Zoom Controls Buttons
  zoomInBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    zoomStep(0.25);
  });

  zoomOutBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    zoomStep(-0.25);
  });

  zoomResetBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    resetZoom();
  });

  // 4. Closing triggers
  closeBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    closeLightbox();
  });

  // Close by clicking backdrop/empty space
  lightboxEl.addEventListener('click', (e) => {
    if (e.target === lightboxEl || e.target === contentEl) {
      closeLightbox();
    }
  });

  // Close by pressing Escape key
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !lightboxEl.classList.contains('hidden')) {
      closeLightbox();
    }
  });

  // Reset transforms on window resize to prevent alignment breaking
  window.addEventListener('resize', () => {
    if (!lightboxEl.classList.contains('hidden')) {
      resetZoom();
    }
  });
}

export function openLightbox(src, prompt = '', tags = []) {
  if (!lightboxEl || !imgEl) return;
  
  imgEl.src = src;
  resetZoom();

  // Update caption panel
  const captionEl = document.getElementById('lightbox-caption');
  const promptTextEl = document.getElementById('lightbox-prompt-text');
  const tagsContainerEl = document.getElementById('lightbox-tags-container');

  if (captionEl && promptTextEl && tagsContainerEl) {
    if (prompt) {
      promptTextEl.textContent = prompt;
      tagsContainerEl.innerHTML = '';
      
      if (tags && tags.length > 0) {
        tags.forEach(tag => {
          const chip = document.createElement('span');
          chip.className = 'lightbox-tag-chip';
          chip.textContent = tag;
          tagsContainerEl.appendChild(chip);
        });
        tagsContainerEl.style.display = 'flex';
      } else {
        tagsContainerEl.style.display = 'none';
      }
      captionEl.classList.remove('hidden');
    } else {
      captionEl.classList.add('hidden');
    }
  }
  
  lightboxEl.classList.remove('hidden');
}

export function closeLightbox() {
  if (!lightboxEl) return;
  lightboxEl.classList.add('hidden');
}

function zoomStep(delta) {
  const oldScale = scale;
  scale = Math.min(Math.max(scale + delta, 1.0), 5.0);
  
  if (scale === 1.0) {
    offsetX = 0;
    offsetY = 0;
  } else {
    // Zoom centered on the viewport center when using buttons
    offsetX = offsetX * (scale / oldScale);
    offsetY = offsetY * (scale / oldScale);
  }
  
  updateTransform();
}

function resetZoom() {
  scale = 1.0;
  offsetX = 0;
  offsetY = 0;
  updateTransform();
}

function updateTransform() {
  if (!imgEl) return;
  imgEl.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
}

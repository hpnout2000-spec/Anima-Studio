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

    scale = Math.min(Math.max(scale + (delta > 0 ? zoomFactor : -zoomFactor) * scale, 0.2), 5.0);

    // Zoom towards cursor location
    const mouseX = e.clientX - (window.innerWidth / 2);
    const mouseY = e.clientY - (window.innerHeight / 2);

    offsetX -= mouseX * (scale / oldScale - 1);
    offsetY -= mouseY * (scale / oldScale - 1);

    updateTransform();
  });

  const btnSendToVideo = document.getElementById('btn-lightbox-send-to-video');
  btnSendToVideo?.addEventListener('click', (e) => {
    e.stopPropagation();
    closeLightbox();
    if (window.sendImageToVideoGen && imgEl) {
      const src = imgEl.src;
      const prompt = document.getElementById('lightbox-prompt-text')?.textContent || '';
      const id = lightboxEl?.dataset.imageId || null;
      window.sendImageToVideoGen(src, prompt, id);
    }
  });

  const btnGenMore = document.getElementById('btn-lightbox-gen-more');
  btnGenMore?.addEventListener('click', (e) => {
    e.stopPropagation();
    closeLightbox();
    if (window.generateMoreFromVideo && imgEl) {
      const src = imgEl.dataset.videoSrc || imgEl.src;
      const prompt = document.getElementById('lightbox-prompt-text')?.textContent || '';
      const id = lightboxEl?.dataset.imageId || null;
      window.generateMoreFromVideo(src, prompt, id);
    }
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

export function openLightbox(src, prompt = '', tags = [], id = null, isVideoHint = false) {
  if (!lightboxEl || !imgEl) return;
  
  lightboxEl.dataset.imageId = id || '';
  
  const isVideo = isVideoHint || (src && (src.includes('.mp4') || src.includes('/video/') || src.includes('.webm')));
  let videoEl = document.getElementById('lightbox-video');
  
  const btnGenMore = document.getElementById('btn-lightbox-gen-more');
  const btnEdit = document.getElementById('btn-lightbox-edit');
  const btnSendToVideo = document.getElementById('btn-lightbox-send-to-video');
  if (isVideo) {
    if (!videoEl) {
      videoEl = document.createElement('video');
      videoEl.id = 'lightbox-video';
      videoEl.controls = true;
      videoEl.autoplay = true;
      videoEl.loop = true;
      videoEl.style.maxWidth = '100%';
      videoEl.style.maxHeight = '100%';
      contentEl.appendChild(videoEl);
    }
    videoEl.src = src;
    videoEl.classList.remove('hidden');
    imgEl.classList.add('hidden');
    imgEl.dataset.videoSrc = src;
    if (btnGenMore) btnGenMore.classList.remove('hidden');
    if (btnEdit) btnEdit.classList.add('hidden');
    if (btnSendToVideo) btnSendToVideo.classList.add('hidden');
  } else {
    if (videoEl) videoEl.classList.add('hidden');
    imgEl.src = src;
    imgEl.classList.remove('hidden');
    delete imgEl.dataset.videoSrc;
    if (btnGenMore) btnGenMore.classList.add('hidden');
    if (btnEdit) btnEdit.classList.remove('hidden');
    if (btnSendToVideo) btnSendToVideo.classList.remove('hidden');
  }

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
  scale = Math.min(Math.max(scale + delta, 0.2), 5.0);
  
  // Zoom centered on the viewport center when using buttons
  offsetX = offsetX * (scale / oldScale);
  offsetY = offsetY * (scale / oldScale);
  
  updateTransform();
}

function resetZoom() {
  scale = 1.0;
  offsetX = 0;
  offsetY = 0;
  updateTransform();
}

function updateTransform() {
  const transformStr = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
  if (imgEl) imgEl.style.transform = transformStr;
  const videoEl = document.getElementById('lightbox-video');
  if (videoEl) videoEl.style.transform = transformStr;

  const resetBtn = document.getElementById('btn-lightbox-zoom-reset');
  if (resetBtn) {
    resetBtn.textContent = `${Math.round(scale * 100)}%`;
  }
}

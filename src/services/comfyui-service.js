import { settingsStore } from './settings-store.js';

/**
 * Build the Anima workflow in ComfyUI API format
 */
function buildAnimaWorkflow(prompt, negPrompt, settings, loras = []) {
  const seed = Math.floor(Math.random() * 2 ** 32);
  const steps = settings.comfyui_steps ?? 30;
  const cfg = settings.comfyui_cfg ?? 4.5;
  const width = settings.comfyui_width ?? 832;
  const height = settings.comfyui_height ?? 1216;
  const sampler = settings.comfyui_sampler ?? 'euler';
  const scheduler = settings.comfyui_scheduler ?? 'normal';
  const unetName = settings.comfyui_unet_name ?? 'anima_baseV10.safetensors';
  const clipName = settings.comfyui_clip_name ?? 'qwen_3_06b_base.safetensors';
  const vaeName = settings.comfyui_vae_name ?? 'qwen_image_vae.safetensors';

  let currentModel = ["1", 0];
  let currentClip = ["2", 0];

  const workflow = {
    "1": {
      "class_type": "UNETLoader",
      "inputs": {
        "unet_name": unetName,
        "weight_dtype": "default"
      }
    },
    "2": {
      "class_type": "CLIPLoader",
      "inputs": {
        "clip_name": clipName,
        "type": "qwen_image"
      }
    },
    "3": {
      "class_type": "VAELoader",
      "inputs": {
        "vae_name": vaeName
      }
    },
    "4": {
      "class_type": "CLIPTextEncode",
      "inputs": {
        "text": prompt,
        "clip": null
      }
    },
    "5": {
      "class_type": "CLIPTextEncode",
      "inputs": {
        "text": negPrompt || "lowres, bad anatomy, worst quality, blurry, watermark",
        "clip": null
      }
    },
    "6": {
      "class_type": "EmptyLatentImage",
      "inputs": {
        "width": width,
        "height": height,
        "batch_size": 1
      }
    },
    "7": {
      "class_type": "KSampler",
      "inputs": {
        "model": null,
        "positive": ["4", 0],
        "negative": ["5", 0],
        "latent_image": ["6", 0],
        "seed": seed,
        "steps": steps,
        "cfg": cfg,
        "sampler_name": sampler,
        "scheduler": scheduler,
        "denoise": 1.0
      }
    },
    "8": {
      "class_type": "VAEDecode",
      "inputs": {
        "samples": ["7", 0],
        "vae": ["3", 0]
      }
    },
    "9": {
      "class_type": "SaveImage",
      "inputs": {
        "images": ["8", 0],
        "filename_prefix": "comfygen_"
      }
    }
  };

  if (Array.isArray(loras) && loras.length > 0) {
    loras.forEach((lora, idx) => {
      const nodeId = String(100 + idx);
      workflow[nodeId] = {
        "class_type": "LoraLoader",
        "inputs": {
          "model": currentModel,
          "clip": currentClip,
          "lora_name": lora.name,
          "strength_model": lora.strength,
          "strength_clip": lora.strength
        }
      };
      currentModel = [nodeId, 0];
      currentClip = [nodeId, 1];
    });
  }

  workflow["4"].inputs.clip = currentClip;
  workflow["5"].inputs.clip = currentClip;
  workflow["7"].inputs.model = currentModel;

  return workflow;
}

/**
 * Build the Anima Edit workflow (Img2Img / Inpaint with optional LLLite)
 */
function buildAnimaEditWorkflow(prompt, negPrompt, settings, sourceFilename, maskFilename, denoise, mode, loras = []) {
  const seed = Math.floor(Math.random() * 2 ** 32);
  const steps = settings.comfyui_steps ?? 30;
  const cfg = settings.comfyui_cfg ?? 4.5;
  const sampler = settings.comfyui_sampler ?? 'euler';
  const scheduler = settings.comfyui_scheduler ?? 'normal';
  const unetName = settings.comfyui_unet_name ?? 'anima_baseV10.safetensors';
  const clipName = settings.comfyui_clip_name ?? 'qwen_3_06b_base.safetensors';
  const vaeName = settings.comfyui_vae_name ?? 'qwen_image_vae.safetensors';
  // Pick the right LLLite model for the mode:
  //   inpaint → requires mask (anima-lllite-inpainting-v2)
  //   img2img  → no mask needed (anima-lllite-any-test-like-v2)
  const llliteNameInpaint = settings.comfyui_lllite_name || '';
  const llliteNameImg2Img = settings.comfyui_lllite_name_img2img || '';
  const llliteName = mode === 'inpaint' ? llliteNameInpaint : llliteNameImg2Img;
  const llliteStrength = settings.comfyui_lllite_strength ?? 1.0;

  let currentModel = ["1", 0];
  let currentClip = ["2", 0];

  const workflow = {
    "1": {
      "class_type": "UNETLoader",
      "inputs": {
        "unet_name": unetName,
        "weight_dtype": "default"
      }
    },
    "2": {
      "class_type": "CLIPLoader",
      "inputs": {
        "clip_name": clipName,
        "type": "qwen_image"
      }
    },
    "3": {
      "class_type": "VAELoader",
      "inputs": {
        "vae_name": vaeName
      }
    },
    "4": {
      "class_type": "CLIPTextEncode",
      "inputs": {
        "text": prompt,
        "clip": null
      }
    },
    "5": {
      "class_type": "CLIPTextEncode",
      "inputs": {
        "text": negPrompt || "lowres, bad anatomy, worst quality, blurry, watermark",
        "clip": null
      }
    },
    "10": {
      "class_type": "LoadImage",
      "inputs": {
        "image": sourceFilename,
        "upload": "image"
      }
    }
  };

  if (Array.isArray(loras) && loras.length > 0) {
    loras.forEach((lora, idx) => {
      const nodeId = String(100 + idx);
      workflow[nodeId] = {
        "class_type": "LoraLoader",
        "inputs": {
          "model": currentModel,
          "clip": currentClip,
          "lora_name": lora.name,
          "strength_model": lora.strength,
          "strength_clip": lora.strength
        }
      };
      currentModel = [nodeId, 0];
      currentClip = [nodeId, 1];
    });
  }

  workflow["4"].inputs.clip = currentClip;
  workflow["5"].inputs.clip = currentClip;

  let modelNode = currentModel;

  // Apply LLLite patch if a model is configured for this mode
  if (llliteName) {
    workflow["15"] = {
      "class_type": "AnimaLLLiteApply",
      "inputs": {
        "model": currentModel,
        "lllite_name": llliteName,
        "image": ["10", 0],
        "strength": llliteStrength,
        "start_percent": 0.0,
        "end_percent": 1.0,
        "preserve_wrapper": false
      }
    };

    if (mode === 'inpaint' && maskFilename) {
      // Inpainting model REQUIRES a mask
      workflow["12"] = {
        "class_type": "LoadImageMask",
        "inputs": {
          "image": maskFilename,
          "channel": "red"
        }
      };
      // Smooth the mask to prevent visible seams
      workflow["12_blur"] = {
        "class_type": "MaskBlur+",
        "inputs": {
          "mask": ["12", 0],
          "amount": 21,
          "device": "auto"
        }
      };
      workflow["15"].inputs["mask"] = ["12_blur", 0];
    }
    // img2img LLLite model does NOT use a mask — no mask input added

    modelNode = ["15", 0];
  } else if (mode === 'inpaint' && maskFilename) {
    // No LLLite configured, but still need LoadImageMask for VAEEncodeForInpaint
    workflow["12"] = {
      "class_type": "LoadImageMask",
      "inputs": {
        "image": maskFilename,
        "channel": "red"
      }
    };
    workflow["12_blur"] = {
      "class_type": "MaskBlur+",
      "inputs": {
        "mask": ["12", 0],
        "amount": 21,
        "device": "auto"
      }
    };
  }

  // Latent encoding setup
  if (mode === 'inpaint' && maskFilename) {
    workflow["13"] = {
      "class_type": "VAEEncodeForInpaint",
      "inputs": {
        "pixels": ["10", 0],
        "vae": ["3", 0],
        "mask": ["12_blur", 0],
        "grow_mask_by": 6
      }
    };
    
    workflow["7"] = {
      "class_type": "KSampler",
      "inputs": {
        "model": modelNode,
        "positive": ["4", 0],
        "negative": ["5", 0],
        "latent_image": ["13", 0],
        "seed": seed,
        "steps": steps,
        "cfg": cfg,
        "sampler_name": sampler,
        "scheduler": scheduler,
        "denoise": denoise
      }
    };
  } else {
    // Global img2img
    workflow["11"] = {
      "class_type": "VAEEncode",
      "inputs": {
        "pixels": ["10", 0],
        "vae": ["3", 0]
      }
    };
    
    workflow["7"] = {
      "class_type": "KSampler",
      "inputs": {
        "model": modelNode,
        "positive": ["4", 0],
        "negative": ["5", 0],
        "latent_image": ["11", 0],
        "seed": seed,
        "steps": steps,
        "cfg": cfg,
        "sampler_name": sampler,
        "scheduler": scheduler,
        "denoise": denoise
      }
    };
  }

  // Decoding & Saving
  workflow["8"] = {
    "class_type": "VAEDecode",
    "inputs": {
      "samples": ["7", 0],
      "vae": ["3", 0]
    }
  };
  
  workflow["9"] = {
    "class_type": "SaveImage",
    "inputs": {
      "images": ["8", 0],
      "filename_prefix": "comfygen_edit_"
    }
  };

  return workflow;
}

/**
 * Build the Anima Edit Pro workflow (Split-Screen Outpainting)
 */
function buildAnimaEditProWorkflow(prompt, negPrompt, settings, sourceFilename, denoise, loras = []) {
  const seed = Math.floor(Math.random() * 2 ** 32);
  const steps = settings.comfyui_steps ?? 30;
  const cfg = settings.comfyui_cfg ?? 4.5;
  const sampler = settings.comfyui_sampler ?? 'euler';
  const scheduler = settings.comfyui_scheduler ?? 'normal';
  const unetName = settings.comfyui_unet_name ?? 'anima_baseV10.safetensors';
  const clipName = settings.comfyui_clip_name ?? 'qwen_3_06b_base.safetensors';
  const vaeName = settings.comfyui_vae_name ?? 'qwen_image_vae.safetensors';
  const llliteName = settings.comfyui_lllite_name || 'anima-lllite-inpainting-v2.safetensors';
  const llliteStrength = settings.comfyui_lllite_strength ?? 1.0;

  const stylePrompt = "masterpiece, best quality";
  const instructions = "split screen, multiple views, The image on the right is different - \n" + prompt;
  const finalPrompt = stylePrompt + ", " + instructions;

  let currentModel = ["1", 0];
  let currentClip = ["2", 0];

  const workflow = {
    "1": {
      "class_type": "UNETLoader",
      "inputs": { "unet_name": unetName, "weight_dtype": "default" }
    },
    "2": {
      "class_type": "CLIPLoader",
      "inputs": { "clip_name": clipName, "type": "qwen_image" }
    },
    "3": {
      "class_type": "VAELoader",
      "inputs": { "vae_name": vaeName }
    },
    "4": {
      "class_type": "CLIPTextEncode",
      "inputs": { "text": finalPrompt, "clip": null }
    },
    "5": {
      "class_type": "CLIPTextEncode",
      "inputs": { "text": negPrompt || "lowres, bad anatomy, worst quality, blurry, watermark", "clip": null }
    },
    "10": {
      "class_type": "LoadImage",
      "inputs": { "image": sourceFilename, "upload": "image" }
    }
  };

  if (Array.isArray(loras) && loras.length > 0) {
    loras.forEach((lora, idx) => {
      const nodeId = String(100 + idx);
      workflow[nodeId] = {
        "class_type": "LoraLoader",
        "inputs": {
          "model": currentModel,
          "clip": currentClip,
          "lora_name": lora.name,
          "strength_model": lora.strength,
          "strength_clip": lora.strength
        }
      };
      currentModel = [nodeId, 0];
      currentClip = [nodeId, 1];
    });
  }

  workflow["4"].inputs.clip = currentClip;
  workflow["5"].inputs.clip = currentClip;

  Object.assign(workflow, {
    "15": {
      "class_type": "ImageResize+",
      "inputs": {
        "width": 1024, "height": 1024, "interpolation": "lanczos",
        "method": "keep proportion", "condition": "always", "multiple_of": 0,
        "image": ["10", 0]
      }
    },
    "51": {
      "class_type": "ImagePadKJ",
      "inputs": {
        "left": 0, "right": 24, "top": 0, "bottom": 0,
        "extra_padding": 0, "pad_mode": "color", "color": "1,1,1",
        "image": ["15", 0]
      }
    },
    "12": {
      "class_type": "AILab_ICLoRAConcat",
      "inputs": {
        "layout": "left-right", "custom_size": 0,
        "object_image": ["51", 0], "base_image": ["15", 0]
      }
    },
    "6": {
      "class_type": "AnimaLLLiteApply",
      "inputs": {
        "lllite_name": llliteName, "strength": llliteStrength,
        "start_percent": 0, "end_percent": 1, "preserve_wrapper": true,
        "model": currentModel, "image": ["12", 0], "mask": ["12", 2]
      }
    },
    "50": {
      "class_type": "InpaintModelConditioning",
      "inputs": {
        "noise_mask": true, "positive": ["4", 0], "negative": ["5", 0],
        "vae": ["3", 0], "pixels": ["12", 0], "mask": ["12", 2]
      }
    },
    "13": {
      "class_type": "KSampler",
      "inputs": {
        "seed": seed, "steps": steps, "cfg": cfg, "sampler_name": sampler,
        "scheduler": scheduler, "denoise": denoise, "model": ["6", 0],
        "positive": ["50", 0], "negative": ["50", 1], "latent_image": ["50", 2]
      }
    },
    "14": {
      "class_type": "VAEDecodeTiled",
      "inputs": {
        "tile_size": 512, "overlap": 64, "temporal_size": 64, "temporal_overlap": 8,
        "samples": ["13", 0], "vae": ["3", 0]
      }
    },
    "40": {
      "class_type": "Crop Image TargetSize (JPS)",
      "inputs": {
        "target_w": ["15", 1], "target_h": ["15", 2], "crop_position": "right",
        "offset": 0, "interpolation": "lanczos", "sharpening": 0,
        "image": ["14", 0]
      }
    },
    "9": {
      "class_type": "SaveImage",
      "inputs": {
        "images": ["40", 0],
        "filename_prefix": "comfygen_edit_pro_"
      }
    }
  });

  return workflow;
}

/**
 * Upload an image file blob to ComfyUI input folder
 */
async function uploadImageToComfyUI(baseUrl, fileBlob, filename) {
  const formData = new FormData();
  formData.append('image', fileBlob, filename);
  formData.append('overwrite', 'true');
  
  const response = await fetch(`${baseUrl}/upload/image`, {
    method: 'POST',
    body: formData
  });
  
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to upload image to ComfyUI: ${response.status} - ${text}`);
  }
  
  return await response.json(); // returns { name: "...", subfolder: "...", type: "input" }
}


/**
 * Check if ComfyUI is reachable
 */
export async function checkComfyUIConnection() {
  try {
    const settings = settingsStore.get();
    const baseUrl = (settings.comfyui_url || 'http://localhost:8188').replace(/\/$/, '');
    const resp = await fetch(`${baseUrl}/system_stats`, { method: 'GET' });
    return resp.ok;
  } catch {
    return false;
  }
}

/**
 * Generate an image via ComfyUI using the Anima workflow
 * @param {string} prompt - The positive prompt
 * @param {function} onProgress - Callback(statusText) for visual stage updates
 * @param {AbortSignal} signal - Signal to abort generation
 * @returns {Promise<string>} - Object URL of the generated image
 */
export async function generateImageComfyUI(prompt, onProgress = () => {}, signal = null, onPreview = null, editParams = null, loras = []) {
  const settings = settingsStore.get();
  const baseUrl = (settings.comfyui_url || 'http://localhost:8188').replace(/\/$/, '');
  const negPrompt = settings.comfyui_negative_prompt || 'lowres, bad anatomy, worst quality, blurry, watermark';
  const clientId = `comfygen_${Date.now()}`;
  let promptId = null;
  let ws = null;

  // Function to cancel the generation on ComfyUI server
  const cancelOnServer = async () => {
    try {
      if (promptId) {
        // Remove the prompt from the pending queue
        await fetch(`${baseUrl}/queue`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ delete: [promptId] })
        }).catch(err => console.warn('Failed to delete prompt from queue:', err));
      }
      // Interrupt the currently executing generation
      await fetch(`${baseUrl}/interrupt`, {
        method: 'POST'
      }).catch(err => console.warn('Failed to interrupt ComfyUI execution:', err));
    } catch (e) {
      console.warn('Error during cancellation on ComfyUI server:', e);
    }
  };

  const abortHandler = () => {
    cancelOnServer();
  };

  if (signal) {
    if (signal.aborted) {
      cancelOnServer();
      throw new DOMException('Image generation stopped by user', 'AbortError');
    }
    signal.addEventListener('abort', abortHandler);
  }

  try {
    onProgress('Building workflow...');

    let workflow;
    if (editParams) {
      onProgress('Uploading source image...');
      const sourceUpload = await uploadImageToComfyUI(baseUrl, editParams.sourceImageBlob, `edit_src_${Date.now()}.jpg`);
      
      let maskUploadName = null;
      if (editParams.maskImageBlob && editParams.mode === 'inpaint') {
        onProgress('Uploading mask...');
        const maskUpload = await uploadImageToComfyUI(baseUrl, editParams.maskImageBlob, `edit_mask_${Date.now()}.jpg`);
        maskUploadName = maskUpload.name;
      }
      
      onProgress('Building workflow...');
      if (editParams.mode === 'edit-pro') {
        workflow = buildAnimaEditProWorkflow(
          prompt,
          negPrompt,
          settings,
          sourceUpload.name,
          editParams.denoise,
          loras
        );
      } else {
        workflow = buildAnimaEditWorkflow(
          prompt,
          negPrompt,
          settings,
          sourceUpload.name,
          maskUploadName,
          editParams.denoise,
          editParams.mode,
          loras
        );
      }
    } else {
      workflow = buildAnimaWorkflow(prompt, negPrompt, settings, loras);
    }

    // 2. Open WebSocket for real-time progress updates
    const wsUrl = baseUrl.replace(/^http/, 'ws') + `/ws?clientId=${clientId}`;
    try {
      ws = new WebSocket(wsUrl);
      ws.binaryType = "blob";
      ws.onmessage = async (event) => {
        try {
          if (event.data instanceof Blob) {
            // This is a binary frame (preview image from KSampler)
            if (onPreview) {
              const arrayBuffer = await event.data.arrayBuffer();
              const imageBlob = new Blob([arrayBuffer.slice(8)], { type: 'image/jpeg' });
              
              if (editParams && editParams.mode === 'edit-pro') {
                const img = new Image();
                img.src = URL.createObjectURL(imageBlob);
                await new Promise(r => img.onload = r);
                const cvs = document.createElement('canvas');
                cvs.width = img.width / 2;
                cvs.height = img.height;
                const ctx = cvs.getContext('2d');
                ctx.drawImage(img, img.width / 2, 0, img.width / 2, img.height, 0, 0, cvs.width, cvs.height);
                onPreview(cvs.toDataURL('image/jpeg'));
                URL.revokeObjectURL(img.src);
              } else {
                const imageUrl = URL.createObjectURL(imageBlob);
                onPreview(imageUrl);
              }
            }
            return;
          }

          const msg = JSON.parse(event.data);
          if (msg.type === 'executing') {
            const node = msg.data.node;
            if (node === '7') {
              onProgress('Running KSampler...');
            } else if (node === '8') {
              onProgress('Decoding image via VAE...');
            } else if (node === '9') {
              onProgress('Saving image...');
            } else if (node === null) {
              onProgress('Finalizing image...');
            } else {
              onProgress(`Executing node ${node}...`);
            }
          } else if (msg.type === 'progress') {
            const val = msg.data.value;
            const max = msg.data.max;
            onProgress(`Generating: Step ${val}/${max}`);
          }
        } catch (e) {
          // ignore websocket parsing errors
        }
      };
    } catch (e) {
      console.warn('Failed to establish WebSocket progress tracking, falling back to basic polling.', e);
    }

    onProgress('Queueing prompt...');

    // 3. Queue the prompt
    let queueResp;
    try {
      queueResp = await fetch(`${baseUrl}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: clientId,
          prompt: workflow
        }),
        signal
      });
    } catch (err) {
      throw new Error(`Failed to connect to ComfyUI server: ${err.message}`);
    }

    if (!queueResp.ok) {
      const errText = await queueResp.text();
      throw new Error(`ComfyUI queue error: ${queueResp.status} — ${errText}`);
    }

    const queueJson = await queueResp.json();
    promptId = queueJson.prompt_id;
    if (!promptId) {
      throw new Error('No prompt_id returned from ComfyUI');
    }

    onProgress('Waiting in ComfyUI queue...');

    // 4. Poll history until ready (max 5 mins)
    const maxWaitMs = 5 * 60 * 1000;
    const pollIntervalMs = 1000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      if (signal?.aborted) {
        throw new DOMException('Image generation stopped by user', 'AbortError');
      }

      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (signal) signal.removeEventListener('abort', onAbort);
          resolve();
        }, pollIntervalMs);

        function onAbort() {
          clearTimeout(timer);
          if (signal) signal.removeEventListener('abort', onAbort);
          reject(new DOMException('Image generation stopped by user', 'AbortError'));
        }

        if (signal) {
          signal.addEventListener('abort', onAbort);
        }
      });

      if (signal?.aborted) {
        throw new DOMException('Image generation stopped by user', 'AbortError');
      }

      const histResp = await fetch(`${baseUrl}/history/${promptId}`, { signal });
      if (!histResp.ok) continue;

      const hist = await histResp.json();
      const entry = hist[promptId];
      if (!entry) continue;

      // Check for error state
      if (entry.status?.status_str === 'error') {
        const errMsg = entry.status?.messages?.find(m => m[0] === 'error')?.[1]?.exception_message || 'Unknown ComfyUI error';
        throw new Error(`ComfyUI generation error: ${errMsg}`);
      }

      // Check outputs
      if (entry.outputs) {
        // SaveImage output node is "9"
        const saveNode = entry.outputs['9'];
        if (saveNode && saveNode.images && saveNode.images.length > 0) {
          const img = saveNode.images[0];
          const imageUrl = `${baseUrl}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder || '')}&type=${encodeURIComponent(img.type || 'output')}`;
          
          onProgress('Image ready!');
          return imageUrl;
        }
      }
    }
  } finally {
    if (ws) ws.close();
    if (signal) {
      signal.removeEventListener('abort', abortHandler);
    }
  }

  throw new Error('ComfyUI generation timed out after 5 minutes');
}

/**
 * Clear ComfyUI VRAM cache (unload models and free memory)
 */
export async function clearComfyUIMemory() {
  try {
    const settings = settingsStore.get();
    const baseUrl = (settings.comfyui_url || 'http://localhost:8188').replace(/\/$/, '');
    const resp = await fetch(`${baseUrl}/free`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unload_models: true, free_memory: true })
    });
    if (!resp.ok) {
      console.warn(`ComfyUI /free memory request failed with status: ${resp.status}`);
      return false;
    }
    console.log('ComfyUI memory successfully cleared via /free endpoint.');
    return true;
  } catch (e) {
    console.warn('Failed to clear ComfyUI memory:', e);
    return false;
  }
}

/**
 * Fetch list of all available LoRAs from ComfyUI /object_info/LoraLoader
 */
export async function getAvailableLoras() {
  try {
    const settings = settingsStore.get();
    const baseUrl = (settings.comfyui_url || 'http://localhost:8188').replace(/\/$/, '');
    const resp = await fetch(`${baseUrl}/object_info/LoraLoader`);
    if (resp.ok) {
      const data = await resp.json();
      const loraNames = data.LoraLoader?.input?.required?.lora_name?.[0];
      if (Array.isArray(loraNames)) {
        // Cache in localStorage
        localStorage.setItem('comfygen_cached_loras', JSON.stringify(loraNames));
        return loraNames;
      }
    }
  } catch (e) {
    console.warn('Failed to fetch LoRAs from ComfyUI, falling back to cache:', e);
  }
  
  // Fallback to localStorage cache
  try {
    const cached = localStorage.getItem('comfygen_cached_loras');
    if (cached) {
      return JSON.parse(cached);
    }
  } catch (e) {}

  // Fallback to default dummy list if nothing is available
  return [
    'detail_tweaker.safetensors',
    'anime_outline_v1.safetensors',
    'flat_color_style.safetensors',
    'glow_effects.safetensors',
    'eyes_enhancer.safetensors'
  ];
}

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
        "batch_size": settings.comfyui_batch_size ?? 1
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
      "class_type": "PreviewImage",
      "inputs": {
        "images": ["8", 0]
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
        "preserve_wrapper": mode === 'inpaint' ? false : true
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
          "amount": 8,
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
        "amount": 8,
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
        "grow_mask_by": 16
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
    "class_type": "PreviewImage",
    "inputs": {
      "images": ["8", 0]
    }
  };

  return workflow;
}

/**
 * Build the Anima Edit Pro workflow (Split-Screen Outpainting)
 */
function buildAnimaEditProWorkflow(prompt, negPrompt, settings, sourceFilename, denoise, loras = [], editMode = 'global', customSettings = null) {
  const seed = Math.floor(Math.random() * 2 ** 32);
  const steps = settings.comfyui_steps ?? 30;
  const cfg = settings.comfyui_cfg ?? 4.5;
  const sampler = settings.comfyui_sampler ?? 'euler';
  const scheduler = settings.comfyui_scheduler ?? 'normal';
  const unetName = settings.comfyui_unet_name ?? 'anima_baseV10.safetensors';
  const clipName = settings.comfyui_clip_name ?? 'qwen_3_06b_base.safetensors';
  const vaeName = settings.comfyui_vae_name ?? 'qwen_image_vae.safetensors';
  const llliteName = settings.comfyui_lllite_name || 'anima-lllite-inpainting-v2.safetensors';
  const llliteStrength = settings.comfyui_lllite_strength_edit_pro 
    ?? settings.comfyui_lllite_strength 
    ?? 0.85;

  const isCustom = editMode === 'custom' && customSettings;
  const resizeMethod = isCustom ? customSettings.resizeMethod : 'keep-proportion-no-rounding';
  const improvedPrompt = isCustom ? customSettings.improvedPrompt : false;
  const negPromptFix = isCustom ? customSettings.negPromptFix : false;

  const stylePrompt = "masterpiece, best quality, very aesthetic, highly detailed";
  
  let instructions;
  if (isCustom) {
    if (improvedPrompt) {
      instructions = `split screen, side-by-side comparison, two panels of the same scene, left panel: original reference image, right panel: ${prompt}, same background as left panel, same lighting, same color palette, same art style, anime illustration, seamless transition between panels`;
    } else {
      instructions = `split screen, comparison view, left: original reference image, right: ${prompt}, same character, same style, anime illustration`;
    }
  } else if (editMode === 'details') {
    // Details mode: сохранить композицию, добавить/уточнить детали
    instructions = `split screen, comparison view, left: original reference image, right: same composition with refined details - ${prompt}, anime illustration`;
  } else {
    // Global mode (по умолчанию): полностью новая правая часть
    instructions = `split screen, comparison view, left: original reference image, right: ${prompt}, same character, same style, anime illustration`;
  }
  
  const finalPrompt = `${stylePrompt}, ${instructions}`;

  let finalNegPrompt = negPrompt || "lowres, bad anatomy, worst quality, blurry, watermark";
  if (negPromptFix) {
    finalNegPrompt += ", black background, dark background, solid black, cropped edges, border artifacts, seam, dividing line, disconnected panels, mismatched lighting, mismatched background";
  }

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
      "inputs": { "text": finalNegPrompt, "clip": null }
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
        "method": resizeMethod === 'stretch' ? "stretch to aspect ratio" : "keep proportion",
        "condition": "always", "multiple_of": resizeMethod === 'keep-proportion-64' ? 64 : 0,
        "image": ["10", 0]
      }
    },
    "51": {
      "class_type": "ImagePadKJ",
      "inputs": {
        "left": 0, "right": isCustom ? customSettings.paddingWidth : 48, "top": 0, "bottom": 0,
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
        "start_percent": 0, "end_percent": 1, "preserve_wrapper": false,
        "model": currentModel, "image": ["12", 0], "mask": ["12", 2]
      }
    },
    "50": {
      "class_type": "InpaintModelConditioning",
      "inputs": {
        "noise_mask": isCustom ? customSettings.noiseMask : true,
        "positive": ["4", 0], "negative": ["5", 0],
        "vae": ["3", 0], "pixels": ["12", 0], "mask": ["12", 2]
      }
    },
    "13": {
      "class_type": "KSampler",
      "inputs": {
        "seed": seed, "steps": steps, "cfg": cfg, "sampler_name": sampler,
        "scheduler": scheduler, "denoise": (isCustom && customSettings.denoiseCap) ? Math.min(denoise, 0.92) : denoise,
        "model": ["6", 0],
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
      "class_type": "PreviewImage",
      "inputs": {
        "images": ["40", 0]
      }
    }
  });

  return workflow;
}

/**
 * Build the Wan 2.2 Image-to-Video Workflow
 */
function buildWanVideoWorkflow(prompt, negPrompt, sourceFilename, videoWidth, videoHeight, videoLength, steps = 4, cfg = 1.0, seed = null) {
  const finalSeed = seed !== null ? seed : Math.floor(Math.random() * 2 ** 32);

  const workflow = {
    "7": {
      "inputs": {
        "text": negPrompt || "",
        "clip": ["38", 0]
      },
      "class_type": "CLIPTextEncode",
      "_meta": { "title": "Negative" }
    },
    "38": {
      "inputs": {
        "clip_name": "umt5_xxl_fp8_e4m3fn_scaled.safetensors",
        "type": "wan",
        "device": "default"
      },
      "class_type": "CLIPLoader",
      "_meta": { "title": "Load CLIP" }
    },
    "39": {
      "inputs": {
        "vae_name": "wan_2.1_vae.safetensors"
      },
      "class_type": "VAELoader",
      "_meta": { "title": "Load VAE" }
    },
    "50": {
      "inputs": {
        "width": videoWidth,
        "height": videoHeight,
        "length": videoLength,
        "batch_size": 1,
        "positive": ["160", 0],
        "negative": ["7", 0],
        "vae": ["39", 0],
        "start_image": ["140", 0]
      },
      "class_type": "WanImageToVideo",
      "_meta": { "title": "WanImageToVideo" }
    },
    "54": {
      "inputs": {
        "shift": 8,
        "model": ["109", 0]
      },
      "class_type": "ModelSamplingSD3",
      "_meta": { "title": "ModelSamplingSD3" }
    },
    "55": {
      "inputs": {
        "shift": 8,
        "model": ["110", 0]
      },
      "class_type": "ModelSamplingSD3",
      "_meta": { "title": "ModelSamplingSD3" }
    },
    "57": {
      "inputs": {
        "add_noise": "enable",
        "noise_seed": ["82", 0],
        "steps": steps,
        "cfg": ["147", 0],
        "sampler_name": "euler",
        "scheduler": "sgm_uniform",
        "start_at_step": 0,
        "end_at_step": ["129", 0],
        "return_with_leftover_noise": "enable",
        "model": ["54", 0],
        "positive": ["50", 0],
        "negative": ["50", 1],
        "latent_image": ["50", 2]
      },
      "class_type": "KSamplerAdvanced",
      "_meta": { "title": "KSampler (HIGH)" }
    },
    "58": {
      "inputs": {
        "add_noise": "disable",
        "noise_seed": ["82", 0],
        "steps": steps,
        "cfg": ["147", 0],
        "sampler_name": "euler",
        "scheduler": "sgm_uniform",
        "start_at_step": ["129", 0],
        "end_at_step": 10000,
        "return_with_leftover_noise": "disable",
        "model": ["228", 0],
        "positive": ["50", 0],
        "negative": ["50", 1],
        "latent_image": ["224", 0]
      },
      "class_type": "KSamplerAdvanced",
      "_meta": { "title": "KSampler (LOW)" }
    },
    "63": {
      "inputs": {
        "frame_rate": 16,
        "loop_count": 0,
        "filename_prefix": `video/${new Date().toISOString().split('T')[0]}/${Date.now()}`,
        "format": "video/h265-mp4",
        "pix_fmt": "yuv420p10le",
        "crf": 22,
        "save_metadata": true,
        "pingpong": false,
        "save_output": true,
        "images": ["74", 0]
      },
      "class_type": "VHS_VideoCombine",
      "_meta": { "title": "Video Combine 🎥🅥🅗🅢" }
    },
    "73": {
      "inputs": {
        "anything": ["154", 0]
      },
      "class_type": "easy cleanGpuUsed",
      "_meta": { "title": "Clean VRAM Used" }
    },
    "74": {
      "inputs": {
        "upscale_method": "lanczos",
        "scale_by": 2.0,
        "image": ["73", 0]
      },
      "class_type": "ImageScaleBy",
      "_meta": { "title": "Upscale Image By" }
    },
    "82": {
      "inputs": {
        "seed": finalSeed
      },
      "class_type": "Seed (rgthree)",
      "_meta": { "title": "Seed (rgthree)" }
    },
    "109": {
      "inputs": {
        "PowerLoraLoaderHeaderWidget": { "type": "PowerLoraLoaderHeaderWidget" },
        "➕ Add Lora": "",
        "model": ["229", 0]
      },
      "class_type": "Power Lora Loader (rgthree)",
      "_meta": { "title": "HIGH LORA LOADER" }
    },
    "110": {
      "inputs": {
        "PowerLoraLoaderHeaderWidget": { "type": "PowerLoraLoaderHeaderWidget" },
        "➕ Add Lora": "",
        "model": ["228", 0]
      },
      "class_type": "Power Lora Loader (rgthree)",
      "_meta": { "title": "LOW LORA LOADER" }
    },
    "129": {
      "inputs": {
        "a": steps,
        "b": 2,
        "operation": "divide"
      },
      "class_type": "easy mathInt",
      "_meta": { "title": "Math Int" }
    },
    "140": {
      "inputs": {
        "upscale_method": "lanczos",
        "width": videoWidth,
        "height": videoHeight,
        "crop": "disabled",
        "image": ["172", 0]
      },
      "class_type": "ImageScale",
      "_meta": { "title": "Upscale Image" }
    },
    "147": {
      "inputs": {
        "value": cfg
      },
      "class_type": "PrimitiveFloat",
      "_meta": { "title": "CFG" }
    },
    "154": {
      "inputs": {
        "samples": ["58", 0],
        "vae": ["39", 0]
      },
      "class_type": "VAEDecode",
      "_meta": { "title": "VAE Decode" }
    },
    "160": {
      "inputs": {
        "text": prompt,
        "clip": ["38", 0]
      },
      "class_type": "CLIPTextEncode",
      "_meta": { "title": "CLIP Text Encode (Prompt)" }
    },
    "167": {
      "inputs": {
        "from_direction": "end",
        "count": 1,
        "image": ["74", 0]
      },
      "class_type": "Pick From Batch (mtb)",
      "_meta": { "title": "Pick From Batch (mtb)" }
    },
    "168": {
      "inputs": {
        "filename_prefix": "video_frame",
        "images": ["167", 0]
      },
      "class_type": "SaveImage",
      "_meta": { "title": "Save Image" }
    },
    "169": {
      "inputs": {
        "images": ["167", 0]
      },
      "class_type": "PreviewImage",
      "_meta": { "title": "Last Frame Preview" }
    },
    "172": {
      "inputs": {
        "image": sourceFilename
      },
      "class_type": "LoadImage",
      "_meta": { "title": "Load Image" }
    },
    "224": {
      "inputs": {
        "value": ["57", 0],
        "model": ["229", 0]
      },
      "class_type": "UnloadModel",
      "_meta": { "title": "UnloadModel" }
    },
    "228": {
      "inputs": {
        "unet_name": "DasiwaWAN22I2V14BLightspeed_snatchkissLowV11.safetensors",
        "weight_dtype": "default"
      },
      "class_type": "UNETLoader",
      "_meta": { "title": "Load Diffusion Model" }
    },
    "229": {
      "inputs": {
        "unet_name": "DasiwaWAN22I2V14BLightspeed_snatchkissHighV11.safetensors",
        "weight_dtype": "default"
      },
      "class_type": "UNETLoader",
      "_meta": { "title": "Load Diffusion Model" }
    }
  };

  return workflow;
}

/**
 * Generate a video using Wan 2.2 Image-to-Video Workflow
 */
export async function generateVideoComfyUI(prompt, negPrompt, sourceImageBlob, videoParams, onProgress = () => {}, signal = null) {
  const settings = settingsStore.get();
  const baseUrl = (settings.comfyui_url || 'http://localhost:8188').replace(/\/$/, '');
  const clientId = `comfygen_vid_${Date.now()}`;
  let promptId = null;
  let ws = null;

  const cancelOnServer = async () => {
    try {
      if (promptId) {
        await fetch(`${baseUrl}/queue`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ delete: [promptId] })
        }).catch(() => {});
      }
      await fetch(`${baseUrl}/interrupt`, { method: 'POST' }).catch(() => {});
    } catch (e) {}
  };

  if (signal) {
    if (signal.aborted) {
      cancelOnServer();
      throw new DOMException('Video generation stopped by user', 'AbortError');
    }
    signal.addEventListener('abort', cancelOnServer);
  }

  try {
    onProgress('Uploading initial image...');
    const sourceUpload = await uploadImageToComfyUI(baseUrl, sourceImageBlob, `video_src_${Date.now()}.png`);

    onProgress('Building Wan 2.2 video workflow...');
    const workflow = buildWanVideoWorkflow(
      prompt,
      negPrompt,
      sourceUpload.name,
      videoParams.width,
      videoParams.height,
      videoParams.length,
      videoParams.steps ?? 4,
      videoParams.cfg ?? 1.0,
      videoParams.seed ?? null
    );

    // Track execution via WebSocket
    let currentNode = null;
    const wsUrl = baseUrl.replace(/^http/, 'ws') + `/ws?clientId=${clientId}`;
    try {
      ws = new WebSocket(wsUrl);
      ws.onmessage = (event) => {
        try {
          if (typeof event.data === 'string') {
            const msg = JSON.parse(event.data);
            if (msg.type === 'executing') {
              const node = msg.data.node;
              currentNode = node;
              if (node === '57') onProgress('Running KSampler (High Pass)...', 10);
              else if (node === '58') onProgress('Running KSampler (Low Pass)...', 50);
              else if (node === '154') onProgress('Decoding video frames via VAE...', 92);
              else if (node === '63') onProgress('Combining video frames to MP4...', 97);
              else if (node === null) onProgress('Finalizing video...', 100);
              else onProgress(`Executing video node ${node}...`, 20);
            } else if (msg.type === 'progress') {
              const val = msg.data.value;
              const max = msg.data.max;
              let overallPct = 10;
              if (currentNode === '57') {
                overallPct = 10 + Math.round((val / max) * 40); // 10% to 50%
              } else if (currentNode === '58') {
                overallPct = 50 + Math.round((val / max) * 40); // 50% to 90%
              } else {
                overallPct = Math.round((val / max) * 100);
              }
              onProgress(`Generating Video: Step ${val}/${max}`, overallPct);
            }
          }
        } catch (e) {}
      };
    } catch (e) {}

    onProgress('Queueing video prompt...');
    const queueResp = await fetch(`${baseUrl}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, prompt: workflow }),
      signal
    });

    if (!queueResp.ok) {
      const errText = await queueResp.text();
      throw new Error(`ComfyUI queue error: ${queueResp.status} — ${errText}`);
    }

    const queueJson = await queueResp.json();
    promptId = queueJson.prompt_id;
    if (!promptId) throw new Error('No prompt_id returned for video generation');

    onProgress('Waiting in ComfyUI queue...');

    // Poll history for video output
    const maxWaitMs = 15 * 60 * 1000; // 15 mins for video
    const pollIntervalMs = 1500;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      if (signal?.aborted) {
        throw new DOMException('Video generation stopped by user', 'AbortError');
      }

      await new Promise(r => setTimeout(r, pollIntervalMs));

      const histResp = await fetch(`${baseUrl}/history/${promptId}`, { signal });
      if (!histResp.ok) continue;

      const histData = await histResp.json();
      const promptObj = histData[promptId];

      if (promptObj) {
        if (promptObj.status && promptObj.status.status_str === 'error') {
          const details = promptObj.status.messages?.[0] || 'Unknown server error';
          throw new Error(`ComfyUI video execution failed: ${details}`);
        }

        const outputs = promptObj.outputs;
        if (outputs) {
          // Check VHS Combine node output (node 63)
          const vhsNode = outputs["63"];
          if (vhsNode && vhsNode.gifs && vhsNode.gifs.length > 0) {
            const vid = vhsNode.gifs[0];
            const videoUrl = `${baseUrl}/view?filename=${encodeURIComponent(vid.filename)}&subfolder=${encodeURIComponent(vid.subfolder || '')}&type=${encodeURIComponent(vid.type || 'output')}`;
            onProgress('Video ready!');
            return { videoUrl, filename: vid.filename };
          }
          
          // Fallback to SaveImage node (node 168)
          const saveNode = outputs["168"];
          if (saveNode && saveNode.images && saveNode.images.length > 0) {
            const img = saveNode.images[0];
            const imageUrl = `${baseUrl}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder || '')}&type=${encodeURIComponent(img.type || 'output')}`;
            onProgress('Last frame ready!');
            return { imageUrl, filename: img.filename };
          }
        }
      }
    }

    throw new Error('ComfyUI video generation timed out');
  } finally {
    if (ws) ws.close();
    if (signal) signal.removeEventListener('abort', cancelOnServer);
  }
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
  const negPrompt = settings.comfyui_negative_prompt !== undefined ? settings.comfyui_negative_prompt : 'lowres, bad anatomy, worst quality, blurry, watermark';
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
    let origW = 0;
    let origH = 0;
    if (editParams && editParams.sourceImageBlob) {
      try {
        const imgBitmap = await createImageBitmap(editParams.sourceImageBlob);
        origW = imgBitmap.width;
        origH = imgBitmap.height;
        imgBitmap.close();
      } catch (e) {
        console.warn("Failed to get image dimensions via ImageBitmap", e);
      }
    }
    
    let W_raw = 0;
    let W_resized = 0;
    if (origW > 0 && origH > 0) {
      const scale = Math.min(1024 / origW, 1024 / origH);
      W_raw = Math.floor(origW * scale);
      W_resized = W_raw - (W_raw % 64);
    }

    onProgress('Building workflow...');

    let workflow;
    if (editParams) {
      onProgress('Uploading source image...');
      const sourceUpload = await uploadImageToComfyUI(baseUrl, editParams.sourceImageBlob, `edit_src_${Date.now()}.jpg`);
      
      let maskUploadName = null;
      if (editParams.maskImageBlob && editParams.mode === 'inpaint') {
        onProgress('Uploading mask...');
        const maskUpload = await uploadImageToComfyUI(baseUrl, editParams.maskImageBlob, `edit_mask_${Date.now()}.png`);
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
          loras,
          editParams.editProMode || 'global',
          editParams.customSettings
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
                
                const isCustom = editParams.editProMode === 'custom';
                const customSettings = isCustom ? editParams.customSettings : null;
                const resizeMethod = customSettings ? customSettings.resizeMethod : 'keep-proportion-no-rounding';
                const paddingWidth = customSettings ? customSettings.paddingWidth : 48;
                
                let cropStart = img.width / 2;
                let cropWidth = img.width / 2;
                
                if (resizeMethod === 'stretch') {
                  const W_resized_stretch = 1024;
                  const previewScale = img.width / (2 * W_resized_stretch + paddingWidth);
                  cropStart = (W_resized_stretch + paddingWidth) * previewScale;
                  cropWidth = W_resized_stretch * previewScale;
                } else if (resizeMethod === 'keep-proportion-64') {
                  if (W_resized > 0) {
                    const previewScale = img.width / (2 * W_resized + paddingWidth);
                    cropStart = (W_resized + paddingWidth) * previewScale;
                    cropWidth = W_resized * previewScale;
                  }
                } else {
                  if (W_raw > 0) {
                    const previewScale = img.width / (2 * W_raw + paddingWidth);
                    cropStart = (W_raw + paddingWidth) * previewScale;
                    cropWidth = W_raw * previewScale;
                  }
                }
                
                cvs.width = cropWidth;
                cvs.height = img.height;
                const ctx = cvs.getContext('2d');
                ctx.drawImage(img, cropStart, 0, cropWidth, img.height, 0, 0, cvs.width, cvs.height);
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
          const urls = saveNode.images.map(img => 
            `${baseUrl}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder || '')}&type=${encodeURIComponent(img.type || 'output')}`
          );
          
          onProgress('Image ready!');
          return urls;
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

export async function getLoraActivationTags(loraName) {
  let tags = [];
  try {
    const settings = settingsStore.get();
    const baseUrl = (settings.comfyui_url || 'http://localhost:8188').replace(/\/$/, '');
    const resp = await fetch(`${baseUrl}/view_metadata/loras?filename=${encodeURIComponent(loraName)}`);
    if (resp.ok) {
      const metadata = await resp.json();
      tags = extractTagsFromMetadata(metadata);
    }
  } catch (e) {
    console.warn(`Failed to fetch LoRA metadata for ${loraName}:`, e);
  }

  // If we couldn't extract any tags from the metadata or the fetch failed/404ed,
  // fall back to a cleaned version of the filename itself.
  if (!tags || tags.length === 0) {
    const fallback = cleanFilenameToTag(loraName);
    if (fallback) {
      tags = [fallback];
    }
  }

  return tags;
}

function cleanFilenameToTag(filename) {
  if (!filename || typeof filename !== 'string') return '';
  
  // Extract just the filename if it is a directory path
  let baseName = filename.split(/[\\/]/).pop();
  
  // Strip standard extensions
  baseName = baseName.replace(/\.safetensors$/i, '')
                     .replace(/\.ckpt$/i, '')
                     .replace(/\.pt$/i, '');
                     
  // Replace underscores and dashes with spaces
  let clean = baseName.replace(/[-_]/g, ' ')
                      .trim()
                      .toLowerCase();
                      
  // Strip common generic patterns/suffixes and keywords
  clean = clean.replace(/\b(v\d+(\.\d+)?|alpha\d+(\.\d+)?|rank\d+|noxattn|last|step\d+|epoch\d+|\d+steps|initial\s+release|by\s+\w+|illustrious|xl|pony|flux|sdxl|sd15|sd21|klein|zit|rmx|concept)\b/g, '')
               .replace(/[\[\]\(\)\{\}]/g, ' ') // Remove brackets
               .replace(/\s+/g, ' ')
               .trim();
               
  // Filter out completely generic single words
  const genericWords = new Set(['lora', 'model', 'add', 'detail', 'style', 'enhancer', 'detailer']);
  if (clean.length <= 2 || genericWords.has(clean)) {
    return '';
  }
  
  return clean;
}

function extractTagsFromMetadata(metadata) {
  if (!metadata) return [];
  
  const tags = new Set();
  
  // ComfyUI may wrap the safetensors metadata in a __metadata__ field or return it directly
  let target = metadata;
  if (metadata.__metadata__) {
    target = metadata.__metadata__;
  }
  
  const tryParseJSON = (str) => {
    try {
      return JSON.parse(str);
    } catch (e) {
      return null;
    }
  };

  // 1. Kohya ss_tag_frequency
  if (target.ss_tag_frequency) {
    const freqData = typeof target.ss_tag_frequency === 'string' 
      ? tryParseJSON(target.ss_tag_frequency) 
      : target.ss_tag_frequency;
      
    if (freqData && typeof freqData === 'object') {
      // Determine if freqData is a nested concept dictionary or a flat tag frequency dictionary
      const isNested = Object.values(freqData).some(v => v && typeof v === 'object');
      const conceptDicts = isNested ? Object.values(freqData) : [freqData];
      
      for (const innerTags of conceptDicts) {
        if (innerTags && typeof innerTags === 'object') {
          let maxFreq = 0;
          const entries = Object.entries(innerTags);
          for (const [tag, freq] of entries) {
            if (typeof freq === 'number' && freq > maxFreq) {
              maxFreq = freq;
            }
          }
          
          // Select tags that occur frequently (typically the trigger word itself matches the max dataset count)
          for (const [tag, freq] of entries) {
            if (typeof freq === 'number' && freq >= maxFreq * 0.85) {
              const cleanTag = tag.trim().toLowerCase();
              if (cleanTag && 
                  cleanTag !== 'masterpiece' && 
                  cleanTag !== 'best quality' && 
                  cleanTag !== 'extremely detailed' &&
                  cleanTag.split(/\s+/).length <= 3) { // Ignore long captions/sentences
                tags.add(cleanTag);
              }
            }
          }
        }
      }
    }
  }
  
  // 2. ss_activation_tags
  if (target.ss_activation_tags) {
    const actTags = String(target.ss_activation_tags).split(',');
    actTags.forEach(t => {
      const clean = t.trim().toLowerCase();
      if (clean && clean.split(/\s+/).length <= 3) tags.add(clean);
    });
  }
  
  // 3. trained_words, trainedWords, ss_trained_words
  const trainedWordsKeys = ['trained_words', 'trainedWords', 'ss_trained_words'];
  trainedWordsKeys.forEach(key => {
    if (target[key]) {
      let val = target[key];
      if (typeof val === 'string') {
        const parsed = tryParseJSON(val);
        if (Array.isArray(parsed)) {
          val = parsed;
        } else {
          val = val.split(/,+/);
        }
      }
      if (Array.isArray(val)) {
        val.forEach(t => {
          const clean = String(t).trim().toLowerCase();
          if (clean && clean.split(/\s+/).length <= 3) tags.add(clean);
        });
      }
    }
  });

  // 4. Fallback to ss_output_name or name field if still empty
  if (tags.size === 0) {
    const cleanOutputName = (nameStr) => {
      if (!nameStr || typeof nameStr !== 'string') return '';
      let clean = nameStr.replace(/\.[a-zA-Z0-9]+$/, '') // remove extension
                         .replace(/[-_]/g, ' ') // replace dashes/underscores with spaces
                         .trim()
                         .toLowerCase();
                         
      // Remove common non-tag words or suffix junk
      clean = clean.replace(/\b(v\d+|alpha\d+|rank\d+|noxattn|last|step\d+|epoch\d+|\d+steps|initial\s+release|lora|model|concept)\b/g, '')
                   .replace(/\s+/g, ' ')
                   .trim();
      return clean;
    };

    const candidates = [target.ss_output_name, target.name];
    for (const cand of candidates) {
      if (cand) {
        const cleaned = cleanOutputName(cand);
        if (cleaned && cleaned.length > 2 && cleaned !== 'lora' && cleaned !== 'model' && cleaned.split(/\s+/).length <= 3) {
          tags.add(cleaned);
          break; // Use the first valid candidate
        }
      }
    }
  }

  return Array.from(tags);
}


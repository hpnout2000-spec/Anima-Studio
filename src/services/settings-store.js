// Settings Store to manage user configurations (ComfyUI & LLM endpoints)

const DEFAULTS = {
  comfyui_url: 'http://localhost:8188',
  comfyui_steps: 30,
  comfyui_cfg: 4.5,
  comfyui_width: 832,
  comfyui_height: 1216,
  comfyui_negative_prompt: 'lowres, bad anatomy, worst quality, blurry, watermark',
  comfyui_sampler: 'euler',
  comfyui_scheduler: 'normal',
  comfyui_unet_name: 'anima_baseV10.safetensors',
  comfyui_unet_models: ['anima_baseV10.safetensors'],
  comfyui_clip_name: 'qwen_3_06b_base.safetensors',
  comfyui_vae_name: 'qwen_image_vae.safetensors',
  comfyui_lllite_name: 'anima-lllite-inpainting-v2.safetensors',
  comfyui_lllite_name_img2img: '',
  comfyui_lllite_strength: 1.0,
  comfyui_lllite_strength_edit_pro: 0.85,
  comfyui_free_memory_interval: 3,
  comfyui_batch_size: 1,
  comfyui_aspect_ratio: '1:1 (Square)',
  comfyui_megapixels: 1.0,
  comfyui_multiple: 16,
  ai_url: 'http://localhost:5001',
  ai_instructions: 'You are Anima Studio AI Assistant, an expert art director helping the user generate pictures using the Anima diffusion model. Help the user create amazing stylized/non-realistic image generation prompts. Avoid realistic styling/photorealism. Guide the user to use natural language descriptions for scenes, poses, and actions instead of lists of raw tags. Help them structure prompts in the Anima model\'s preferred tag order: [quality/meta/year/safety tags] [1girl/1boy/1other etc] [character] [series] [artist] [general tags/natural description]. Keep all suggestions suited for stylized anime art/drawings.',
  gelbooru_api_key: '',
  gelbooru_user_id: '',
  comfyui_positive_prompt_prefix: 'Masterpiece, good quality',
  model_settings: {}
};

let settings = { ...DEFAULTS };

export const settingsStore = {
  async load() {
    try {
      const resp = await fetch('/api/load-settings');
      if (resp.ok) {
        const data = await resp.json();
        settings = { ...DEFAULTS, ...data };
        console.log('Settings successfully loaded from server:', settings);
        // Sync with localStorage
        try {
          localStorage.setItem('comfygen_settings', JSON.stringify(settings));
        } catch (e) {}
        return settings;
      }
    } catch (e) {
      console.log('Server settings storage not available, falling back to localStorage');
    }

    try {
      const saved = localStorage.getItem('comfygen_settings');
      if (saved) {
        settings = { ...DEFAULTS, ...JSON.parse(saved) };
        console.log('Settings successfully loaded from localStorage:', settings);
      } else {
        console.log('No settings found in localStorage. Using defaults:', settings);
      }
    } catch (e) {
      console.warn('Failed to load settings from localStorage:', e);
    }
    return settings;
  },

  get() {
    return settings;
  },

  save(newSettings) {
    settings = { ...settings, ...newSettings };
    console.log('Saving settings to localStorage:', settings);
    try {
      localStorage.setItem('comfygen_settings', JSON.stringify(settings));
    } catch (e) {
      console.error('Failed to save settings to localStorage:', e);
    }
    // Asynchronously save to server in the background
    fetch('/api/save-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings)
    }).catch(e => console.warn('Failed to save settings to server:', e));

    return settings;
  }
};

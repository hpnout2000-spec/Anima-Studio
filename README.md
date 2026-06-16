# ComfyGen - Anima Image Generator

ComfyGen is a web-based companion client designed to interface with ComfyUI for generating and editing anime-style illustrations using the Anima v1 base model.

## Features

- Simple and Advanced prompt construction modes.
- Composed tags library with active chips management.
- Built-in AI prompt helper chat using local LLM APIs.
- Fullscreen image lightbox with zoom and metadata tracking.
- Local Album storage using IndexedDB to save history.
- Image Editor supporting local inpainting and global image-to-image (img2img) operations.
- Specialized low-rank ControlNet guidance (LLLite) for high-fidelity inpainting.

## Installation and Setup

### 1. Client Installation
Ensure you have Node.js installed on your system.

```bash
# Clone or download this project
cd ComfyGen

# Install client dependencies
npm install

# Start the Vite development server
npm run dev
```
Open `http://localhost:5173` in your browser.

### 2. ComfyUI Server Setup
You need a running instance of ComfyUI. Open the Settings panel in the client (via Menu -> Settings) and ensure the "ComfyUI Server URL" matches your running instance (e.g., `http://localhost:8188`).

### 3. Model Requirements and Download Links
Because the Anima model uses a Diffusion Transformer (DiT) architecture with a separate Qwen text encoder and VAE, you must download the following components and place them into your local ComfyUI folder:

#### Anima v1 Base Model (Diffusion weights)
- Filename: `anima_baseV10.safetensors` (or `anima-base-v1.0.safetensors`)
- Path: `ComfyUI/models/diffusion_models/`
- Download Link: [Hugging Face - circlestone-labs/Anima/anima-base-v1.0.safetensors](https://huggingface.co/circlestone-labs/Anima/resolve/main/anima-base-v1.0.safetensors)

#### Qwen Text Encoder (Multimodal Text Encoder)
- Filename: `qwen_3_06b_base.safetensors`
- Path: `ComfyUI/models/text_encoders/`
- Download Link: [Hugging Face - circlestone-labs/Anima/qwen_3_06b_base.safetensors](https://huggingface.co/circlestone-labs/Anima/resolve/main/qwen_3_06b_base.safetensors)

#### Qwen VAE (Variational Autoencoder)
- Filename: `qwen_image_vae.safetensors`
- Path: `ComfyUI/models/vae/`
- Download Link: [Hugging Face - circlestone-labs/Anima/qwen_image_vae.safetensors](https://huggingface.co/circlestone-labs/Anima/resolve/main/qwen_image_vae.safetensors)

### 4. Custom Nodes and LLLite Weights (For Inpainting and Image Editing)
To use the specialized Image Editor, you must install the LLLite custom nodes and download the corresponding model weights:

#### ComfyUI-Anima-LLLite Extension
- Repository Link: [GitHub - kohya-ss/ComfyUI-Anima-LLLite](https://github.com/kohya-ss/ComfyUI-Anima-LLLite)
- Installation: Clone this repository into your ComfyUI custom nodes folder:
  ```bash
  cd ComfyUI/custom_nodes/
  git clone https://github.com/kohya-ss/ComfyUI-Anima-LLLite.git
  ```
  Or search for `ComfyUI-Anima-LLLite` in the ComfyUI Manager and install it.

#### LLLite Inpainting Model Weights
- Filename: `anima-lllite-inpainting-v2.safetensors`
- Path: `ComfyUI/models/controlnet/`
- Download Link: [Hugging Face - kohya-ss/Anima-LLLite/anima-lllite-inpainting-v2.safetensors](https://huggingface.co/kohya-ss/Anima-LLLite/resolve/main/anima-lllite-inpainting-v2.safetensors)

After downloading the file, verify that the LLLite weights filename matches the "LLLite Model Name" in your ComfyGen settings panel.

#### Edit Pro (Split-Screen) Required Nodes
To use the **Edit Pro** mode, the following custom node packs must be installed (available via ComfyUI Manager):
- **ComfyUI_essentials** (for `ImageResize+` node)
- **ComfyUI-KJNodes** (for `ImagePadKJ` node)
- **AILab-Nodes** (for `AILab_ICLoRAConcat` node)
- **ComfyUI-JPS-Nodes** (for `Crop Image TargetSize (JPS)` node)

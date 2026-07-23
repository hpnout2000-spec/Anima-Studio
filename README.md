# Anima Studio — Anima & Wan 2.2 Companion

**Anima Studio** is a web-based companion client designed to interface with ComfyUI for generating anime-style illustrations (using **Anima v1**) and high-quality AI videos (using **Wan 2.2**).

> [!NOTE]
> **Disclaimer:** *Anima Studio is an open-source community Web UI companion for ComfyUI. It is independent and not officially affiliated with or endorsed by Circlestone Labs.*

---

## 🌟 Recommended Models (Civitai & HuggingFace)

For optimal performance and stunning visual results with Anima Studio, we strongly recommend using:

- 🎬 **Wan 2.2 (img2vid Video Generation)**: Excellent motion quality, high temporal consistency, and responsive camera control. Highly recommended on Civitai!
- 🎨 **Anima v1 Base Model (txt2img)**: A state-of-the-art anime Diffusion Transformer (DiT) base model by Circlestone Labs.

---

## ✨ Features

### 🎬 Video Generation (Wan 2.2 img2vid)
- **Top Engine Switcher**: Easily toggle between `txt2img (Anima)` and `img2vid (Wan 2.2)` modes.
- **Structured Video Prompts**: 3 dedicated input fields for **Setting/Environment**, **Action/Subject Motion**, and **Camera Movement** that automatically merge upon generation.
- **Dynamic Resolution Scaling**: Specify target resolution in **Megapixels (MP)**; Anima Studio automatically computes optimal dimensions preserving the initial image's aspect ratio (aligned to 16px multiples).
- **Flexible Video Controls**: Configurable duration (seconds), KSampler steps, and CFG scale (with automatic negative prompt field when CFG > 1.0).
- **Video Continuation ("Generate More")**: Continue any generated or saved video! Extracts the exact last frame of a video into the initial image slot so you can generate seamless continuation clips.
- **Full Video Lineage Tree**: Visual node history tree mapping source images to generated video clips, tagged with `Video Gen: <prompt>`.

### 🎨 Image Generation & Editing (Anima v1)
- Simple and Advanced prompt construction modes with active tag chips.
- Built-in AI prompt helper chat using local LLM APIs.
- Fullscreen image & video lightbox with zoom and metadata tracking.
- Local Album storage using IndexedDB to save history and custom folder downloads.
- Image Editor supporting local inpainting and global image-to-image (img2img) operations.
- Specialized low-rank ControlNet guidance (LLLite) for high-fidelity inpainting.

---

## 🛠️ Installation and Setup

### 1. Client Installation
Ensure you have Node.js installed on your system.

```bash
# Clone or download this project
cd Anima-Studio

# Install client dependencies
npm install

# Start the Vite development server
npm run dev
```
Open `http://localhost:5173` in your browser.

### 2. ComfyUI Server Setup
You need a running instance of ComfyUI. Open the Settings panel in the client (via Menu -> Settings) and ensure the "ComfyUI Server URL" matches your running instance (e.g., `http://localhost:8188`).

### 3. Model Requirements and Download Links

#### 🎨 Anima v1 Base Model (Diffusion Transformer)
- **Diffusion weights**: `anima_baseV10.safetensors` → `ComfyUI/models/diffusion_models/` ([Download HuggingFace](https://huggingface.co/circlestone-labs/Anima/resolve/main/anima-base-v1.0.safetensors))
- **Text Encoder**: `qwen_3_06b_base.safetensors` → `ComfyUI/models/text_encoders/` ([Download HuggingFace](https://huggingface.co/circlestone-labs/Anima/resolve/main/qwen_3_06b_base.safetensors))
- **VAE**: `qwen_image_vae.safetensors` → `ComfyUI/models/vae/` ([Download HuggingFace](https://huggingface.co/circlestone-labs/Anima/resolve/main/qwen_image_vae.safetensors))

#### 🎬 Wan 2.2 Model Setup (img2vid)
- Download the **Wan 2.2 (Wan2.1 / Wan 2.2)** diffusion checkpoints and VAE from Civitai or HuggingFace into your ComfyUI models folder.
- Ensure `wan_2.1_vae.safetensors` (or Wan VAE) is in `ComfyUI/models/vae/`.

---

## 📦 Custom Nodes & Prerequisites

### For Wan 2.2 Video Generation:
Ensure standard ComfyUI video nodes or Wan 2.2 support nodes are loaded (e.g., `WanVideoSampler`, `KSampler`, `VHS_VideoCombine` / `SaveAnimatedWEBP`).

### For Anima LLLite Inpainting:
- **ComfyUI-Anima-LLLite**: Clone into `ComfyUI/custom_nodes/` from [GitHub - kohya-ss/ComfyUI-Anima-LLLite](https://github.com/kohya-ss/ComfyUI-Anima-LLLite).
- **LLLite Weights**: `anima-lllite-inpainting-v2.safetensors` in `ComfyUI/models/controlnet/`.

### For Edit Pro (Split-Screen):
- **ComfyUI_essentials**
- **ComfyUI-KJNodes**
- **AILab-Nodes**
- **ComfyUI-JPS-Nodes**

---

## ⚖️ Legal & Privacy Notice

- **Open Source & License:** Anima Studio is released under the open-source **MIT License**. The software is provided "AS IS", without warranty of any kind.
- **Client-Side Privacy:** Anima Studio processes all user data, prompt inputs, and generated media entirely on the user's local web browser and local ComfyUI instance (`http://localhost:8188`). No image data, video files, or user metadata are uploaded to external servers.
- **Third-Party Trademarks:** All model names, trademarks, and logos (e.g., Anima, Wan 2.2, ComfyUI, Civitai, HuggingFace) belong to their respective owners. Anima Studio is an independent community project and is not affiliated with or endorsed by Circlestone Labs or any third party.


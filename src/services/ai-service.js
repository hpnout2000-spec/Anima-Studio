import { settingsStore } from './settings-store.js';
import { tagsDatabase } from '../data/tags.js';

export function stripThinking(text) {
  if (!text) return '';
  let clean = text;
  
  // 1. Remove all closed thinking blocks of various formats
  const closedRegex = /(?:<\|channel>thought|<\|?think\|?>|<thought>|<reasoning>)[\s\S]*?(?:<channel\|>|<\|?\/think\|?>|<\/thought>|<\/reasoning>)/gi;
  clean = clean.replace(closedRegex, '');
  
  // 2. Remove any unclosed thinking block from the start of the opening tag onwards
  const openTags = ['<think>', '<|think|>', '<thought>', '<reasoning>', '<|channel>thought'];
  for (const tag of openTags) {
    const idx = clean.toLowerCase().indexOf(tag);
    if (idx !== -1) {
      clean = clean.substring(0, idx);
    }
  }
  
  return clean.trim();
}

/**
 * Parses XML suggestions out of response text.
 * Trims out the tags from the visible text and compiles the action list.
 * @param {string} text - Raw model output
 * @returns {object} - { cleanText, suggestions: [...] }
 */
function getAttributeValue(attrStr, attrName) {
  if (!attrStr) return '';
  const regex = new RegExp(`${attrName}\\s*=\\s*["'“»”’‘«„]?([^"'“»”’‘«„>]+)["'“»”’‘«„]?`, 'i');
  const match = attrStr.match(regex);
  return match ? match[1].trim() : '';
}

export function parseSuggestions(text) {
  const suggestions = [];
  if (!text) return { cleanText: '', suggestions };

  let cleanText = stripThinking(text);

  // Match suggest_add and suggestion tags
  // Group 1: tag name (suggest_add/suggestion)
  // Group 2: attributes string (optional)
  // Group 3: inner content (optional)
  const addRegex = /<(suggest_add|suggestion)(?:\s+([^>]*?))?(?:\/>|>([\s\S]*?)<\/\1>)/gi;
  let match;
  while ((match = addRegex.exec(text)) !== null) {
    const tagName = match[1];
    const attrStr = match[2] || '';
    const innerContent = match[3] ? match[3].trim() : '';

    let tag = getAttributeValue(attrStr, 'tag');
    if (!tag && innerContent) {
      tag = innerContent;
    }

    const category = getAttributeValue(attrStr, 'category') || 'general';
    const description = getAttributeValue(attrStr, 'description');

    if (tag) {
      suggestions.push({
        action: 'add',
        tag,
        category,
        description
      });
    }
  }

  // Match suggest_remove and suggestion_remove tags
  const removeRegex = /<(suggest_remove|suggestion_remove)(?:\s+([^>]*?))?(?:\/>|>([\s\S]*?)<\/\1>)/gi;
  while ((match = removeRegex.exec(text)) !== null) {
    const tagName = match[1];
    const attrStr = match[2] || '';
    const innerContent = match[3] ? match[3].trim() : '';

    let tag = getAttributeValue(attrStr, 'tag');
    if (!tag && innerContent) {
      tag = innerContent;
    }

    if (tag) {
      suggestions.push({
        action: 'remove',
        tag
      });
    }
  }

  // Strip all XML suggestions (including their content) from the text so they don't render inside the user bubble
  cleanText = cleanText
    .replace(/<(suggest_add|suggestion)(?:\s+[^>]*?)?(?:\/>|>[\s\S]*?<\/\1>)/gi, '')
    .replace(/<(suggest_remove|suggestion_remove)(?:\s+[^>]*?)?(?:\/>|>[\s\S]*?<\/\1>)/gi, '')
    .trim();

  // Strip any partial tag (like <sug...) that is currently streaming at the end of the text
  const partialIdx = cleanText.toLowerCase().indexOf('<sug');
  if (partialIdx !== -1) {
    cleanText = cleanText.substring(0, partialIdx).trim();
  }

  // Deduplicate suggestions by tag (case-insensitive) and action, preserving description/category if present
  const uniqueSuggestions = [];
  const seen = new Map(); // key: `${action}:${tag.toLowerCase()}`
  for (const sug of suggestions) {
    const key = `${sug.action}:${sug.tag.toLowerCase()}`;
    if (!seen.has(key)) {
      seen.set(key, sug);
      uniqueSuggestions.push(sug);
    } else {
      const existing = seen.get(key);
      if (sug.description && !existing.description) {
        existing.description = sug.description;
      }
      if (sug.category && sug.category !== 'general' && (!existing.category || existing.category === 'general')) {
        existing.category = sug.category;
      }
    }
  }

  return { cleanText, suggestions: uniqueSuggestions };
}

/**
 * Parses basic Markdown formatting and converts it to HTML.
 * Escapes HTML characters first for safety.
 * @param {string} text 
 * @returns {string} Safe HTML
 */
export function parseMarkdown(text) {
  if (!text) return '';

  // 1. Escape HTML for safety against XSS
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // 2. Code blocks: ```language\ncode\n```
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code class="language-$1">$2</code></pre>');

  // 3. Inline code: `code`
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');

  // 4. Bold: **text**
  html = html.replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>');

  // 5. Italic: *text* or _text_
  html = html.replace(/\*([\s\S]+?)\*/g, '<em>$1</em>');
  html = html.replace(/_([\s\S]+?)_/g, '<em>$1</em>');

  // 6. Headers: ### Header
  html = html.replace(/^### (.*?)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.*?)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.*?)$/gm, '<h1>$1</h1>');

  // 7. Unordered lists: lines starting with "- " or "* "
  html = html.replace(/^[-\*]\s+(.*?)$/gm, '<li>$1</li>');

  // Wrap consecutive <li> elements in <ul>
  html = html.replace(/(<li>.*?<\/li>)+/gs, '<ul>$&</ul>');

  // 8. Newlines to <br>
  html = html.replace(/\n/g, '<br>');

  // 9. Clean up layout around block elements (remove excess <br> immediately after blocks)
  html = html.replace(/<\/ul><br>/g, '</ul>');
  html = html.replace(/<\/pre><br>/g, '</pre>');
  html = html.replace(/<\/h3><br>/g, '</h3>');
  html = html.replace(/<\/h2><br>/g, '</h2>');
  html = html.replace(/<\/h1><br>/g, '<h1>');

  return html;
}

export const aiService = {
  /**
   * Check if the AI server is reachable
   */
  async checkConnection() {
    const settings = settingsStore.get();
    try {
      const resp = await fetch(`${settings.ai_url}/v1/models`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  },

  /**
   * Stream a chat completion from the AI assistant
   * @param {Array} history - Array of {role, content}
   * @param {Array} activeTags - Current active prompt tags list
   * @param {AbortSignal} signal - Abort signal
   * @param {Function} onChunk - Callback(textSoFar)
   * @param {Function} onDone - Callback(finalRawText)
   * @param {Function} onError - Callback(err)
   */
  async streamHelpChat(history, activeTags, promptText, signal, onChunk, onDone, onError) {
    const settings = settingsStore.get();
    const categories = tagsDatabase.getAllCategories();
    
    // Compile tag definitions for system prompt context
    let dbInfo = '';
    for (const key in categories) {
      dbInfo += `- Category '${key}' (${categories[key].name}):\n`;
      categories[key].tags.forEach(t => {
        dbInfo += `  * tag: "${t.tag}" (Name: ${t.name}, Description: ${t.description})\n`;
      });
    }

    const userInstructions = settings.ai_instructions || "You are an expert prompt engineer. Help the user create amazing image generation prompts.";
    const systemPrompt = `${userInstructions}

You are Anima Studio AI Assistant, an expert art director helping the user generate pictures using the Anima diffusion model.
The user wants to construct a visual prompt composition.
You help them brainstorm ideas, describe scenes, or suggest changes using a hybrid prompting approach that balances Danbooru/Gelbooru tags with natural language.

CRITICAL DIRECTIVE: The user wants a non-realistic/stylized image (such as anime, illustration, painting, sketch). Do NOT recommend or use terms or tags related to photorealism, realism, or 3D rendering, including: "photorealistic", "realistic", "realism", "hyperrealistic", "8k", "4k", "octane render", "unreal engine", "soft shadows", "ultra detailed textures", "raytracing", "photography", "photograph". Keep all suggestions suited for stylized art/drawings.

ANIMA PROMPTING RULES & STRUCTURE:
1. Tag Order Schema:
   Instruct the user to structure their prompt elements in this specific order, and make sure any prompt recommendations follow this exact order:
   [quality/meta/year/safety tags] [1girl/1boy/1other etc] [character] [series] [artist] [general tags/natural language description]

2. Quality tags:
   - Human score based: "masterpiece", "best quality", "good quality", "normal quality", "low quality", "worst quality".
   - PonyV7 aesthetic model based: "score_9", "score_8", "score_7", "score_6", "score_5", "score_4", "score_3", "score_2", "score_1".
   - All combinations work: you can use human score tags, aesthetic model tags, both together, or neither. (e.g., "masterpiece, best quality, score_7, safe, ").

3. Time period tags:
   - Specific year: "year 2025", "year 2024", etc.
   - Period: "newest", "recent", "mid", "early", "old".

4. Meta tags:
   - "highres", "absurdres", "anime screenshot", "jpeg artifacts", "official art", etc. (e.g., use "absurdres" by default for high-res).

5. Safety tags:
   - "safe", "sensitive", "nsfw", "explicit".

6. Hybrid Prompting & Natural Language Descriptions:
   - Prioritize writing descriptive, natural English descriptions for actions, composition, clothing, and background scenery instead of a list of raw tags. For example, instead of just "1girl, tree, bench, outdoor, summer", describe the scene naturally: "a girl sitting on a wooden bench under a large green tree in a sunlit summer garden".
   - Natural language descriptions should be descriptive and typically at least two sentences long when writing full scenes.
   - You can recommend natural language phrases or descriptions as prompt elements. If recommending a natural language phrase/description to be added to their active tags/prompt, output it using the <suggest_add> XML tag with category="general".
   - Combine character tags/details and specific tags with natural language for best results.

7. Formatting & Conventions:
   - Use lowercase for all tags/descriptions, and spaces instead of underscores (except for "score_" tags which use underscores, e.g., "score_9").
   - Follow standard English capitalization rules for specific character names (e.g., "Holo") and series names (e.g., "Spice and Wolf").
   - Prefer Gelbooru-style tags over Danbooru tags when they differ.
   - Character specifics: Using descriptive names/details (e.g., "Jess, a 21-year-old blonde woman") is recommended for character consistency.

8. No Weight Syntax:
   - Do NOT use or recommend Stable Diffusion weight syntax (e.g., "(tag:1.3)" or "(tag)") in your suggestions, as weights are not supported in the same way and may confuse the Anima Qwen text encoder. Recommend describing elements in natural language to emphasize them instead.

When you recommend adding a tag, phrase, or description, you MUST output a <suggest_add> XML tag:
<suggest_add tag="tag_name_or_natural_phrase" category="category_name" description="brief explanation of why to add" />
(Prefer recommending existing tags from the database list below or custom descriptive natural language phrases for the scene details with category "general"!)

When you recommend removing a tag or phrase currently active in their composition, you MUST output a <suggest_remove> XML tag:
<suggest_remove tag="tag_name_or_phrase" />

Current main text prompt typed in the user's workspace:
"${promptText || 'None'}"

Active prompt tags currently enabled in the user's workspace:
${activeTags.length > 0 ? activeTags.map(t => `"${t}"`).join(', ') : 'None'}

Valid database categories and tags:
${dbInfo}

Reply friendly in the language the user is speaking to you (e.g. Russian if they talk in Russian). Give helpful suggestions and ideas. You can recommend multiple tags or descriptive phrases to add or remove! CRITICAL: Only your conversation and explanations should be in the user's language. All tags, XML suggestions, and prompt elements MUST always be strictly in English.

CRITICAL FORMAT DIRECTIVES (Follow GenAI standards):
1. XML TAG SUGGESTION FORMAT: Recommending tags/phrases is your way of emitting suggestions/functions. They MUST be outputted on their own separate lines at the VERY END of your response.
2. DO NOT wrap XML tags inside markdown code blocks (e.g. do not put them inside \`\`\`), write them as raw XML.
3. STOP generating immediately after outputting the XML tags — do not write any text, conversational filler, or explanations after the final XML tag. All explanations must be written BEFORE the XML tags or inside the description attribute.`;

    const apiMessages = [
      { role: 'system', content: systemPrompt },
      ...history.map(m => ({ ...m }))
    ];

    // Append workspace context to the latest user message to keep it in the LLM's short-term attention span
    if (apiMessages.length > 1) {
      const lastMsg = apiMessages[apiMessages.length - 1];
      if (lastMsg && lastMsg.role === 'user') {
        lastMsg.content = `${lastMsg.content}
---
[Current Workspace State:
- Text Prompt: "${promptText || 'None'}"
- Active Tags: ${activeTags.length > 0 ? activeTags.join(', ') : 'None'}]`;
      }
    }

    try {
      const resp = await fetch(`${settings.ai_url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: apiMessages,
          stream: true,
          max_tokens: 2000,
          temperature: 0.7
        }),
        signal
      });

      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`AI API error ${resp.status}: ${errText}`);
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullText = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete line

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;

          const data = trimmed.slice(6);
          if (data === '[DONE]') {
            onDone(fullText);
            return;
          }

          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta;
            if (delta?.content) {
              fullText += delta.content;
              onChunk(fullText);
            }
          } catch (e) {
            // ignore
          }
        }
      }

      onDone(fullText);
    } catch (err) {
      if (err.name === 'AbortError') {
        onDone(fullText);
      } else {
        onError(err);
      }
    }
  },

  /**
   * Improve the user prompt
   */
  async improvePrompt(promptText, activeTags) {
    const settings = settingsStore.get();
    const instructions = settings.ai_instructions || "You are an expert prompt engineer.";
    const systemPrompt = `${instructions}
You are Anima Studio AI Assistant, an expert art director. 
Your task is to enhance the user's image generation prompt.

ANIMA PROMPTING RULES for improvement:
1. Leverage Natural Language: Enhance the prompt by describing specific visual details, subject features, background elements, action/poses, lighting, and composition in clean, descriptive, natural English sentences or detailed phrases.
2. DO NOT add redundant, generic, or style-altering tags (such as "masterpiece", "highly detailed", "sharp focus", "beautiful", or generic style modifiers) that change or dilute the user's intended style. Keep the expansion tasteful.
3. Formatting: Use lowercase for general descriptions, and spaces instead of underscores. Use standard English capitalization for specific character/series names.
4. No Weight Syntax: Do NOT use SDXL/CLIP weight syntax like "(tag:1.3)" or "(tag)" as it does not work correctly with the Anima Qwen text encoder.
5. Keep the expansion concise, clean, and high-quality. Do not write a long paragraph of cluttered keywords.
6. Strictly respect the active tags provided below. Do not add styling keywords that conflict with or duplicate these tags.

CRITICAL DIRECTIVE: You are strictly forbidden from writing any conversational text, introductions, explanations, or introductory/concluding remarks. You MUST return ONLY the raw text of the improved text prompt. Do NOT wrap the prompt in markdown code blocks (such as \`\`\`), markdown text formatting, or quotes. Start directly with the prompt content.

STYLE RESTRICTION: The user wants a non-realistic/stylized image (like anime, illustration, painting, sketch). Do NOT make the image realistic or photorealistic. Strictly avoid using terms like "photorealistic", "realistic", "realism", "hyperrealistic", "8k", "4k", "octane render", "unreal engine", "soft shadows", "ultra detailed textures", "raytracing", "photography", "photograph", or any 3D rendering terms.

Current active prompt tags (enabled in workspace):
${activeTags.length > 0 ? activeTags.join(', ') : 'None'}

Current main text prompt/idea:
"${promptText || 'None'}"`;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: "Please generate the improved prompt combining both the main prompt text and active tags." }
    ];

    try {
      const resp = await fetch(`${settings.ai_url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages,
          stream: false,
          max_tokens: 2000,
          temperature: 0.8
        })
      });

      if (!resp.ok) {
        throw new Error(`AI API error ${resp.status}`);
      }

      const parsed = await resp.json();
      let content = parsed.choices?.[0]?.message?.content || '';
      content = stripThinking(content);
      return content.trim() || promptText;
    } catch (err) {
      console.error(err);
      return promptText; // fallback to original
    }
  }
};

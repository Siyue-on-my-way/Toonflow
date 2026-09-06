const fs = require('fs');
const path = require('path');

const vendorsDir = path.join(__dirname, 'src/vendors');
const files = fs.readdirSync(vendorsDir).filter(f => f.endsWith('.ts') && f !== 'index.ts');

const imports = `import { VendorConfig, TextModel, ImageModel, VideoModel, TTSModel, ImageConfig, VideoConfig, TTSConfig, PollResult, ReferenceList, VideoMode } from "@/types/vendor";
import { createOpenAI } from "@ai-sdk/openai";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createZhipu } from "zhipu-ai-provider";
import { createQwen } from "qwen-ai-provider-v5";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createXai } from "@ai-sdk/xai";
import { createMinimax } from "vercel-minimax-ai-provider";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import axios from "axios";
import jsonwebtoken from "jsonwebtoken";
import { zipImage, zipImageResolution, mergeImages, urlToBase64, pollTask, logger } from "@/utils/vm";
`;

for (const file of files) {
  const filePath = path.join(vendorsDir, file);
  let content = fs.readFileSync(filePath, 'utf8');

  // Remove type definitions
  content = content.replace(/\/\/ =+[\s\S]*?\/\/ 类型定义[\s\S]*?\/\/ =+[\s\S]*?(?=\/\/ =+[\s\S]*?\/\/ 全局声明)/, '');
  
  // Remove global declarations
  content = content.replace(/\/\/ =+[\s\S]*?\/\/ 全局声明[\s\S]*?\/\/ =+[\s\S]*?(?=\/\/ =+[\s\S]*?\/\/ 供应商配置)/, '');

  // Replace exports.xxx = xxx with export { xxx }
  content = content.replace(/exports\.(\w+)\s*=\s*\1;/g, '');
  
  // Remove export {}
  content = content.replace(/export\s*\{\s*\};?/g, '');
  
  // Add export keyword to the functions and vendor object
  content = content.replace(/const vendor: VendorConfig/g, 'export const vendor: VendorConfig');
  content = content.replace(/const textRequest =/g, 'export const textRequest =');
  content = content.replace(/const imageRequest =/g, 'export const imageRequest =');
  content = content.replace(/const videoRequest =/g, 'export const videoRequest =');
  content = content.replace(/const ttsRequest =/g, 'export const ttsRequest =');
  content = content.replace(/const checkForUpdates =/g, 'export const checkForUpdates =');
  content = content.replace(/const updateVendor =/g, 'export const updateVendor =');

  // Prepend imports
  content = imports + '\n' + content;

  fs.writeFileSync(filePath, content);
  console.log(`Refactored ${file}`);
}

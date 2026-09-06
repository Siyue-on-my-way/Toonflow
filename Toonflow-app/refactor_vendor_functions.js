const fs = require('fs');
const path = require('path');

const vendorsDir = path.join(__dirname, 'src/vendors');
const files = fs.readdirSync(vendorsDir).filter(f => f.endsWith('.ts') && f !== 'index.ts');

for (const file of files) {
  const filePath = path.join(vendorsDir, file);
  let content = fs.readFileSync(filePath, 'utf8');

  // Update function signatures
  content = content.replace(/export const textRequest = \(model: TextModel, think: boolean, thinkLevel: 0 \| 1 \| 2 \| 3\) => \{/g, 'export const textRequest = (model: TextModel, think: boolean, thinkLevel: 0 | 1 | 2 | 3, inputValues: Record<string, string>) => {');
  content = content.replace(/export const textRequest = \(model: TextModel\) => \{/g, 'export const textRequest = (model: TextModel, think: boolean, thinkLevel: 0 | 1 | 2 | 3, inputValues: Record<string, string>) => {');
  
  content = content.replace(/export const imageRequest = async \(config: ImageConfig, model: ImageModel\): Promise<string> => \{/g, 'export const imageRequest = async (config: ImageConfig, model: ImageModel, inputValues: Record<string, string>): Promise<string> => {');
  
  content = content.replace(/export const videoRequest = async \(config: VideoConfig, model: VideoModel\): Promise<string> => \{/g, 'export const videoRequest = async (config: VideoConfig, model: VideoModel, inputValues: Record<string, string>): Promise<string> => {');
  
  content = content.replace(/export const ttsRequest = async \(config: TTSConfig, model: TTSModel\): Promise<string> => \{/g, 'export const ttsRequest = async (config: TTSConfig, model: TTSModel, inputValues: Record<string, string>): Promise<string> => {');

  // Replace vendor.inputValues with inputValues
  content = content.replace(/vendor\.inputValues/g, 'inputValues');

  fs.writeFileSync(filePath, content);
  console.log(`Refactored functions in ${file}`);
}

const fs = require('fs');
const path = require('path');

const vendorsDir = path.join(__dirname, 'src/vendors');
const files = fs.readdirSync(vendorsDir).filter(f => f.endsWith('.ts') && f !== 'index.ts');

for (const file of files) {
  const filePath = path.join(vendorsDir, file);
  let content = fs.readFileSync(filePath, 'utf8');

  // Find the end of the vendor config object
  const vendorEndMatch = content.match(/export const vendor: VendorConfig = \{[\s\S]*?\n\};\n/);
  if (!vendorEndMatch) {
    console.error(`Could not find vendor config in ${file}`);
    continue;
  }
  
  const vendorEndIndex = vendorEndMatch.index + vendorEndMatch[0].length;
  
  const topPart = content.substring(0, vendorEndIndex);
  let bottomPart = content.substring(vendorEndIndex);
  
  // Remove the export keywords from the request functions in the bottom part
  bottomPart = bottomPart.replace(/export const (textRequest|imageRequest|videoRequest|ttsRequest|checkForUpdates|updateVendor) =/g, 'const $1 =');
  
  // Remove the inputValues parameter from the request functions that we added earlier
  bottomPart = bottomPart.replace(/, inputValues: Record<string, string>\) => \{/g, ') => {');
  
  // Wrap the bottom part in the factory function
  const factoryWrapper = `
export function createVendorAPI(inputValues: Record<string, string>) {
${bottomPart.split('\n').map(line => '  ' + line).join('\n')}
  return { textRequest, imageRequest, videoRequest, ttsRequest, checkForUpdates, updateVendor };
}
`;

  // Add missing imports
  let newTopPart = topPart;
  if (!newTopPart.includes('import crypto')) {
    newTopPart = 'import crypto from "node:crypto";\n' + newTopPart;
  }
  if (!newTopPart.includes('import FormData')) {
    newTopPart = 'import FormData from "form-data";\n' + newTopPart;
  }

  fs.writeFileSync(filePath, newTopPart + factoryWrapper);
  console.log(`Refactored ${file} to use factory function`);
}

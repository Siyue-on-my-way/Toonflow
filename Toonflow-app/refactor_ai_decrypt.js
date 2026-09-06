const fs = require('fs');
const path = require('path');

const aiPath = path.join(__dirname, 'src/utils/ai.ts');
let content = fs.readFileSync(aiPath, 'utf8');

const oldLogic = `  const inputValues = JSON.parse(vendorConfigData.inputValues ?? "{}");`;

const newLogic = `  const rawInputValues = JSON.parse(vendorConfigData.inputValues ?? "{}");
  const inputValues = { ...rawInputValues };
  for (const key in inputValues) {
    if (key.toLowerCase().includes("key") || key.toLowerCase().includes("secret") || key.toLowerCase().includes("token")) {
      inputValues[key] = u.crypto.decrypt(inputValues[key]);
    }
  }`;

content = content.replace(oldLogic, newLogic);
fs.writeFileSync(aiPath, content);
console.log('Refactored ai.ts for decryption');

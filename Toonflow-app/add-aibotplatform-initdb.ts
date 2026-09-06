import fs from 'fs';
import path from 'path';

const initDBPath = path.join(__dirname, 'src/lib/initDB.ts');
let content = fs.readFileSync(initDBPath, 'utf-8');

const newVendor = `
          {
            id: "aibotplatform",
            enable: 1,
            inputValues: JSON.stringify({
              apiKey: "",
              baseUrl: "https://bus-ie.aibotplatform.com/assistant/vendor-api/v2",
            }),
            models: JSON.stringify([
              { name: "GPT-4o", modelName: "gpt-4o", type: "text", think: false },
              { name: "GPT-3.5-Turbo", modelName: "gpt-3.5-turbo", type: "text", think: false },
            ]),
          },`;

// Find the o_vendorConfig initData section
const vendorConfigRegex = /(name:\s*"o_vendorConfig"[\s\S]*?initData:\s*async\s*\(knex\)\s*=>\s*\{\s*await\s*knex\("o_vendorConfig"\)\.insert\(\[)/;
const match = content.match(vendorConfigRegex);

if (match) {
  if (!content.includes('id: "aibotplatform"')) {
    content = content.replace(vendorConfigRegex, `$1${newVendor}`);
    fs.writeFileSync(initDBPath, content);
    console.log("Added aibotplatform to src/lib/initDB.ts");
  } else {
    console.log("aibotplatform already in src/lib/initDB.ts");
  }
} else {
  console.error("Could not find o_vendorConfig initData in src/lib/initDB.ts");
}

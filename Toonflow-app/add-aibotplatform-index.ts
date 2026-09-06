import fs from 'fs';
import path from 'path';

const indexPath = path.join(__dirname, 'src/vendors/index.ts');
let content = fs.readFileSync(indexPath, 'utf-8');

if (!content.includes('import * as aibotplatform')) {
  // Add import
  content = content.replace(
    'import * as atlascloud from "./atlascloud";',
    'import * as aibotplatform from "./aibotplatform";\nimport * as atlascloud from "./atlascloud";'
  );
  
  // Add to exports
  content = content.replace(
    '  atlascloud,',
    '  aibotplatform,\n  atlascloud,'
  );
  
  fs.writeFileSync(indexPath, content);
  console.log("Added aibotplatform to src/vendors/index.ts");
} else {
  console.log("aibotplatform already in src/vendors/index.ts");
}

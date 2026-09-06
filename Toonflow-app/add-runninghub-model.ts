import fs from 'fs';
import path from 'path';

const vendorPath = path.join(__dirname, 'src/vendors/runninghub.ts');
let content = fs.readFileSync(vendorPath, 'utf-8');

// Fix the comma issue from the previous run
content = content.replace('}\n  ,\n    {', '},\n    {');
fs.writeFileSync(vendorPath, content);

console.log("Fixed formatting.");

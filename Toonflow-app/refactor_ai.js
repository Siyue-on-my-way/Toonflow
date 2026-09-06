const fs = require('fs');
const path = require('path');

const aiPath = path.join(__dirname, 'src/utils/ai.ts');
let content = fs.readFileSync(aiPath, 'utf8');

const oldLogic = `  const code = u.vendor.getCode(id);
  const jsCode = transform(code, { transforms: ["typescript"] }).code;
  const running = u.vm(jsCode);
  if (running.vendor) {
    Object.assign(running.vendor.inputValues, JSON.parse(vendorConfigData.inputValues ?? "{}"));
    running.vendor.models = modelList;
  }
  const fn = running[fnName];`;

const newLogic = `  const vendorModule = u.vendor.getVendorModule(id);
  if (!vendorModule) throw new Error(\`未找到供应商模块 id=\${id}\`);
  const inputValues = JSON.parse(vendorConfigData.inputValues ?? "{}");
  const api = vendorModule.createVendorAPI(inputValues);
  const fn = api[fnName];`;

content = content.replace(oldLogic, newLogic);
fs.writeFileSync(aiPath, content);
console.log('Refactored ai.ts');

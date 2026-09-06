const { transform } = require("sucrase");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function getCode(id) {
  const targetFile = path.join(__dirname, "data/vendor", `${id}.ts`);
  if (!fs.existsSync(targetFile)) return "";
  return fs.readFileSync(targetFile, "utf-8");
}

function runVm(code) {
  code = code.replace(/export\s*\{\s*\};?/g, "");
  const jsCode = transform(code, { transforms: ["typescript"] }).code;
  const sandbox = {
    exports: {},
    console: console,
    require: require,
    process: process,
    Buffer: Buffer,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: setInterval,
    clearInterval: clearInterval,
  };
  vm.createContext(sandbox);
  vm.runInContext(jsCode, sandbox);
  return sandbox.exports;
}

try {
  const code = getCode("runninghub");
  const vendorData = runVm(code);
  console.log("Vendor object:", vendorData.vendor);
} catch (e) {
  console.error("Error:", e);
}

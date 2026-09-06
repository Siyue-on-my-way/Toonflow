import { vendor } from "./src/vendors/runninghub";

console.log("RunningHub Vendor Config Models:");
console.log(JSON.stringify(vendor.models, null, 2));
process.exit(0);

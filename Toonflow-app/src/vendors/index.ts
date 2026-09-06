import * as aibotplatform from "./aibotplatform";
import * as atlascloud from "./atlascloud";
import * as deepseek from "./deepseek";
import * as grsai from "./grsai";
import * as klingai from "./klingai";
import * as minimax from "./minimax";
import * as nullVendor from "./null";
import * as openai from "./openai";
import * as runninghub from "./runninghub";
import * as toonflow from "./toonflow";
import * as vidu from "./vidu";
import * as volcengine from "./volcengine";
import * as volcengineSd2 from "./volcengineSd2";

export const vendors: Record<string, any> = {
  aibotplatform,
  atlascloud,
  deepseek,
  grsai,
  klingai,
  minimax,
  null: nullVendor,
  openai,
  runninghub,
  toonflow,
  vidu,
  volcengine,
  volcengineSd2,
};

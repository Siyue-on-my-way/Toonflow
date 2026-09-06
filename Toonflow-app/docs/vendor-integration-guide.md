# Toonflow 渠道接入 SOP

这份文档把"如何给 Toonflow 接入一个新的模型渠道"固化成一份操作手册，目标是任何人（包括另一个不带上下文的 LLM 会话）拿到这份文档 + 一份新渠道的 API 文档，就能独立完成接入，不需要再回来问架构性的问题。

背景讨论全文在 [SIY-30](mention://issue/63f1c834-3581-4c4e-93e1-740845f4c33b) 的评论区；本文档只固化"渠道和模型怎么接入"这一件事，不覆盖账号/角色相关内容（那部分见 SIY-44/46/47/48 的实现）。

## 1. 两层架构：Layer1（协议目录）vs Layer2（账号数据）

Toonflow 把"一个渠道怎么用"拆成两层，互不耦合：

| | Layer1：协议目录 | Layer2：账号数据 |
|---|---|---|
| 内容 | 这个渠道有哪些模型、每个模型怎么调用（endpoint/字段/DSL 或代码） | 某个登录账号自己的 key/token、自己启用了哪些模型 |
| 归属 | 全账号共享，只读 | 每个账号私有，互相隔离 |
| 维护方式 | **改代码**（`src/vendors/<id>.ts` + 可选的 `<id>-models.ts`），不能通过接口动态增删 | 账号自助通过接口维护（设置页配 key、加入模型），任意登录用户都能操作，不需要审批 |
| 落地位置 | 数据库 `o_vendorConfig` 表（`src/lib/initDB.ts:553`）：`id`/`inputValues`（渠道级 schema 占位，不放真实密钥）/`models`（该渠道当前的模型协议目录 JSON）/`enable`。**这张表的 `models` 字段是当前协议目录的实际来源**——`getModelList()`（`src/utils/vendor.ts:13`）完全以数据库里的 `models` 为准，代码里 `vendor.models` 只是"新装一套时 `initData` 写进去的初始值"，见第 4 节的重要坑。 | 数据库 `o_vendorAccount` 表（`src/lib/initDB.ts:635`）：`userId`/`vendorId`/`enable`/`inputValues`（该账号自己的 key）/`enabledModels`（该账号选用的 modelName 列表）。唯一键 `(userId, vendorId)`。 |
| 读写函数 | `u.vendor.getVendor(id)` / `getVendorModule(id)` / `getModelList(id)`（`src/utils/vendor.ts`） | `u.vendor.getVendorAccount(userId, vendorId)` / `upsertVendorAccount(...)` / `getEnabledModelNames(...)`（同文件） |

实际调用链路（发起一次真实生成请求时）：`src/utils/ai.ts` 的 `getVendorTemplateFn(fnName, "vendorId:modelName", userId)` 先按 `userId + vendorId` 查 `o_vendorAccount` 拿到这个账号的 key，校验该账号是否启用了这个模型（不在 `enabledModels` 里直接报错"请先在设置页加入这个模型"），再调 `src/vendors/<id>.ts` 里对应的适配器函数（`imageRequest`/`videoRequest`/...），把账号的 `inputValues` 传进去执行真正的 HTTP 请求。

**一句话记住这层关系**：Layer1 决定"这个渠道/模型存在、怎么发请求"；Layer2 只决定"用谁的 key、这个人能不能用"。接入新渠道/新模型，动的永远是 Layer1；Layer2 的代码（`o_vendorAccount` 相关路由）不需要为每个新渠道单独改。

⚠️ **`addVendor.ts` 接口已经废弃**（`src/routes/setting/vendorConfig/addVendor.ts`）：调用会直接返回 403"系统已升级为静态代码架构，禁止动态添加供应商。请通过提交代码的方式新增供应商。"——新增渠道**必须**改代码，没有"纯后台配置无需发版"的路径。

## 2. Model Spec JSON DSL（目前仅 RunningHub 落地）

只有 RunningHub 渠道（字段命名/枚举/endpoint 极不规整）落地了这套"请求体拼装用 JSON 数据描述，不用 if/else"的 DSL。其它渠道（klingai/minimax/openai/...）仍然是纯手写代码，见第 5 节的判断标准。

DSL 定义 + 解释器都在 `src/vendors/runninghub-models.ts`，被 `src/vendors/runninghub.ts` 的 `imageRequest`/`videoRequest` 调用。

### 2.1 `RunningHubModelSpec` 字段

```ts
export interface RunningHubModelSpec {
  modelName: string;        // 对应 vendor.models 里的 modelName
  endpoint: string;         // 完整请求路径，不能靠 modelName+固定action 拼接推导
  type: "image" | "video";
  fields?: RunningHubFieldSpec[];
  imageInput?: RunningHubImageInput;
  constants?: Record<string, any>;
  rawExtra?: Record<string, any>;
  requiresMode?: string;         // 该模型只支持某个 VideoMode，不满足则报错
  requiresModeError?: string;
}
```

- **`endpoint`**：完整路径字符串，直接抄文档给的路径，不要试图用 `modelName + "/xxx"` 规律去猜——真实反例：`rhart-video/minimax-h3-oss/fl2va` 是三段式路径，和 modelName 完全一致但别的模型不是这样（比如 `kling-v3.0-pro` 的 endpoint 是 `kling-v3.0-pro/image-to-video`）。
- **`fields`**：从内部 `ImageConfig`/`VideoConfig`（`src/types/vendor.ts`）取一个字段，映射到请求体里的另一个字段名。每条：
  - `from`：内部配置对象上的字段名（`prompt`/`duration`/`aspectRatio`/`size`/`audio` 等）。
  - `target`：请求体里的字段名。
  - `cast`：`"int" | "float" | "string" | "bool"`，值取出来之后做类型转换。真实例子：RunningHub 有的模型 `duration` 要传字符串 `"5"`（`kling-video-o3-pro` 用 `cast: "string"`），有的要传 float（`fl2va` 用 `cast: "float"`）。
  - `enumMap`：枚举值映射表，处理"内部统一值 → 该模型专属取值"的转换。真实例子：内部 `aspectRatio` 统一是 `"16:9"`/`"9:16"` 短格式，但 `fl2va` 模型要求长格式 `{"16:9": "16:9 (Widescreen)", "9:16": "9:16 (Portrait Widescreen)"}`。
  - `default`：取到的值是 `undefined`/`null` 时的兜底值；不设置 `default` 则该字段直接不出现在请求体里（不是传 `null`/`undefined`）。真实例子：`sound` 字段 `default: false`——用户没勾选音频时，请求体里 `sound: false` 而不是缺省不传。
- **`imageInput`**：两种模式，处理"参考图怎么塞进请求体"：
  - `{ mode: "namedSlots", slots: ["firstImageUrl", "lastImageUrl"] }`：几个固定具名字段，按图片引用数组的顺序依次填入 `slots[i]`。真实例子：`kling-v3.0-pro`（首尾帧图生视频）。
  - `{ mode: "array", arrayField: "imageUrls", max: 3 }`：塞进一个数组字段，`max` 限制最多取几张。真实例子：`rhart-image-n-g31-flash`（`max: 1`）、`rhart-video-v3.1-fast`（`max: 3`）。
  - `required`/`requiredError`：图片数量不足时的校验和报错文案。不设置则不校验（0 张也能通过）。
- **`constants`**：该模型固定写死、和输入无关的字段。真实例子：`kling-v3.0-pro` 的 `{ cfgScale: 0.5, multiShot: false, shotType: "customize" }`。
- **`rawExtra`**：兜底透传——`fields`/`imageInput`/`constants` 覆盖不到的怪异字段结构，直接把一段**固定** JSON 合并进最终请求体。注意 `rawExtra` 里的值是写死的常量，**不能**根据输入动态变化；如果某个字段的值要跟着用户输入变（比如"数组长度取决于参考图数量"），`rawExtra` 用不了，只能走第 5 节的"手写代码"路线。
- **`requiresMode`**：模型只支持某个生成模式时用来在拼请求体前直接报错拦截。真实例子：`kling-video-o3-pro` 是纯文生视频模型，`requiresMode: "text"`，如果账号选了图生视频模式调用它会直接抛错，而不是拼出一个错误的请求体发出去。

解释器 `buildRunningHubRequestBody(spec, config, imageRefs)` 的处理顺序是固定的：`requiresMode` 校验 → 逐条处理 `fields` → 处理 `imageInput` → 合并 `constants` → 合并 `rawExtra`（写在后面，意味着 `rawExtra` 里的 key 会覆盖前面几步算出来的同名字段，可以用来强制覆盖）。

### 2.2 完整例子（三段式 endpoint + 长格式枚举 + namedSlots）

```json
{
  "modelName": "rhart-video/minimax-h3-oss/fl2va",
  "endpoint": "rhart-video/minimax-h3-oss/fl2va",
  "type": "video",
  "fields": [
    { "target": "prompt", "from": "prompt" },
    { "target": "aspectRatio", "from": "aspectRatio", "enumMap": { "16:9": "16:9 (Widescreen)", "9:16": "9:16 (Portrait Widescreen)" } },
    { "target": "duration", "from": "duration", "cast": "float" }
  ],
  "imageInput": { "mode": "namedSlots", "slots": ["firstFrameUrl", "lastFrameUrl"] }
}
```

## 3. 通用轮询模式：提交任务 → 轮询查询 → 拿结果 URL

所有异步生成任务（图片/视频）的骨架都是同一个模式：`submit` 拿到 `taskId` → 用 `taskId` 反复 `query` 直到完成 → 拿到结果 URL 再转成 base64（`urlToBase64`，`src/utils/vm.ts`）。这个"反复轮询直到超时或完成"的**引擎**是通用的：`pollTask(queryFn, intervalMs, timeoutMs)`（`src/utils/vm.ts`），`queryFn` 返回 `PollResult { completed: boolean; data?: string; error?: string }`（`src/types/vendor.ts:84`），`pollTask` 负责按 `intervalMs` 间隔重复调用直到 `completed: true` 或超时。

### 3.1 什么时候可以直接复用现成实现

如果新渠道的接口形状和 RunningHub 一样简单——**提交返回一个 `taskId`，查询接口传 `taskId` 返回一个 `status` 字段（`SUCCESS`/`FAILED`/其它=运行中）和结果数组**——直接照抄 `src/vendors/runninghub.ts` 里的 `submitTask`/`queryTask` 两个函数，改掉 `baseUrl`/鉴权头/字段名即可，`pollTask` 调用方式不用变。

### 3.2 什么时候不能直接复用，需要单独处理

`src/vendors/klingai.ts` 的 `submitAndPoll` 就是一个反例，原因：

1. **鉴权方式不同**：不是固定 Bearer key，而是要用 `accessKey`/`secretKey` 现算一个 HS256 JWT（`generateAuthToken`），而且 JWT 30 分钟过期——每次轮询查询前都要**重新生成**一个新 token（`freshToken`），不能像 RunningHub 一样查询请求全程复用同一个 header。
2. **请求方式和响应结构不同**：提交是 `POST`，查询是 `GET /{queryUrlBase}/{taskId}`（不是 `POST {taskId}`）；返回体是 `{ code, data: { task_status, task_status_msg, task_result: { videos: [{url}] } } }` 这种嵌套结构，字段名和判断"成功"的取值（`"succeed"`/`"failed"`）都和 RunningHub 的 `SUCCESS`/`FAILED` 不一样。

结论：**`pollTask` 这个轮询循环引擎永远复用**；但"怎么提交""怎么查询"这两个函数要不要照抄 RunningHub 的实现，取决于新渠道的鉴权方式和响应结构是否和 RunningHub 一致——不一致就参照 `klingai.ts` 的写法自己写一版 `submitAndPoll`，只要最终喂给 `pollTask` 的 `queryFn` 返回符合 `PollResult` 形状就行。

## 4. 接入 Checklist：从"拿到新渠道 API 文档"到"能在 Toonflow 里用"

1. **确定 vendor id**：纯英文小写，无特殊符号/空格（例如 `runninghub`、`klingai`）。检查 `src/vendors/` 下是否已有同名文件——没有则复制 `src/vendors/_template.ts` 改名为 `src/vendors/<id>.ts`（模板见第 6 节）。
2. **确定 `vendor.inputs`**（`src/vendors/<id>.ts` 里的 `VendorConfig.inputs`）：账号要在设置页填哪些字段才能用这个渠道。按认证方式定，常见形态：
   - 单 API Key：`[{ key: "apiKey", type: "password", required: true }, { key: "baseUrl", type: "url", required: true }]`（RunningHub 的写法）。
   - AK/SK 双密钥：`[{ key: "accessKey", ... }, { key: "secretKey", ... }, { key: "baseUrl", ... }]`（klingai 的写法）。
   - `inputs` 里字段名包含 `key`/`secret`/`token`（大小写不敏感）的，前端和后端在存取时会自动加密/解密（见 `updateVendorInputs.ts`/`getVendorList.ts` 里的判断逻辑），不需要自己写加解密代码。
3. **把新渠道注册进渠道索引**：在 `src/vendors/index.ts` 的 `vendors` 常量里加一行 `import * as <id> from "./<id>"` + `<id>,`。
4. **把渠道协议行写进数据库**：`o_vendorConfig` 表的 `models`/`inputValues` 是"当前协议目录"的实际来源（不是代码里的 `vendor.models`，见第 1 节表格）。
   - 如果是**全新环境、数据库还没建过表**：直接在 `src/lib/initDB.ts` 的 `o_vendorConfig` `initData` 里加一条渠道记录（`id`/`enable`/`inputValues: "{}"`（不放密钥）/`models`：这个渠道支持的模型协议目录 JSON）即可，跟着建表一起初始化。
   - 如果是**已经跑起来、数据库已经建过表的环境**（这是目前生产环境的实际情况）：`initData` 不会重新执行，必须额外写一个一次性脚本直连 MySQL 插入/更新这一行。仓库里已有真实模式可以照抄：`init-aibotplatform-db.js`（用 `mysql2/promise` 直连，`INSERT ... WHERE NOT EXISTS` 式的幂等写法）；DB 连接信息见 `docker/docker-compose.yaml` 的环境变量，本机可用 `127.0.0.1:1886` / `toonflow_db` 连接验证。
   - **同一渠道下新增模型**（渠道已存在，只是加一个新模型协议）：本质是对已有那一行的 `models` 字段做 JSON 更新——**必须先查出现有 `models` 值再追加**，不能整体覆盖，否则会把该渠道下其它账号已经在用的模型协议目录一起清空（`o_vendorConfig.models` 是全账号共享的协议目录，被谁的 `enabledModels` 引用着就不能丢）。
5. **确定每个模型的请求体怎么拼**，按第 5 节的判断标准二选一：
   - 能用 DSL：在 `<id>-models.ts` 里参照 `runninghub-models.ts` 的格式加一条 spec（如果是给 RunningHub 加模型，直接加进 `RUNNINGHUB_MODEL_SPECS`；如果是给别的渠道第一次引入 DSL，需要新建 `<id>-models.ts`，把 `RunningHubXxx` 这些类型名复制一份改成渠道自己的命名再写解释器，目前 DSL 类型定义是 RunningHub 专属的，还没抽成通用的）。
   - 需要手写代码：在 `src/vendors/<id>.ts` 的 `imageRequest`/`videoRequest`/`textRequest`/`ttsRequest` 里加分支逻辑，参照 `klingai.ts` 按 `config.mode` 分支挑接口的写法。
6. **在 `vendor.models` 里加模型协议条目**（`TextModel`/`ImageModel`/`VideoModel`/`TTSModel`，字段定义见 `src/types/vendor.ts`）——这一步和第 4 步的"写进数据库"要保持一致，因为运行时读的是数据库，代码里的 `vendor.models` 只在全新建表时生效。
7. **用真实 key 做验收测试**：
   1. `POST /api/setting/vendorConfig/updateVendorInputs` `{ id, inputValues }`：给当前登录账号配置这个渠道的真实 key（写入 `o_vendorAccount`）。
   2. `POST /api/setting/vendorConfig/addVendorModel` `{ id, model }`：把协议目录里的某个模型加入当前账号的 `enabledModels`（模型必须已经在第 4 步写进 `o_vendorConfig.models`，否则报错"尚未在渠道协议目录中定义"）。
   3. `POST /api/setting/vendorConfig/modelTest/imageTest`（或 `textTest`/`videoTest`）`{ id, modelName, prompt, ... }`：以当前登录账号身份触发一次真实调用，验证能拿到结果。
   4. 代码改动生效前需要 `./restart.sh` 重新构建镜像并重启服务（生产是 Docker 部署，见 `docker/docker-compose.yaml`）。
   5. 如果是重构现有模型的请求拼装逻辑（比如把 if/else 改造成 DSL），额外写一个像 `test-runninghub-dsl.ts` 那样的手写断言脚本（`npx tsx test-xxx.ts`），把重构前每个已知输入对应的请求体断言下来，确保重构后行为完全不变，再上真实 key 做一次线上验收。

## 5. 判断标准：什么时候只需要加 JSON 数据，什么时候必须手写代码

**能用 DSL 覆盖**的特征：请求体是"拍平的 key-value + 固定几个具名图片槏位或一个图片数组 + 一段固定不变的常量"，`endpoint` 是一个固定字符串，不随输入变化。

**必须手写代码**的场景，举真实/假想例子：

1. **鉴权本身需要动态计算**：不是"固定 key 塞进 Header"，而是要签名/生成有时效性的 token（RunningHub 的反例：`klingai.ts` 的 HS256 JWT，每次查询都要重新生成）。DSL 目前只管"怎么拼请求体"，不管鉴权，所以这类渠道即使请求体字段规整，`submitTask`/`queryTask` 这一层也得手写。
2. **请求体结构随输入分支变化，不是简单字段映射**：比如 `klingai.ts` 的 Omni 模型，根据用户选的模式（纯文本/单图/首尾帧/多参考）要拼出完全不同的 `image_list` 结构和不同的默认 prompt 兜底文案——这是"逻辑分支"，不是"字段改名/换个枚举值"，DSL 的 `fields`/`imageInput` 是静态声明式的，做不了条件判断。
3. **嵌套且数量随输入变化的字段结构**：假设某渠道要求 `multiPrompt: [{ step: 1, text: "..." }, { step: 2, text: "..." }]` 或 `elementList: [{ type: "character", ref: "img0" }, ...]` 这种"数组长度和每项内容都取决于用户传了几个东西"的结构。DSL 的 `fields` 只能做"一对一映射"，`rawExtra` 只能塞"写死不变"的 JSON，两者都覆盖不了"结构本身随输入动态展开"的情况，只能在 `imageRequest`/`videoRequest` 里手写循环拼装。
4. **需要请求前后做额外副作用**（比如先调一个接口上传图片拿到 URL，再把 URL 填进主请求），DSL 没有"多步骤"的概念，这类需要手写。

不确定某个模型是否能用 DSL 覆盖时，先按 DSL 写一遍试试：如果发现某个字段值必须"写代码才能算出来"（不是配置就能表达的静态值/静态映射），就是该拆出来手写或走 `rawExtra`（仅当那个值本身是固定常量时）的信号。

## 6. 骨架模板

`src/vendors/_template.ts` 是可以直接复制改名开始写的骨架文件（复制后记得改文件名和里面的 `vendor.id`，并按第 4 步注册进 `src/vendors/index.ts`；这个文件本身**不会**被注册进 `vendors/index.ts`，只是模板，不是一个可用渠道）。模板里保留了详细的注释规则（命名规范、返回值约定、禁止事项等），照着写基本不会偏离现有代码风格。

如果目标渠道的字段结构和 RunningHub 类似（不规整、多模型、需要 DSL），在写完 `_template.ts` 骨架之后，额外新建 `src/vendors/<id>-models.ts`，参照 `src/vendors/runninghub-models.ts` 的结构写 DSL + 解释器，再在 `imageRequest`/`videoRequest` 里调用，不要把拼请求体的逻辑直接堆在 `_template.ts` 里。

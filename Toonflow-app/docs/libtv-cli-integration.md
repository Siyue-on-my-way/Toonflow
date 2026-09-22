# LibTV CLI 渠道接入（liblib.tv）

本文档记录 LibTV CLI 的调研结论与 Toonflow 的接入设计，对应 issue SIY-169。

## 1. LibTV 与它的 CLI 是什么

LibTV（liblib.tv）是 LiblibAI 的 AI 图像/视频创作画布（对标可灵、TapNow），画布上聚合了大量第三方模型：StarVideo 2.0（原 Seedance 2.0）、Kling 3、Hailuo 2.3、Vidu Q2、PixVerse 5、Wan 2.6、Nebula、Seedream、Midjourney 视频等（2026-08 实测模型清单见 PomeloR611/libtv-video-agent 的能力快照）。

官方 CLI（`libtv`，2026-08 版本 1.0.2）把画布操作搬到命令行：项目/分组/节点/模型/素材。**旧的 `sk-libtv-*` OpenAPI / access key 已废弃，且旧 API 建的项目不出现在 web 仪表盘——只能用 CLI**（`libtv-labs/libtv-skills` 的 IM-OpenAPI 方案属于旧路线，本项目不采用）。

### 1.1 安装与登录

```bash
# 安装（装到 ~/.libtv/libtv，支持 LIBTV_CLI_INSTALL_DIR 自定义目录）
curl -fL "https://liblibai-web-static.liblib.cloud/cli/latest/install-libtv-cli.sh" | sh

# 登录（必须浏览器/手机验证码，不能离线拿 token）
libtv login web          # 凭据落在 ~/.libtv/credentials.json
libtv account info       # 成功退出是唯一可靠的登录证明（空 project list 不算）
```

### 1.2 核心命令（三层结构：项目 → [分组] → 节点）

```bash
libtv project create "项目名"     # 返回项目 ID
libtv project use <ID>            # 绑定当前目录（写 .libtv/project.json），之后 node/upload 免带 -p
libtv upload "<节点名>" -f <本地文件> [-t image|video|audio]   # 上传资源节点，stdout 出 NDJSON（含 newNodeKey）
libtv model search -t video       # 列模型（modelKey）
libtv model <modelKey>            # 拉模型参数 schema（-s 只能写 schema 内的键）
libtv node create "<名>" -t video --prompt "..." --left <上游> -s model="StarVideo 2.0" \
  -s modeType=image2video -s ratio=16:9 -s resolution=720p -s duration=8 -s enableSound=off --run
libtv node "<名>"                 # 查询/更新节点（不存在时输出含 count:0 / matches:[]）
```

关键语义：

- `-s k=v` 写 `data.params.*`（生成参数，走模型 schema 校验）；`-u k=v` 写节点自身属性。
- `--left` 连线顺序 = 上游引用顺序，prompt 里用 `{{Image 1}}`、`{{Image 2}}` 引用。
- `-s model=` 要**显示名**（如 `StarVideo 2.0`），schema 查询用 **modelKey**（`star-video2`）。显示名会改版（实测 Seedance 2.0 VIP → StarVideo 2.0），modelKey 更稳定。
- `node create --run` 前台调用可能超时但后端作业继续——超时后先查同名节点再决定重试。

### 1.3 StarVideo 2.0 schema（CLI 1.0.2，2026-08-05 审计）

| 参数 | 允许值 |
|---|---|
| `model` | `StarVideo 2.0`（显示名） |
| `modeType` | `text2video` / `singleImage2video` / `frames2video`(1-2图) / `image2video`(1-9图) / `mixed2video`(1-15项) / … |
| `ratio` | adaptive / 16:9 / 4:3 / 1:1 / 3:4 / 9:16 / 21:9 |
| `resolution` | 480p / 720p / 1080p / 4k |
| `duration` | 4–15 秒 |
| `enableSound` | on / off |

生图模型：`nebula-ultra`（编辑/一致性强）、`seedream-4`（中文文字渲染强）等；图像节点实测用法只带 `-s model=<显示名> -s aspectRatio=16:9`。

### 1.4 能力边界与风险

- 登录只能浏览器/手机验证码，**服务端必须离线注入 credentials.json**（见下文）。
- 真人合规墙：含真人形象的参考图会被视频模型硬拦（CG 化也拦不住），需平台官方授权校验。
- 生成消耗 LibTV 账号积分；每次生成计费在平台侧。
- 节点/模型查询的输出格式官方未公开，状态字段是社区逆向结论，平台改版可能导致解析失效（本接入已做防御式解析 + 明确报错，见 2.4）。

## 2. Toonflow 接入设计

### 2.1 总体

按渠道接入 SOP（docs/vendor-integration-guide.md）落成标准 vendor：

- `src/vendors/libtv.ts` — 适配器，全部能力通过子进程调用 CLI 实现，不拼任何 HTTP。
- `src/vendors/index.ts` — 注册 `libtv`。
- `src/lib/initDB.ts` — 全新环境的 `o_vendorConfig` 初始行（enable=0）。
- `init-libtv-db.ts` — 已有环境的一次性幂等脚本：`npx tsx init-libtv-db.ts`。
- `test-libtv-cli.ts` — 离线冒烟测试：假 CLI 驱动完整链路（登录→建项目→解析显示名→上传参考→建节点→轮询→解析结果 URL），无需真实账号。

### 2.2 模型协议目录（Layer1）

| 目录 modelName（稳定标识） | LibTV 侧 | 类型 | 模式 |
|---|---|---|---|
| `star-video2` | StarVideo 2.0 | video | text / singleImage / startEndRequired / 多参考 imageReference:9 |
| `nebula-ultra` | Nebula Ultra | image | text / singleImage / multiReference |
| `seedream-4` | Seedream 4 | image | text / singleImage / multiReference |

目录 `modelName` 刻意用 **modelKey** 而不是显示名：创建节点的 `-s model=` 显示名在运行时通过 `libtv model search` 实时解析（10 分钟缓存），LibTV 改显示名不会导致协议目录失效；解析失败时落到内置映射（`KNOWN_MODEL_NAMES`），再失败则报可操作错误。

### 2.3 服务端凭据方案

CLI 凭据只能浏览器登录产出，Docker 服务端无法交互登录。方案（vendor 设置页四项输入）：

| 输入 | 说明 |
|---|---|
| CLI 可执行文件路径 | 默认 `~/.libtv/libtv`，找不到时报安装命令 |
| 登录凭据（credentials.json 内容） | 在任意有浏览器的机器 `libtv login web`，把 `~/.libtv/credentials.json` 完整内容粘进来。字段名含 token，存库自动加密。vendor 写入 `<homeDir>/.libtv/credentials.json` 并以 `HOME=<homeDir>` 启动 CLI 子进程 |
| CLI HOME 目录 | 默认 `<数据目录>/libtv/home`（Docker 卷内，重建容器不丢） |
| 画布绑定目录 | 默认 `<数据目录>/libtv/work`，CLI 的 `project use` 绑定写在这里 |
| 画布项目 ID | 留空自动 `project create "Toonflow"` 并绑定；也可手工填网页画布 URL 里的 projectId |

凭据过期时（时效未知），重新登录并粘贴一次即可。每次生成前跑一次 `libtv account info` 校验（结果缓存 10 分钟）。

**无状态 Pods 部署**：凭据的 source of truth 不在 pod 本地——设置页字段加密存 MySQL（库在集群外，pod 重建不丢），pod 里的 credentials.json 是每次 CLI 调用前重新物化的临时文件。也可改用环境变量 `LIBTV_CREDENTIALS`（如 K8s Secret 注入）承载同样内容，优先级：设置页 > 环境变量；或用 Secret 卷挂载一个含 `.libtv/credentials.json` 的目录，把「CLI HOME 目录」指向它。

### 2.4 生成链路与防御式解析

```
videoRequest/imageRequest
  → account info（登录检查，缓存 10min）
  → project use（绑定画布项目，进程内 promise 锁防并发重复绑定）
  → model search 实时解析显示名
  → 参考图 base64 落盘 → libtv upload（NDJSON 提取 newNodeKey，--left 用 key）
  → node create --run（180s 前台超时；超时不判定失败，转入 create-then-verify）
  → 轮询 libtv node <名>（视频 10s×30min，图片 5s×10min，复用 pollTask 引擎）
  → 解析结果 URL → 返回给 ai.ts（urlToBase64 → MinIO，与其它渠道一致）
```

`libtv node` 的输出格式官方未公开（社区审计只给出「不存在时含 count:0/matches:[]」）。解析器按以下启发式实现，解析不出时把原文片段抛进错误信息，便于第一手校准：

- 状态字段名匹配 `status|state|taskStatus|…`，取值按 success/failed 词表归类；
- 结果 URL 按「扩展名匹配 + 键名/路径加权 + 输入引用字段降权」打分选取（视频要 .mp4，图片要图片扩展名）。

**首次真实生成后建议人工核对一次解析结果**（跑 `libtv node <节点名>` 对照），如字段对不上，改 `parseNodeOutput` 即可。

### 2.5 验证

- `npx tsx test-libtv-cli.ts` — 假 CLI 冒烟：断言参数拼装、显示名解析（JSON 数组/对象两种形态）、状态轮询、结果 URL 提取、参考图临时文件清理、越界参数裁剪（duration 20→15、8k→720p）。
- `yarn lint`（tsc --noEmit）通过。
- 真实账号验收（需要管理员）：设置页启用渠道 → 粘贴凭据 → 启用模型 → 模型测试里跑 imageTest/videoTest。

## 3. 未决问题（需产品/管理员确认）

1. **积分消耗归属**：LibTV 生成消耗的是渠道配置里那个 LibTV 账号的积分，是否接受全员共享一个账号？
2. **画布项目隔离粒度**：当前全渠道共用一个 Toonflow 画布项目；如果要按 Toonflow 项目隔离，需要把 projectId 输入扩展到调用级（当前 vendor inputs 是渠道级配置）。
3. **节点清理策略**：生成的节点保留在 LibTV 画布上作为历史记录，画布会持续膨胀；如需自动清理要加开关（LibTV 侧无批量删除 API，只能逐节点 `node delete`）。
4. **旧 OpenAPI 路线**：libtv-labs/libtv-skills 的 IM-OpenAPI（LIBTV_ACCESS_KEY）被 2026-08 审计标记为废弃，未采用；如果官方恢复 token 化 OpenAPI，可以替换子进程方案去掉凭据注入的麻烦。

## 4. 用户自助绑定（方案 A：短信验证码流）

用户在自己的浏览器页面里完成 LibTV 账号绑定，全程不需要终端：

```
设置页「绑定 LibTV 账号」→ 输入手机号 → [发送验证码]
→ 收到 LibTV 短信 → 填入 6 位验证码 → 提交 → 绑定成功
```

- 后端 `src/utils/libtvBinding.ts` 驱动 CLI 两步流（1.0.2 实测契约）：
  `libtv login phone -p <手机号>` 发短信 → `libtv login phone -p <手机号> -c <验证码>` 完成登录 →
  凭据落在该用户专属 HOME（`<数据目录>/libtv/home/<userId>/.libtv/credentials.json`）→
  `account info` 验活 → 加密存入 `o_vendorAccount`（userId + 'libtv'）。
- 方案 B 保底：`bindCredentials` 接口支持粘贴 credentials.json 内容（JSON 校验 + 验活后同样落库）。
- 调用链（`src/utils/ai.ts getVendorTemplateFn`）：该用户在 `o_vendorAccount` 有绑定时，用户级输入项覆盖渠道全局值，并把 `userId` 注入 vendor——libtv vendor 据此把 HOME/work 目录按用户隔离（`libtv/home/<uid>`、`libtv/work/<uid>`），画布项目也按用户各自绑定，互不串号。其它渠道不受影响（仅 libtv 启用合并）。
- 接口：`/api/setting/vendorConfig/libtv/{sendSms,verifySms,bindCredentials,unbind,bindingStatus}`（登录用户自助，绑定状态不回显凭据）。
- 已知限制：验证码短信可能触发 LibTV 人机验证（`--captcha`），此时发送失败并提示改用方案 B；凭据时效未知，失效后重新绑定即可。

## 5. 快创模式接入（模型选择 + 资源导入 + 错误卡片）

### 5.1 模型选择器里的 LibTV（权益入口）

- LibTV 模型一旦进协议目录并启用，就自然出现在所有模型选择器里（快创/塑角造景/视频生产共用 `modelSelect` 组件），不需要为快创写专门后端。
- 选择器对 LibTV 渠道做了权益标识：未绑定时模型行显示「消耗我的 LibTV 积分」；已绑定显示绿点「已绑定」（绑定状态来自 `/setting/vendorConfig/libtv/bindingStatus`）。
- **未绑定时选中 LibTV 模型不阻断**：就地弹出绑定小浮层（`openLibtvBindDialog`，复用绑定向导的同一组接口，手机号验证码主打 + 粘贴凭据保底），绑定成功自动恢复刚才的选择；点「换用平台模型」则清掉选择。

### 5.2 「从 LibTV 导入」（存量资源收编）

方向是把用户在 LibTV 的存量**拉进来**，不是把我们的内容推上去。一次性收编、只读不写回，不回读生成历史/积分。

```
素材中心/素材选择器 → 「从 LibTV 导入」标签（置顶）
  → project list 列画布项目 → project <id> 回读产物节点（图/视频/音频，缩略图+时间）
  → 勾选 → 下载存 MinIO → o_assets（type=clip）+ o_image 落库
  → remark 打「来源: LibTV」标并携带节点 key（幂等：重导同一节点自动跳过）
```

- 后端 `src/utils/libtvImport.ts`：用户级凭据（与绑定共用 per-user HOME），`listUserProjects` / `getProjectNodes` / `importNodes`；画布节点 JSON 未公开，解析是防御式的（只收有产物 URL 的节点，类型按声明+扩展名双判定）。
- 接口：`/api/setting/vendorConfig/libtv/{projects,projectNodes,importAssets}`（登录用户自助）。
- 前端入口：`Toonflow-web/src/views/assets/components/libtvImport.vue`，素材中心与素材选择器弹窗共用。

### 5.3 错误卡片（说人话 + 下一步动作）

vendor 抛出的失败带机器可读前缀 `[LIBTV:<CODE>]`（`LibtvError`），随 `errorReason` 落库/下发；前端 `parseLibtvError` 解析后由 `libtvErrorCard.vue` 渲染带动作的卡片，已接入塑角造景（卡片失败态/详情抽屉）与视频生产（失败镜头悬浮卡）：

| 后端失败 | 卡片 | 动作 |
|---|---|---|
| NOT_BOUND / AUTH_EXPIRED（account info 401） | 「LibTV 授权已过期」 | [重新绑定]（就地浮层）/ [换平台模型] |
| INSUFFICIENT_CREDITS | 「你的 LibTV 积分不足」 | [去 LibTV 充值]（外链）/ [换平台模型] |
| COMPLIANCE_REJECTED（真人合规墙） | 「参考图含真人形象被平台拒绝」 | [替换参考图] / [换模型] |
| GENERATION_TIMEOUT（30 分钟） | 「生成时间较长，已转入后台」 | [查看任务中心]，镜头位保留占位 |

分类是启发式的（`classifyLibtvFailure`，CLI 输出格式未公开），按关键词匹配积分/合规/401/超时，miss 归 UNKNOWN。

### 5.4 周边能力

- **节点清理开关**：渠道设置「生成后清理临时节点」（`deleteNodeAfterGen`，填 1 开启）。走**延迟队列**——产物 URL 的下载发生在 vendor 返回之后，立即删节点有断链风险，所以成功生成后先登记（`pending-node-cleanup.json`，上限 50），下一轮生成开始时再删；画布最多滞留一轮的临时节点。
- **模型目录桥**：admin 在 LibTV 渠道设置点「同步模型目录」（`/setting/vendorConfig/libtv/syncModels`）→ `model search -t image/-t video` 全量同步进协议目录。同步条目默认**不启用**（不动 enabledModels）；策略：能官方直连的模型走直连渠道，LibTV 只承接差集模型。精编三模型（star-video2/nebula-ultra/seedream-4）保留原样不被覆盖。
- **暂缓**（等快创主链路跑顺、有真实需求再加）：script→分镜表节点（`script storyboard`）、音频/配乐节点（`-s scene=Music`）；video-clip 终剪节点维持不做（平台终剪不如本地 ffmpeg 可控，Toonflow 有自己的视频工作台）。

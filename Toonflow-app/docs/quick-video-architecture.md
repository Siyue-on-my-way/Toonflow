# 单视频快创（Quick Video）架构与业务链路

本文记录当前源码对应的 Quick Video 全链路，供接手开发、排障和验收使用。快创是新增的 `quick_video` 项目类型，与小说/专业模式并行；它复用项目、脚本、资产、图片、视频和视频轨道表，但不改变专业模式的路由或状态。

## 1. 组件边界

```text
Toonflow-web/src/views/quickVideo/index.vue
  ├─ 左侧会话：SessionList + t-chat-list + t-chat-sender
  ├─ 侧边栏模块：会话 / 简报 / 分镜 / 资产白板 / 预览导出
  ├─ 产物：brief、storyboard、生成进度、首帧绑定
  └─ timelinePlayer：AVCanvas 预览、字幕、BGM、转场、MP4 导出
              │ REST（状态/媒体/确认） + Socket.IO（聊天流）
              ▼
Toonflow-app
  ├─ routes/quickVideo：项目、工作台、确认门、资产、时间线、重试
  ├─ socket/routes/quickVideoAgent.ts：鉴权、会话归属、聊天中止/重连
  ├─ agents/quickVideoAgent：提示词 + 受限 JSON Schema 工具
  └─ lib/quickVideo：契约、事务状态机、生成引擎、MinIO/媒体、时间线
              │
              ├─ MySQL：o_project / o_script / o_agentWorkData / o_quickVideoSession
              │         o_quickVideoMedia / o_assets / o_image / o_video / o_videoTrack
              └─ MinIO：图片、视频和素材文件；接口按需签发临时访问地址
```

前端只把 `o_agentWorkData` 的聚合结果作为右侧产物来源，不尝试从 Socket 聊天文本推断简报或分镜。Agent 工具写库后，聊天结束、Socket 错误和生成轮询都会触发工作台刷新；这样消息流和结构化白板各自有明确的事实来源。

## 2. 数据契约与兼容性

- `o_project.projectType = "quick_video"` 是入口判定；专业项目仍走原有 `/novel`、`/script`、`/production` 链路。
- `o_agentWorkData.key = "quickVideoAgent"`，`data` 是版本化 JSON。服务端唯一写入口是 `mutateQuickVideoState`（`src/lib/quickVideo/state.ts`）。
- 当前 `schemaVersion = 1`。状态缺少后续新增的 `generation` 字段时，Zod preprocess 会补默认值，保证存量状态可读。
- 状态写入同时具备：行锁事务、`expectedVersion` 乐观锁、`idempotencyKey` 去重、阶段白名单和最终 schema 校验。前端收到版本冲突时必须重新调用 `getWorkbench`，不能盲目覆盖。
- `generation.snapshot` 是素材/成本确认门冻结的输入快照，包含镜头内容、资产解析结果、预估值和首帧 `filePath`。生成过程不读取会变化的草稿分镜。
- `generation.timeline.trackIds` 只记录最近一次快创装配生成的 `o_videoTrack` 行。重新装配新分镜版本时，事务会按这些明确 ID 删除旧轨道，再创建新轨道，不会按项目清空轨道，避免误伤专业模式数据。

### 阶段状态机

| 阶段 | 含义 | 主要写入者 | 下一步 |
| --- | --- | --- | --- |
| `collect_brief` | 收集/修改简报 | Agent 或用户编辑 | 用户确认简报 |
| `brief_confirmed` | 简报已通过确认门 | 用户 | Agent 提交分镜 |
| `storyboard_draft` | 分镜可编辑草稿 | Agent 或用户编辑 | 用户确认分镜 |
| `storyboard_confirmed` | 分镜冻结、待解析素材 | 用户 | 解析并确认素材/成本 |
| `generating` | 逐镜头生成 | 用户确认后启动，Agent 可幂等重启 | 全部成功或单镜重试 |
| `ready_to_assemble` | 全部图片/视频镜头完成 | 生成引擎 | 获取时间线并预览 |
| `completed` | MP4 已下载且导出结果已回写 | 用户导出确认 | 终态 |

确认门只允许用户操作。Agent 只能提醒，不会调用 `confirmStage` 代替确认。

## 3. 创建到分镜确认

1. 项目页选择单视频快创，填写标题、画风、比例（`16:9` / `9:16` / `1:1`）和目标时长（15 / 30 / 60 秒）。`POST /api/quickVideo/createProject` 在一个事务内创建 `o_project`、可选的 `o_script`、状态行和默认 `o_quickVideoSession`，带 `idempotencyKey` 防止重复项目。
2. 前端进入 `/quickVideo` 后先调用 `getWorkbench`，再调用 `listSessions`；确定会话后才建立 `/socket/quickVideoAgent`，然后从 `/agents/getMemory` 恢复聊天记录。
3. Socket 握手携带 `projectId + sessionId + token`。服务端验证用户、项目会话归属后才构造隔离键 `projectId:quickVideoAgent:sessionId`，客户端不能直接传入记忆隔离键。
4. 用户输入一句话、草稿脚本或附件。`QuickVideoAgent` 读取 `data/skills/quick_video_agent.md`、项目状态和会话记忆，先调用 `get_state`，再按需要调用：
   - `update_config`：修改项目配置；生成开始后锁定画风、比例和目标时长。
   - `save_brief`：写入主题、钩子、叙事、CTA、关键词，并重置简报确认状态。
   - `propose_storyboard`：替换式提交完整分镜；镜头字段和数量/总时长由 schema 与 `validateStoryboard` 双重校验。
   - `update_shot` / `add_shot` / `remove_shot`：只允许在草稿阶段修改。
   - `bind_asset`：以 `role/scene/tool + name` 去重绑定视觉资产引用。
   - `get_generation_status` / `generate_shots`：查询或幂等触发生成；不能跨过确认门。
   - 聊天模式切换为图片或视频后，才分别暴露 `generate_image` / `generate_video`；模型 key 和媒体引用由服务端校验。
5. 每个工具调用通过 `mutateQuickVideoState` 落库，并以 Socket `message`、`content:add`、`content:update`、`message:update` 事件流式回传思考/结果。前端收到助手消息完成、Socket 错误或连接恢复时刷新聚合工作台。

## 4. 三道确认门与生成恢复

### 门 1：简报

`POST /api/quickVideo/confirmStage`，`gate=brief`：

- `confirm`：`collect_brief/storyboard_draft -> brief_confirmed`，必须已有简报。
- `reject`：回到 `collect_brief`，简报保留但标记为未确认。

### 门 2：分镜与素材/成本

- `gate=storyboard, action=confirm`：检查镜头数量、每镜 5-15 秒和总时长误差，`storyboard_draft -> storyboard_confirmed`。
- `POST /api/quickVideo/resolveAssets`：按项目和名称匹配 `o_assets + o_image`，排除聊天媒体伪装资产，生成素材清单和成本/耗时估计；首帧文件失效会明确报错，不静默换图。
- `gate=materials, action=confirm`：若快照缺失或分镜版本变化，服务端现场重建快照；写入 `materialsConfirmed` 后进入 `generating`，随后启动后台生成。
- `reject`：取消素材确认，停在 `storyboard_confirmed`，允许重新解析。

### 逐镜头生成与重试

`src/lib/quickVideo/generate.ts` 的管线是：补齐缺失素材图 → 镜头分镜图 → 单图/首帧输入的视频片段。项目级并发为 2；每个镜头独立 try/catch，成功镜头不会因其他镜头失败而重跑。`POST /api/quickVideo/retryShot` 只重置目标镜头尚未完成的部分，支持一次重试多个镜头，已完成镜头会被拒绝。

生成运行 ID、镜头状态、失败原因和产物 OSS key 都写入状态。模型未配置、首帧失效、供应商超时等异常会把对应图片/视频状态收敛为 `failed`，避免 `image=failed, video=pending` 这种无法判断的卡死态。

`getWorkbench` 每次读取前调用 `ensureGenerationRecovery`：

- 进程内仍有运行时不干预；
- 没有运行且所有镜头 done，推进到 `ready_to_assemble`；
- 服务重启前停在 `pending` 或 `generating` 的镜头统一标记 failed，并给出可重试原因；
- 缺失生成快照时把当前未完成镜头标记 failed，而不是让项目无限显示 generating。

### 门 3：导出

`POST /api/quickVideo/getTimeline` 只允许 `ready_to_assemble/completed`。它使用后端纯函数按镜头顺序计算裁剪、变速、0.5 秒 crossfade、CTA 片尾补齐和字幕 cue，第一次或分镜版本变化时记录 `o_videoTrack` 与 `generation.timeline`。

浏览器拿到完整镜头 URL 后，用户在预览面板确认导出：

1. `timelinePlayer` 按真实视频元数据重新计算时间线，防止供应商实际时长与规划时长不同造成错位。
2. `AVCanvas` 添加 NativeVideoClip、字幕层、可选 BGM 和片尾卡；原视频音轨不作为输入，当前产品使用从 0 秒开始、循环铺满成片的合成 BGM。
3. `createCombinator` 在浏览器端编码 MP4；导出尺寸限制为最长边 320px 的软件友好档，5fps 仅用于当前低资源 Chromium 兼容路径，预览画布仍使用项目比例。
4. 用户点击取消时同时取消输出 reader 并销毁 combinator；加载新时间线或离开页面也会取消旧导出。导出 finally 会解绑事件、恢复 sprite 几何、释放帧缓存和源 clip。
5. 编码成功先触发浏览器下载，再以 `gate=export` 回写文件名、字节数和实际时长，`ready_to_assemble -> completed`。

字幕 cue 避开 crossfade 重叠区，并按画布尺寸计算字号；长台词先规范空白，再限制为最多三行的字符上限并加省略号，避免溢出画布。BGM 的 `AudioClip` 从 0 秒开始，时长严格等于装配后的总时长，音量变化会重建单一音频 sprite，避免多条音频轨叠加。

## 5. 前端工作台交互

原先聊天、简报、分镜、资产和预览同时压在两个窄 pane 中。当前 `/quickVideo` 改为左侧窄导航 + 右侧单模块大屏：

- **会话**：保留聊天流、会话列表、模型选择和停止生成。
- **创意简报**：查看/编辑简报、第一道确认门。
- **分镜表**：查看镜头描述、台词、资产、首帧和生成状态；草稿时编辑/增删/绑定首帧。
- **资产白板**：分页查看项目媒体，复制稳定 `mediaId`，为草稿镜头设置或解除首帧。
- **预览/导出**：生成进度、失败镜头重试、时间线预览、字幕/BGM/转场和第三道确认门。

导航切换只改变展示面板，不清空状态或重新创建 Socket。离开路由时 `quickVideoStore.dispose()` 停止轮询、清理标题补刷定时器和 Socket；再次进入时 `resume()` 恢复生成轮询，Socket 会重新握手当前会话。工作台请求有去重与错误提示，避免轮询、Socket idle 刷新和手动刷新互相覆盖。

## 6. 主要接口索引

| 用途 | 接口 |
| --- | --- |
| 项目/会话 | `createProject`, `listSessions`, `createSession`, `updateSession`, `updateModels` |
| 聚合状态 | `getWorkbench`, `getMemory` |
| Agent 结构化产物 | Socket `/socket/quickVideoAgent` |
| 配置/简报/分镜 | `updateConfig`, `updateBrief`, `addShot`, `updateShot`, `removeShot`, `bindShotFirstFrame` |
| 确认门 | `confirmStage`，`gate=brief/storyboard/materials/export` |
| 素材/生成 | `resolveAssets`, `retryShot`, `getAssetBoard`, `getMediaUrls` |
| 装配 | `getTimeline` |
| 诊断 | `getMetrics` |

所有接口都在 `Toonflow-app/src/router.ts` 注册为 `/api/quickVideo/*`。媒体访问地址由 MinIO helper 按需签发，前端不把短期 URL 写回状态。

## 7. 排障清单与当前限制

1. 右侧数据不更新：先看 `getWorkbench` 是否返回新 `state.version`，再看 Socket 是否触发 idle/error 刷新；不要以聊天文本判断数据库状态。
2. 页面显示 generating 但没有任务：刷新工作台触发恢复对账；确认镜头是否已变成 failed，再点击单镜头重试或让 Agent 幂等调用 `generate_shots`。
3. 首帧/参考图异常：检查 `o_quickVideoMedia` 的项目归属、kind=image、state=done 以及绑定的 `o_image.filePath`；失效首帧必须解除或重新绑定。
4. 导出失败：先在预览面板重新装配，确认各 `videoUrl` 可下载；Chromium 没有 AAC 编码能力时会关闭音频轨，视频仍可导出。软件编码档适用于当前兼容性路径，若恢复更高分辨率必须重新评估客户端内存与 WebCodecs 能力。
5. 专业模式不应读取 `quickVideoAgent` 状态，也不应依赖快创的 `o_videoTrack.reason = "quickVideo 时间线装配"`；所有快创路由均先检查 `projectType`。

## 8. 验证入口

- 前端纯函数/状态：`cd Toonflow-web && yarn vitest run src/stores/__tests__/quickVideo.spec.ts src/views/quickVideo/__tests__/timelineCore.spec.ts --config vitest.config.ts`
- 前端构建：`cd Toonflow-web && yarn build-only`（资源较多时需提高 Node heap）。
- 后端时间线/契约：`cd Toonflow-app && yarn tsx scripts/quickvideo-timeline-unit.ts`。
- 后端会话/媒体纯测试：`yarn tsx scripts/quickvideo-session-unit.ts`、`yarn tsx scripts/quickvideo-media-unit.ts`。
- 真实闭环：启动 MySQL、MinIO、后端和前端后运行 `scripts/quickvideo-e2e.ts`；恢复路径使用 `scripts/quickvideo-recovery-check.ts`。真实供应商生成和 MP4 编码仍取决于本地模型、对象存储与浏览器 WebCodecs 能力。

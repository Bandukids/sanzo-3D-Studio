# SANZO 3D Studio

用一句话或一张图生成 3D 资产的网站，与 [SANZO Music](https://sanzomusic.com/) 共用蓝橙品牌语言。首页保留深色 3D 主视觉，工作区采用冰蓝玻璃界面，并支持浅色 / 深色主题。
生成能力来自腾讯云 TokenHub 上的闭源模型：**混元 3D**（3.1 / 3.0 / Express）与 **Tripo 3D**（3.1 / P1）。

## 运行

需要 Node.js 20+。

```bash
npm install
```

```bash
npm start
```

打开 <http://localhost:5173>。

## 新版工作空间

| 页面 | 用途 |
| --- | --- |
| `/` | 品牌首页，描述与灵感模板可带入创作空间 |
| `/create/` | 文生 / 图生模型，基础参数与高级设置分层 |
| `/studio/` | 外部模型绑骨、文生动作，以及已有资产的后续加工 |
| `/assets/` | 搜索、排序、项目筛选、重命名、版本记录与回收恢复 |
| `/tasks/` | 查看任务状态与历史结果 |
| `/settings/` | 主题与服务连接状态 |

一个模型及其绑骨、动画任务归为一项资产；详情内保留每个版本的预览入口和文件下载。回收操作仅隐藏资产，恢复后保留完整版本与本地文件。已有任务会自动参与分组，无需迁移数据。

桌面上生成按钮固定在参数面板底部，模型舞台与加工面板持续可见；手机切换「创作参数 / 模型预览」，侧栏通过菜单展开。主题和文字草稿会保存在当前浏览器，本地上传的图片不会保存到草稿。

### API Key

服务端按顺序读取 `TOKENHUB_API_KEY` → `HUNYUAN_3D_API_KEY` → `TENCENT_HUNYUAN_API_KEY`，
来源可以是系统环境变量，或项目根目录的 `.env`（参考 `.env.example`）。
Key 只在服务端使用，不会下发到浏览器；服务只监听 `127.0.0.1`。

没有 Key 时自动进入**演示模式**：完整走一遍「提交 → 排队 → 生成 → 预览」流程，但结果是内置示例，不调用 API。
有 Key 时也可以在创作台手动打开演示模式来调界面。

### 验证与隔离演示

```bash
npm test
npm run preview:demo
```

测试覆盖资产分组、版本分支、筛选、回收恢复、页面直达与元数据保存，使用独立的临时数据目录。隔离演示运行于 <http://localhost:5174>，使用 `output/demo-preview/`，强制禁用生成凭证，不会修改现有 `data/`。可通过 `SANZO_DATA_DIR` 指定独立存储目录，通过 `PORT` 修改端口。

## 结构

```text
server.mjs          零框架后端：静态站点 + TokenHub 代理 + 任务/文件存储
public/index.html   品牌首页与工作区视图
public/css/style.css       首页与基础组件
public/css/workspace.css   工作区、主题与响应式布局
public/js/hero.js   首页实时 3D 主视觉（玻璃丝带、线框、星尘、辉光）
public/js/viewer.js 创作台预览器（待命 / 全息粒子 / GLB / FBX / 骨架与动画）
public/js/shell.js  页面路由、主题与手机导航
public/js/asset-data.js    资产分组与筛选
public/js/library.js       资产、任务与版本详情交互
public/js/main.js   表单、草稿、任务轮询与加工管线
tests/              资产逻辑与后端集成测试
scripts/preview-demo.mjs   隔离演示启动器
data/               运行时生成：tasks.json 与下载到本地的模型（已 gitignore）
```

## 接口

| 路径 | 说明 |
| --- | --- |
| `GET /api/config` | 是否已配置 Key、可用模型列表 |
| `GET /api/check-auth` | 读取 TokenHub 模型目录校验 Key，不消耗额度 |
| `POST /api/generate` | 提交生成任务（`mode` `model` `prompt` `imageBase64` `imageUrl` `pbr` `geometry` `faceCount` `demo`） |
| `POST /api/rig` | 绑骨（`sourceId` 或 `fileUrl`，`engine`: `hunyuan` / `tripo`，混元可带 `motionType` 1–48 动作模板） |
| `POST /api/animate` | Tripo 预设动画（`sourceId` 为已完成的 Tripo 绑骨任务，`preset`） |
| `POST /api/motion` | 混元文生动作（`prompt` ≤128 字，`duration` 1–12 秒） |
| `GET /api/tasks` · `GET /api/tasks/:id` | 任务列表 / 查询并推进单个任务 |
| `PATCH /api/tasks/:id` | 更新名称 `title`、所属项目 `collection`、回收状态 `trashed`；不会改动模型文件 |
| `DELETE /api/tasks/:id` | 删除本地记录与文件（不会取消云端任务） |

新版资产库使用 `PATCH` 回收与恢复，不调用永久删除接口。

上游统一走 `POST /v1/api/3d/submit` 与 `POST /v1/api/3d/query`。任务完成后，服务端会立刻把签名链接里的模型和预览图
下载到 `data/assets/<任务ID>/`（上游任务 ID 与链接只保留 24 小时）。

## 管线：建模 → 绑骨 → 动作

创作台预览区下方的「管线」面板会根据当前打开的任务给出下一步：

- **混元**：`hy-3d-rigging` 一次任务完成绑骨，并可同时套用 48 个人形动作模板之一，输出 FBX。换动作需要重新提交绑骨。
- **Tripo**：`tripo-3d-rigging` 先绑骨，再用绑骨任务的云端 ID 调 `tripo-3d-animation` 套预设动画。
- 两家引擎可以交叉使用（例如混元生成、Tripo 绑骨）。
- 预览器支持 GLB / FBX，可显示骨架、切换并播放动画片段。

绑骨的输入必须是上游能访问的 HTTPS 链接。对本站生成的模型，服务端会向上游重新查询来源任务，拿新的签名链接；
因此**绑骨和加动画要在来源任务生成后的 24 小时内进行**。站外模型用左侧「模型绑骨」提交公开链接。

## 已知边界

- **已实测**：混元 Express 文生模型 → 混元绑骨 + 动作模板（走路-1），FBX 在预览器里骨架、贴图、动画均正常。
- **尚未实测**：Tripo 绑骨与动画、混元文生动作、混元专业版 3.1 / 3.0、图生模型、仅绑骨不加动作。这些只用演示模式验证过界面流程。
- 混元动作模板只适用于 A / T Pose 的人形角色；非人形只能绑骨。
- Tripo 动画预设在 TokenHub 文档里只确认了 `walk`，其余预设名来自 Tripo 官方 API，可能被拒绝。
- 混元文生动作生成的是自带标准人形的独立动画；重定向到自定义角色的请求结构官方未公开，没有接入。
- 减面、格式转换、纹理重生成、UV 展开尚未接入。

- **提交只发一次**：提交超时或没有返回任务 ID 时不会自动重试，避免重复扣费，请先到 TokenHub 控制台核对。
- **Tripo 图生 3D 只支持图片 URL**，不支持本地上传（上游接口限制）。
- **Tripo 的返回结构官方未公开**，服务端按通用规则解析任务 ID 与下载链接；首次真实调用后如有出入，调整 `server.mjs` 的 `collectResults`。
- 混元专业版的白模使用 `generate_type: "Geometry"`（依据服务端报错信息，尚未实测）。
- 在线预览支持 GLB / glTF / FBX；其他格式提供下载。
- 多数 3D 模型默认并发为 1，前一个任务结束后再提交下一个。

API 细节参考 [hunyuan-3d-skills](https://github.com/Bandukids/hunyuan-3d-skills) 与 [tripo-3d-skills](https://github.com/Bandukids/tripo-3d-skills)。

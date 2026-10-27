# dsh-fdehub

**FDE 工坊 + 场景市场** — 给 DeepSeek Harness（`dsh`）的插件。

FDE（Forward Deployed Engineer，驻场交付工程师）最费时间的不是写代码，是**从现场把业务讲清楚**：听两小时会、收一堆表格，然后在一晚上回答「业务怎么跑 → 卡在哪 → AI 能插哪一步 → 两周能验什么」。

这个插件把这条链路压成三步：**录音/上传 → 转写取文 → 结构化蓝图**，并把每次梳理沉淀成可复用的场景卡，进市场给下一个人用。

```
现场录音 ─┐
上传音频 ─┼→ 转写 / 取文 → 业务现状 → 痛点(带证据) → AI 机会点(插入点+人工兜底+判定指标)
业务文件 ─┘                                    → PoC / 试点 / 推广路径 → 待确认问题
                                                                    ↓
                                                            场景卡 → 市场 → 下一个项目
```

## 和已有的 dsh 插件有什么区别

开工前查过一圈，dsh 生态里和「录音」相关的插件已经有几个，但都停在**转写与归档**，没有走到业务侧：

| 项目 | 做什么 | 与本插件的关系 |
| --- | --- | --- |
| `dsh-voice-memo` | 口述归档：音频 + 波形图 + 带时间戳的笔记 | 互补。它解决「录音留在工作区」，本插件解决「录音变成方案」 |
| `dsh-plugin-local-voice` | 本地实时转写浮窗（Apple Silicon + Qwen3-ASR） | 互补。它的转写结果可以直接粘进本插件的材料 |
| `dsh-asr-plugin` | 会议转写 + 说话人标签 + `@会议` 让 agent 总结 | 部分重叠（都做转写）。它做会议记录，本插件做业务建模与场景沉淀 |
| `dsh-market` / `dshmarket` | 通用插件市场 | 形态不同。它分发**插件**，本插件分发**AI+业务场景卡** |

**没有找到**把「现场录音/材料 → 业务与 AI 逻辑 → 可复用场景资产」这条链打通的现成开源项目，所以自己写了一个。转写层不重造轮子：宿主有语音服务就用，没有就接本地命令，都没有就如实标注「未转写」。

## 安装

```sh
# 从本地目录（开发用）
dsh plugin --profile desktop add link:/path/to/dsh-fdehub

# 从 GitHub（发布后）
dsh plugin --profile desktop add github:<owner>/dsh-fdehub
```

装完重启 DSH，左侧栏会出现两个入口：**FDE 工坊**、**场景市场**。

## 用法

### 一、工坊：一次现场梳理

1. **新建案例** → 填客户、域、补充背景（这次要解决什么、谁在场）；
2. 采集材料，三种方式随便混用：
   - **现场录音**：浏览器里按一下开始，再按结束，自动上传并转写；
   - **上传音频 / 业务文件**：`wav/mp3/m4a/webm/mp4` 走转写；`pdf/docx/pptx/xlsx/txt/md/csv` 走取文；图片与扫描版 PDF 走**宿主模型识图**（见下）；
   - **粘贴文字**：没有转写引擎时的正路——把纪要贴进来一样能分析；
3. 点 **梳理业务 + AI 逻辑**，得到：
   - 业务现状：角色与卡点、流程、系统、数据资产、可量化指标；
   - 痛点：每条挂**证据**（原话/材料事实）与影响，带严重度；
   - AI 机会点：AI 形态、**插入点**、输入/输出、**人工兜底**、可行性×价值、工作量、**判定指标**、缺什么数据、要对接什么、风险；
   - 落地路径：PoC / 试点 / 推广各自的范围、天数、交付物、判定标准；
   - **必须回客户确认**与**这次材料没覆盖的**——不知道就写不知道，不猜；
4. **导出 Markdown**：一份能直接贴进飞书/Word 的蓝图，不依赖插件。

#### 图片与扫描件：OCR 用宿主自己的模型

不打包 tesseract 之类的识别引擎（几百 MB，还和宿主的模型能力重复），直接走 `ctx.llm` 的当前路由：

- 图片（`png/jpg/webp/heic/tiff`）直接用；
- 扫描版 PDF 先用 `pdftoppm` 渲染前 N 页（默认 5 页）再逐页识图；
- 提示词只要求「抄字」：表格还原成 Markdown、手写看不清用 `□`、无文字回 `NO_TEXT`；
- 触发时机是「文本抽取拿不到内容」之后，不额外消耗；
- 模型不支持图片输入时**明确报错**「换一个多模态模型」，不会静默给空结果。

识图结果会存进材料里（`method: model-ocr(provider/model)`），后续重新分析直接复用，不重复烧 token。

### 二、市场：场景资产流通

- 内置 12 条种子场景（协同办公/客户服务/售后/采购/法务/财务/人力/知识管理/项目管理/运营/销售），综合类业务通用，离线可用；
- 搜索 + 按域筛选，点开看五要素；
- **用这个场景起案例**：把场景填成案例的「补充背景」，现场只需补客户事实；
- **发布成场景**：把一次分析抽成卡片，存本地并给出可提 PR 的 JSON。

### 三、对 agent 说

面板是给人的，工具是给模型的：

| 工具 | 作用 |
| --- | --- |
| `fde_case_list` | 列出案例 |
| `fde_case_read` | 读某个案例的材料与蓝图 |
| `fde_analyze` | 对某个案例跑一次梳理 |
| `fde_scene_search` | 搜场景市场 |
| `fde_scene_publish` | 把案例发布成场景卡 |
| `fdehub_status` | 转写能力 / 模型通道 / 数据目录 |

```
把 FDE 案例 abc123 梳理一下，重点看备件预测那条
找找有没有类似的客服场景，插在工单分派那一步的
```

## 配置

`cordis.patch.yml` 里都有安全默认值，也可以在面板改（`POST /fdehub/api/config`，重启回到文件）。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `dataDir` | `$DSH_HOME/fdehub` | 案例、场景、原始音频都在这，换机器直接拷走 |
| `asrMode` | `auto` | `auto` / `host` / `local` / `off` |
| `asrCommand` | 空 | 本地转写命令模板，占位符 `{input} {outdir} {basename}` |
| `ffmpegPath` | `ffmpeg` | 统一转 16k 单声道 wav |
| `llmProvider` / `llmModel` | 空 | 留空 = 跟随当前会话的模型路由 |
| `analysisMaxChars` | 60000 | 送进模型的材料上限，超了会截断并在结果里标注 |
| `ocrEnabled` | `true` | 图片/扫描件是否走宿主模型识图 |
| `ocrMaxPages` | 5 | 扫描版 PDF 最多识别前几页（每页一次模型请求） |
| `indexUrl` | 空 | 场景市场远端索引（GitHub raw 的 `scenes/index.json`） |
| `author` / `org` | 空 | 发布场景时的署名 |

本地转写命令示例（Apple Silicon，先 `pip install mlx-whisper`）：

```yaml
asrCommand: mlx_whisper {input} --model mlx-community/whisper-large-v3-turbo --output-format txt --output-dir {outdir} --output-name {basename}
```

## 权限与隐私

- **不联网取数据**：只有场景市场会 `fetch` `indexUrl`（你配了才有），分析走宿主已配置的模型通道。
- **不引入新凭据**：不读任何 key，复用宿主的 `ctx.llm` 与会话路由。
- **音频不出本机**：转写只用宿主语音服务或你本机的命令；用大模型总结时，材料会发给你在 DSH 里配的模型服务方——这条与其它 dsh 插件一致。
- **图片会发给模型服务方**：识图走的就是你配的那个模型；涉密扫描件请先确认模型侧的数据条款，或把 `ocrEnabled` 关掉改贴文字。
- **不编内容**：转写不出来标「未转写」，材料没覆盖的进 `notCovered`，模型不可用时明确拒绝分析而不是给一份空气蓝图。
- 数据全部在 `dataDir` 下，删除案例会连音频一起清掉。

## 开发

```sh
node test/smoke.mjs          # 零依赖冒烟测试：路由 / 工具 / 种子 / 市场 / 解析器
dsh plugin --profile plugin-dev add link:$(pwd)
dsh --profile plugin-dev --dump-config | grep fdehub
```

结构：

```
index.js              host 入口：配置、store、路由延迟绑定、模型路由监听
client.js             浏览器入口：侧栏两个面板（工坊 / 市场），无 JSX、无构建
lib/config.js         配置归一化（全部有安全默认值）
lib/store.js          JSON 落盘（tmp+rename、防抖、种子合并）
lib/extract.js        pdf/docx/pptx/xlsx/txt 取文（本机工具优先）
lib/ocr.js            图片 / 扫描版 PDF 识图（走宿主模型，不内置引擎）
lib/asr.js            转写引擎链：宿主服务 → 本地命令 → 如实标注未转写
lib/analyze.js        prompt、截断容错解析、结果收口、场景卡抽取
lib/registry.js       场景市场：种子 + 本地 + 远端索引
lib/routes.js         /fdehub/api
lib/tools.js          6 个 agent 工具
scenes/               种子场景与索引（GitHub 上的集散地）
```

## 已知限制

- **转写要自备引擎**：插件不自带 ASR 模型。宿主有语音服务就用；否则装 `mlx-whisper`（Apple Silicon）或 `whisper.cpp`，在 `asrCommand` 里指过去。都不配也能用——「粘贴文字」这条路是完整可用的。
- **识图要模型支持图片输入**：纯文本模型会明确拒绝，不会给出瞎猜的文字。
- **`xls` 旧格式、纯图片 PPT** 取文有限；后者会退到识图（只识别前 `ocrMaxPages` 页）。
- **说话人区分**：本插件不做声纹分离，多人会议转写稿是一整段。要区分说话人，用 `dsh-asr-plugin` 转好再贴进来。

## 兼容性

- 在 **DSH 0.2.x**（`@deepseek-ai/dsh` 0.2.1-rc.2）、**Node 22** 上开发与验证；DeepSeek Harness 处于开发者预览期，宿主升级后请重跑 `node test/smoke.mjs`。
- 零运行时依赖：不 import `@deepseek-ai/*`，避免「装了但解析不到」的一类故障。
- macOS / Linux / Windows 均可；取文与转写会按平台退到可用工具（macOS 有 `textutil`，其它平台走 `unzip`/`pdftotext`）。

## License

MIT（代码）· 场景卡默认 CC-BY-4.0（内容），提交时请确认你有权授权。

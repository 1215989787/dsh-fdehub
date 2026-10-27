# 场景注册表（Scene Registry）

本目录是**唯一真源**。目录结构对齐 `dsh-mcp-connector` 的社区注册表做法：

```
registry/
├── schema/scene.schema.json   场景卡 JSON Schema
├── scenes/<id>.json           一条场景一个文件（PR 只动一个，不打架）
└── catalog.json               由 scenes/ 生成，插件通过 CDN 拉这个
```

`scenes/seed.json`（仓库根）也是生成物，两者都由 `npm run market:build` 从 `registry/scenes/` 产出，**不要手改**。

## 上架流程

```sh
# 1. 复制一份空模板
cp registry/scenes/seed-meeting-actions.json registry/scenes/my-scene.json
# 2. 改成你的场景（id 必须等于文件名；published: true）
# 3. 生成 + 门禁
npm run market:build
npm run market:validate
# 4. 提 PR，只带这两个文件：registry/scenes/my-scene.json 与重新生成的 catalog.json / scenes/seed.json
```

在插件面板里点「发布成场景」会自动生成同样的文件内容并复制到剪贴板，省掉手写。

## 门禁在查什么

`npm run market:validate` 是离线上架门禁，零依赖手写，规则和 `schema/scene.schema.json` 对齐：

| 规则 | 为什么 |
| --- | --- |
| 五要素必填：`injection` / `inputs` / `outputs` / `humanInLoop` / `proofMetric` | 缺任何一条，这条场景就没法被别人复用 |
| `proofMetric` 必须含数字 | 「效率提升」不可测量，不叫指标 |
| `id` 合法且与文件名一致、全库唯一 | catalog 是按 id 去重的 |
| `effort` ∈ S/M/L | 面板按这个分组 |
| `featured` ≤ 30% | 否则首页被少数条目占满 |
| 无手机号 / 邮箱 / 身份证 / 内网 IP / 内部域名 | 市场放方法，不放客户事实 |

`risks` 为空只报警告不阻断——但请补上：只讲好处的场景卡价值为零。

## 分发

- 插件默认 `indexUrl` = `https://cdn.jsdelivr.net/gh/1215989787/dsh-fdehub@master/registry/catalog.json`
- CDN 失败自动退 `https://raw.githubusercontent.com/1215989787/dsh-fdehub/master/registry/catalog.json`
- 缓存 `refreshSkewMs`（默认 5 分钟），面板「刷新」按钮强制重取
- 想只用自己的私有目录：改 `cordis.patch.yml` 的 `indexUrl` 指向你的 `catalog.json` 即可，格式一致

> jsDelivr 对分支有缓存，`@master` 更新通常几分钟内生效；紧急改动用 `@<commit-sha>` 或点面板「刷新」。

## 目录格式

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-10-27T07:50:00.000Z",
  "count": 12,
  "featured": 3,
  "domains": ["人力", "客户服务", "..."],
  "scenes": [ { "id": "...", "...": "..." } ]
}
```

插件对格式是宽容的：顶层是数组也行（老版本索引），`published: false` 的条目自动隐藏。

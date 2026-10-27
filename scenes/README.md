# 场景市场：怎么往上加一条

> 真源在 `registry/scenes/`，本目录的 `seed.json` 是生成物（`npm run market:build` 产出，不要手改）。
> 完整上架流程、门禁规则、分发方式见 [`registry/README.md`](../registry/README.md)。

一条「场景」不是案例，也不是 PPT 里的愿景，而是五个必须能答上来的问题：

1. **插在流程哪一步**（`injection`）——在谁手上、什么时点触发。说不清插在哪的，是口号。
2. **吃什么**（`inputs`）——录音、工单文本、报价单 PDF、制度文件……
3. **产出什么**（`outputs`）——给谁看、什么形态（表 / 预警 / 草稿 / 工单）。
4. **人在哪兜底**（`humanInLoop`）——哪一步必须人确认。
5. **用什么证明有效**（`proofMetric`）——指标 + 时间窗，必须带数字。

答不上第 1 条和第 5 条的场景，一律不收。

## 三种提交方式

1. **面板发布（最省事）**：FDE 工坊里做完一次梳理 → 点「发布成场景」→ 存进本地市场，同时把 `registry/scenes/<id>.json` 的内容复制到剪贴板 → 提 PR。
2. **手写文件**：`cp registry/scenes/seed-meeting-actions.json registry/scenes/<你的id>.json`，改完跑 `npm run market:build && npm run market:validate`。
3. **批量导入**：直接往 `registry/scenes/` 放多个文件，build 会一起收进 catalog。

## 提交前自查

- [ ] 有没有客户名、项目代号、未公开的价格或产量数据？——脱敏，市场里只放方法，不放客户事实。
- [ ] `injection` 是不是能落到具体岗位和时点？
- [ ] `proofMetric` 是不是可测量？「效率提升」不算。
- [ ] `risks` 有没有写？只讲好处的场景卡价值为零。
- [ ] license 是否为你有权授权的？默认 CC-BY-4.0，公司内部资产请先确认。

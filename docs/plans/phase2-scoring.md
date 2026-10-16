# 第二期验收：十份报告打分

执行日期：2026-10-16（UTC）。十份报告在 04:02:03 到 04:14:18 UTC 之间生成，同时最多 3 份，全程 12 分 15 秒，十份都一次成功。三项分数和备注待人工填写。计划见 [2026-10-15-redo.md](2026-10-15-redo.md) 的 Task 14。

| 项 | 值 |
| --- | --- |
| OpenCodex | 0.3.0，提交 `a2f3aad`；装进 profile 的 `dist/` 与这次构建逐字节相同 |
| DSH | 0.2.1-alpha.2 |
| profile | `opencodex`，DSH home `~/.dsh`，bundle 为 dsh-base、dsh-web-app、dsh-opencodex |
| DSH 镜像 | `~/harness/deepseek-harness`；报告 01 到 09 在 `cc6a8f59b41`，报告 10 运行中镜像同步到 `2119de0b48c`（见「问题」第 4 条） |
| DSH 索引 | 825 条，提交 `cc6a8f59b41`，建于 03:57 UTC |
| 报告模型 | `deepseek-official` / `deepseek-v4-pro`，会话日志记的推理强度为 high |
| 归类模型 | `deepseek-official` / `deepseek-flash` |
| 设置 | `dshMirrorPath` 为上面的镜像路径，`dailyReportLimit` 20，`reportPreset` 留空（会话用 DSH 默认的 standard 预设），其余为默认值 |
| 报告副本 | `~/harness/opencodex-phase2-reports/`：每条一份 `<序号>-<slug>.md`，以及该条证据目录的 INDEX.md，存为 `<序号>-<slug>.INDEX.md` |

## 打分标准

每条三项，各 0、1、2 分：证据到位、DSH 现状准确、工作量合理。

通过线：

- 平均分不低于 4/6
- 单条不超过 3 万 token
- `dshRefsResolved / dshRefsTotal` 不低于 0.8

不达线就改模板或证据包，再跑同样十条。

## 十份报告

耗时从分析会话创建算到 `report.generatedAt`。输入含缓存命中。引用解析为 `dshRefsResolved/dshRefsTotal`。

| 序号 | 候选标题 | 来源 / 分类 / 相关度 | 耗时 | 输入 / 输出 token | requiredSections | 引用解析 | 结论 | 报告文件 | 证据到位 | DSH 现状准确 | 工作量合理 | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 01 | 协议类型有变化（0.162）：17 个类型 | codex-files / cli-core / high | 3:43 | 1,485,133 / 15,760 | 是 | 11/11 | 不做，0 工时；升级 subagent-codex 或做 app-server 服务端时再跟进，0.5–2 天 | `01-protocol-types-0162.md` | | | | |
| 02 | 功能开关注册表有变化（0.162） | codex-files / cli-core / high | 2:51 | 388,672 / 14,585 | 是 | 9/9 | 不做，0 工时；可选做 code mode 工具发现，1–2 天 | `02-feature-flags-0162.md` | | | | |
| 03 | Add JavaScript helpers for streaming promise results as they settle… | codex-release / cli-core / high | 3:36 | 972,372 / 18,346 | 是 | 8/8 | 可做：只做 #51209 排名工具检索，2–4 天；#51126 的两个 settlement helper 暂不做 | `03-js-promise-helpers.md` | | | | |
| 04 | Navigate and copy transcript blocks with `/copy`… | codex-release / cli-core / medium | 3:15 | 666,069 / 16,945 | 是 | 9/9 | 不做，0 工时；可选做 `/copy` 键盘复制，约 1 天 | `04-transcript-copy.md` | | | | |
| 05 | Add tools for creating and listing managed Git worktrees… | codex-release / cli-core / medium | 2:03 | 670,791 / 9,760 | 是 | 10/10 | 可做：只补只读 `list_worktrees`，0.5–1 天；异步创建加持久化 5 天以上 | `05-managed-worktrees.md` | | | | |
| 06 | Configure live web access and remote compaction capabilities… | codex-release / cli-core / medium | 2:54 | 642,534 / 14,758 | 是 | 12/12 | 不做，0 工时；可选做 provider 能力声明，0.5–1 天 | `06-web-access-remote-compaction.md` | | | | |
| 07 | Edit Markdown and code directly in the app, use inline annotations… | rss / desktop / medium | 3:24 | 1,119,698 / 16,165 | 是 | 10/10 | 可做：先做选区修订，2–3 天；应用内编辑加行内批注 3–4 周 | `07-edit-markdown-annotations.md` | | | | |
| 08 | Review changes across repositories | rss / desktop / medium | 2:12 | 525,467 / 10,519 | 是 | 12/12 | 可做：多仓库汇总加仓库选择，2–3 天；跨仓库统一 diff 视图 4–6 天 | `08-multi-repo-review.md` | | | | |
| 09 | Added Record & Replay, a macOS feature… | rss / desktop / medium | 1:51 | 467,343 / 8,895 | 是 | 10/10 | 可做：先做手动沉淀技能，约 1 天；自动录制回放 1–2 周 | `09-record-and-replay.md` | | | | |
| 10 | Import setup and recent work from other agents | rss / cli-core / medium | 1:54 | 513,952 / 8,873 | 是 | 14/14 | 可做：只做 Claude Code 的 skills 和 instructions 导入，1–2 天；完整导入加同步 5–10 天 | `10-import-from-other-agents.md` | | | | |

## 生成记录

时间为 UTC。点「生成报告」到会话创建之间是取 GitHub 证据和建证据包，每条几秒，不计入耗时。

| 序号 | 候选 ID | 分析会话 | 开始 | 结束 | 结果 | 报告字符数 / 行数 |
| --- | --- | --- | --- | --- | --- | --- |
| 01 | `c65bef9d-404f-409d-9f3f-00fe1531671d` | `session-54a670ae-83b2-4e47-a0f9-2046798d8c43` | 04:02:03 | 04:05:45 | reported | 6,855 / 75 |
| 02 | `ae774787-b284-4a25-9f9d-80c8473fd9b1` | `session-0724e959-47ed-4204-a2c3-e583f3427429` | 04:02:39 | 04:05:30 | reported | 5,103 / 68 |
| 03 | `ef6b7532-62a2-42ed-9e95-6baed800a3fe` | `session-68e64cbd-15a4-4aa3-8043-f9e43e6a8591` | 04:03:08 | 04:06:45 | reported | 4,976 / 67 |
| 04 | `e752a852-b006-461c-89df-2addd5305ae8` | `session-2a3e468e-f517-4b5f-81dd-ca3e426bf5d2` | 04:06:08 | 04:09:24 | reported | 4,719 / 45 |
| 05 | `55d42252-6f12-4edf-853b-03762a81199e` | `session-fe5017a3-a6a3-41b5-82c6-84dc25e4a2e8` | 04:06:28 | 04:08:31 | reported | 5,489 / 65 |
| 06 | `97a58756-63f9-4d05-8478-fa81dee57fe0` | `session-740adea4-8e67-473f-a9ff-f64663745f68` | 04:07:10 | 04:10:04 | reported | 5,395 / 48 |
| 07 | `4452035d-f9b7-47c2-b125-43144356c6b6` | `session-b9e7f0a9-1e01-46f5-987c-be9f6fdf1559` | 04:08:51 | 04:12:15 | reported | 2,813 / 44 |
| 08 | `d8391ac8-1bfb-4e55-b312-9298297ebb51` | `session-4b266231-c663-4dfa-bfff-c4e2ddc22eb4` | 04:09:48 | 04:12:01 | reported | 2,711 / 45 |
| 09 | `2a049328-38c0-4269-b181-4a3c34f5a900` | `session-f1e5b469-5c5e-4e1a-9dce-e97b97200195` | 04:10:28 | 04:12:19 | reported | 3,273 / 58 |
| 10 | `2445068a-cb9d-4bc8-af1e-44423e5f03bd` | `session-24bdce05-c332-4f32-ae94-7d2e065b4eb2` | 04:12:24 | 04:14:18 | reported | 3,396 / 51 |

## token 明细

用量取自会话日志 `~/.dsh/sessions/<编码后的 cwd>/<会话 id>/session.v4.jsonl.zstd`，把每个 `assistant/message` 事件的 `usage` 相加。输入 = `inputTokens` + `cacheReadTokens`，`cacheWriteTokens` 全为 0。

| 序号 | 模型调用 | 未命中缓存的输入 | 缓存命中 | 输出 | 合计 | 最后一次请求的上下文 |
| --- | --- | --- | --- | --- | --- | --- |
| 01 | 23 | 115,533 | 1,369,600 | 15,760 | 1,500,893 | 130,098 |
| 02 | 11 | 68,032 | 320,640 | 14,585 | 403,257 | 75,882 |
| 03 | 16 | 82,772 | 889,600 | 18,346 | 990,718 | 108,454 |
| 04 | 16 | 61,013 | 605,056 | 16,945 | 683,014 | 85,529 |
| 05 | 20 | 46,151 | 624,640 | 9,760 | 680,551 | 63,339 |
| 06 | 17 | 56,294 | 586,240 | 14,758 | 657,292 | 78,240 |
| 07 | 28 | 47,570 | 1,072,128 | 16,165 | 1,135,863 | 70,115 |
| 08 | 18 | 40,347 | 485,120 | 10,519 | 535,986 | 58,364 |
| 09 | 11 | 66,319 | 401,024 | 8,895 | 476,238 | 82,979 |
| 10 | 12 | 80,672 | 433,280 | 8,873 | 522,825 | 97,210 |
| 合计 | 172 | 664,703 | 6,787,328 | 134,606 | 7,586,637 | |

## 自动统计

| 项 | 结果 |
| --- | --- |
| 生成成功 | 10/10，没有失败和重试 |
| requiredSections 为真 | 10/10 |
| 引用解析不低于 0.8 | 10/10，105 处引用全部解析 |
| 单条不超过 3 万 token | 0/10，按累计合计算最少 403,257（见「问题」第 7 条） |
| 平均耗时 | 2 分 46 秒，最短 1:51，最长 3:43 |
| token 合计 | 输入 7,452,031（缓存命中占 91.1%），输出 134,606，合计 7,586,637 |
| 结论分布 | 不做 4 份，可做 6 份，做 0 份 |
| 人工平均分 | 待填 |

## 问题

1. 同一路径重装没有换掉旧代码。`dsh plugin --profile opencodex add <同一路径的 dsh-opencodex-0.3.0.tgz>` 退出码为 0，锁文件也换成了新包的 integrity，但 `node_modules/dsh-opencodex/dist` 仍是 10/15 冒烟时的旧文件（host bundle 198,639 字节，本次构建 195,827 字节）。这个 profile 用 `nodeLinker: hoisted`，包路径不变时 pnpm 不重新解包。先 `dsh plugin --profile opencodex remove dsh-opencodex` 再 `add` 才装上新包。Task 18 往日常 profile 装新版时会遇到同样情况。
2. 启动后的检查带来计划外的归类调用。DSH 启动 60 秒后自动检查一次：窗口 rust-v0.162.1 → rust-v0.163.0，发布说明 +6、仓库文件 +2、RSS +1，没有错误。9 条新候选用 deepseek-flash 归类，这部分用量不在上表里。十条入选候选的记录没有被这次检查改动。
3. 同一条更新归成了两条候选。新 RSS 候选 `7d150b71-c8ec-4075-ba40-48a9fd074b82`（Configure live web access and remote compaction capabilities for custom Responses-compatible model providers）与第 06 条（发布说明 `97a58756…`）是同一条更新，没有 `mergedInto`，归类也不同：rss / cloud / low 对 codex-release / cli-core / medium。按标题前缀找候选已不唯一，本次选的是发布说明那条。
4. 镜像在报告 10 运行中同步。launchd 在 04:13:59 UTC 把镜像从 `cc6a8f59b41` 重置到 `2119de0b48c`（10 个提交，61 个文件），报告 10 的会话在 04:12:24 到 04:14:16 之间运行。报告 01 到 09 按 `cc6a8f59b41` 校验，报告 10 按 `2119de0b48c` 校验。事后把 105 处引用对两个提交各查一遍：都能解析，被引用的文件在两个提交之间没有改动。
5. 分析会话里没有 `rg`。提示词和模板要求用 `rg` 定位，本机没有装 ripgrep：报告 01、05、06、07、08、09 共 11 次 bash 调用得到 `bash: rg: command not found`（exit 127），之后改用 DSH 的 grep 工具。报告正文里写的「查过 rg …」多数实际由 grep 工具完成。
6. 引用校验只核对行号存在。`dshRefsResolved` 只看文件在镜像里、行号不超过文件行数，不看那几行写了什么。例如报告 07 引用的 `packages/client/ui-open-in-app/README.md:9` 是空行，也算解析成功。只写文件名的短引用（报告 01 的 `wire.ts:674-675`、`(:57)`）和 `packages`、`apps`、`docs`、`.agents` 以外的路径（报告 02 的 `scripts/ci-workflow.spec.ts:1301`）不计入总数。
7. 3 万 token 的口径未定。每份报告是一次多轮会话，11 到 28 次模型调用，每次都重发整个上下文。第一次请求约 9.1k token（系统提示、工具定义和模板），读完证据和镜像后最后一次请求的上下文为 5.8 万到 13.0 万。累计合计为 40 万到 150 万；只算未命中缓存的输入加输出为 5.1 万到 13.1 万；只算输出为 0.89 万到 1.83 万，只有这个口径十份都在线内。
8. 报告头部的「生成时间」是会话开始的时间。模板的 `{{generatedAt}}` 在拼提示词时填入，报告 01 头部写 04:02:03，`report.generatedAt` 和页面上的「生成于」是写完的时间 04:05:45。
9. 运行中没有其他异常：会话审批策略由 ask 改为 never，没有等待审批；沙箱为 workspace-write；没有开子代理，没有联网或安装命令；每个会话只写了一次 report.md，回合都以 completed 结束；页面运行中显示「生成中」，完成后显示「校验通过」。

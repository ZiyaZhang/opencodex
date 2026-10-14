# 从 REA 学习如何减少无效调查

核对日期：2026-10-14。公开源码固定在 [`morluto/rea@ffeb2d436756008a764ec2045157855098768381`](https://github.com/morluto/rea/tree/ffeb2d436756008a764ec2045157855098768381)。本次核对入口 skill、JavaScript 调查手册、Evidence 工作流、实际视图服务与 DSH adapter，以及 REA 自己的效率实验。没有运行 REA 引擎，也没有把仓库最新文档当作已安装工具的能力。

结论：值得借鉴的是**将已做过的调查保存成可精确读取的证据，再用具体未解问题驱动下一步**。把更多手册全部塞给模型，或仅要求“少读多写”，不能替代工具和执行流程的约束。

## 真实实现与适用范围

| REA 中已存在的做法 | 源码证据 | 对 OpenCodex 的意义 |
| --- | --- | --- |
| 完整分析保存在 session ledger，返回摘要；后续按 parent Evidence ID 读取 section/module/page | [`AnalysisViewService.ts`](https://github.com/morluto/rea/blob/ffeb2d436756008a764ec2045157855098768381/src/application/analysisView/AnalysisViewService.ts) 的 `summarizeRetainedAnalysis` 先 `recordEvidence`，再 `inspectAnalysisViewValidated`；缺少留存能力时拒绝摘要模式 | 对模型返回精简视图，对资料页保留完整内容；分页携带同一内容摘要，不能靠截断后重新生成“完整报告” |
| 模块列表先给身份，选定 node ID 后返回模块细节；页耗尽与源分析完整性分开 | [`javascriptApplicationView.ts`](https://github.com/morluto/rea/blob/ffeb2d436756008a764ec2045157855098768381/src/domain/analysisView/javascriptApplicationView.ts) 的 `selectModule`、`pageCoverage` 和原始 coverage 保留 | 先定位具体接口/文件，再读有限范围；未命中不能自动解释成“DSH 没有该能力” |
| 按实际目标选工具；可用工具已经存在时不重复诊断；同样输入不重复分析 | [入口 skill](https://github.com/morluto/rea/blob/ffeb2d436756008a764ec2045157855098768381/.agents/skills/reverse-engineer-anything/SKILL.md) 的 target routing、summary-first 和 staged workflow | 有公开 DSH 源码与声明时直接定位，不先调用二进制引擎；已保存的接口结论在版本未变时复用 |
| JS 可以按确切 `source_paths` 限定分析；沿一个 literal/route/API/IPC/node seed 追踪 | [JavaScript 手册](https://github.com/morluto/rea/blob/ffeb2d436756008a764ec2045157855098768381/.agents/skills/reverse-engineer-anything/references/javascript-applications.md) | 围绕具体 UI 合同扩展：入口、状态、交互和生命周期。摘要只减少交付量，`source_paths` 才改变实际分析范围 |
| Unknown 有独立登记与 revision，证据相关联；重建验收限定于声明的规格 | [Evidence 手册](https://github.com/morluto/rea/blob/ffeb2d436756008a764ec2045157855098768381/.agents/skills/reverse-engineer-anything/references/evidence-workflows.md) | 遇到界面权限或宿主能力缺口，保存缺口并推进不依赖它的实现；不能靠重复读取把 unknown 变成 pass |

REA 的 [`DshCordisPatch.ts`](https://github.com/morluto/rea/blob/ffeb2d436756008a764ec2045157855098768381/src/application/DshCordisPatch.ts) 把 REA stdio server 注册到 `@deepseek-ai/dsh-mcp-client`，并处理 Cordis patch 的所有权和配置编辑。它**不是 DSH 功能插件生成器**，没有替 OpenCodex 提供 UI 扩展点索引、编译模板、模型预算或“何时开始写目标代码”的阶段机制。

## 本次失败暴露的问题

实际生成实验的总成本和人工协助见 [预览版实测记录](validation-2026-10-14.md)。本节只使用保存日志的汇总，不发布原始聊天、私有路径或截图。

- 首次实验的一个保存片段含 53 次工具调用，其中 33 次 shell 调用，30 次命令读取框架。很多是相同问题下的 `grep → sed → grep`：寻找 `useSessionStatus`、`PropsRuntime`、`slots.inject` 和 overlay fallback，而不是验证目标行为。这个片段不是完整运行，不能用它推算全程比例。
- 使用模板后的另一个保存片段中，模型用 7 次独立读取重新看完模板文件，再继续寻找类型声明。模板已经减少手写打包配置，但返回结果没有给出足够明确的入口、可改文件和下一步命令。
- 暂停后重新注入完整入口 skill，工具返回完整长参考文档，进一步增加了已经在会话中的材料。增加单次/总 token 上限只能延后停止，不能保证代码更早产生。
- 输出上限与推理模式还影响了实际写文件；有一轮先耗尽输出空间，改变测试会话的推理设置后才开始产出。它与文档阅读是不同问题，不能将所有消耗归因于一个因素。

## 六项具体调整

1. **长资料默认目录，显式读取有界正文。** 模型接口返回标题、章节偏移、内容 hash；正文通过 offset 限制读取。短资料直接附正文，避免机械增加一个调用。前端资料页仍可读全文。借鉴 REA retained view；资源目录格式与字符上限是 OpenCodex 自己的设计。
2. **恢复不重复完整入口规则。** 继续同一个 session 时保留任务、当前阶段、任务总预算和用户续跑说明，并要求先用 `status` 查询最新余额及已保存记录 ID，再用 `record` 精读相关记录。恢复 prompt 不直接注入最新规格、待办记录 ID 或剩余额度。完整入口规则首轮提供，恢复时不重复注入；证据继续保留在持久化 ledger。借鉴 REA 复用会话/证据；恢复 prompt 策略是 OpenCodex 自己的设计。
3. **将框架探索压成按版本核验的 API map。** 一次读取精确的包 manifest/exports，列出该功能需要的 slot、hook、服务，以及对应声明文件、符号、范围、内容 hash。相同版本与文件摘要复用结果；摘要变化只重查相关条目。未找到或不兼容要明确标记，不能使用旧地图伪装当前事实。这是拟新增的 DSH 适配能力，不是 REA 已有功能。不要启动时扫描全部 `node_modules`，也不要为每个问题建立一个新的全仓库索引。
4. **模板返回可执行起点。** JSX 入口直接使用 `.tsx`；模板回执包含本次实际复制的 `clientSource`、文件 hash、SDK 依赖、共享 externals 说明、构建命令和输出路径。让模型能直接修改真实入口，遇到具体错误再读相关配置，而不必先分别读取七个模板文件。这里的 SDK 信息来自模板的真实 package 配置，**不是现场探测结果**，也不证明当前宿主的 API 与模板兼容。模板只解决打包与注册，不内置目标功能。这是 OpenCodex 新增的实现选择，不是 REA 自带。
5. **最小合同成立后开始实现，以编译/验收错误驱动精读。** 已有入口、状态选择器、生命周期和验收场景时，保存最小规格后进入 building；每一次追加框架读取必须回答一个具体的实现阻塞。原有研究无进展守卫仅约束 researching，不能把正在写代码的 building 错判为无进展。后续可记录“首次目标代码、首次编译、首次可安装包”的时间/调用数，但不以任意写文件冒充进展。REA 的有限问题与证据原则提供方向；这些阶段门槛是我们的产品设计。
6. **用完整任务结果判断优化，保留失败样本。** 比较相同 DSH 版本、相同目标、相同模型/推理设置和预算；同时记录总调用数、首次目标代码、编译/打包结果、全部输入/缓存输入/输出、错误与人工介入。更短回复和更少重复注入可以离线验证，但在真实任务重复对照前不宣称 token 或速度降低了多少。

## 本轮落实与后续边界

本轮落实到现有工具的改动是 1、2、4：有界资料读取、恢复时不重复完整入口，以及带真实入口和构建合同的 scaffold 回执。它们改变模型实际收到的内容，不仅是添加“减少读取”的提示词。第 5 项沿用现有的证据、规格、building 阶段和 research 无进展守卫，明确何时可以开始写代码；“每次读取必须回答实现阻塞”是工作流指引，并没有新增自动判断读取价值的机制。具体检查结果以 [实测记录](validation-2026-10-14.md) 为准。

一次离线读取测量中，`dsh-adaptation` 的全文为 12,171 字符，默认索引序列化后为 763 字符。这只验证本次默认返回的字符量减少，不包含模型调用、追加精读或回答质量，不能据此推算 token 成本或完成速度。

第 3 项版本化 API map **本轮没有实现**。若后续对照仍显示框架定位是主要开销，再增加有界的定位与版本失效机制；不先引入全仓库扫描、新工具目录或跨任务缓存。第 6 项定义下一轮验证方法，本轮不为宣称优化再启动大额度模型循环。

## 为什么不能把少字直接说成省 token

REA 自己的 [效率测量说明](https://github.com/morluto/rea/blob/ffeb2d436756008a764ec2045157855098768381/experiments/analysis-efficiency/README.md) 和 [模型上下文实验](https://github.com/morluto/rea/blob/ffeb2d436756008a764ec2045157855098768381/experiments/analysis-efficiency/model-context.md) 区分工具原始字节、客户端真正展示的结果和模型用量。某些 summary 对照返回更短，但总模型输入增加；工具发现与额外轮数可能抵消收益。精确工具名称指引的有限实验改善了发现开销，也保留了失败样本和无法推断的资源结果。这些是 REA 的有限实验，不能当作 OpenCodex 的性能数据。

## 本轮验证边界

- 资源读取：默认目录、短文直返、分页连续性、hash 稳定、长单行、代码块内伪标题、无效 offset/上限、旧 UI 全文读取不变。
- 恢复上下文：首轮包含入口规则；恢复不包含整份入口正文；保留任务、阶段、任务总预算和用户说明，最新余额与记录 ID 由 `status` 查询；停止的 job 不自动新增调用。
- 模板：检查回执中的入口源码与文件 hash 对应真实落盘内容，SDK/commands 来自模板配置；以含 JSX 的最小贡献验证无需改 build 入口即可类型检查、构建和打包；仍拒绝覆盖已有工作区。离线模板通过不等于真实宿主 API 兼容已通过。
- API map 尚未实现时明确标注，不用手写说明冒充实时版本核验。
- 本轮代码检查与离线回归不替代生成插件的真实 DSH UI 验收，也不建立任意功能自动复刻成功率。

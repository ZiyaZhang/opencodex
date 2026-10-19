# 第三期试用记录

OpenCodex 0.4.0 装进日常使用的 `desktop` profile、并装上每日任务后试用一周，每天看一次页面，按下面的格式记一天。0.4.0 的设计和计划见 [2026-10-16-0.4.0-design.md](2026-10-16-0.4.0-design.md)、[2026-10-16-0.4.0-plan.md](2026-10-16-0.4.0-plan.md)。

| 项 | 值 |
| --- | --- |
| 试用起止 | 桌面端重启到 0.4.0 那天起七天：YYYY-MM-DD 到 YYYY-MM-DD |
| OpenCodex | 0.4.0，提交 74d8670 |
| DSH | 桌面端 0.2.0-rc.2（`desktop` profile）；每日任务用桌面端自带的 CLI 起 `opencodex` profile |
| DSH 镜像 | `~/harness/deepseek-harness`；开始时的提交 ed75efeffee（2026-10-16） |
| 检查 | 桌面端开着时每 24 小时一次（`checkIntervalHours` = 24）；每日任务每天 08:00 一次 |
| 自动调研 | `autoResearch` = 相关度高；`dailyReportLimit` = 20 |

## 通过线

一周结束时填。

| 项 | 结果 | 依据 |
| --- | --- | --- |
| 至少一条动态从发现、调研走到执行，执行会话产出可装的 bundle | 未定 | 动态标题、执行会话 id、bundle 路径、安装结果 |
| 七天里每天都有一次检查，不需要人工干预 | 未定 | `checks.jsonl` 里每天的记录（时间、触发方式、错误数） |
| 自动调研的报告不用人点就出现在列表里 | 未定 | 每天自动调研的份数、失败原因 |

## 每天看哪里

| 看什么 | 在哪里 |
| --- | --- |
| 最近一次检查 | 页面顶部「上次检查」一行。它读 `checks.jsonl` 的最后一行，DSH 重启后也在；由每日任务跑的会标「由另一个 DSH 进程执行」 |
| 每一次检查 | 数据目录的 `checks.jsonl`，一次一行；`trigger` 是 `startup`（启动后 60 秒）、`timer`（定时）、`manual`（点了「检查更新」）、`run-once`（每日任务） |
| 每日任务的结果 | `last-run.json`（那次检查和每份自动调研的结果）和 `logs/daily-YYYY-MM-DD.log` |
| 当天调研了几份 | `state.json` 里的 `reportsOn-<UTC 日期>`，开过的调研会话都算，失败的也算 |
| 自动调研为什么停了 | 页面顶部的提示，例如「今天的报告额度用完，还有 N 条明天继续」「另一个 DSH 进程正在检查」 |

「上次检查」一行的各部分：

| 部分 | 含义 |
| --- | --- |
| 时间 | 这次检查结束的时间，本机时区 |
| `rust-v0.161.0 → rust-v0.162.1`，或「没有新的正式版」 | 这次处理的 Codex 正式版窗口 |
| `发布说明 +N`、`仓库文件 +N`、`桌面端 +N`、`RSS +N` | 四个来源各新增的动态数 |
| 「没有错误」，或「N 条错误」 | 点开看每条；行首是出错的环节：`releases`、`files`、`desktop`、`rss`、`index`、`classify`、`research`，整次检查失败是 `check` |

- 桌面端和每日任务不会同时检查：后到的那个被数据目录锁挡住，10 分钟后再试。
- 点「检查更新」、重启 DSH、改设置都记在当天的「人工干预」里。
- 某天 `checks.jsonl` 里一条都没有时，先看电脑那天是否一直睡眠、每日任务是否还在（`launchctl print gui/$(id -u)/com.opencodex.daily`），再记成问题。
- 「DSH 索引」一行是条数、镜像提交和建立时间。提交一直不变，说明镜像本身没有更新。

## 每日记录

### 第 1 天：YYYY-MM-DD

- 检查：（当天 `checks.jsonl` 里的几行：时间、触发方式、错误数；有错误时逐条抄下）
- 人工干预：（无；或点过「检查更新」、重启过 DSH、改过设置）
- 调研：（自动几份、手动几份；每份的动态标题和引用核对结果；失败的写原因）
- 执行：（个数；动态标题、会话 id、bundle 能不能装）
- 问题：

### 第 2 天：YYYY-MM-DD

- 检查：（当天 `checks.jsonl` 里的几行：时间、触发方式、错误数；有错误时逐条抄下）
- 人工干预：（无；或点过「检查更新」、重启过 DSH、改过设置）
- 调研：（自动几份、手动几份；每份的动态标题和引用核对结果；失败的写原因）
- 执行：（个数；动态标题、会话 id、bundle 能不能装）
- 问题：

### 第 3 天：YYYY-MM-DD

- 检查：（当天 `checks.jsonl` 里的几行：时间、触发方式、错误数；有错误时逐条抄下）
- 人工干预：（无；或点过「检查更新」、重启过 DSH、改过设置）
- 调研：（自动几份、手动几份；每份的动态标题和引用核对结果；失败的写原因）
- 执行：（个数；动态标题、会话 id、bundle 能不能装）
- 问题：

### 第 4 天：YYYY-MM-DD

- 检查：（当天 `checks.jsonl` 里的几行：时间、触发方式、错误数；有错误时逐条抄下）
- 人工干预：（无；或点过「检查更新」、重启过 DSH、改过设置）
- 调研：（自动几份、手动几份；每份的动态标题和引用核对结果；失败的写原因）
- 执行：（个数；动态标题、会话 id、bundle 能不能装）
- 问题：

### 第 5 天：YYYY-MM-DD

- 检查：（当天 `checks.jsonl` 里的几行：时间、触发方式、错误数；有错误时逐条抄下）
- 人工干预：（无；或点过「检查更新」、重启过 DSH、改过设置）
- 调研：（自动几份、手动几份；每份的动态标题和引用核对结果；失败的写原因）
- 执行：（个数；动态标题、会话 id、bundle 能不能装）
- 问题：

### 第 6 天：YYYY-MM-DD

- 检查：（当天 `checks.jsonl` 里的几行：时间、触发方式、错误数；有错误时逐条抄下）
- 人工干预：（无；或点过「检查更新」、重启过 DSH、改过设置）
- 调研：（自动几份、手动几份；每份的动态标题和引用核对结果；失败的写原因）
- 执行：（个数；动态标题、会话 id、bundle 能不能装）
- 问题：

### 第 7 天：YYYY-MM-DD

- 检查：（当天 `checks.jsonl` 里的几行：时间、触发方式、错误数；有错误时逐条抄下）
- 人工干预：（无；或点过「检查更新」、重启过 DSH、改过设置）
- 调研：（自动几份、手动几份；每份的动态标题和引用核对结果；失败的写原因）
- 执行：（个数；动态标题、会话 id、bundle 能不能装）
- 问题：

## 2026-10-16 开工实跑

两条已出报告的候选各点一次「开工」，看创造模式会话能不能按报告的建议做出可装的 bundle。

- DSH：0.2.1-alpha.2（`/Users/ziya/harness/dsh-video-plan/runtime/node_modules/.bin/dsh`），profile `opencodex`，`--no-open --port 0` 启动，页面在浏览器里操作。
- OpenCodex：0.3.0，已装构建 `a2f3aad`；`startPreset` = `cordis`（创造模式）。
- DSH 镜像：`/Users/ziya/harness/deepseek-harness`，提交 `2119de0b48c`。
- 会话权限：沙箱 `workspace-write`，审批 `ask`，两个开工会话全程没变。
- 操作人的动作：回答提问，处理审批卡片，处理两处环境问题（候选 55d42252 的问题 1、问题 3），会话结束后另开普通会话验证。
- 时间为 UTC。token 口径同 [phase2-scoring.md](phase2-scoring.md)：会话日志里每条 `assistant/message` 的 `usage` 相加，输入 = 未命中缓存 + 缓存命中。

### Add tools for creating and listing managed Git worktrees（候选 55d42252）

- 报告建议：级别 1，只补一个只读的 `list_worktrees` 工具。
- 开工会话：`session-3a5c1744-5bc4-44b9-b1a6-89cdeb09fb02`，工作目录 `~/.dsh/opencodex/work/55d42252-6f12-4edf-853b-03762a81199e`。04:31:56 点「开工」，页面直接切到「实现 · Add tools for creating and listing managed Git worktrees fro」。
- 模型：按 profile 默认的 deepseek-flash 起步；04:34:08 在会话的模型选择器里换成 DeepSeek-V4-Pro（High），从第 35 次模型调用起生效。
- 计划（会话的任务清单）：写 bundle → 语法和清单检查 → `plugin_manager` 安装 → 用 `cordis_inspect_query` 确认注册并实际调用 → 汇报。
- bundle：`dsh-tool-list-worktrees`，包名 `@local/dsh-tool-list-worktrees`。文件：`package.json`、`cordis.patch.yml`（只插入 `tool-list-worktrees` 一行）、`index.js`（213 行）、`icon.svg`、`locale/en.json`、`locale/zh.json`。
- 工具行为：无参数、只读。先用 `git rev-parse --path-format=absolute --git-common-dir` 找到主仓库根，再跑 `git worktree list --porcelain`，只保留路径在 `<主仓库根>/.agents/worktrees` 下、在分支上的检出，返回 `name`、`path`、`branch`、`baseCommit`。git 子进程按调用会话的沙箱策略运行；池目录固定为 `.agents/worktrees`。
- 安装：`plugin_manager` 的 `install_bundle`，目标是上面的目录。profile 的 `package.json` 多了 `link:` 依赖和 `dsh.profile.bundles` 里的一项。

过程：

1. 04:32–04:38 只读调研：worktree 运行时和 `tool-worktree` 源码、`dsh-tools` 的 `defineTool`、插件加载器的模块解析、subprocess 和 sandbox 接口；在 /tmp 建临时仓库试 `git worktree list --porcelain`。
2. 04:38–04:40 写出 bundle，`node --check` 和 JSON 检查通过。
3. 04:40 第一次安装失败，见问题 1。04:43 重装，包装上了，插件停在 pending，见问题 2。
4. 04:45 会话改 patch，连带打开实验插件的两行，这次安装被拒绝。04:48 改成不依赖 `worktrees` 服务后重装，返回 `restart-required`；04:50 `set_bundle` 重载仍是旧模块，见问题 3。04:52 第 1 轮结束，请求重启 DSH。
5. 重启 DSH 后告知会话。第 2 轮（04:54–04:57）`list_worktrees` 出现在工具列表；会话在工作目录里建临时仓库（主仓库，加上池内的 `feat/alpha`、`plain` 两个检出）调用三次：在主仓库根返回 2 条，在 `feat/alpha` 检出里返回同样 2 条，在没有池的仓库返回 `[]`。之后删掉临时仓库。

提问和回复：

- `ask_user_question`：0 次。
- 第 1 轮结尾问是否重启后继续验证。回复：已重启 DSH；先确认 `list_worktrees` 已注册、bundle 是 active，再在临时仓库里端到端验证。
- 04:46 拒绝安装后发给会话的说明：只做级别 1；不在这个 profile 里打开 `create_worktree`（去掉 `tool-worktree` 那一行）；`list_worktrees` 要么只打开 worktree 运行时那一行，要么不依赖 `worktrees` 服务、池目录用默认的 `.agents/worktrees`；改好再装。会话选了后一种。

审批：5 张卡片，都是 `plugin_manager`，卡片文字为「允许本次操作使用 danger-full-access 权限：plugin_manager {…}」，只对这一次调用生效。

| 时间 | 调用 | 处理 | 结果 |
| --- | --- | --- | --- |
| 04:40 | `install_bundle` | 允许一次 | 失败，问题 1 |
| 04:43 | `install_bundle` | 允许一次 | 已装，插件 pending，问题 2 |
| 04:45 | `install_bundle`，patch 里多了 `@deepseek-ai/dsh-experimental-worktree` 和 `@deepseek-ai/dsh-experimental-tool-worktree` | 拒绝 | 范围超出级别 1 |
| 04:48 | `install_bundle` | 允许一次 | `restart-required` |
| 04:50 | `set_bundle`（`enabled: true`） | 允许一次 | 仍 pending，问题 3 |

问题和处理：

1. 第一次安装报 `ENOENT: no such file or directory, open '/Users/ziya/harness/opencodex-v2/dsh-opencodex-0.3.0.tgz'`。`install_bundle` 对整个 profile 重跑 pnpm，profile 里 `dsh-opencodex` 依赖的就是这个 tgz 路径，而 tgz 已经不在了。处理：把 profile 里已装的 `node_modules/dsh-opencodex` 原样打成 tgz 放回原路径（`*.tgz` 在 .gitignore 里，hoisted 布局下同路径重装不会替换已装的包）。会话自己发现文件回来了，重试成功。
2. 插件停在 `tool-list-worktrees (@local/dsh-tool-list-worktrees): pending (waiting for service: worktrees)`。`index.js` 注入了 `worktrees` 服务，这个服务来自实验插件「Git 工作树」（`@deepseek-ai/dsh-experimental-worktree`），默认组合里没开。报告里「DSH 已有 `create_worktree`」是按镜像源码说的，默认 profile 里并没有这个工具。处理：会话先想连带打开实验插件，被拒绝后改成不注入 `worktrees`，池目录和 git 参数写成运行时的默认值。
3. 同一个包名改了 Host 代码后再装，返回 `application: restart-required`；`set_bundle` 重载后运行进程拿到的仍是旧模块，还是报 `waiting for service: worktrees`。处理：重启 DSH，第 2 轮开始时工具注册进来。
4. 会话自己找出并修掉一个解析问题：按池目录下一级子目录名去匹配，会漏掉带斜杠的分支（`feat/alpha` 是两层目录），改成按路径前缀过滤。

外部验证：

- 工作目录里只有 `dsh-tool-list-worktrees/`：`cordis.patch.yml`、`icon.svg`、`index.js`、`locale/en.json`、`locale/zh.json`、`package.json`。
- `dsh plugin --profile opencodex list` 列出 `@local/dsh-tool-list-worktrees@link:../../opencodex/work/55d42252-6f12-4edf-853b-03762a81199e/dsh-tool-list-worktrees`。插件页「已安装」里是「列出 Worktree」，描述「新增只读的 list_worktrees 工具，列出仓库 worktree 池中已托管 Git 检出。」，图标正常显示，开关为开。
- 新开普通会话 `session-35ed6c27-e809-4021-9457-a5693cfbf47d`，工作区 /private/tmp。测试仓库有 `main` 和一个用 `git worktree add -b feature-a .agents/worktrees/feature-a` 建的检出。请会话先用 `working_directory` 切到测试仓库，再「列出这个仓库的 worktree」：模型调用 `list_worktrees {}`，返回 `[{"name":"feature-a","path":"<测试仓库>/.agents/worktrees/feature-a","branch":"feature-a","baseCommit":"e557dce072d0057c097a5d8e6df364224768fed5"}]`，和 `git worktree list --porcelain` 一致；主检出 `main` 不在池里，按设计不列。这次验证 3 次模型调用，合计 27,116 token。

用时和用量：

- 用时：04:32:01 建会话到 04:56:59 第 2 轮结束，共 25.0 分钟。第 1 轮 20.4 分钟，等重启 1.7 分钟，第 2 轮 2.8 分钟。
- 模型调用 147 次（Flash 34 次，V4-Pro 113 次）。输入 19,607,150（未命中缓存 476,270，缓存命中 19,130,880），输出 111,754，合计 19,718,904。最后一次请求的上下文 264,920。
- 重启后第一次请求没有命中缓存，一次就是 238,805 个未命中输入。

结论：可用。

试用：

```bash
/Users/ziya/harness/dsh-video-plan/runtime/node_modules/.bin/dsh --profile opencodex
```

在工作目录位于 Git 仓库里的会话中问「列出这个仓库的 worktree」。池里要有检出才会有结果，可以先在仓库根运行 `git worktree add -b feature-a .agents/worktrees/feature-a`。

### Added Record & Replay, a macOS feature that turns a demonstrated workflow into a reusable skill（候选 2a049328）

- 报告建议：第 1 级，手动技能沉淀：一份技能书写模板和流程指引，写出的 `SKILL.md` 靠现有的 skill-filesystem 自动发现。
- 开工会话：`session-de7968cf-92d9-4648-87b2-30ee377ec37f`，工作目录 `~/.dsh/opencodex/work/2a049328-38c0-4269-b181-4a3c34f5a900`。05:06:13 点「开工」，页面切到新会话。
- 模型：直接以 DeepSeek-V4-Pro（High）起步，原因见「共同情况」第 1 条。
- 计划（会话的任务清单）：写 bundle → 语法检查和技能注册对象检查 → `plugin_manager` 安装 → 确认安装生效、技能已注册。
- bundle：`dsh-workflow-to-skill`，包名 `@local/dsh-workflow-to-skill`。文件：`package.json`、`cordis.patch.yml`（插入 `workflow-to-skill` 一行）、`index.js`（35 行，注入 `skills`，用 `ctx.skills.register` 注册运行时技能 `workflow-to-skill`，正文读同目录的 `skill-content.md`）、`skill-content.md`（89 行：何时用、五步流程、`SKILL.md` 的 frontmatter 规则、模板和例子、写入位置和优先级、发现和校验）、`icon.svg`、`locale/en.json`、`locale/zh.json`。
- 安装：`plugin_manager` 的 `install_bundle`，一次成功，`application: applied`，`warnings: []`。

过程：

1. 05:06–05:11 调研：`dsh-skill`、`dsh-skill-filesystem`、`dsh-tool-skill` 的 README 和 `skill/src/index.ts`；用 `cordis_inspect_query` 确认 live 的 `skills` 服务有 `register`、`registerProvider`、`list`、`snapshot`、`get`；参照候选 55d42252 的 bundle 写法。
2. 05:11 写出 bundle，`node --check`、JSON 检查和注册对象检查通过；05:11:48 安装。
3. 05:12–05:13 自验：技能出现在本会话的技能目录；`skill {"name":"workflow-to-skill"}` 读回完整正文（provider 为 `runtime`）。05:13:21 结束，结尾提出可以再写一个示例 `SKILL.md` 演示，没有接着做。

提问和回复：`ask_user_question` 0 次，没有文字提问。

审批：1 张卡片，05:11:48 `plugin_manager` `install_bundle`，允许一次。

问题和处理：无失败。

外部验证：

- 工作目录里只有 `dsh-workflow-to-skill/`：`cordis.patch.yml`、`icon.svg`、`index.js`、`locale/en.json`、`locale/zh.json`、`package.json`、`skill-content.md`。
- `dsh plugin --profile opencodex list` 列出 `@local/dsh-workflow-to-skill@link:../../opencodex/work/2a049328-38c0-4269-b181-4a3c34f5a900/dsh-workflow-to-skill`。插件页「已安装」里是「工作流转技能」，描述「新增 workflow-to-skill 指导技能，把完成的电脑使用工作流写成可复用的 SKILL.md。」，图标正常显示。
- 新会话输入框打 `/workflow`，补全列表的「技能」一栏出现 `workflow-to-skill` 和它的描述。
- 新开普通会话 `session-6ae4d907-bf59-4010-8541-9ce09705c0dd`，请会话先加载 `workflow-to-skill`，再按它把「在仓库根目录运行 `git worktree list --porcelain`，逐条读出每个 worktree 的路径、HEAD 和分支」存成技能（先切到一个带 `.git` 的测试项目），写完读回：模型调用 `skill {"name":"workflow-to-skill"}` 拿到正文，写出 `.dsh/skills/list-git-worktrees/SKILL.md`（frontmatter 有 `name`、`description`、`whenToUse`），再调用 `skill {"name":"list-git-worktrees"}`，由 skill-filesystem 读回全文。技能正文里的写入位置和优先级（`<projectRoot>/.dsh/skills` 100、`<projectRoot>/.agents/skills` 200、`<dshHome>/skills` 400、`<agentsHome>/skills` 500）和 `dsh-skill-filesystem` 的 README 一致。这次验证 6 次模型调用，合计 69,271 token。

用时和用量：

- 用时：05:06:16 建会话到 05:13:21 结束，7.1 分钟，一轮。
- 模型调用 20 次，全部 V4-Pro。输入 1,365,392（未命中缓存 87,056，缓存命中 1,278,336），输出 44,191，合计 1,409,583。最后一次请求的上下文 115,019。

结论：可用。只做了第 1 级：不录制、不回放，靠模型按指引手写 `SKILL.md`。

试用：用上面的命令启动 DSH，在任一会话输入 `/workflow-to-skill`，或说「先用 skill 工具加载 workflow-to-skill，再把刚才的流程存成技能」。

### 共同情况

1. 会话里换模型会改 profile 的默认模型：模型选择器的选择写进了 `~/.dsh/profiles/opencodex/cordis.patch.yml` 的 `agent-default-model`（deepseek-v4-pro，high），之后新建的会话都默认 V4-Pro，第二个开工会话也是。实跑结束后删掉了这一项，profile 默认回到 deepseek-flash。OpenCodex 开工时不指定模型。
2. 每次 `plugin_manager` 调用都要审批，卡片写「允许本次操作使用 danger-full-access 权限」，只对那一次调用生效，会话的沙箱一直是 `workspace-write`。两条候选共 6 张卡片：允许 5 次，拒绝 1 次。
3. 两个 bundle 都以 `link:` 装进 profile，profile 读的就是开工工作目录本身：改工作目录里的文件会改已装的插件（Host 代码要重启才生效），删工作目录会让 profile 装不起来。
4. profile 依赖 OpenCodex 的 tgz 路径：`install_bundle` 每次对整个 profile 重跑 pnpm，`dsh-opencodex` 的 `file:` tgz 不在原路径时，装任何插件都失败（问题 1）。
5. 页面和 Host：两次点「开工」都直接切到新会话；候选状态变为「已开工」并显示会话 id 和时间；DSH 重启后，详情里的「打开会话」能回到原会话。会话标题按 60 个字符截断，截断处不加省略号（「…worktrees fro」）。

### 提示词改进

开工提示词：

1. 范围：只做报告建议的那一级；要打开其他官方或实验插件时先用 `ask_user_question` 问。候选 55d42252 想连带打开 `create_worktree`。
2. 先查 live 组合：写代码前用 `cordis_inspect_query` 确认要注入的服务在当前 profile 里存在。`worktrees` 不在，第一版装上后卡在 pending。
3. 只装一次：检查全部做完再 `install_bundle`。装过以后又改了 Host 代码，同名重装要重启 DSH，要在结尾写明，或者换包名。
4. 调研和搜索范围：候选 55d42252 到第一次安装用了 93 次模型调用（04:32–04:40），大部分在读 DSH 运行时的内部实现：插件加载器的模块解析、`dsh-tools` 的参数编译和调度、sandbox、subprocess、fs 的类型声明。安装失败后还跑过 `find /Users/ziya -name dsh-opencodex-0.3.0.tgz`，扫整个主目录，60 秒后转为后台任务，随后被会话停掉。可写明：先用 inspect 工具和包 README，搜索只在工作目录、profile 目录和镜像里做。
5. 临时文件：候选 55d42252 在 /tmp 留下 `plugprobe.WbxkBb`、`wtprobe.B583jA` 两个临时目录。可写明：临时仓库建在工作目录里，结束前删掉。
6. 模型：开工会话要固定用 V4-Pro 的话，宜在建会话时指定，不靠在会话里切（会改 profile 默认，见「共同情况」第 1 条）。

报告提示词：「DSH 现在有没有」一节要分清源码里有和默认组合里开着。候选 55d42252 的报告按源码写「DSH 已有 `create_worktree`」，默认 profile 里这个工具没开，开工时才发现。

# 第一期验收：命令行采集

执行日期：2026-10-15，第一次运行开始于 14:00:35 UTC。仓库在 `40eedda`，加上本次提交对 PR 查询失败提示措辞的改动（两次运行都没有触发这条提示）。DSH 官方镜像 `~/harness/deepseek-harness` 在 `cc6a8f59b41`。本机 Node 25.8.1，`gh` 已登录 github.com，ChatGPT.app 为 `26.1007.21159 (20052)`。

验收标准：不启动 DSH，一条命令把四路来源的候选写进一个新建的空数据目录；对同一目录再跑一次，不新增任何候选。

两次运行用同一条命令：

```bash
npx tsx scripts/collect.ts --home <新建的空目录> --mirror ~/harness/deepseek-harness
```

脚本依次打印检查结果的 JSON、桌面端一行和候选列表。候选列表按来源分组，最多 30 行。`errors` 不为空时退出码为 1，参数或 `--home` 有问题时为 2。结果里的 `files.unread` 按原因统计没读到内容的文件（超出读取上限、遇到速率限制、读取失败），`index.builtAt` 是索引的生成时间。来源失败和部分结果的提示（速率限制、未读文件、断档）都写进 `errors`，每条以来源名开头。

## 第一次运行

用时 57 秒，退出码 0，`errors` 为空，没有任何提示。

- release notes：窗口从 `rust-v0.161.0` 到 `rust-v0.162.1`，新增 6 条，都来自 0.162.0 的 New Features。0.162.1 只有 Bug Fixes，没有候选。
- 受关注路径：窗口相同，新增 2 条：功能开关注册表 1 条，协议类型 1 条（17 个类型）。`unread` 三项都是 0，改动的文件都读到了内容。
- 桌面端：第一次运行只建基线，`changed` 为 true，新增 0。zh-CN 文案包里有 3208 个 `codex.` 键。
- RSS：新增 41 条。
- DSH 索引：825 条，其中包 340 条、config 151 条、notes 334 条，`builtAt` 是这次的生成时间。

```text
{
  "releases": {
    "window": {
      "from": "rust-v0.161.0",
      "to": "rust-v0.162.1",
      "releases": [
        "rust-v0.162.1",
        "rust-v0.162.0"
      ]
    },
    "added": 6,
    "gap": false,
    "prLookupFailures": 0,
    "unreleased": [],
    "unrecognized": [],
    "rateLimited": false
  },
  "files": {
    "window": {
      "from": "rust-v0.161.0",
      "to": "rust-v0.162.1",
      "releases": [
        "rust-v0.162.1",
        "rust-v0.162.0"
      ]
    },
    "added": 2,
    "merged": 0,
    "gap": false,
    "unread": {
      "overBudget": 0,
      "rateLimited": 0,
      "failed": 0
    }
  },
  "desktop": {
    "version": "26.1007.21159 (20052)",
    "changed": true,
    "added": 0,
    "keys": 3208,
    "localeBundle": "/webview/assets/zh-CN-b05cfd55c534.js"
  },
  "rss": 41,
  "errors": [],
  "index": {
    "entries": 825,
    "commit": "cc6a8f59b4121994a3295f2be188ae0f4b1c6d39",
    "builtAt": "2026-10-15T14:01:32.186Z"
  }
}
desktop: version 26.1007.21159 (20052), changed true, added 0, keys 3208, localeBundle /webview/assets/zh-CN-b05cfd55c534.js, keysReset false
candidates: 49 (codex-release 6, codex-files 2, desktop 0, rss 41)
- [codex-release] Add tools for creating and listing managed Git worktrees from trusted local projects when the worktrees feature is enabled. (1 evidence)
- [codex-release] Pin tasks in the agent Command Center with `p` and keep them in a shared Pinned group when supported by the server. (1 evidence)
- [codex-release] Navigate and copy transcript blocks with `/copy`, use `Ctrl+Insert` to copy selections, and tune mouse-wheel scrolling with `tui.mouse_scroll_speed`. (3 evidence)
- [codex-release] Make URLs clickable in approval headers, questions, MCP prompts, warnings, banners, and verification prompts, including when links wrap across lines. (6 evidence)
- [codex-release] Configure live web access and remote compaction capabilities for custom Responses-compatible model providers. (1 evidence)
- [codex-release] Add JavaScript helpers for streaming promise results as they settle, plus opt-in ranked tool search in Code Mode. (2 evidence)
- [codex-files] 功能开关注册表有变化（0.162） (2 evidence)
- [codex-files] 协议类型有变化（0.162）：17 个类型 (17 evidence)
- [rss] Composer predictions in Codex (1 evidence)
- [rss] Added the option to move selected chats to a project at once. (1 evidence)
- [rss] Added a notification sound setting for task completions, permission requests, and questions. (1 evidence)
- [rss] Chat while you work (1 evidence)
- [rss] Share an app window on Windows (1 evidence)
- [rss] Added a configurable shortcut to open web links in your default browser. (1 evidence)
- [rss] Added Open with > New tab to file diffs so you can open a source file at the selected line in the app. (1 evidence)
- [rss] Codex app (1 evidence)
- [rss] More browsers (1 evidence)
- [rss] Site tools (WebMCP) (1 evidence)
- [rss] Cloud browser sign-in (1 evidence)
- [rss] Trigger scheduled tasks from Gmail, Slack, and GitHub events (1 evidence)
- [rss] Apple Messages (1 evidence)
- [rss] Site co-editing (1 evidence)
- [rss] Editable Site URLs (1 evidence)
- [rss] Computer History in Europe (1 evidence)
- [rss] Shared thread snapshots (1 evidence)
- [rss] Unified pinned threads (1 evidence)
- [rss] Codex app (1 evidence)
- [rss] GitLab support in Codex cloud (Beta) (1 evidence)
- [rss] Public plugin catalog CSV export (1 evidence)
- [rss] Computer History (1 evidence)
```

## 第二次运行

用时 9 秒，退出码 0，`errors` 为空。四路新增都是 0：两个 GitHub 来源的检查点已经是最新 tag，没有窗口；桌面端版本没变，`changed` 为 false；RSS 新增 0。候选仍是 49 条。索引每次检查都重建，条目数不变，`builtAt` 换成这次的时间。

```text
{
  "releases": {
    "added": 0,
    "gap": false,
    "prLookupFailures": 0,
    "unreleased": [],
    "unrecognized": [],
    "rateLimited": false
  },
  "files": {
    "added": 0,
    "merged": 0,
    "gap": false,
    "unread": {
      "overBudget": 0,
      "rateLimited": 0,
      "failed": 0
    }
  },
  "desktop": {
    "version": "26.1007.21159 (20052)",
    "changed": false,
    "added": 0,
    "keys": 3208,
    "localeBundle": "/webview/assets/zh-CN-b05cfd55c534.js"
  },
  "rss": 0,
  "errors": [],
  "index": {
    "entries": 825,
    "commit": "cc6a8f59b4121994a3295f2be188ae0f4b1c6d39",
    "builtAt": "2026-10-15T14:01:41.234Z"
  }
}
desktop: version 26.1007.21159 (20052), changed false, added 0, keys 3208, localeBundle /webview/assets/zh-CN-b05cfd55c534.js, keysReset false
candidates: 49 (codex-release 6, codex-files 2, desktop 0, rss 41)
- [codex-release] Add tools for creating and listing managed Git worktrees from trusted local projects when the worktrees feature is enabled. (1 evidence)
- [codex-release] Pin tasks in the agent Command Center with `p` and keep them in a shared Pinned group when supported by the server. (1 evidence)
- [codex-release] Navigate and copy transcript blocks with `/copy`, use `Ctrl+Insert` to copy selections, and tune mouse-wheel scrolling with `tui.mouse_scroll_speed`. (3 evidence)
- [codex-release] Make URLs clickable in approval headers, questions, MCP prompts, warnings, banners, and verification prompts, including when links wrap across lines. (6 evidence)
- [codex-release] Configure live web access and remote compaction capabilities for custom Responses-compatible model providers. (1 evidence)
- [codex-release] Add JavaScript helpers for streaming promise results as they settle, plus opt-in ranked tool search in Code Mode. (2 evidence)
- [codex-files] 功能开关注册表有变化（0.162） (2 evidence)
- [codex-files] 协议类型有变化（0.162）：17 个类型 (17 evidence)
- [rss] Composer predictions in Codex (1 evidence)
- [rss] Added the option to move selected chats to a project at once. (1 evidence)
- [rss] Added a notification sound setting for task completions, permission requests, and questions. (1 evidence)
- [rss] Chat while you work (1 evidence)
- [rss] Share an app window on Windows (1 evidence)
- [rss] Added a configurable shortcut to open web links in your default browser. (1 evidence)
- [rss] Added Open with > New tab to file diffs so you can open a source file at the selected line in the app. (1 evidence)
- [rss] Codex app (1 evidence)
- [rss] More browsers (1 evidence)
- [rss] Site tools (WebMCP) (1 evidence)
- [rss] Cloud browser sign-in (1 evidence)
- [rss] Trigger scheduled tasks from Gmail, Slack, and GitHub events (1 evidence)
- [rss] Apple Messages (1 evidence)
- [rss] Site co-editing (1 evidence)
- [rss] Editable Site URLs (1 evidence)
- [rss] Computer History in Europe (1 evidence)
- [rss] Shared thread snapshots (1 evidence)
- [rss] Unified pinned threads (1 evidence)
- [rss] Codex app (1 evidence)
- [rss] GitLab support in Codex cloud (Beta) (1 evidence)
- [rss] Public plugin catalog CSV export (1 evidence)
- [rss] Computer History (1 evidence)
```

第二次运行后，`state.json` 里有五个检查点：`lastStableTag` 和 `lastFilesTag` 都是 `rust-v0.162.1`，`lastDesktopVersion` 是 `26.1007.21159 (20052)`，另有 `rssHash` 和 `indexCommit`。桌面端快照有一个版本，占 2.4 MB；索引文件 1.0 MB。

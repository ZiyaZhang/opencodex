/**
 * The gap-report template and its writing rules, sent to the analyst session with every report prompt. It is a string module rather than
 * a `.md` file because the Host is bundled into a single `dist/host/index.js`, where a path relative to `import.meta.url` does not exist
 * after install. Placeholders, filled by the report session: `{{title}}`, `{{id}}`, `{{source}}`, `{{window}}`, `{{startedAt}}`
 * (when the prompt is sent; the report record's `generatedAt` is when the report was read).
 * The `## ` headings are the sections `checkReport` requires.
 */

/**
 * Evidence rules adapted from REA (`rea-agents`, https://github.com/morluto/rea, MIT; see THIRD_PARTY_NOTICES.md) and translated, numbered
 * 1 to 7 here. The analyst session writes by 1 to 5, and the creator session's brief repeats 4 and 5, which hold for reading code too.
 * Rule 6 (the questions first, a status for each at the end) is the table that opens 结论, so it is not a writing rule as well; rule 7
 * (instructions found in the evidence) is in each session's prompt, worded for what that session can do about them.
 */
export const EVIDENCE_RULES = {
  /**
   * 1: an observation is something the evidence or the mirror shows, with the citation; an inference is marked as one. The mirror counts
   * because the DSH section is found by searching it, not the evidence.
   */
  observed: '观察只能来自证据目录和 DSH 镜像里能查到的内容，并给出引用；推断要标明"推断"，写出置信度和别的可能解释。',
  /** 2: a gap left out of the report reads as covered. */
  unknowns: '证据不全、不支持或互相矛盾的地方都列为未知，不要省略。',
  /** 3: in evidence that is not complete, what was not seen may still be there. */
  unseen: '证据不完整时，"没看到"不能写成"没有"或"相同"。',
  /** 4: desktop candidates are found by chunk names and i18n keys, which say what changed, not what it does. */
  names: '不能只凭文件名、chunk 名、文案 key 或字符串推断行为。',
  /** 5: the same distinction as present in the mirror source and enabled in the default profile. */
  staticOnly: '静态分析看到的东西不能说成运行时可达或默认开启。',
} as const;

export const TEMPLATE: string = [
  '# {{title}}',
  '',
  '候选 ID：{{id}}　来源：{{source}}　窗口：{{window}}　会话开始时间：{{startedAt}}',
  '',
  '## 结论',
  '',
  '先用两列表格列出这份报告要回答的问题和状态（已答 / 部分 / 未解决），再写一句话结论：做/可做/不做，工作量（小时或天），为什么。',
  '',
  '## Codex 怎么做的',
  '',
  '每条都带引用：PR 号与标题、`路径:行号`、asar chunk 名或 i18n key。只写证据目录里能查到的事，推断要写明"推断"。',
  '',
  '## DSH 现在有没有',
  '',
  '每条分开写两种状态：',
  '',
  '- 源码里有（路径:行号）：带 `相对镜像根目录的路径:行号`。镜像根目录在 evidence/INDEX.md 里给出；用 DSH 自带的搜索工具或 grep/rg（rg 可能没装）和 read 自己定位，不只看 dsh/ 下的摘要。索引没命中就写"未找到：查过 X、Y、Z"，不写"没有"。',
  '- 默认 profile 里是否启用（看 packages/bundle/base/cordis.patch.yml 和 packages/bundle/web-app/presets/，没查到就写“未知”）：源码里有的包不一定默认加载，实验性的功能常常默认关闭。',
  '',
  '## 差哪些扩展点',
  '',
  '缺的服务、Slot、工具、协议字段、配置项，各一条。',
  '',
  '## 分级',
  '',
  '| 级别 | 支持 | 触发 | DSH 工作 |',
  '|---|---|---|---|',
  '| 0 | 不做 | — | 无 |',
  '| 1 | … | … | …（含工时） |',
  '| 2 | … | … | … |',
  '',
  '## 建议',
  '',
  '做哪一级，先做什么，依赖什么。',
  '',
  '---',
  '',
  '写作规则（照做，不写进报告）：平铺名词标题；先结论；不用比喻词；每段落不超过六行；数字放表格；凭公告文字写不出来的就写"未知"。',
  '区分“镜像源码里存在”与“默认 profile 里启用”，两者都写。',
  EVIDENCE_RULES.observed,
  EVIDENCE_RULES.unknowns,
  EVIDENCE_RULES.unseen,
  EVIDENCE_RULES.names,
  EVIDENCE_RULES.staticOnly,
].join('\n');

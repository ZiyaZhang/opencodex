/**
 * The gap-report template and its writing rules, sent to the analyst session with every report prompt. It is a string module rather than
 * a `.md` file because the Host is bundled into a single `dist/host/index.js`, where a path relative to `import.meta.url` does not exist
 * after install. Placeholders, filled by the report session: `{{title}}`, `{{id}}`, `{{source}}`, `{{window}}`, `{{generatedAt}}`.
 * The `## ` headings are the sections `checkReport` requires.
 */
export const TEMPLATE: string = [
  '# {{title}}',
  '',
  '候选 ID：{{id}}　来源：{{source}}　窗口：{{window}}　生成时间：{{generatedAt}}',
  '',
  '## 结论',
  '',
  '一句话：做/可做/不做，工作量（小时或天），为什么。',
  '',
  '## Codex 怎么做的',
  '',
  '每条都带引用：PR 号与标题、`路径:行号`、asar chunk 名或 i18n key。只写证据目录里能查到的事，推断要写明"推断"。',
  '',
  '## DSH 现在有没有',
  '',
  '每条都带 `相对镜像根目录的路径:行号`。镜像根目录在 evidence/INDEX.md 里给出；用 rg 和 read 自己去定位，不只看 dsh/ 下的摘要。索引没命中就写"未找到：查过 X、Y、Z"，不写"没有"。',
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
].join('\n');

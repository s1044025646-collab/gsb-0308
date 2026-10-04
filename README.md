# Gitignore 规则匹配与目录剪枝解释后端

一个**完全离线**的 Gitignore 规则分析服务：用户给出相对“虚拟项目根目录”的文件树和一份根目录忽略规则文本，
即可查询哪些路径会被忽略、**哪一条规则（行号/原文/取反）决定结果**，以及父目录被排除时对子树的剪枝影响。

只对内存中的**虚拟路径**做计算：不触碰真实文件、不调用 Git、不做备份/打包/同步。

- 语言/运行时：TypeScript + Node.js（使用内置实验模块 `node:sqlite`，建议 Node ≥ 22.5，本机 Node 25 验证通过）
- 存储：SQLite（项目内 `./data/app.sqlite`，WAL 模式）
- 形态：仅 HTTP API 与 CLI，无前端、无 Docker/WSL、无在线服务

## 支持的规则子集（语法版本 `gitignore-subset/1.0`）

| 语法 | 含义 |
| --- | --- |
| 普通字面字符 | 按字面匹配 |
| `*` | 匹配除 `/` 外任意数量字符（不跨目录段） |
| `?` | 匹配除 `/` 外单个字符 |
| `**`（完整路径段） | 跨**零个或多个**目录层，如 `a/**/b` 同时匹配 `a/b`（零层）与 `a/x/y/b` |
| 开头 `/` | 锚定虚拟根目录，如 `/foo` 只匹配根下 `foo` |
| 结尾 `/` | 仅匹配**目录**，同名文件不匹配 |
| 开头 `!` | 取反（重新包含），后出现的规则覆盖前者 |
| `\#`、`\!` 开头 | 转义为字面 `#`、`!` |

无斜杠的“名字模式”（如 `*.log`）可在任意层级匹配；含 `/` 的模式相对虚拟根匹配。
空行、未转义 `#` 开头行为注释。

### 明确不支持（产生诊断，拒绝发布，不做兼容猜测）

- 字符类 `[ab]`、除开头 `\#`/`\!` 外的其他反斜杠转义、尾部空格（不隐式忽略）
- 段内双星（如 `a**b`）；嵌套 `.gitignore`（只有根目录一份规则）

任何非法规则都会让整次导入/分析失败并返回全部诊断（错误不会被静默跳过）。

## 核心语义：规则顺序 × 作用范围 × 目录剪枝

每个节点同时给出两层结论：

- **直接匹配 `directIgnored`**：只按模式逐条匹配，后出现的规则覆盖前者，不考虑父目录。
- **遍历结论 `ignored`**：从根做目录遍历。某目录一旦在本层被判为忽略，其整棵子树被**剪掉**，
  子节点不再评估规则；因此即使子文件直接命中取反规则，只要祖先目录仍被排除，它**依然不可见**。
  报告用 `prunedBy` / `blockerChain` 指出**最先阻断遍历的目录**。
- 若目录被取反规则重新包含（如 `build/` 之后再 `!build/`），遍历重新进入，子项再按各自规则判断。

## 输入与路径约束

- 路径统一正斜杠；拒绝绝对路径、盘符、反斜杠、空段（`a//b`）、`.`/`..` 段。
- 节点为对象数组，`type` 必须显式为 `"file"` 或 `"dir"`；必须显式列出所有父目录。
- 拒绝重复条目、文件充当目录父节点、缺失父目录。
- 结果对输入节点顺序不敏感（内部排序后遍历）。

默认规模限制（见 `src/limits.ts`，可改代码调整）：规则 500 条、节点 5000、深度 50、
路径长 260、模式长 200、规则文本 256KB、树载荷 2MB、匹配预算 200 万步（超出报 `MATCH_BUDGET_EXCEEDED`）。

## 快速开始

```powershell
npm install
npm run build     # 编译到 dist/
npm test          # 编译并运行全部 27 个测试
npm run demo      # 运行端到端演示（所有要求场景）
npm start         # 启动 HTTP 服务（默认自动选择空闲端口）
```

指定端口/数据目录：

```powershell
$env:PORT="8080"; $env:DATA_DIR="data"; npm start
```

## HTTP API

所有请求/响应均为 JSON。错误统一形如 `{ "code": "...", "message": "...", "issues"?: [...] }`。

| 方法 & 路径 | 说明 |
| --- | --- |
| `GET /health` | 健康检查 |
| `POST /rules` | 导入规则文本 `{ "content": "..." }`，生成新规则版本（非法规则整单失败） |
| `GET /rules` | 规则版本历史 |
| `POST /trees` | 导入虚拟树（节点数组，或 `{ "nodes": [...] }`） |
| `GET /trees` | 树版本历史 |
| `POST /analyze` | 分析全部路径；可用 `treeId`/`ruleVersionId` 指定版本，`save:false` 不落报告 |
| `POST /explain` | `{ "path": "build/keep.txt" }` 单路径解释（直接匹配 + 遍历结论 + 阻断链） |
| `POST /compare` | `{ "versionA": 1, "versionB": 2, "treeId": 1 }` 比较两版规则的最终可见性 |
| `GET /reports` | 报告历史列表 |
| `GET /reports/{id}` | 读取**冻结**的历史报告完整 JSON |

示例（PowerShell）：

```powershell
$b = "http://127.0.0.1:<端口>"
Invoke-RestMethod -Method Post "$b/rules" -ContentType 'application/json' `
  -Body '{"content":"*.log\n!logs/keep.log\nbuild/\n"}'
Invoke-RestMethod -Method Post "$b/trees" -ContentType 'application/json' `
  -InFile examples/tree.json
Invoke-RestMethod -Method Post "$b/explain" -ContentType 'application/json' `
  -Body '{"path":"build/keep.txt"}'
```

## CLI

```powershell
node dist/cli.js import-rules examples/rules.gitignore
node dist/cli.js import-tree  examples/tree.json
node dist/cli.js analyze --out result.json
node dist/cli.js explain build/keep.txt
node dist/cli.js compare 1 2
node dist/cli.js history
node dist/cli.js report 1 --out report-1.json
```

用 `$env:DATA_DIR="..."` 切换数据目录。

## 数据模型与历史冻结

SQLite 表（`src/db.ts`）：`rule_versions`、`tree_versions`、`reports`、`active_refs`。
每次导入规则/树都产生**新版本**；分析时可把完整结果保存为报告快照。
报告保存时连同结果 JSON、树版本、规则版本、语法版本一起冻结——之后编辑或删除规则不会改变旧报告。

## 错误码（节选）

`VALIDATION_FAILED`（含 `issues` 明细）、`ABSOLUTE_PATH_REJECTED`、`BACKSLASH_UNSUPPORTED`、
`EMPTY_PATH_SEGMENT`、`DOT_SEGMENT_REJECTED`、`DUPLICATE_ENTRY`、`MISSING_PARENT`、
`FILE_AS_DIRECTORY_PARENT`、`UNSUPPORTED_CHARACTER_CLASS`、`UNSUPPORTED_ESCAPE`、
`UNSUPPORTED_TRAILING_WHITESPACE`、`UNSUPPORTED_INFIX_DOUBLE_STAR`、`MATCH_BUDGET_EXCEEDED`、
`NO_RULES`、`NO_TREE`、`PATH_NOT_IN_TREE`、`REPORT_NOT_FOUND`、`PAYLOAD_TOO_LARGE`。

## 项目结构

```
src/
  errors.ts    统一错误码与诊断聚合
  limits.ts    规模限制与语法版本号
  types.ts     数据类型
  pathutil.ts  路径规范化
  tree.ts      虚拟树校验与稳定排序
  rules.ts     规则解析、诊断、段匹配器（含 ** 回溯）
  engine.ts    直接匹配 + 根遍历剪枝
  db.ts        SQLite 持久层与报告冻结
  service.ts   编排：导入/分析/解释/对比
  server.ts    HTTP API（默认空闲端口）
  cli.ts       命令行
  demo.ts      端到端演示
  tests/       node:test 测试
```

## 已知限制

- 仅实现上文列出的规则子集；字符类、其他转义、尾部空格、嵌套 `.gitignore` 一律报错而非兼容。
- 存储使用 Node 内置 `node:sqlite`（实验模块，已抑制实验警告）；需 Node ≥ 22.5。
- 无鉴权/并发写锁优化，面向本地单机使用；不提供任何真实文件操作。

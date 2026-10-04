# Gitignore 规则匹配与目录剪枝解释后端

一个**完全离线**的 `.gitignore` 规则分析服务：输入虚拟文件树（节点数组，文件/目录身份显式给出）与一份根目录忽略规则，输出每个路径的最终可见性、命中的每条规则、决定性规则行号，以及父目录被排除时对子树的剪枝链。只计算虚拟路径，**不触碰真实文件、不操作 Git 工作区、不做备份/打包/同步**。

技术栈：TypeScript + Node.js（原生 `node:sqlite`，无需编译原生模块）+ 内置 HTTP API 与 CLI。无需 Docker、WSL 或任何在线服务。

## 运行环境

- Windows，Node.js **>= 22.5**（开发与验证使用 Node v25.5.0；`node:sqlite` 为内置实验模块，运行时会打印一条 ExperimentalWarning，不影响功能）

## 快速开始

```powershell
npm install
npm run build      # TypeScript 编译到 dist/
npm test           # 运行全部测试（32 个用例）
npm run demo       # 内置五个核心场景演示（先编译）
npm start          # 启动 HTTP API，默认自动选择空闲端口
# 或指定端口 / 数据文件：
node dist/cli.js serve --port 8080 --db data/app.db
```

## 支持的规则子集（syntaxVersion: `gitignore-subset/1.0`）

| 语法 | 含义 |
| --- | --- |
| 普通字面字符 | 字面匹配 |
| `*` 单星号 | 匹配任意个**非斜杠**字符 |
| `?` 问号 | 匹配**一个**非斜杠字符 |
| `**` 双星号 | 必须是**完整路径段**（`a/**/b`、`**/b`、`a/**`），跨零个或多个目录层；`a**b` 等写法报错 |
| 开头 `/` | 锚定虚拟根，如 `/rootonly.log` 不匹配 `src/rootonly.log` |
| 结尾 `/` | 仅匹配目录，如 `build/` 不匹配同名文件 |
| 开头 `!` | 取反（重新包含），后出现的规则覆盖此前规则 |
| `\#`、`\!` 开头 | 转义为字面 `#` / `!` |
| 空行、未转义 `#` 开头 | 注释，忽略 |

**明确不支持并报诊断**（不猜测 Git 兼容性）：

- 字符类 `[abc]`、`[0-9]`
- 除 `\#`、`\!`、`\\`、`\*`、`\?` 外的其他反斜杠转义
- 未转义的尾部空格（不实现空格转义）
- 嵌套 `.gitignore`（仅接受根目录一份规则）
- 非完整路径段的 `**`

## 语义模型（核心）

1. 规则按**行序**对路径直接生效，后出现的匹配规则覆盖之前规则，最后一条命中规则决定“直接效果”。
2. 从根做目录遍历：目录的最终状态若为 ignored，则其子树被**剪枝**。子文件即便被取反规则直接命中（`directIgnored=false`），也**不能越过**仍被排除的父目录；报告给出**最先阻断遍历的目录**（`blockerChain[0]`）及其规则，而非只写最后命中的规则。
3. 父目录被 `!dir/` 重新包含（且其父链未被剪枝）后，遍历恢复，再按子项自身规则判断。

每个路径的解释同时包含：

- `directMatches`：直接命中的全部规则（行号、原文、正向/取反、锚定/名字）
- `directIgnored` / `visible`：**仅直接匹配**与**遍历后**两种结果（二者可能不同）
- `decisiveRule`：决定最终结果的规则
- `blockerChain`：阻断链（首个元素即最先阻断的祖先目录）

## 限制（可在 `src/limits.ts` 调整）

规则 ≤ 2000 条、单规则 ≤ 1024 字符、节点 ≤ 50000、深度 ≤ 100、路径 ≤ 1024 字符、匹配预算 500 万次正则测试（超出返回 `MATCH_BUDGET_EXCEEDED`）。路径必须用正斜杠；拒绝绝对路径、盘符、空段、`.`/`..` 段、重复条目，以及文件充当目录父节点。

**错误规则不会被静默跳过**：任何一条诊断都会导致整份规则被拒绝（HTTP 400 / CLI 退出码 1），不会发布成功报告。

## CLI

```powershell
node dist/cli.js demo
node dist/cli.js check --rules rules.txt --path logs/a.log --type file
node dist/cli.js analyze --rules rules.txt --tree tree.json
node dist/cli.js import-tree --name demo --tree tree.json --db data/app.db
node dist/cli.js add-rules --tree 1 --rules rules.txt --db data/app.db
node dist/cli.js run --tree 1 [--rule-version 1]          # 分析并保存不可变报告
node dist/cli.js explain --tree 1 --path build/keep.txt --type file
node dist/cli.js diff --tree 1 --a 1 --b 2               # 比较两个规则版本
node dist/cli.js history [--tree 1]
node dist/cli.js report --id 1 [--out report.json]        # 读取 / JSON 导出
node dist/cli.js serve [--port 8080] [--db data/app.db]
```

`tree.json` 形如：

```json
[
  { "path": "build", "type": "dir" },
  { "path": "build/keep.txt", "type": "file" }
]
```

## HTTP API

统一返回 `{ ok: true, data: ... }`；失败返回 `{ ok: false, error: { code, message, details } }` 与对应 HTTP 状态码。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查与语法版本 |
| POST | `/api/trees` | 导入虚拟树 `{ name, nodes }` |
| GET | `/api/trees` / `/api/trees/:id` | 列出 / 查看树 |
| POST | `/api/validate-rules` | 仅校验规则，返回诊断 |
| POST | `/api/trees/:id/rules` | 新增规则版本（有诊断则 400） |
| GET | `/api/trees/:id/rules` / `/api/trees/:id/rules/:v` | 版本列表 / 原文 |
| POST | `/api/trees/:id/analyze` | 全路径分析，保存不可变报告（body 可选 `{ ruleVersion }`） |
| POST | `/api/trees/:id/explain` | 解释单路径 `{ path, type, ruleVersion? }` |
| GET | `/api/trees/:id/diff/:a/:b` | 比较两个规则版本 |
| GET | `/api/reports` / `/api/reports/:id` | 历史报告列表 / 完整报告 |

错误码示例：`VALIDATION_ABSOLUTE_PATH`、`VALIDATION_DUPLICATE_ENTRY`、`VALIDATION_PARENT_IS_FILE`、`RULE_CHARACTER_CLASS_UNSUPPORTED`、`RULE_TRAILING_SPACE_UNSUPPORTED`、`RULE_INVALID_ESCAPE`、`RULE_EMPTY_BODY`、`RULE_TOO_MANY`、`MATCH_BUDGET_EXCEEDED`、`TREE_NOT_FOUND`、`VERSION_NOT_FOUND`、`REPORT_NOT_FOUND`、`INVALID_JSON`。

## 数据与不可变性

- SQLite 文件默认位于项目内 `data/gitignore-analyzer.db`（自动创建，WAL 模式）。
- 表：`trees`（树版本/快照）、`rule_versions`（规则原文、版本号、语法版本）、`reports`（生成时的完整 JSON 快照）。
- 编辑规则总是追加**新版本**；报告保存的是当时计算结果的完整快照，因此后续删除/修改规则不会改变旧报告，服务重启后旧报告依旧完整可读（已由持久化测试覆盖）。

## 演示场景与验证

`npm run demo` 覆盖：

1. `*.log` 忽略全部日志 + `!logs/keep.log` 重新包含单个文件；
2. `/rootonly.log` 根锚定 vs `*.tmp` 任意层名字匹配；
3. `**/*.tmp` 匹配零层（`zero.tmp`）与多层（`a/b/c/deep.tmp`）；
4. `build/` 忽略后，`!build/keep.txt` 直接命中取反但**仍不可见**，阻断链指向 `build`；
5. 增加 `!build/` 恢复父目录后，`!build/keep.txt` 生效。

手写预期测试还覆盖：顺序颠倒、目录专用模式不匹配文件、文件与目录同名、`\#`/`\!` 转义、空规则体、直接匹配与遍历结果差别、输入节点重排不变性、规则版本比较、服务重启后旧报告完整可读。

### 与 Git 的子集对照（可选）

可在项目内临时目录用真实 Git 交叉核对（主实现**不调用 Git**）：

```powershell
mkdir tmp-gitcheck; cd tmp-gitcheck; git init
# 写入 .gitignore 与空文件后：
git check-ignore -v --no-index logs/a.log build/keep.txt
```

已核对：`*.log`、`!logs/keep.log`、`build/`、`/rootonly.log`、`**/*.tmp` 的命中路径与本服务一致（`build/keep.txt` 在 Git 中同样因父目录剪枝显示为 `build/` 决定）。

## 已知限制与假设

- 省略中间目录是允许的（只要不存在“文件充当父节点”）；显式列出的目录身份以输入为准。
- 仅一份根规则；不合并多层 `.gitignore`。
- 匹配预算按“规则 × 路径”的正则测试次数计；超限直接报错而非截断。
- 路径比较区分大小写（与 Linux Git 一致；Windows Git 默认大小写不敏感，此差异属于明确子集选择）。
- `node:sqlite` 在当前 Node 版本标记为实验性，后续 Node 大版本若调整 API 需要小幅适配。

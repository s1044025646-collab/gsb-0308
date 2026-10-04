/** 节点类型：文件或目录必须显式给出。 */
export type NodeType = "file" | "dir";

export interface TreeNodeInput {
  /** 相对虚拟项目根目录的路径，使用正斜杠，例如 "src/a.ts"。 */
  path: string;
  type: NodeType;
}

/** 校验后的树节点。 */
export interface TreeNode extends TreeNodeInput {
  /** 规范化后的路径（去掉末尾斜杠）。 */
  path: string;
  segments: string[];
  name: string;
  parent: string | null;
}

/** 编译后的规则。 */
export type SegmentPattern = { kind: "glob"; regex: RegExp } | { kind: "dblstar" };

export interface CompiledRule {
  line: number;
  raw: string;
  negated: boolean;
  dirOnly: boolean;
  anchored: boolean;
  /** 段匹配器；anchored=false 时长度为 1，对每个名字段尝试。 */
  patterns: SegmentPattern[];
  /** 原始模式片段（去掉锚定/取反/目录标记后的部分）。 */
  body: string;
}

export interface RuleMatch {
  line: number;
  raw: string;
  negated: boolean;
}

/** 目录剪枝阻断链上的一个环节。 */
export interface Blocker {
  path: string;
  line: number;
  raw: string;
}

export interface PathReport {
  path: string;
  type: NodeType;
  /** 直接对该路径做模式匹配的结论（不考虑父目录剪枝）。 */
  directIgnored: boolean;
  /** 直接命中的全部规则，按行号升序。 */
  directMatches: RuleMatch[];
  /** 直接匹配层面最后生效的规则（后出现者覆盖前者）。 */
  directDecidingRule: RuleMatch | null;
  /** 从根遍历后的最终可见性：true 表示被忽略（不可见）。 */
  ignored: boolean;
  /** 最终决定该节点结果的规则（可能来自父目录剪枝）。 */
  decidingRule: RuleMatch | null;
  /** 最先阻断遍历的目录链；空数组表示没有被父目录剪枝。 */
  blockerChain: Blocker[];
  /** 该节点被父目录剪枝时，最先阻断的目录；否则为 null。 */
  prunedBy: Blocker | null;
  /** 父目录是否被剪枝（导致取反规则无法越过）。 */
  parentPruned: boolean;
}

export interface AnalysisResult {
  syntaxVersion: string;
  ruleVersionId: number | null;
  treeId: number | null;
  reports: PathReport[];
  ignoredCount: number;
  visibleCount: number;
}

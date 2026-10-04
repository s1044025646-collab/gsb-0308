export type NodeType = 'file' | 'dir';

export interface TreeNodeInput {
  /** 相对虚拟根目录的路径，统一正斜杠，例如 "src/app.ts"、"build"。 */
  path: string;
  type: NodeType;
}

export interface TreeNode extends TreeNodeInput {
  segments: string[];
}

export interface RuleHit {
  line: number;
  raw: string;
  effect: 'positive' | 'negation';
  matchedPath: string;
  kind: 'name' | 'anchored';
}

export interface PathExplanation {
  path: string;
  type: NodeType;
  /** 不考虑父目录剪枝时，路径自身命中的全部规则（按行号）。 */
  directMatches: RuleHit[];
  /** 路径自身最后一条命中规则的作用；无命中为 null。 */
  directLastEffect: 'positive' | 'negation' | null;
  /** 仅看直接匹配是否会被忽略。 */
  directIgnored: boolean;
  /** 从根遍历时是否可见（可见 = 未被忽略）。 */
  visible: boolean;
  /** 最终是否被忽略（= !visible）。 */
  ignored: boolean;
  /** 决定最终结果的最后一条命中规则（含父目录），可能为 null。 */
  decisiveRule: RuleHit | null;
  /** 最先阻断遍历的祖先目录链；空数组表示无阻断。 */
  blockerChain: Blocker[];
}

export interface Blocker {
  dirPath: string;
  rule: RuleHit;
}

export interface ReportRow {
  path: string;
  type: NodeType;
  ignored: boolean;
  visible: boolean;
  directIgnored: boolean;
  decisiveLine: number | null;
  blockerPath: string | null;
}

export interface AnalysisReport {
  syntaxVersion: string;
  treeVersion: number;
  ruleVersion: number;
  createdAt: string;
  rows: ReportRow[];
  explanations: Record<string, PathExplanation>;
  stats: {
    total: number;
    ignored: number;
    visible: number;
    prunedSubtrees: number;
  };
}

/** 可配置的规模限制，防止极端输入拖垮服务。 */
export interface LimitConfig {
  maxRules: number;
  maxTreeNodes: number;
  maxDepth: number;
  maxPathLength: number;
  maxPatternLength: number;
  maxTreePayloadBytes: number;
  maxRulesPayloadBytes: number;
  /** 单次遍历允许消耗的匹配预算（token 对齐步数）。 */
  matchBudget: number;
}

export const DEFAULT_LIMITS: LimitConfig = {
  maxRules: 500,
  maxTreeNodes: 5000,
  maxDepth: 50,
  maxPathLength: 260,
  maxPatternLength: 200,
  maxTreePayloadBytes: 2 * 1024 * 1024,
  maxRulesPayloadBytes: 256 * 1024,
  matchBudget: 2_000_000,
};

/** 当前实现的规则语法版本。旧报告按写入时的版本冻结保存。 */
export const SYNTAX_VERSION = "gitignore-subset/1.0";

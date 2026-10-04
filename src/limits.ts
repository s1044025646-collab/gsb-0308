export const SUPPORTED_SYNTAX_VERSION = 'gitignore-subset/1.0';

export interface Limits {
  maxRules: number;
  maxRuleLength: number;
  maxNodes: number;
  maxTreeDepth: number;
  maxPathLength: number;
  matchBudget: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxRules: 2000,
  maxRuleLength: 1024,
  maxNodes: 50000,
  maxTreeDepth: 100,
  maxPathLength: 1024,
  matchBudget: 5_000_000,
};

import { AnalyzerError, type Diagnostic } from './errors.js';
import { DEFAULT_LIMITS, type Limits } from './limits.js';

export interface CompiledRule {
  line: number;
  raw: string;
  negated: boolean;
  /** 含路径分隔（或开头斜杠锚定）的模式相对根匹配；否则为任意层名字匹配。 */
  anchored: boolean;
  /** 结尾斜杠：仅匹配目录。 */
  dirOnly: boolean;
  /** 匹配完整路径（正斜杠分段，不含空段）的正则。 */
  regex: RegExp;
  /** 名字模式下用于快速判断的 basename 正则。 */
  nameRegex: RegExp | null;
}

/**
 * 支持的明确子集：
 *  - 普通字面字符
 *  - * 单星号：不跨斜杠
 *  - ? 问号：匹配单个非斜杠字符
 *  - ** 完整路径段双星号：跨零个或多个目录层
 *  - 开头 / 锚定根
 *  - 结尾 / 仅匹配目录
 *  - 开头 ! 取反
 *  - 开头 \# 或 \! 转义为字面量
 * 不支持并报诊断：字符类 [...]、其他反斜杠转义、尾部空格、嵌套 .gitignore。
 */
export function parseRules(text: string, limits: Limits = DEFAULT_LIMITS): {
  rules: CompiledRule[];
  diagnostics: Diagnostic[];
} {
  if (typeof text !== 'string') {
    throw new AnalyzerError('RULE_PARSE_ERROR', '规则文本必须是字符串');
  }
  const lines = text.split(/\r\n|\r|\n/);
  const rules: CompiledRule[] = [];
  const diagnostics: Diagnostic[] = [];

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    let line = lines[i] ?? '';

    if (line.length > limits.maxRuleLength) {
      diagnostics.push({
        line: lineNo,
        code: 'RULE_TOO_LONG',
        message: `规则长度超过 ${limits.maxRuleLength}`,
        raw: line,
      });
      continue;
    }

    // 空行 / 注释
    if (line === '') continue;
    if (line.startsWith('#')) continue;
    if (/\s$/.test(line)) {
      diagnostics.push({
        line: lineNo,
        code: 'RULE_TRAILING_SPACE_UNSUPPORTED',
        message: '不支持尾部空格（未实现空格转义），请删除尾部空白',
        raw: line,
      });
      continue;
    }

    let negated = false;
    if (line.startsWith('!')) {
      negated = true;
      line = line.slice(1);
    }

    let anchored = false;
    if (line.startsWith('/')) {
      anchored = true;
      line = line.slice(1);
    }

    let dirOnly = false;
    if (line.endsWith('/')) {
      dirOnly = true;
      line = line.slice(0, -1);
    }

    if (line === '') {
      diagnostics.push({
        line: lineNo,
        code: 'RULE_EMPTY_BODY',
        message: '规则去掉前缀/后缀斜杠后为空',
        raw: lines[i] ?? '',
      });
      continue;
    }

    // 开头字面转义：\# 与 \!
    if (line.startsWith('\\#') || line.startsWith('\\!')) {
      line = line.slice(1);
    }

    if (line.includes('[') || line.includes(']')) {
      diagnostics.push({
        line: lineNo,
        code: 'RULE_CHARACTER_CLASS_UNSUPPORTED',
        message: '不支持字符类 [...] 语法',
        raw: lines[i] ?? '',
      });
      continue;
    }

    let pattern: string;
    let namePattern: string | null = null;
    const containsSlash = line.includes('/');
    if (containsSlash) {
      anchored = true;
      pattern = line;
    } else {
      namePattern = line;
      pattern = line;
    }

    try {
      const regex = new RegExp('^' + buildRegexFromSegments(pattern.split('/')) + '$');
      const nameRegex = namePattern === null ? null : new RegExp('^' + patternToRegex(namePattern) + '$');
      rules.push({ line: lineNo, raw: lines[i] ?? '', negated, anchored, dirOnly, regex, nameRegex });
    } catch (err) {
      diagnostics.push({
        line: lineNo,
        code: err instanceof AnalyzerError ? err.code : 'RULE_PARSE_ERROR',
        message: `模式编译失败: ${(err as Error).message}`,
        raw: lines[i] ?? '',
      });
    }
  }

  if (rules.length > limits.maxRules) {
    throw new AnalyzerError('RULE_TOO_MANY', `规则数量超过 ${limits.maxRules}`, { count: rules.length });
  }
  return { rules, diagnostics };
}

/**
 * 将路径模式（已按 / 分段）转为正则片段。
 * 规则：* 不跨 /；? 匹配一个非 / 字符；** 必须是完整路径段，跨零或多个目录层；
 * 仅支持 \#、\!、\\、\*、\? 转义。
 */
export function patternToRegex(pattern: string): string {
  return buildRegexFromSegments(pattern.split('/'));
}

function buildRegexFromSegments(segments: string[]): string {
  let out = '';
  let i = 0;
  while (i < segments.length) {
    const seg = segments[i]!;
    if (seg === '**') {
      const rest = segments.slice(i + 1);
      if (rest.length === 0) {
        // 末尾或独立的 **：匹配零或多层
        out += out === '' ? '.*' : '(?:/.*)?';
        return out;
      }
      const restRegex = rest.map((s) => {
        if (s.includes('**')) {
          throw new AnalyzerError(
            'RULE_PARSE_ERROR',
            '双星号 ** 必须是完整路径段（不允许 a**、**b、a**b）',
            { segment: s },
          );
        }
        return segmentToRegex(s);
      });
      const suffix = restRegex.join('/');
      // **/rest：rest 可位于当前位置（零层）或任意更深层
      if (out === '') {
        out += '(?:.*/)?' + suffix;
      } else {
        // 已有前缀（如 a/）：a + 零层(/b) 或多层(/x/y/b)
        out += '/(?:.*/)?' + suffix;
      }
      return out;
    }
    if (seg.includes('**')) {
      throw new AnalyzerError(
        'RULE_PARSE_ERROR',
        '双星号 ** 必须是完整路径段（不允许 a**、**b、a**b）',
        { segment: seg },
      );
    }
    out += out === '' ? segmentToRegex(seg) : '/' + segmentToRegex(seg);
    i++;
  }
  return out;
}

function segmentToRegex(seg: string): string {
  let out = '';
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i]!;
    if (ch === '\\') {
      const next = seg[i + 1];
      if (next === '#' || next === '!' || next === '\\' || next === '*' || next === '?') {
        out += escapeRegex(next);
        i++;
        continue;
      }
      throw new AnalyzerError(
        'RULE_INVALID_ESCAPE',
        '仅支持转义 \\#、\\!、\\\\、\\*、\\?',
        { near: seg.slice(i, i + 2) },
      );
    }
    if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else out += escapeRegex(ch);
  }
  return out;
}

function escapeRegex(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\|]/g, '\\$&');
}

export interface RuleMatch {
  rule: CompiledRule;
}

/** 路径自身的全部命中规则（按行号顺序）。isDir 决定目录专用模式是否适用。 */
export function matchPath(
  rules: CompiledRule[],
  fullPath: string,
  segments: string[],
  isDir: boolean,
  budget: { remaining: number },
): CompiledRule[] {
  const hits: CompiledRule[] = [];
  const basename = segments[segments.length - 1]!;

  for (const rule of rules) {
    if (budget.remaining-- <= 0) {
      throw new AnalyzerError('MATCH_BUDGET_EXCEEDED', '匹配预算耗尽，规则/树规模过大');
    }
    if (rule.dirOnly && !isDir) continue;

    if (rule.anchored) {
      if (rule.regex.test(fullPath)) hits.push(rule);
    } else {
      // 无斜杠名字模式：既可按 basename 匹配任意层，也可匹配任意深度的完整相对路径
      // （与 git 行为一致，例如 *.log 同时匹配 a.log 与 src/a.log）
      if (rule.nameRegex && (rule.nameRegex.test(basename) || rule.regex.test(fullPath))) {
        hits.push(rule);
      }
    }
  }
  return hits;
}

/** 最后一条命中规则决定直接效果：无命中 => 不忽略。 */
export function directEffect(hits: CompiledRule[]): {
  ignored: boolean;
  last: CompiledRule | null;
} {
  if (hits.length === 0) return { ignored: false, last: null };
  const last = hits[hits.length - 1]!;
  return { ignored: !last.negated, last };
}

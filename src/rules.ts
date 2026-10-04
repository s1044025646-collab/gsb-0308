import { ValidationError, ValidationIssue } from "./errors";
import { DEFAULT_LIMITS, LimitConfig } from "./limits";
import { CompiledRule, SegmentPattern } from "./types";

/** 转义正则元字符（除 * ? 外，这两个由通配逻辑处理）。 */
function escapeRegexChar(ch: string): string {
  return "\\^$.|+()[]{}".includes(ch) ? "\\" + ch : ch;
}

/**
 * 把单个路径段内的模式翻译为正则片段。
 * '*' 匹配除斜杠外任意数量字符；'?' 匹配除斜杠外单个字符；
 * '**' 只允许作为完整段出现（段内双星在段解析阶段单独处理）。
 */
function translateSegment(segment: string, issues: ValidationIssue[], line: number): string {
  let out = "";
  let i = 0;
  while (i < segment.length) {
    const ch = segment[i];
    if (ch === "*") {
      if (segment[i + 1] === "*") {
        issues.push({
          code: "UNSUPPORTED_INFIX_DOUBLE_STAR",
          line,
          message: `第 ${line} 行: '**' 只能作为完整路径段（如 a/**/b），段内双星不支持`,
        });
        out += "[^/]*\\*?";
        i += 2;
        continue;
      }
      out += "[^/]*";
      i++;
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      i++;
      continue;
    }
    if (ch === "\\") {
      issues.push({
        code: "UNSUPPORTED_ESCAPE",
        line,
        message: `第 ${line} 行: 除开头的 '\\#' 与 '\\!' 外不支持反斜杠转义`,
      });
      i++;
      continue;
    }
 if (ch === "[") {
      issues.push({
        code: "UNSUPPORTED_CHARACTER_CLASS",
        line,
        message: `第 ${line} 行: 不支持字符类 '[]'`,
      });
      out += "\\[";
      i++;
      continue;
    }
    out += escapeRegexChar(ch);
    i++;
  }
  return out;
}

interface ParsedLine {
  line: number;
  raw: string;
  negated: boolean;
  dirOnly: boolean;
  anchored: boolean;
  body: string;
}

/** 段级匹配器：支持完整段 ** 跨零或多层，带回溯与步数预算。 */
function matchSegments(patterns: SegmentPattern[], segments: string[], budget: { used: number; max: number }): boolean {
  const recursive = (pi: number, si: number): boolean => {
    budget.used++;
    if (budget.used > budget.max) {
      throw new Error("MATCH_BUDGET_EXCEEDED");
    }
    if (pi === patterns.length) return si === segments.length;
    const pat = patterns[pi];
    if (pat.kind === "dblstar") {
      // ** 匹配 0..剩余任意层，尝试最长优先
      for (let take = segments.length - si; take >= 0; take--) {
        if (recursive(pi + 1, si + take)) return true;
      }
      return false;
    }
    if (si >= segments.length) return false;
    if (pat.regex.test(segments[si])) return recursive(pi + 1, si + 1);
    return false;
  };
  return recursive(0, 0);
}

/**
 * 解析规则文本。
 * - 空行、未转义 '#' 开头为注释
 * - 开头 '\\#' 或 '\\!' 为字面转义
 * - 开头 '!' 取反；结尾 '/' 仅目录；中间含 '/' 锚定根
 * - 非法规则收集为诊断，任何一条非法都阻止发布
 */
export function parseRules(text: string, limits: LimitConfig = DEFAULT_LIMITS): ParsedLine[] {
  const { parsed, issues } = parseRulesInternal(text, limits);
  if (issues.length > 0) throw new ValidationError(issues);
  return parsed;
}

function parseRulesInternal(
  text: string,
  limits: LimitConfig = DEFAULT_LIMITS
): { parsed: ParsedLine[]; issues: ValidationIssue[] } {
  if (typeof text !== "string") {
    throw new ValidationError([{ code: "INVALID_RULES", message: "规则文本必须是字符串" }]);
  }
  if (Buffer.byteLength(text, "utf8") > limits.maxRulesPayloadBytes) {
    throw new ValidationError([
      {
        code: "RULES_PAYLOAD_TOO_LARGE",
        message: `规则文本超过 ${limits.maxRulesPayloadBytes} 字节上限`,
      },
    ]);
  }

  const lines = text.split(/\r\n|\r|\n/);
  const issues: ValidationIssue[] = [];
  const parsed: ParsedLine[] = [];

  lines.forEach((rawLine, idx) => {
    const line = idx + 1;
    let content = rawLine;

    if (content.trim() === "") return; // 空行（纯空白行按空行处理）
    // 不支持尾部空格（不做隐式忽略）
    if (/[ \t]$/.test(content)) {
      issues.push({
        code: "UNSUPPORTED_TRAILING_WHITESPACE",
        line,
        message: `第 ${line} 行: 不支持尾部空格/制表符（不会被隐式忽略）`,
      });
      return;
    }
    if (content.startsWith("#")) return; // 注释

    const dirOnly = content.endsWith("/");
    if (dirOnly) content = content.slice(0, -1);
    if (content === "") {
      issues.push({ code: "EMPTY_PATTERN", line, message: `第 ${line} 行: 模式为空` });
      return;
    }

    // 开头转义：\# 与 \! 作为字面字符（需在取反判断之前处理）
    if (content.startsWith("\\#") || content.startsWith("\\!")) {
      content = content.slice(1);
    }

    let negated = false;
    if (content.startsWith("!")) {
      // 仅当 ! 不是由 \! 转义而来时才是取反
      if (rawLine.startsWith("\\!")) {
        // 字面 !
      } else {
        negated = true;
        content = content.slice(1);
        if (content.length === 0 || content.startsWith("#")) {
          issues.push({
            code: "EMPTY_NEGATION_PATTERN",
            line,
            message: `第 ${line} 行: 取反规则 '!' 后缺少模式`,
          });
          return;
        }
      }
    }

    const anchored = content.includes("/");
    if (anchored && content.startsWith("/")) content = content.slice(1);
    if (content.startsWith("/")) {
      issues.push({
        code: "EMPTY_PATH_SEGMENT",
        line,
        message: `第 ${line} 行: 规则包含空路径段`,
      });
      return;
    }
    if (content.includes("//")) {
      issues.push({
        code: "EMPTY_PATH_SEGMENT",
        line,
        message: `第 ${line} 行: 规则包含空路径段（重复斜杠）`,
      });
      return;
    }
    if (content.length > limits.maxPatternLength) {
      issues.push({
        code: "PATTERN_TOO_LONG",
        line,
        message: `第 ${line} 行: 模式长度超过 ${limits.maxPatternLength}`,
      });
      return;
    }

    parsed.push({ line, raw: rawLine, negated, dirOnly, anchored, body: content });
  });

  if (parsed.length > limits.maxRules) {
    issues.push({
      code: "TOO_MANY_RULES",
      message: `有效规则数量 ${parsed.length} 超过上限 ${limits.maxRules}`,
    });
  }
  return { parsed, issues };
}

/** 把解析结果编译为正则。 */
function compileOne(p: ParsedLine, issues: ValidationIssue[]): CompiledRule {
  const segments = p.body.split("/");
  const buildPatterns = (): SegmentPattern[] =>
    segments.map<SegmentPattern>((seg) =>
      seg === "**"
        ? { kind: "dblstar" }
        : { kind: "glob", regex: new RegExp("^(?:" + translateSegment(seg, issues, p.line) + ")$") }
    );

  return {
    line: p.line,
    raw: p.raw,
    negated: p.negated,
    dirOnly: p.dirOnly,
    anchored: p.anchored,
    body: p.body,
    patterns: buildPatterns(),
  };
}

export function compileRules(text: string, limits: LimitConfig = DEFAULT_LIMITS): CompiledRule[] {
  const { parsed, issues: parseIssues } = parseRulesInternal(text, limits);
  const issues: ValidationIssue[] = [];
  const compiled = parsed.map((p) => compileOne(p, issues));
  const all = [...parseIssues, ...issues];
  if (all.length > 0) throw new ValidationError(all);
  return compiled;
}

export { matchSegments };

import { ValidationError, ValidationIssue, AppError } from "./errors";
import { DEFAULT_LIMITS, LimitConfig } from "./limits";
import { normalizeRelativePath, parentOf } from "./pathutil";
import { TreeNode, TreeNodeInput } from "./types";

/**
 * 校验用户提供的扁平节点数组。
 * 规则：显式 file/dir 身份；路径唯一；父节点必须存在且为目录；深度/长度受限。
 */
export function validateTree(input: unknown, limits: LimitConfig = DEFAULT_LIMITS): TreeNode[] {
  if (!Array.isArray(input)) {
    throw new AppError("INVALID_TREE", "tree 必须是节点数组", 422);
  }
  if (input.length > limits.maxTreeNodes) {
    throw new AppError(
      "TREE_TOO_LARGE",
      `节点数量 ${input.length} 超过上限 ${limits.maxTreeNodes}`,
      422
    );
  }

  const issues: ValidationIssue[] = [];
  const byPath = new Map<string, TreeNode>();

  for (let i = 0; i < input.length; i++) {
    const rawNode = input[i] as Partial<TreeNodeInput>;
    const ctx = `节点[${i}]`;
    if (rawNode === null || typeof rawNode !== "object") {
      issues.push({ code: "INVALID_NODE", message: `${ctx} 必须是对象` });
      continue;
    }
    if (rawNode.type !== "file" && rawNode.type !== "dir") {
      issues.push({
        code: "INVALID_NODE_TYPE",
        path: String(rawNode.path ?? ""),
        message: `${ctx} 的 type 必须显式为 "file" 或 "dir"`,
      });
      continue;
    }
    let normalized: { path: string; segments: string[] };
    try {
      normalized = normalizeRelativePath(rawNode.path as string);
    } catch (err) {
      if (err instanceof AppError) {
        issues.push({ code: err.code, path: String(rawNode.path ?? ""), message: `${ctx}: ${err.message}` });
        continue;
      }
      throw err;
    }
    if (normalized.path.length > limits.maxPathLength) {
      issues.push({
        code: "PATH_TOO_LONG",
        path: normalized.path,
        message: `${ctx} 路径长度 ${normalized.path.length} 超过上限 ${limits.maxPathLength}`,
      });
      continue;
    }
    if (normalized.segments.length > limits.maxDepth) {
      issues.push({
        code: "DEPTH_EXCEEDED",
        path: normalized.path,
        message: `${ctx} 深度 ${normalized.segments.length} 超过上限 ${limits.maxDepth}`,
      });
      continue;
    }
    if (byPath.has(normalized.path)) {
      issues.push({
        code: "DUPLICATE_ENTRY",
        path: normalized.path,
        message: `${ctx} 路径重复`,
      });
      continue;
    }
    const node: TreeNode = {
      path: normalized.path,
      segments: normalized.segments,
      name: normalized.segments[normalized.segments.length - 1],
      parent: parentOf(normalized.segments),
      type: rawNode.type,
    };
    byPath.set(normalized.path, node);
  }

  // 父链校验：父必须存在且为目录；文件不能充当目录父节点。
  for (const node of byPath.values()) {
    let ancestor = node.parent;
    let depth = 1;
    while (ancestor !== null) {
      const parent = byPath.get(ancestor);
      if (!parent) {
        issues.push({
          code: "MISSING_PARENT",
          path: node.path,
          message: `路径 "${node.path}" 的父目录 "${ancestor}" 不存在（树必须显式列出所有目录）`,
        });
        break;
      }
      if (parent.type !== "dir") {
        issues.push({
          code: "FILE_AS_DIRECTORY_PARENT",
          path: node.path,
          message: `路径 "${node.path}" 的父节点 "${ancestor}" 是文件，不能充当目录`,
        });
        break;
      }
      ancestor = parent.parent;
      depth++;
    }
  }

  if (issues.length > 0) throw new ValidationError(issues);
  return [...byPath.values()];
}

/** 按路径分段排序，保证父节点总在子节点之前（遍历顺序对输入重排不变）。 */
export function sortNodes(nodes: TreeNode[]): TreeNode[] {
  return [...nodes].sort((a, b) => {
    const len = Math.max(a.segments.length, b.segments.length);
    for (let i = 0; i < len; i++) {
      const sa = a.segments[i];
      const sb = b.segments[i];
      if (sa === undefined) return -1;
      if (sb === undefined) return 1;
      if (sa !== sb) return sa < sb ? -1 : 1;
    }
    // 同名时目录排在文件前，结果稳定
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return 0;
  });
}

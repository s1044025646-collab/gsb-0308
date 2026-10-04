import { AnalyzerError } from './errors.js';
import { DEFAULT_LIMITS, type Limits } from './limits.js';
import type { NodeType, TreeNode, TreeNodeInput } from './types.js';

export function validatePath(rawPath: string, limits: Limits = DEFAULT_LIMITS): string[] {
  if (typeof rawPath !== 'string') {
    throw new AnalyzerError('VALIDATION_INVALID_PATH', '路径必须是字符串', { path: String(rawPath) });
  }
  if (rawPath.length === 0) {
    throw new AnalyzerError('VALIDATION_INVALID_PATH', '路径不能为空');
  }
  if (rawPath.length > limits.maxPathLength) {
    throw new AnalyzerError('VALIDATION_PATH_TOO_LONG', `路径长度超过 ${limits.maxPathLength}`, {
      path: rawPath,
      length: rawPath.length,
    });
  }
  if (rawPath.includes('\\')) {
    throw new AnalyzerError('VALIDATION_BACKSLASH_PATH', '路径必须使用正斜杠 /', { path: rawPath });
  }
  if (/^[A-Za-z]:/.test(rawPath) || rawPath.startsWith('/')) {
    throw new AnalyzerError('VALIDATION_ABSOLUTE_PATH', '不允许绝对路径或盘符', { path: rawPath });
  }
  const segments = rawPath.split('/');
  for (const seg of segments) {
    if (seg === '') {
      throw new AnalyzerError('VALIDATION_EMPTY_SEGMENT', '路径不允许空段（连续斜杠或首尾斜杠）', {
        path: rawPath,
      });
    }
    if (seg === '.' || seg === '..') {
      throw new AnalyzerError('VALIDATION_DOT_SEGMENT', '路径不允许 . 或 .. 段', { path: rawPath });
    }
  }
  if (segments.length > limits.maxTreeDepth) {
    throw new AnalyzerError('VALIDATION_TREE_TOO_DEEP', `目录深度超过 ${limits.maxTreeDepth}`, {
      path: rawPath,
      depth: segments.length,
    });
  }
  return segments;
}

/**
 * 校验并规范化虚拟文件树。
 * 拒绝：重复条目、文件充当目录父节点、目录/文件类型冲突。
 */
export function validateTree(
  nodes: TreeNodeInput[],
  limits: Limits = DEFAULT_LIMITS,
): TreeNode[] {
  if (!Array.isArray(nodes)) {
    throw new AnalyzerError('VALIDATION_INVALID_PATH', 'tree.nodes 必须是数组');
  }
  if (nodes.length > limits.maxNodes) {
    throw new AnalyzerError('VALIDATION_TOO_MANY_NODES', `节点数量超过 ${limits.maxNodes}`, {
      count: nodes.length,
    });
  }

  const result: TreeNode[] = [];
  const typeByPath = new Map<string, NodeType>();

  for (const node of nodes) {
    if (node === null || typeof node !== 'object') {
      throw new AnalyzerError('VALIDATION_INVALID_PATH', '节点必须是对象');
    }
    const segments = validatePath(node.path, limits);
    if (node.type !== 'file' && node.type !== 'dir') {
      throw new AnalyzerError('VALIDATION_INVALID_PATH', "节点 type 必须是 'file' 或 'dir'", {
        path: node.path,
      });
    }
    const normalized = segments.join('/');
    if (typeByPath.has(normalized)) {
      throw new AnalyzerError('VALIDATION_DUPLICATE_ENTRY', '存在重复路径条目', { path: normalized });
    }

    for (let i = 1; i <= segments.length - 1; i++) {
      const ancestor = segments.slice(0, i).join('/');
      const ancestorType = typeByPath.get(ancestor);
      if (ancestorType === 'file') {
        throw new AnalyzerError('VALIDATION_PARENT_IS_FILE', '文件不能充当目录父节点', {
          path: normalized,
          ancestor,
        });
      }
    }

    typeByPath.set(normalized, node.type);
    result.push({ path: normalized, type: node.type, segments });
  }

  return result;
}

/** 父目录路径（无父级返回 null）。 */
export function parentPath(path: string): string | null {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? null : path.slice(0, idx);
}

/** 祖先目录路径列表，自根向近，例如 a/b/c.ts -> ["a","a/b"]。 */
export function ancestorDirs(segments: string[]): string[] {
  const out: string[] = [];
  for (let i = 1; i <= segments.length - 1; i++) {
    out.push(segments.slice(0, i).join('/'));
  }
  return out;
}

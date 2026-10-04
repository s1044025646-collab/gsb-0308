import { AppError } from "./errors";

/** 把相对路径规范化为正斜杠形式，并拒绝非法输入。返回分段。 */
export function normalizeRelativePath(input: string): { path: string; segments: string[] } {
  if (typeof input !== "string") {
    throw new AppError("INVALID_PATH", "路径必须是字符串");
  }
  if (input.length === 0) {
    throw new AppError("INVALID_PATH", "路径不能为空", 400, { path: input });
  }
  if (input.includes("\\")) {
    throw new AppError("BACKSLASH_UNSUPPORTED", "路径必须使用正斜杠 '/'，不支持反斜杠", 422, {
      path: input,
    });
  }
  if (/^[a-zA-Z]:/.test(input) || input.startsWith("/")) {
    throw new AppError("ABSOLUTE_PATH_REJECTED", "拒绝绝对路径或盘符路径", 422, {
      path: input,
    });
  }
  const trimmed = input.endsWith("/") && input !== "/" ? input.slice(0, -1) : input;
  const segments = trimmed.split("/");
  for (const seg of segments) {
    if (seg === "" ) {
      throw new AppError("EMPTY_PATH_SEGMENT", "路径包含空段（重复斜杠或末尾斜杠）", 422, {
        path: input,
      });
    }
    if (seg === "." || seg === "..") {
      throw new AppError("DOT_SEGMENT_REJECTED", "路径不允许 '.' 或 '..' 段", 422, {
        path: input,
      });
    }
  }
  return { path: trimmed, segments };
}

export function parentOf(segments: string[]): string | null {
  if (segments.length <= 1) return null;
  return segments.slice(0, -1).join("/");
}

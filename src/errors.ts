/** 统一的业务错误，携带稳定错误码与 HTTP 状态码。 */
export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: string, message: string, status = 400, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export interface ValidationIssue {
  code: string;
  line?: number;
  path?: string;
  message: string;
}

/** 聚合多个校验诊断（例如规则文本中的所有非法行）。 */
export class ValidationError extends AppError {
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    super("VALIDATION_FAILED", "输入校验未通过，共 " + issues.length + " 个问题", 422, issues);
    this.issues = issues;
  }
}

export type ErrorCode =
  | 'VALIDATION_INVALID_PATH'
  | 'VALIDATION_ABSOLUTE_PATH'
  | 'VALIDATION_EMPTY_SEGMENT'
  | 'VALIDATION_DOT_SEGMENT'
  | 'VALIDATION_PATH_TOO_LONG'
  | 'VALIDATION_DUPLICATE_ENTRY'
  | 'VALIDATION_PARENT_IS_FILE'
  | 'VALIDATION_BACKSLASH_PATH'
  | 'VALIDATION_TREE_TOO_DEEP'
  | 'VALIDATION_TOO_MANY_NODES'
  | 'RULE_CHARACTER_CLASS_UNSUPPORTED'
  | 'RULE_TRAILING_SPACE_UNSUPPORTED'
  | 'RULE_INVALID_ESCAPE'
  | 'RULE_EMPTY_BODY'
  | 'RULE_TOO_MANY'
  | 'RULE_TOO_LONG'
  | 'RULE_PARSE_ERROR'
  | 'MATCH_BUDGET_EXCEEDED'
  | 'PATH_NOT_FOUND'
  | 'VERSION_NOT_FOUND'
  | 'TREE_NOT_FOUND'
  | 'REPORT_NOT_FOUND'
  | 'INVALID_JSON'
  | 'INVALID_REQUEST';

export class AnalyzerError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;
  readonly httpStatus: number;

  constructor(
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>,
    httpStatus = 400,
  ) {
    super(message);
    this.name = 'AnalyzerError';
    this.code = code;
    this.details = details;
    this.httpStatus = httpStatus;
  }
}

export interface Diagnostic {
  line: number;
  code: ErrorCode;
  message: string;
  raw: string;
}

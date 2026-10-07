/**
 * Erros de aplicação com contrato estável para o front:
 *   { error: { code, message, hint?, detail? } }
 */
export class AppError extends Error {
  constructor(code, message, { status = 400, hint = null, detail = null } = {}) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.hint = hint;
    this.detail = detail;
  }
}

export const SETUP_GUIDE = "docs/PROXIMOS-PASSOS.html";
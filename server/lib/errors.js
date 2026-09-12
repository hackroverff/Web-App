/** AppError: the only error type routes are expected to throw for control flow. */
export class AppError extends Error {
  constructor(status, message, opts = {}) {
    super(message);
    this.status = status;
    this.code = opts.code || undefined;
    this.fields = opts.fields || undefined;
    this.expose = true;
  }
}

export const badRequest = (msg, opts) => new AppError(400, msg, opts);
export const unauthorized = (msg = 'Please sign in to continue.') => new AppError(401, msg);
export const forbidden = (msg = 'You do not have access to this action.') => new AppError(403, msg);
export const notFound = (msg = 'Not found.') => new AppError(404, msg);
export const conflict = (msg, opts) => new AppError(409, msg, opts);
export const tooMany = (msg = 'Too many attempts. Please wait a moment.') => new AppError(429, msg);
export const unprocessable = (msg, opts) => new AppError(422, msg, opts);

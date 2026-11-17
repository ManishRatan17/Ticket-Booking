// An error we throw ON PURPOSE, carrying the HTTP status and a stable machine-readable code.
// Anything that is NOT an AppError is treated as an unexpected bug (500) by the error handler.
//
//   throw new AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists');
//
// `code` is for programs (the frontend can switch on it); `message` is for humans.
export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details; // optional extra info, e.g. which fields failed validation
  }
}

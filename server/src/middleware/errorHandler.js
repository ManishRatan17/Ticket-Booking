import { AppError } from '../lib/errors.js';

// Every error response in the API has the same shape:
//   { "error": { "code": "VALIDATION_ERROR", "message": "...", "details": [...] } }

export function notFound(req, res, next) {
  next(new AppError(404, 'NOT_FOUND', `Not found: ${req.method} ${req.originalUrl}`));
}

// Express recognises an error handler by its FOUR parameters, so `next` must stay
// even though it is unused.
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  // 1. Errors we threw on purpose: safe to show to the client.
  if (err instanceof AppError) {
    // The HTTP standard says a 401 must tell the client HOW to authenticate.
    // There's no registered scheme for cookie sessions, so this names it informally.
    if (err.status === 401) res.set('WWW-Authenticate', 'Cookie realm="flash-sale-api"');
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
  }

  // 2. Errors from express.json() when the request body is bad.
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' } });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' } });
  }

  // 3. Anything else is a bug. Log the full details on the server,
  //    but never send stack traces or internal messages to the client.
  console.error(err);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
}

import { AppError } from '../lib/errors.js';

// Validates the request against zod schemas BEFORE the route handler runs.
//
//   router.post('/register', validate({ body: registerSchema }), controller.register);
//
// On success, the cleaned values are on req.validated.body / .params / .query.
// Handlers should read from req.validated (never req.body) so they only ever see
// data that passed validation, with unknown fields removed and values normalised.
export function validate(schemas) {
  return (req, res, next) => {
    req.validated = {};
    const problems = [];

    for (const part of ['body', 'params', 'query']) {
      const schema = schemas[part];
      if (!schema) continue;

      const result = schema.safeParse(req[part] ?? {});
      if (result.success) {
        req.validated[part] = result.data;
      } else {
        for (const issue of result.error.issues) {
          problems.push({ field: [part, ...issue.path].join('.'), message: issue.message });
        }
      }
    }

    if (problems.length > 0) {
      return next(new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', problems));
    }
    next();
  };
}

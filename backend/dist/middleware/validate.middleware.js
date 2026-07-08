"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validate = void 0;
const zod_1 = require("zod");
const validate = (schema) => {
    return async (req, res, next) => {
        try {
            await schema.parseAsync({
                body: req.body,
                query: req.query,
                params: req.params,
            });
            next();
        }
        catch (error) {
            if (error instanceof zod_1.ZodError) {
                return res.status(400).json({
                    error: 'Validation failed. Please ensure all required fields are provided and correctly formatted.',
                    details: error.errors.map(err => ({
                        field: err.path.join('.'),
                        message: err.message,
                    })),
                });
            }
            return res.status(500).json({ error: 'An internal error occurred during request validation.' });
        }
    };
};
exports.validate = validate;
//# sourceMappingURL=validate.middleware.js.map
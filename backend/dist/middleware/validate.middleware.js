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
                    message: 'Validation failed',
                    errors: error.errors.map(err => ({
                        path: err.path.join('.'),
                        message: err.message,
                    })),
                });
            }
            return res.status(500).json({ message: 'Internal server error' });
        }
    };
};
exports.validate = validate;
//# sourceMappingURL=validate.middleware.js.map
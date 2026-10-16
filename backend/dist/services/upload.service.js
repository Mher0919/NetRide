"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UploadService = void 0;
const storage_service_1 = require("./storage.service");
const file_policy_1 = require("../security/file-policy");
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB
class UploadService {
    static async upload(req, res) {
        let buffer = null;
        try {
            // Authentication is enforced by authMiddleware on the route. Defence in
            // depth: never fall back to an `anonymous` owner.
            const userId = req.user?.id;
            if (!userId) {
                return res.status(401).json({ error: 'Unauthorized: sign in to upload files.' });
            }
            const { image, mimetype, filename, file_type } = req.body;
            if (!image || !mimetype) {
                return res.status(400).json({ error: 'No image data or mimetype provided' });
            }
            const normalizedMime = (0, file_policy_1.validateUploadMime)(mimetype);
            if (!normalizedMime) {
                return res.status(415).json({
                    error: 'Unsupported file type. Only JPEG, PNG, WebP and HEIC images are accepted.',
                });
            }
            buffer = Buffer.from(image, 'base64');
            if (buffer.length === 0) {
                return res.status(400).json({ error: 'Empty upload.' });
            }
            if (buffer.length > MAX_UPLOAD_BYTES) {
                return res.status(413).json({ error: `File too large. Max ${MAX_UPLOAD_BYTES / 1024 / 1024}MB.` });
            }
            // Client-declared category, sanitised. Unknown categories degrade to
            // `general`, which is PRIVATE — secure by default. Only `profile`
            // (and legacy `avatar`) uploads become publicly readable.
            const fileType = (0, file_policy_1.sanitizeUploadFileType)(file_type);
            const visibility = (0, file_policy_1.classifyFileVisibility)(fileType);
            const result = await storage_service_1.StorageService.upload(buffer, {
                userId,
                fileType,
                originalName: filename || 'upload',
                mimetype: normalizedMime,
                visibility,
            });
            // Never log the base64 payload; file id + size are enough for support.
            console.log(`📸 [UPLOAD] user=${userId} file=${result.id} (${buffer.length} bytes, ${visibility})`);
            res.json({ url: result.url, file_id: result.id, visibility });
        }
        catch (error) {
            console.error('❌ Upload error:', error.message);
            res.status(500).json({ error: 'Upload failed. Please try again.' });
        }
        finally {
            buffer = null;
        }
    }
}
exports.UploadService = UploadService;
//# sourceMappingURL=upload.service.js.map
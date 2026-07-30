"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UploadService = void 0;
const storage_service_1 = require("./storage.service");
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB
class UploadService {
    static async upload(req, res) {
        let buffer = null;
        try {
            const { image, mimetype, filename } = req.body;
            if (!image || !mimetype) {
                return res.status(400).json({ error: 'No image data or mimetype provided' });
            }
            buffer = Buffer.from(image, 'base64');
            if (buffer.length > MAX_UPLOAD_BYTES) {
                return res.status(413).json({ error: `File too large. Max ${MAX_UPLOAD_BYTES / 1024 / 1024}MB.` });
            }
            const userId = req.user?.id || 'anonymous';
            const result = await storage_service_1.StorageService.upload(buffer, {
                userId,
                fileType: 'general',
                originalName: filename || 'upload',
                mimetype,
            });
            console.log(`📸 [UPLOAD] Uploaded via StorageService: ${result.id} (${buffer.length} bytes) -> ${result.url}`);
            res.json({ url: result.url });
        }
        catch (error) {
            console.error('❌ Upload error:', error);
            res.status(500).json({ error: error.message });
        }
        finally {
            buffer = null;
            if (global.gc)
                global.gc();
        }
    }
}
exports.UploadService = UploadService;
//# sourceMappingURL=upload.service.js.map
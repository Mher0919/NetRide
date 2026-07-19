"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UploadService = void 0;
const storage_service_1 = require("./storage.service");
class UploadService {
    static async upload(req, res) {
        try {
            const { image, mimetype, filename } = req.body;
            if (!image || !mimetype) {
                return res.status(400).json({ error: 'No image data or mimetype provided' });
            }
            const buffer = Buffer.from(image, 'base64');
            // Infer user ID from request auth (optional, for path organisation)
            const userId = req.user?.id || 'anonymous';
            const result = await storage_service_1.StorageService.upload(buffer, {
                userId,
                fileType: 'general',
                originalName: filename || 'upload',
                mimetype,
            });
            // Return the relative /api/files/{id} path.
            // The Flutter app resolves it to a full URL via resolveFileUrl(),
            // which works on any platform (emulator, device, web).
            console.log(`📸 [UPLOAD] Uploaded via StorageService: ${result.id} (${buffer.length} bytes) -> ${result.url}`);
            res.json({ url: result.url });
        }
        catch (error) {
            console.error('❌ Upload error:', error);
            res.status(500).json({ error: error.message });
        }
    }
}
exports.UploadService = UploadService;
//# sourceMappingURL=upload.service.js.map
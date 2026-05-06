"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.UploadService = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const uuid_1 = require("uuid");
const env_1 = require("../config/env");
class UploadService {
    /**
     * Processes a base64 string, saves it to the filesystem, and returns a URL.
     */
    static async upload(req, res) {
        try {
            const { image, mimetype, filename } = req.body;
            if (!image || !mimetype) {
                return res.status(400).json({ error: 'No image data or mimetype provided' });
            }
            // 1. Generate unique filename
            const extension = mimetype.split('/')[1] || 'jpg';
            const safeFilename = `${(0, uuid_1.v4)()}.${extension}`;
            const uploadDir = path_1.default.join(__dirname, '../../uploads');
            const filePath = path_1.default.join(uploadDir, safeFilename);
            // 2. Ensure directory exists
            if (!fs_1.default.existsSync(uploadDir)) {
                fs_1.default.mkdirSync(uploadDir, { recursive: true });
            }
            // 3. Save buffer to file
            const buffer = Buffer.from(image, 'base64');
            fs_1.default.writeFileSync(filePath, buffer);
            // 4. Construct URL
            // We use APP_URL from env, e.g., http://localhost:3000
            const fileUrl = `${env_1.env.APP_URL}/uploads/${safeFilename}`;
            console.log(`📸 [UPLOAD] File saved: ${safeFilename} (${buffer.length} bytes) -> ${fileUrl}`);
            res.json({ url: fileUrl });
        }
        catch (error) {
            console.error('❌ Upload error:', error);
            res.status(500).json({ error: error.message });
        }
    }
}
exports.UploadService = UploadService;
//# sourceMappingURL=upload.service.js.map
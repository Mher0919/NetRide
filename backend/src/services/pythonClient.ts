// backend/src/services/pythonClient.ts
//
// Thin wrapper around the Python face verification microservice. The Node
// backend is the only thing that talks to it — the Flutter app always
// hits our own /api/face/* endpoints and we proxy to the Python service.

import FormData from 'form-data';
import { env } from '../config/env';

export interface FaceVerifyLiveness {
  face_frames: number;
  total_frames: number;
  motion_px: number;
  blink_count: number;
  laplacian_var: number;
  passed: boolean;
}

export interface FaceVerifyResult {
  match: boolean;
  score: number;
  distance?: number;
  reason: string;
  liveness: FaceVerifyLiveness;
}

export class PythonFaceClient {
  /**
   * Send a captured video clip + a reference image to the Python service
   * for verification. Throws on transport errors; returns a result object
   * (with match=false) when the service responds but verification fails.
   */
  static async verify(args: {
    videoBuffer: Buffer;
    videoMime: string;
    videoFilename: string;
    referenceBuffer: Buffer;
    referenceMime: string;
    referenceFilename: string;
  }): Promise<FaceVerifyResult> {
    const form = new FormData();
    form.append('video', args.videoBuffer, {
      filename: args.videoFilename,
      contentType: args.videoMime,
    });
    form.append('reference', args.referenceBuffer, {
      filename: args.referenceFilename,
      contentType: args.referenceMime,
    });

    const url = `${env.FACE_SERVICE_URL}/verify`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000); // 20s ceiling

    try {
      const response = await fetch(url, {
        method: 'POST',
        body: form as any,
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Face service returned ${response.status}: ${text}`);
      }
      return (await response.json()) as FaceVerifyResult;
    } catch (err: any) {
      if (err.name === 'AbortError') {
        throw new Error('Face verification timed out. Please try again.');
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}
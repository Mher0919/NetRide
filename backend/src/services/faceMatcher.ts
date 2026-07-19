// backend/src/services/faceMatcher.ts
//
// Pure-TypeScript face verification, replacing the standalone Python
// microservice. Runs entirely in-process in the Node backend using
// face-api.js (TensorFlow.js). Performs:
//   1. Face detection (tinyFaceDetector)
//   2. 128-d face descriptor extraction (faceRecognitionNet)
//   3. Image quality checks (blur / brightness / face size / multi-face)
//   4. Lightweight anti-spoofing heuristic (texture + brightness uniformity)
//   5. Cosine/euclidean distance comparison against a stored descriptor
//
// The descriptor (number[]) is the source of truth for matching. The
// enrolled reference image URL is retained only for admin review.

import * as faceapi from 'face-api.js';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { createCanvas, loadImage, Image, Canvas } from 'canvas';

const MODEL_DIR = path.join(__dirname, 'faceModels');
const MODEL_BASE =
  'https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights';

// ---- Types (mirror the previous Python service contract) -------------

export interface FaceQualityMetrics {
  passed: boolean;
  laplacian_var: number;
  brightness: number;
  face_area_ratio: number;
  face_count: number;
  reasons: string[];
}

export interface AntiSpoofingResult {
  passed: boolean;
  confidence: number;
  laplacian_var: number;
  lbp_variance: number;
  brightness: number;
  reasons: string[];
}

export interface ImageVerifyResult {
  match: boolean;
  score: number;
  distance?: number;
  reason: string;
  liveness: AntiSpoofingResult;
  quality: FaceQualityMetrics;
}

let modelsLoaded = false;
let loadPromise: Promise<void> | null = null;

function ensureModelFile(relName: string): Promise<void> {
  const dest = path.join(MODEL_DIR, relName);
  if (fs.existsSync(dest)) return Promise.resolve();
  fs.mkdirSync(MODEL_DIR, { recursive: true });
  return new Promise<void>((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https
      .get(`${MODEL_BASE}/${relName}`, (resp) => {
        if (resp.statusCode !== 200) {
          fs.unlink(dest, () => {});
          reject(new Error(`Failed to fetch model ${relName}: ${resp.statusCode}`));
          return;
        }
        resp.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
      })
      .on('error', (err) => {
        fs.unlink(dest, () => {});
        reject(err);
      });
  });
}

export async function loadFaceModels(): Promise<void> {
  if (modelsLoaded) return;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const files = [
      'tiny_face_detector_model-weights_manifest.json',
      'tiny_face_detector_model-shard1',
      'face_recognition_model-weights_manifest.json',
      'face_recognition_model-shard1',
      'face_recognition_model-shard2',
    ];
    for (const f of files) {
      await ensureModelFile(f);
    }
    faceapi.env.monkeyPatch({ Canvas, Image } as any);
    await faceapi.nets.tinyFaceDetector.loadFromDisk(MODEL_DIR);
    await faceapi.nets.faceRecognitionNet.loadFromDisk(MODEL_DIR);
    modelsLoaded = true;
  })();
  return loadPromise;
}

// ---- Image helpers ----------------------------------------------------

const MAX_DIM = 416;

// Minimal EXIF orientation reader (only the Orientation tag, 1-8).
function readExifOrientation(buffer: Buffer): number {
  // APP1 segment begins with "Exif\0\0".
  let i = 2;
  while (i + 4 < buffer.length) {
    if (buffer[i] === 0xff && buffer[i + 1] === 0xe1) {
      const segLen = buffer.readUInt16BE(i + 2);
      const seg = buffer.slice(i + 4, i + 4 + segLen - 2);
      if (seg.slice(0, 6).toString('ascii') === 'Exif\0\0') {
        let p = 6;
        const byteOrder = seg.slice(p, p + 2).toString('ascii');
        const little = byteOrder === 'II';
        p += 2;
        p += 2; // skip 0x002A
        const ifdOffset = little ? seg.readUInt32LE(p) : seg.readUInt32BE(p);
        p = 6 + ifdOffset;
        const entries = little ? seg.readUInt16LE(p) : seg.readUInt16BE(p);
        p += 2;
        for (let e = 0; e < entries; e++) {
          const tag = little ? seg.readUInt16LE(p) : seg.readUInt16BE(p);
          if (tag === 0x0112) {
            return little ? seg.readUInt16LE(p + 8) : seg.readUInt16BE(p + 8);
          }
          p += 12;
        }
      }
      i += 2 + segLen;
    } else if (buffer[i] === 0xff) {
      const marker = buffer[i + 1];
      if (marker === 0xd9 || marker === 0xda) break;
      const len = buffer.readUInt16BE(i + 2);
      i += 2 + len;
    } else {
      break;
    }
  }
  return 1;
}

function decodeCanvas(buffer: Buffer): Promise<any> {
  return loadImage(buffer as any).then((img: any) => {
    let { width, height } = img;
    const scale = Math.min(1, MAX_DIM / Math.max(width, height));
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));

    const orientation = readExifOrientation(buffer);
    // Orientation 5-8 swap width/height when rotated 90/270.
    const swap = orientation >= 5 && orientation <= 8;
    const cw = swap ? height : width;
    const ch = swap ? width : height;
    const canvas = createCanvas(cw, ch);
    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.translate(cw / 2, ch / 2);
    switch (orientation) {
      case 2: ctx.scale(-1, 1); break;
      case 3: ctx.rotate(Math.PI); break;
      case 4: ctx.scale(1, -1); break;
      case 5: ctx.rotate(Math.PI / 2); ctx.scale(-1, 1); break;
      case 6: ctx.rotate(Math.PI / 2); break;
      case 7: ctx.rotate(-Math.PI / 2); ctx.scale(-1, 1); break;
      case 8: ctx.rotate(-Math.PI / 2); break;
      default: break;
    }
    ctx.drawImage(img, -width / 2, -height / 2, width, height);
    ctx.restore();
    return canvas;
  });
}

function toGrayscaleFloat(canvas: any): { data: Float64Array; w: number; h: number } {
  const ctx = canvas.getContext('2d');
  const { width: w, height: h } = canvas;
  const img = ctx.getImageData(0, 0, w, h).data;
  const gray = new Float64Array(w * h);
  for (let i = 0, p = 0; i < img.length; i += 4, p++) {
    gray[p] = 0.299 * img[i] + 0.587 * img[i + 1] + 0.114 * img[i + 2];
  }
  return { data: gray, w, h };
}

function laplacianVariance(gray: Float64Array, w: number, h: number): number {
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap =
        gray[i - 1] + gray[i + 1] + gray[i - w] + gray[i + w] - 4 * gray[i];
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  if (n === 0) return 0;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

// ---- Public API -------------------------------------------------------

export interface VerifyImageArgs {
  selfieBuffer: Buffer;
  referenceDescriptor?: number[] | null;
}

export async function verifyImage(args: VerifyImageArgs): Promise<ImageVerifyResult> {
  await loadFaceModels();

  const selfieCanvas = await decodeCanvas(args.selfieBuffer);
  const { data: gray, w, h } = toGrayscaleFloat(selfieCanvas);
  const imageArea = w * h;
  const brightness = gray.reduce((a, b) => a + b, 0) / (imageArea || 1);

  // NOTE: face-api.js' withFaceLandmarks() chain crashes on the pure-JS
  // TensorFlow backend (op not implemented), which silently yielded zero
  // detections for every image — including real faces. We therefore detect
  // without landmarks and compute the descriptor directly from the detection
  // box via faceRecognitionNet (no landmark alignment needed).
  const detectWithTimeout: Promise<any[]> = Promise.race([
    faceapi
      .detectAllFaces(
        selfieCanvas,
        new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.5 })
      ) as any,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('face detection timeout')), 8000)
    ),
  ]);
  const detections: any[] = await detectWithTimeout;

  const descriptors: Float32Array[] = [];
  for (const det of detections) {
    try {
      descriptors.push(
        (await (faceapi.nets.faceRecognitionNet as any).computeFaceDescriptor(selfieCanvas, det)) as Float32Array
      );
    } catch {
      /* skip face if descriptor fails */
    }
  }

  const faceCount = detections.length;
  const qualityReasons: string[] = [];

  const laplacianVar = laplacianVariance(gray, w, h);

  if (laplacianVar < 80) qualityReasons.push('Image too blurry');
  if (brightness < 40) qualityReasons.push('Image too dark');
  else if (brightness > 230) qualityReasons.push('Image too bright');
  if (faceCount === 0) qualityReasons.push('No face detected');
  else if (faceCount > 1) qualityReasons.push(`Multiple faces detected (${faceCount})`);

  let faceAreaRatio = 0;
  if (detections.length > 0) {
    const box = detections[0].box;
    faceAreaRatio = (box.width * box.height) / (imageArea || 1);
    if (faceAreaRatio < 0.04) qualityReasons.push('Face too small in frame');
    else if (faceAreaRatio > 0.6) qualityReasons.push('Face too large in frame');
  }

  const quality: FaceQualityMetrics = {
    passed: qualityReasons.length === 0,
    laplacian_var: Math.round(laplacianVar * 100) / 100,
    brightness: Math.round(brightness * 10) / 10,
    face_area_ratio: Math.round(faceAreaRatio * 10000) / 10000,
    face_count: faceCount,
    reasons: qualityReasons,
  };

  // Anti-spoofing / liveness heuristic. Reuses the already-computed
  // Laplacian variance (texture detail) plus brightness uniformity — cheap,
  // no extra per-pixel passes. (The old LBP loop was the main CPU cost.)
  const spoofReasons: string[] = [];
  const laplacianScore = Math.min(1, laplacianVar / 240);
  if (laplacianVar < 80) {
    spoofReasons.push(`Low texture detail (${laplacianVar.toFixed(1)})`);
  }
  const brightnessStd = stdDev(gray, brightness);
  const brightnessScore = Math.min(1, brightnessStd / 40);
  if (brightnessStd < 15) {
    spoofReasons.push(`Unnatural brightness uniformity (${brightnessStd.toFixed(1)})`);
  }
  let combined = 0.5 * laplacianScore + 0.5 * brightnessScore;
  if (brightness > 220) {
    combined *= 0.7;
    spoofReasons.push('Extremely bright — possible screen');
  }
  const livenessPassed = combined >= 0.5;
  const liveness: AntiSpoofingResult = {
    passed: livenessPassed,
    confidence: Math.round(combined * 1000) / 1000,
    laplacian_var: Math.round(laplacianVar * 100) / 100,
    lbp_variance: 0,
    brightness: Math.round(brightness * 10) / 10,
    reasons: spoofReasons,
  };

  // Enrollment: no reference descriptor yet → self-match is irrelevant.
  // Return the freshly computed descriptor so the caller can persist it.
  if (!args.referenceDescriptor || args.referenceDescriptor.length === 0) {
    return {
      match: true,
      score: 1,
      distance: 0,
      reason: 'enrolled',
      liveness,
      quality,
      _descriptor: faceCount > 0 ? Array.from(descriptors[0]) : [],
    } as ImageVerifyResult & { _descriptor: number[] };
  }

  if (faceCount === 0) {
    return {
      match: false,
      score: 0,
      reason: 'no_face_in_selfie',
      liveness,
      quality,
    };
  }

  const live = Array.from(descriptors[0]);
  const distance = euclidean(live, args.referenceDescriptor);
  // Loose threshold — we only need the selfie to be "kind of similar" to the
  // enrolled profile, not a forensic match. face-api.js euclidean distances
  // below ~0.6 are the same person for pragmatic purposes.
  const matched = distance < 0.6;
  const score = Math.max(0, 1 - distance);

  return {
    match: matched,
    score: Math.round(score * 1000) / 1000,
    distance: Math.round(distance * 10000) / 10000,
    reason: matched ? 'match' : 'face_mismatch',
    liveness,
    quality,
  };
}

function euclidean(a: number[], b: number[]): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s);
}

function stdDev(gray: Float64Array, mean: number): number {
  let s = 0;
  for (let i = 0; i < gray.length; i++) s += (gray[i] - mean) * (gray[i] - mean);
  return Math.sqrt(s / (gray.length || 1));
}

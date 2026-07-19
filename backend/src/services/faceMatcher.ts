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

const MAX_DIM = 224;

function decodeCanvas(buffer: Buffer): Promise<any> {
  return loadImage(buffer as any).then((img: any) => {
    let { width, height } = img;
    const scale = Math.min(1, MAX_DIM / Math.max(width, height));
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, width, height);
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

  const detectWithTimeout = Promise.race([
    faceapi
      .detectAllFaces(
        selfieCanvas,
        new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.5 })
      )
      .withFaceLandmarks()
      .withFaceDescriptors(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('face detection timeout')), 8000)
    ),
  ]);
  const detections = await detectWithTimeout;

  const faceCount = detections.length;
  const qualityReasons: string[] = [];

  const laplacianVar = laplacianVariance(gray, w, h);

  if (laplacianVar < 80) qualityReasons.push('Image too blurry');
  if (brightness < 40) qualityReasons.push('Image too dark');
  else if (brightness > 230) qualityReasons.push('Image too bright');
  if (faceCount === 0) qualityReasons.push('No face detected');
  else if (faceCount > 1) qualityReasons.push(`Multiple faces detected (${faceCount})`);

  let faceAreaRatio = 0;
  if (faceCount > 0) {
    const box = detections[0].detection.box;
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
      _descriptor: faceCount > 0 ? Array.from(detections[0].descriptor as Float32Array) : [],
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

  const live = Array.from(detections[0].descriptor as Float32Array);
  const distance = euclidean(live, args.referenceDescriptor);
  const matched = distance < 0.6; // face-api.js euclidean; ~0.6 is a relaxed threshold
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

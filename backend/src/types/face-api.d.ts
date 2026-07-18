// backend/src/types/face-api.d.ts
// Minimal ambient declarations for face-api.js (ships without types).
declare module 'face-api.js' {
  export class TinyFaceDetectorOptions {
    constructor(options?: { inputSize?: number; scoreThreshold?: number });
  }

  export interface IBox {
    x: number;
    y: number;
    width: number;
    height: number;
  }

  export interface FaceDetection {
    box: IBox;
    score: number;
  }

  export interface FaceLandmarks {
    positions: Array<{ x: number; y: number }>;
  }

  export interface WithFaceDescriptor {
    detection: FaceDetection;
    descriptor: Float32Array;
    landmarks?: FaceLandmarks;
  }

  export const env: {
    monkeyPatch: (env: unknown) => void;
    [key: string]: unknown;
  };

  export const nets: {
    tinyFaceDetector: {
      loadFromDisk: (modelPath: string) => Promise<void>;
    };
    faceRecognitionNet: {
      loadFromDisk: (modelPath: string) => Promise<void>;
    };
    [key: string]: { loadFromDisk: (modelPath: string) => Promise<void> };
  };

  export function detectAllFaces(
    input: unknown,
    options?: TinyFaceDetectorOptions,
  ): {
    withFaceLandmarks: () => {
      withFaceDescriptors: () => Promise<WithFaceDescriptor[]>;
    };
  };
}

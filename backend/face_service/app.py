"""
NetRide face verification microservice.

Supports two verification modes:
  1. POST /verify          — Legacy video-clip verification (multi-angle)
  2. POST /verify-image    — Single selfie verification with anti-spoofing

The /verify-image endpoint replaces the multi-angle flow with a single
front-facing selfie, validated for quality before ML inference.

Anti-spoofing approach (single image):
  - Laplacian variance (texture) – detects blurry / low-res replays
  - LBP histogram variance       – detects uniform screen/print artifacts
  - Brightness uniformity check  – detects backlit screens
  - Face size / position check   – ensures natural framing

Thresholds come from environment variables (see env.py / docker-compose).
"""

from __future__ import annotations

import io
import logging
import os
import tempfile
from dataclasses import dataclass
from typing import Optional

import cv2
import face_recognition
import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from PIL import Image

logging.basicConfig(level=logging.INFO, format="%(asctime)s [face] %(message)s")
log = logging.getLogger("face_service")

app = FastAPI(title="NetRide Face Verification", version="2.0.0")

# ---------------------------------------------------------------------------
# Configuration (env-driven, no hardcoded thresholds)
# ---------------------------------------------------------------------------

MATCH_THRESHOLD = float(os.getenv("FACE_MATCH_THRESHOLD", "0.45"))
MIN_LAPLACIAN_VAR = float(os.getenv("FACE_MIN_LAPLACIAN_VAR", "80"))
MIN_FACE_AREA_RATIO = float(os.getenv("FACE_MIN_AREA_RATIO", "0.04"))
MAX_FACE_AREA_RATIO = float(os.getenv("FACE_MAX_AREA_RATIO", "0.60"))
MIN_BRIGHTNESS = float(os.getenv("FACE_MIN_BRIGHTNESS", "40"))
MAX_BRIGHTNESS = float(os.getenv("FACE_MAX_BRIGHTNESS", "230"))
MIN_LBP_VARIANCE = float(os.getenv("FACE_MIN_LBP_VARIANCE", "3.0"))
MAX_MULTIPLE_FACES = int(os.getenv("FACE_MAX_MULTIPLE_FACES", "1"))
LIVENESS_CONFIDENCE_THRESHOLD = float(os.getenv("FACE_LIVENESS_CONFIDENCE", "0.5"))

# Legacy video params
MIN_MOTION_PX = float(os.getenv("FACE_MIN_MOTION_PX", "15"))
MIN_BLINK_COUNT = int(os.getenv("FACE_MIN_BLINK_COUNT", "1"))
SAMPLE_FRAMES = int(os.getenv("FACE_SAMPLE_FRAMES", "15"))
EYE_AR_THRESHOLD = float(os.getenv("FACE_EYE_AR_THRESHOLD", "0.21"))

# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------


@dataclass
class LivenessMetrics:
    face_frames: int
    total_frames: int
    motion_px: float
    blink_count: int
    laplacian_var: float


@dataclass
class QualityMetrics:
    passed: bool
    laplacian_var: float
    brightness: float
    face_area_ratio: float
    face_count: int
    lbp_variance: float
    reasons: list[str]


@dataclass
class AntiSpoofingResult:
    passed: bool
    confidence: float
    laplacian_var: float
    lbp_variance: float
    brightness: float
    reasons: list[str]


# ---------------------------------------------------------------------------
# Image quality validation
# ---------------------------------------------------------------------------


def _compute_laplacian_variance(gray: np.ndarray) -> float:
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def _compute_brightness(gray: np.ndarray) -> float:
    return float(np.mean(gray))


def _compute_lbp_variance(gray: np.ndarray) -> float:
    """Compute Local Binary Pattern histogram variance.

    Real faces have richer texture variation than printed photos or
    screen replays, resulting in higher LBP histogram variance.
    """
    h, w = gray.shape
    radius = 1
    n_points = 8 * radius
    lbp = np.zeros_like(gray, dtype=np.int32)
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            if dx == 0 and dy == 0:
                continue
            shifted = np.roll(np.roll(gray, dy, axis=0), dx, axis=1)
            lbp += (shifted >= gray).astype(np.int32) << (dy + radius) * 3 + (dx + radius)
    hist, _ = np.histogram(lbp, bins=256, range=(0, 256))
    hist = hist.astype(np.float32)
    hist /= hist.sum() + 1e-6
    return float(np.var(hist))


def validate_image_quality(
    gray: np.ndarray,
    face_locations: list[tuple[int, int, int, int]],
    image_area: int,
) -> QualityMetrics:
    """Validate image quality before sending to ML pipeline.

    Returns QualityMetrics with pass/fail and detailed reasons.
    """
    reasons: list[str] = []

    laplacian_var = _compute_laplacian_variance(gray)
    brightness = _compute_brightness(gray)
    face_count = len(face_locations)
    lbp_variance = _compute_lbp_variance(gray)

    if laplacian_var < MIN_LAPLACIAN_VAR:
        reasons.append("Image too blurry")

    if brightness < MIN_BRIGHTNESS:
        reasons.append("Image too dark")
    elif brightness > MAX_BRIGHTNESS:
        reasons.append("Image too bright")

    if face_count == 0:
        reasons.append("No face detected")
    elif face_count > MAX_MULTIPLE_FACES:
        reasons.append(f"Multiple faces detected ({face_count})")

    if face_count > 0:
        top, right, bottom, left = face_locations[0]
        face_area = (bottom - top) * (right - left)
        face_area_ratio = face_area / max(image_area, 1)

        if face_area_ratio < MIN_FACE_AREA_RATIO:
            reasons.append("Face too small in frame")
        elif face_area_ratio > MAX_FACE_AREA_RATIO:
            reasons.append("Face too large in frame")

        # Check face is not cut off at edges
        h, w = gray.shape
        margin = 5
        if top < margin or bottom > h - margin or left < margin or right > w - margin:
            reasons.append("Face partially outside frame")
    else:
        face_area_ratio = 0.0

    passed = len(reasons) == 0

    return QualityMetrics(
        passed=passed,
        laplacian_var=laplacian_var,
        brightness=brightness,
        face_area_ratio=face_area_ratio if face_count > 0 else 0.0,
        face_count=face_count,
        lbp_variance=lbp_variance,
        reasons=reasons,
    )


def compute_anti_spoofing_score(gray: np.ndarray, face_location: tuple[int, int, int, int]) -> AntiSpoofingResult:
    """Compute anti-spoofing / liveness confidence from a single face crop.

    Combines multiple texture-based heuristics to distinguish a live person
    from presentation attacks (prints, screen replays).

    Returns a confidence score 0..1 where higher = more likely live.
    """
    top, right, bottom, left = face_location
    face_crop = gray[top:bottom, left:right]
    if face_crop.size == 0:
        return AntiSpoofingResult(
            passed=False,
            confidence=0.0,
            laplacian_var=0.0,
            lbp_variance=0.0,
            brightness=0.0,
            reasons=["Empty face crop"],
        )

    reasons: list[str] = []
    laplacian_var = _compute_laplacian_variance(face_crop)
    brightness = _compute_brightness(face_crop)
    lbp_variance = _compute_lbp_variance(face_crop)

    # Laplacian: real skin has fine texture; prints/screens are smoother or noisier
    laplacian_score = min(1.0, laplacian_var / (MIN_LAPLACIAN_VAR * 3))
    if laplacian_var < MIN_LAPLACIAN_VAR:
        reasons.append(f"Low texture detail ({laplacian_var:.1f})")
        laplacian_score *= 0.3

    # LBP: real faces have richer local texture patterns
    lbp_score = min(1.0, lbp_variance / 15.0)
    if lbp_variance < MIN_LBP_VARIANCE:
        reasons.append(f"Uniform texture pattern ({lbp_variance:.1f})")
        lbp_score *= 0.3

    # Brightness: check for unnatural uniformity (screen glow)
    brightness_std = float(np.std(face_crop))
    brightness_score = min(1.0, brightness_std / 40.0)
    if brightness_std < 15:
        reasons.append(f"Unnatural brightness uniformity ({brightness_std:.1f})")
        brightness_score *= 0.4

    combined = 0.40 * laplacian_score + 0.35 * lbp_score + 0.25 * brightness_score
    # Penalize extreme brightness (screen at max)
    if brightness > 220:
        combined *= 0.7
        reasons.append("Extremely bright — possible screen")

    passed = combined >= LIVENESS_CONFIDENCE_THRESHOLD

    return AntiSpoofingResult(
        passed=passed,
        confidence=round(combined, 3),
        laplacian_var=round(laplacian_var, 2),
        lbp_variance=round(lbp_variance, 2),
        brightness=round(brightness, 1),
        reasons=reasons,
    )


# ---------------------------------------------------------------------------
# Legacy helpers (preserved for backward-compatible /verify endpoint)
# ---------------------------------------------------------------------------


def _load_reference_embedding(data: bytes) -> Optional[np.ndarray]:
    """Decode an enrollment image and return its 128-d face embedding."""
    try:
        img = face_recognition.load_image_file(io.BytesIO(data))
    except Exception as e:
        log.error("Could not decode reference image: %s", e)
        return None
    locations = face_recognition.face_locations(img, model="hog")
    if not locations:
        return None
    encodings = face_recognition.face_encodings(img, known_face_locations=locations)
    if not encodings:
        return None
    areas = [(b[2] - b[0]) * (b[1] - b[3]) for b in locations]
    return encodings[int(np.argmax(areas))]


def _eye_aspect_ratio(eye_landmarks: np.ndarray) -> float:
    """Eye aspect ratio (EAR) from 6 (x, y) landmarks."""
    p = eye_landmarks
    v1 = np.linalg.norm(p[1] - p[5])
    v2 = np.linalg.norm(p[2] - p[4])
    h = np.linalg.norm(p[0] - p[3])
    if h == 0:
        return 1.0
    return (v1 + v2) / (2.0 * h)


def _laplacian_variance(gray: np.ndarray) -> float:
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def _analyze_video(video_bytes: bytes) -> tuple[Optional[np.ndarray], LivenessMetrics]:
    """
    Sample SAMPLE_FRAMES evenly-spaced frames from the clip, run face
    detection on each, and aggregate liveness metrics.

    Returns the embedding from the largest detected face, plus the metrics.
    """
    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=True) as tmp:
        tmp.write(video_bytes)
        tmp.flush()
        cap = cv2.VideoCapture(tmp.name)
        if not cap.isOpened():
            return None, LivenessMetrics(0, 0, 0, 0, 0)

        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        if total <= 0:
            cap.release()
            return None, LivenessMetrics(0, 0, 0, 0, 0)

        indices = np.linspace(0, total - 1, num=min(SAMPLE_FRAMES, total), dtype=int)

        centers: list[tuple[float, float]] = []
        sizes: list[tuple[int, int, int, int]] = []
        face_frames = 0
        blink_count = 0
        prev_ear_closed = False
        best_frame: Optional[np.ndarray] = None
        best_area = 0
        best_laplacian = 0.0

        for idx in indices:
            cap.set(cv2.CAP_PROP_POS_FRAMES, int(idx))
            ok, frame = cap.read()
            if not ok or frame is None:
                continue

            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            locations = face_recognition.face_locations(rgb, model="hog")
            if not locations:
                continue
            face_frames += 1

            areas = [(b[2] - b[0]) * (b[1] - b[3]) for b in locations]
            i = int(np.argmax(areas))
            top, right, bottom, left = locations[i]
            cx = (left + right) / 2.0
            cy = (top + bottom) / 2.0
            centers.append((cx, cy))
            sizes.append((top, right, bottom, left))

            landmarks_list = face_recognition.face_landmarks(rgb, face_locations=[locations[i]])
            if landmarks_list:
                landmarks = landmarks_list[0]
                left_eye = np.array(landmarks.get("left_eye", []))
                right_eye = np.array(landmarks.get("right_eye", []))
                if len(left_eye) >= 6 and len(right_eye) >= 6:
                    ear = (_eye_aspect_ratio(left_eye) + _eye_aspect_ratio(right_eye)) / 2.0
                    if ear < EYE_AR_THRESHOLD:
                        if not prev_ear_closed:
                            blink_count += 1
                            prev_ear_closed = True
                    else:
                        prev_ear_closed = False

            face_crop = frame[top:bottom, left:right]
            if face_crop.size > 0:
                gray = cv2.cvtColor(face_crop, cv2.COLOR_BGR2GRAY)
                var = _laplacian_variance(gray)
                area = areas[i]
                if area > best_area and var > best_laplacian:
                    best_area = area
                    best_laplacian = var
                    best_frame = rgb

        cap.release()

        motion = 0.0
        if len(centers) >= 2:
            arr = np.array(centers)
            deltas = arr[:, None, :] - arr[None, :, :]
            dists = np.linalg.norm(deltas, axis=-1)
            motion = float(dists.max())

        metrics = LivenessMetrics(
            face_frames=face_frames,
            total_frames=len(indices),
            motion_px=motion,
            blink_count=blink_count,
            laplacian_var=best_laplacian,
        )

        if best_frame is None:
            return None, metrics

        locations = face_recognition.face_locations(best_frame, model="hog")
        if not locations:
            return None, metrics
        encodings = face_recognition.face_encodings(best_frame, known_face_locations=locations)
        if not encodings:
            return None, metrics
        areas = [(b[2] - b[0]) * (b[1] - b[3]) for b in locations]
        return encodings[int(np.argmax(areas))], metrics


def _extract_embedding_from_image(rgb: np.ndarray) -> Optional[np.ndarray]:
    """Extract the 128-d face embedding from the largest face in an RGB image."""
    locations = face_recognition.face_locations(rgb, model="hog")
    if not locations:
        return None
    encodings = face_recognition.face_encodings(rgb, known_face_locations=locations)
    if not encodings:
        return None
    areas = [(b[2] - b[0]) * (b[1] - b[3]) for b in locations]
    return encodings[int(np.argmax(areas))]


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "service": "face_verification",
        "version": "2.0.0",
        "thresholds": {
            "match": MATCH_THRESHOLD,
            "laplacian_var": MIN_LAPLACIAN_VAR,
            "min_face_area_ratio": MIN_FACE_AREA_RATIO,
            "max_face_area_ratio": MAX_FACE_AREA_RATIO,
            "min_brightness": MIN_BRIGHTNESS,
            "max_brightness": MAX_BRIGHTNESS,
            "min_lbp_variance": MIN_LBP_VARIANCE,
            "liveness_confidence": LIVENESS_CONFIDENCE_THRESHOLD,
        },
    }


@app.post("/verify-image")
async def verify_image(
    selfie: UploadFile = File(..., description="Single front-facing selfie."),
    reference: UploadFile = File(..., description="Trusted enrollment image."),
) -> JSONResponse:
    """Single-selfie verification with quality validation + anti-spoofing.

    This is the new primary endpoint. Replaces the old multi-angle video flow.

    Pipeline:
      1. Image quality validation (blur, brightness, face size, multiple faces)
      2. Anti-spoofing / liveness analysis (texture, LBP, brightness uniformity)
      3. Face embedding extraction
      4. Similarity comparison against enrolled reference
      5. Combined decision: quality AND liveness AND match must pass
    """
    selfie_bytes = await selfie.read()
    reference_bytes = await reference.read()

    if not selfie_bytes or not reference_bytes:
        raise HTTPException(status_code=400, detail="Both selfie and reference files are required.")

    # 1. Load and validate the selfie image
    try:
        selfie_img = face_recognition.load_image_file(io.BytesIO(selfie_bytes))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not decode selfie image: {e}")

    if len(selfie_img.shape) != 3:
        raise HTTPException(status_code=400, detail="Invalid image format.")

    h, w = selfie_img.shape[:2]
    image_area = h * w

    # Convert to grayscale for quality/anti-spoofing
    gray = cv2.cvtColor(selfie_img, cv2.COLOR_RGB2GRAY)

    # 2. Face detection for quality validation
    face_locations = face_recognition.face_locations(selfie_img, model="hog")

    # 3. Quality validation
    quality = validate_image_quality(gray, face_locations, image_area)

    if not quality.passed:
        log.info("Quality check failed: %s", ", ".join(quality.reasons))
        return JSONResponse(
            status_code=200,
            content={
                "match": False,
                "score": 0.0,
                "reason": "quality_failed",
                "quality": {
                    "passed": False,
                    "laplacian_var": round(quality.laplacian_var, 2),
                    "brightness": round(quality.brightness, 1),
                    "face_area_ratio": round(quality.face_area_ratio, 4),
                    "face_count": quality.face_count,
                    "reasons": quality.reasons,
                },
            },
        )

    # 4. Anti-spoofing on the primary face
    primary_face = face_locations[0]
    spoof = compute_anti_spoofing_score(gray, primary_face)

    # 5. Load reference embedding
    ref_embedding = _load_reference_embedding(reference_bytes)
    if ref_embedding is None:
        raise HTTPException(status_code=400, detail="No face found in the reference image.")

    # 6. Extract selfie embedding
    live_embedding = _extract_embedding_from_image(selfie_img)
    if live_embedding is None:
        return JSONResponse(
            status_code=200,
            content={
                "match": False,
                "score": 0.0,
                "reason": "no_face_in_selfie",
                "quality": {
                    "passed": True,
                    "laplacian_var": round(quality.laplacian_var, 2),
                    "brightness": round(quality.brightness, 1),
                    "face_area_ratio": round(quality.face_area_ratio, 4),
                    "face_count": quality.face_count,
                    "reasons": [],
                },
                "liveness": {
                    "passed": spoof.passed,
                    "confidence": spoof.confidence,
                    "laplacian_var": round(spoof.laplacian_var, 2),
                    "lbp_variance": round(spoof.lbp_variance, 2),
                    "reasons": spoof.reasons,
                },
            },
        )

    # 7. Similarity comparison
    distance = float(np.linalg.norm(live_embedding - ref_embedding))
    matched = distance < MATCH_THRESHOLD
    score = max(0.0, 1.0 - distance)

    # 8. Combined decision
    all_passed = matched and spoof.passed

    if not all_passed:
        reason = "liveness_failed" if not spoof.passed else "face_mismatch"
        log.info(
            "Selfie verify FAILED: match=%s score=%.3f liveness=%.3f lap=%.1f lbp=%.3f",
            matched,
            score,
            spoof.confidence,
            spoof.laplacian_var,
            spoof.lbp_variance,
        )
    else:
        log.info(
            "Selfie verify PASSED: score=%.3f liveness=%.3f",
            score,
            spoof.confidence,
        )

    return JSONResponse(
        status_code=200,
        content={
            "match": bool(matched),
            "score": round(score, 3),
            "distance": round(distance, 4),
            "reason": reason if not all_passed else "match",
            "liveness": {
                "passed": bool(spoof.passed),
                "confidence": round(spoof.confidence, 3),
                "laplacian_var": round(spoof.laplacian_var, 2),
                "lbp_variance": round(spoof.lbp_variance, 2),
                "brightness": round(spoof.brightness, 1),
                "reasons": spoof.reasons,
            },
            "quality": {
                "passed": True,
                "laplacian_var": round(quality.laplacian_var, 2),
                "brightness": round(quality.brightness, 1),
                "face_area_ratio": round(quality.face_area_ratio, 4),
                "face_count": quality.face_count,
                "reasons": [],
            },
        },
    )


# ---------------------------------------------------------------------------
# Legacy endpoint (preserved for backward compatibility)
# ---------------------------------------------------------------------------


@app.post("/verify")
async def verify(
    video: UploadFile = File(..., description="Short MP4 clip captured in-app."),
    reference: UploadFile = File(..., description="Trusted enrollment image."),
) -> JSONResponse:
    """Legacy multi-angle video verification. Preserved for backward compatibility."""
    video_bytes = await video.read()
    reference_bytes = await reference.read()

    if not video_bytes or not reference_bytes:
        raise HTTPException(status_code=400, detail="Both video and reference files are required.")

    ref_embedding = _load_reference_embedding(reference_bytes)
    if ref_embedding is None:
        raise HTTPException(status_code=400, detail="No face found in the reference image.")

    live_embedding, metrics = _analyze_video(video_bytes)

    liveness_pass = (
        metrics.face_frames >= max(3, metrics.total_frames // 2)
        and metrics.motion_px >= MIN_MOTION_PX
        and metrics.blink_count >= MIN_BLINK_COUNT
        and metrics.laplacian_var >= MIN_LAPLACIAN_VAR
    )

    if live_embedding is None or not liveness_pass:
        log.info(
            "Liveness/face fail: face_frames=%d/%d motion=%.1f blinks=%d lap=%.1f",
            metrics.face_frames,
            metrics.total_frames,
            metrics.motion_px,
            metrics.blink_count,
            metrics.laplacian_var,
        )
        return JSONResponse(
            status_code=200,
            content={
                "match": False,
                "score": 1.0,
                "reason": "liveness_failed",
                "liveness": {
                    "face_frames": metrics.face_frames,
                    "total_frames": metrics.total_frames,
                    "motion_px": round(metrics.motion_px, 2),
                    "blink_count": metrics.blink_count,
                    "laplacian_var": round(metrics.laplacian_var, 2),
                    "passed": False,
                },
            },
        )

    distance = float(np.linalg.norm(live_embedding - ref_embedding))
    matched = distance < MATCH_THRESHOLD
    score = max(0.0, 1.0 - distance)

    log.info(
        "Face verify: match=%s distance=%.3f score=%.3f motion=%.1f blinks=%d lap=%.1f",
        matched,
        distance,
        score,
        metrics.motion_px,
        metrics.blink_count,
        metrics.laplacian_var,
    )

    return JSONResponse(
        status_code=200,
        content={
            "match": bool(matched),
            "score": round(score, 3),
            "distance": round(distance, 4),
            "reason": "match" if matched else "face_mismatch",
            "liveness": {
                "face_frames": metrics.face_frames,
                "total_frames": metrics.total_frames,
                "motion_px": round(metrics.motion_px, 2),
                "blink_count": metrics.blink_count,
                "laplacian_var": round(metrics.laplacian_var, 2),
                "passed": True,
            },
        },
    )

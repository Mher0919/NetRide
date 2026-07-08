"""
NetRide face verification microservice.

Accepts a short video clip + a reference (enrollment) image, runs four
liveness heuristics, and returns whether the face in the clip matches the
reference along with liveness metrics.

The threshold values come from environment variables so they can be tuned
without rebuilding the image.

Endpoints:
  GET  /health  → liveness probe.
  POST /verify  → multipart form: video (mp4), reference (jpg/png).
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

app = FastAPI(title="NetRide Face Verification", version="1.0.0")


# ---------------------------------------------------------------------------
# Configuration (read from env so docker-compose / k8s can tune without rebuild)
# ---------------------------------------------------------------------------

MATCH_THRESHOLD = float(os.getenv("FACE_MATCH_THRESHOLD", "0.45"))
MIN_MOTION_PX = float(os.getenv("FACE_MIN_MOTION_PX", "15"))
MIN_BLINK_COUNT = int(os.getenv("FACE_MIN_BLINK_COUNT", "1"))
MIN_LAPLACIAN_VAR = float(os.getenv("FACE_MIN_LAPLACIAN_VAR", "80"))
SAMPLE_FRAMES = int(os.getenv("FACE_SAMPLE_FRAMES", "15"))
EYE_AR_THRESHOLD = float(os.getenv("FACE_EYE_AR_THRESHOLD", "0.21"))


@dataclass
class LivenessMetrics:
    face_frames: int
    total_frames: int
    motion_px: float
    blink_count: int
    laplacian_var: float


# ---------------------------------------------------------------------------
# Helpers
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
    # Largest face wins (helps when there are background faces).
    areas = [(b[2] - b[0]) * (b[1] - b[3]) for b in locations]
    return encodings[int(np.argmax(areas))]


def _eye_aspect_ratio(eye_landmarks: np.ndarray) -> float:
    """Eye aspect ratio (EAR) from 6 (x, y) landmarks."""
    p = eye_landmarks
    # Vertical distances
    v1 = np.linalg.norm(p[1] - p[5])
    v2 = np.linalg.norm(p[2] - p[4])
    # Horizontal distance
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
        sizes: list[tuple[int, int]] = []  # (top, right, bottom, left)
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

            # Largest face in this frame.
            areas = [(b[2] - b[0]) * (b[1] - b[3]) for b in locations]
            i = int(np.argmax(areas))
            top, right, bottom, left = locations[i]
            cx = (left + right) / 2.0
            cy = (top + bottom) / 2.0
            centers.append((cx, cy))
            sizes.append((top, right, bottom, left))

            # Blink detection via eye aspect ratio.
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

            # Texture + best-frame selection.
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

        # Motion: max distance between any two centers.
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

        # Compute embedding on the largest detected frame using its bbox.
        # (best_frame was set when we had a face, so locations is non-empty.)
        locations = face_recognition.face_locations(best_frame, model="hog")
        if not locations:
            return None, metrics
        encodings = face_recognition.face_encodings(best_frame, known_face_locations=locations)
        if not encodings:
            return None, metrics
        areas = [(b[2] - b[0]) * (b[1] - b[3]) for b in locations]
        return encodings[int(np.argmax(areas))], metrics


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "service": "face_verification",
        "thresholds": {
            "match": MATCH_THRESHOLD,
            "motion_px": MIN_MOTION_PX,
            "blink_count": MIN_BLINK_COUNT,
            "laplacian_var": MIN_LAPLACIAN_VAR,
        },
    }


@app.post("/verify")
async def verify(
    video: UploadFile = File(..., description="Short MP4 clip captured in-app."),
    reference: UploadFile = File(..., description="Trusted enrollment image."),
) -> JSONResponse:
    video_bytes = await video.read()
    reference_bytes = await reference.read()

    if not video_bytes or not reference_bytes:
        raise HTTPException(status_code=400, detail="Both video and reference files are required.")

    ref_embedding = _load_reference_embedding(reference_bytes)
    if ref_embedding is None:
        raise HTTPException(status_code=400, detail="No face found in the reference image.")

    live_embedding, metrics = _analyze_video(video_bytes)

    # ---- Liveness gate -------------------------------------------------------
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
    score = max(0.0, 1.0 - distance)  # Convert to a 0..1 confidence (1 = identical).

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
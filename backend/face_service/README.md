# Face verification microservice

Python FastAPI service that compares a short live video clip against a stored
enrollment image. Returns match + liveness metrics.

## Endpoints

| Method | Path     | Purpose                                                    |
|--------|----------|------------------------------------------------------------|
| GET    | /health  | Liveness probe with current threshold values.              |
| POST   | /verify  | Multipart: `video` (mp4) + `reference` (jpg/png). Returns `{ match, score, liveness }`. |

## Liveness heuristics

| Check           | Threshold           | Catches            |
|-----------------|---------------------|--------------------|
| Face presence   | >= 50% of sampled frames contain a single face | Empty / covered camera |
| Motion          | Bounding-box center moves >= `FACE_MIN_MOTION_PX` (default 15 px) | Printed photo |
| Blink           | Eye aspect ratio dips below threshold at least `FACE_MIN_BLINK_COUNT` times (default 1) | Held-up photo |
| Texture         | Laplacian variance of face region >= `FACE_MIN_LAPLACIAN_VAR` (default 80) | Screen replay at low resolution |

All four must pass for the result to be trusted. Otherwise the response is
`{ match: false, reason: "liveness_failed" }` and the calling backend
flips the driver to FLAGGED.

## Local dev

```bash
cd backend/face_service
pip install -r requirements.txt
uvicorn app:app --reload --port 8000
```

## Docker

```bash
docker build -t netride/face-service backend/face_service
docker run --rm -p 8000:8000 netride/face-service
```
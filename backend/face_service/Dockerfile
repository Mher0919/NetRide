FROM python:3.11-slim

# System deps for dlib + OpenCV
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        cmake \
        libgl1 \
        libglib2.0-0 \
        libsm6 \
        libxrender1 \
        libxext6 \
        ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt

COPY app.py .

EXPOSE 8000

# Use 1 worker (face_recognition is not thread-safe with shared state).
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
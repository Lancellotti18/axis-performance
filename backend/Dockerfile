FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y \
    libgl1 \
    libglib2.0-0 \
    tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Cap glibc per-thread arenas: stops a threaded Python server hoarding freed
# memory until Render's limit restarts it (see app/core/memory.py).
ENV MALLOC_ARENA_MAX=2

CMD uvicorn app.main:app --host 0.0.0.0 --port 8000

FROM python:3.13-slim

ARG UID=1000
ARG GID=1000

WORKDIR /app

# apt-get upgrade patcht auch bereits im Base-Image vorhandene Pakete (z.B. linux-libc-dev) -
# ohne das wuerde der Trivy-Scan in der CI (.github/workflows/deploy.yml) bei jeder bekannten,
# im Debian-Repo bereits gefixten CVE eines Base-Image-Pakets fehlschlagen, auch wenn wir das
# Paket selbst nie explizit installieren.
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
    libjpeg-dev \
    zlib1g-dev \
    ffmpeg \
    fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .

RUN pip install --no-cache-dir -r requirements.txt && pip install --no-cache-dir gunicorn

# ADMIN_TOKEN und SECRET_KEY sind bewusst NICHT vorbelegt - app.py bricht ohne sie
# ab. Muessen beim "docker run" per -e gesetzt werden, siehe README. ACCESS_TOKEN
# ebenso, ausser PUBLIC_MODE=1 wird gesetzt (dann entfaellt es).
ENV PHOTO_DIR=/photos \
    THUMB_DIR=/data/thumbs \
    REEL_DIR=/data/reels \
    DB_PATH=/data/trips.db \
    CONTACT_EMAIL=deine.email@beispiel.de \
    PYTHONUNBUFFERED=1

COPY static ./static
COPY templates ./templates
COPY app.py .

RUN groupadd -g ${GID} appuser && \
    useradd -u ${UID} -g appuser -s /bin/sh -M appuser

RUN mkdir -p /photos /data/thumbs /data/reels && \
    chown -R appuser:appuser /app /photos /data/thumbs /data/reels

EXPOSE 5000

USER appuser

# Reihenfolge ist wichtig: "A && B & gunicorn" wuerde in sh als "(A && B) &" plus
# parallel dazu gunicorn geparst - der Webserver startet dann vor init_db() und
# beantwortet die ersten Requests mit "no such table". Der Watcher laeuft als
# eigener Hintergrundprozess, gunicorn per exec als PID 1 (saubere Signale).
#
# -w 1: der Reel-Lock (threading.Lock) und das Rate-Limiting (storage_uri memory://)
# sind prozesslokal und waeren mit mehreren Workern wirkungslos. Threads statt
# Prozesse, weil die App I/O-gebunden ist (SQLite, ffmpeg als Subprozess).
CMD ["sh", "-c", "python -c 'import app; app.init_db()' && (python -c 'import app; app.start_background_services(); import threading; threading.Event().wait()' &) && exec gunicorn -w 1 --threads 8 -b 0.0.0.0:5000 app:app"]

FROM python:3.10-slim

ARG UID=1000
ARG GID=1000

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    libjpeg-dev \
    zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .

RUN pip install --no-cache-dir -r requirements.txt && pip install gunicorn

# ACCESS_TOKEN, ADMIN_TOKEN und SECRET_KEY sind bewusst NICHT vorbelegt - app.py
# bricht ohne sie ab. Muessen beim "docker run" per -e gesetzt werden, siehe README.
ENV PHOTO_DIR=/photos \
    THUMB_DIR=/data/thumbs \
    DB_PATH=/data/trips.db \
    CONTACT_EMAIL=deine.email@beispiel.de \
    PYTHONUNBUFFERED=1

COPY static ./static
COPY templates ./templates
COPY app.py .

RUN groupadd -g ${GID} appuser && \
    useradd -u ${UID} -g appuser -s /bin/sh -M appuser

RUN mkdir -p /photos /data/thumbs && \
    chown -R appuser:appuser /app /photos /data/thumbs

EXPOSE 5000

USER appuser

CMD ["sh", "-c", "python -c 'import app; app.init_db()' && python -c 'import app; app.start_background_services(); import time; time.sleep(31536000)' & gunicorn -w 3 -b 0.0.0.0:5000 app:app"]

# Basis Image: Python 3.10 Slim
FROM python:3.10-slim

# Arbeitsverzeichnis setzen
WORKDIR /app

# 1. System-Abhängigkeiten installieren
# Minimale Installation ohne empfohlene Pakete zur Reduktion der Image-Größe
RUN apt-get update && apt-get install -y --no-install-recommends \
    libjpeg-dev \
    zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

# 2. Python Abhängigkeiten
# Requirements zuerst kopieren, um Docker-Layer-Caching effizient zu nutzen
COPY requirements.txt .

# Installation der Abhängigkeiten inklusive Gunicorn
RUN pip install --no-cache-dir -r requirements.txt && pip install gunicorn

# 3. Umgebungsvariablen
# Definition der Standardwerte
ENV PHOTO_DIR=/photos \
    THUMB_DIR=/data/thumbs \
    DB_PATH=/data/trips.db \
    ACCESS_TOKEN=geheim123 \
    CONTACT_EMAIL=deine.email@beispiel.de \
    # Python-Output ungepuffert ausgeben (für Logs)
    PYTHONUNBUFFERED=1

# 4. Anwendungs-Code kopieren
COPY static ./static
COPY templates ./templates
COPY app.py .

# 5. Verzeichnisse erstellen
RUN mkdir -p /photos /data/thumbs

# Port freigeben
EXPOSE 5000

# 6. Startbefehl
# Startet den Scanner-Thread (via Python) und den Webserver (Gunicorn) parallel
CMD ["sh", "-c", "python -c 'import app; import threading; threading.Thread(target=app.scan_worker, daemon=True).start(); import time; time.sleep(31536000)' & gunicorn -w 3 -b 0.0.0.0:5000 app:app"]
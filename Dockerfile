# Basis Image: Python 3.10 Slim (guter Kompromiss aus Größe und Kompatibilität)
FROM python:3.10-slim

# Arbeitsverzeichnis setzen
WORKDIR /app

# 1. System-Abhängigkeiten installieren
# --no-install-recommends hält das Image klein
RUN apt-get update && apt-get install -y --no-install-recommends \
    libjpeg-dev \
    zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

# 2. Python Dependencies
# Wir kopieren ERST die requirements, damit Docker diesen Schritt cachen kann,
# wenn sich nur der Code (app.py) ändert.
COPY requirements.txt .

# WICHTIG: Falls gunicorn nicht in deiner requirements.txt steht,
# installieren wir es hier sicherheitshalber explizit mit.
RUN pip install --no-cache-dir -r requirements.txt && pip install gunicorn

# 3. Umgebungsvariablen (Standardwerte)
# Zusammengefasst in einen Block für weniger Image-Layer
ENV PHOTO_DIR=/photos \
    THUMB_DIR=/data/thumbs \
    DB_PATH=/data/trips.db \
    ACCESS_TOKEN=geheim123 \
    CONTACT_EMAIL=deine.email@beispiel.de \
    # Verhindert, dass Python Logs puffert (wichtig für Docker Logs)
    PYTHONUNBUFFERED=1

# 4. App-Code kopieren
COPY static ./static
COPY templates ./templates
COPY app.py .

# 5. Ordner erstellen
RUN mkdir -p /photos /data/thumbs

# Port freigeben
EXPOSE 5000

# 6. DER STARTBEFEHL (Der Trick)
# Wir nutzen 'sh -c', um zwei Prozesse zu starten:
# A) Den Scanner im Hintergrund (&) -> 'python -c ...'
# B) Den Gunicorn Server im Vordergrund -> 'gunicorn ...'
# -w 3 bedeutet: 3 Worker Prozesse gleichzeitig (gut für Synology)
CMD ["sh", "-c", "python -c 'import app; import threading; threading.Thread(target=app.scan_worker, daemon=True).start(); import time; time.sleep(31536000)' & gunicorn -w 3 -b 0.0.0.0:5000 app:app"]

FROM python:3.10-slim

WORKDIR /app


RUN apt-get update && apt-get install -y \
    libjpeg-dev \
    zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*


COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# --- UMGEBUNGSVARIABLEN (Standardwerte) ---
ENV PHOTO_DIR=/photos
ENV THUMB_DIR=/data/thumbs
ENV DB_PATH=/data/trips.db
ENV ACCESS_TOKEN=geheim123
ENV CONTACT_EMAIL=deine.email@beispiel.de


COPY static ./static
COPY templates ./templates
COPY app.py .

RUN mkdir -p /photos /data/thumbs

EXPOSE 5000

CMD ["python", "app.py"]
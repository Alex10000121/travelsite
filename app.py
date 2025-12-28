import os
import sqlite3
import threading
import time
import math
import hashlib
import logging
from datetime import datetime

# Drittanbieter-Bibliotheken
from flask import Flask, render_template, request, jsonify, send_file, abort
from PIL import Image, ImageOps
from PIL.ExifTags import TAGS, GPSTAGS
import reverse_geocoder as rg
from werkzeug.utils import secure_filename

# --- 1. KONFIGURATION & LOGGING ---

# Logging konfigurieren (besser als print)
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

app = Flask(__name__)

# Konfigurations-Variablen (Fallback auf Defaults)
CONFIG = {
    'PHOTO_DIR': os.environ.get('PHOTO_DIR', './photos'),
    'THUMB_DIR': os.environ.get('THUMB_DIR', './data/thumbs'),
    'DB_PATH': os.environ.get('DB_PATH', './data/trips.db'),
    'ACCESS_TOKEN': os.environ.get('ACCESS_TOKEN', 'geheim123'),
    'ADMIN_TOKEN': os.environ.get('ADMIN_TOKEN', 'admin_geheim'),
    'CONTACT_EMAIL': os.environ.get('CONTACT_EMAIL', 'deine.email@beispiel.de')
}

# Verzeichnisse erstellen
os.makedirs(CONFIG['THUMB_DIR'], exist_ok=True)
os.makedirs(os.path.dirname(CONFIG['DB_PATH']), exist_ok=True)


# --- 2. HILFSFUNKTIONEN (LOGIK) ---

def calculate_distance(lat1, lon1, lat2, lon2):
    """Berechnet die Distanz zwischen zwei Koordinaten (Haversine-Formel)."""
    R = 6371.0  # Erdradius in km
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c


def get_decimal_from_dms(dms, ref):
    """Wandelt DMS (Degrees, Minutes, Seconds) in Dezimalgrad um."""
    degrees = dms[0] + (dms[1] / 60.0) + (dms[2] / 3600.0)
    if ref in ['S', 'W']:
        degrees = -degrees
    return degrees


def extract_exif_data(image_path):
    """Liest GPS und Zeitstempel aus den EXIF-Daten eines Bildes."""
    timestamp = None
    coords = None

    try:
        with Image.open(image_path) as img:
            exif = img._getexif()
            if not exif:
                return None, None

            # 1. Zeitstempel holen
            date_str = exif.get(36867)  # DateTimeOriginal
            if date_str:
                try:
                    dt = datetime.strptime(date_str, '%Y:%m:%d %H:%M:%S')
                    timestamp = dt.timestamp()
                except ValueError:
                    pass

            # 2. GPS Daten holen
            gps_info = {}
            for k, v in exif.items():
                if TAGS.get(k) == "GPSInfo":
                    for t in v:
                        gps_info[GPSTAGS.get(t, t)] = v[t]

            if 'GPSLatitude' in gps_info and 'GPSLongitude' in gps_info:
                lat = get_decimal_from_dms(gps_info['GPSLatitude'], gps_info['GPSLatitudeRef'])
                lon = get_decimal_from_dms(gps_info['GPSLongitude'], gps_info['GPSLongitudeRef'])
                coords = (lat, lon)

    except Exception as e:
        logger.warning(f"EXIF Fehler bei {image_path}: {e}")

    return timestamp, coords


def get_location_name(lat, lon):
    """Ermittelt den Ort basierend auf Koordinaten (Offline Reverse Geocoding)."""
    if lat == 0 and lon == 0: return "Unbekannt"
    try:
        results = rg.search((lat, lon))
        if results:
            # Beispiel: "München, DE"
            return f"{results[0]['name']}, {results[0]['cc']}"
    except Exception as e:
        logger.error(f"Geocoding Fehler: {e}")
    return "Unbekannt"


def generate_thumbnail(original_path, thumb_path):
    """Erstellt ein komprimiertes Thumbnail, beachtet EXIF-Rotation."""
    if os.path.exists(thumb_path):
        return True

    try:
        with Image.open(original_path) as img:
            # WICHTIG: Bild gemäß EXIF-Tags drehen (sonst liegen Hochformat-Bilder auf der Seite)
            img = ImageOps.exif_transpose(img)

            # Farbpalette konvertieren (für PNG/GIF Support)
            if img.mode in ("RGBA", "P"):
                img = img.convert("RGB")

            img.thumbnail((800, 800))
            img.save(thumb_path, "JPEG", quality=70, optimize=True)
        return True
    except Exception as e:
        logger.error(f"Thumbnail Fehler bei {original_path}: {e}")
        return False


# --- 3. DATENBANK MANAGEMENT ---

def get_db():
    """Hilfsfunktion für DB-Verbindung."""
    conn = sqlite3.connect(CONFIG['DB_PATH'])
    conn.row_factory = sqlite3.Row  # Zugriff über Spaltennamen ermöglichen
    return conn


def init_db():
    """Initialisiert die Datenbank-Tabellen."""
    try:
        with get_db() as conn:
            conn.execute('''
                CREATE TABLE IF NOT EXISTS photos (
                    filename TEXT PRIMARY KEY, 
                    lat REAL, 
                    lon REAL, 
                    timestamp REAL, 
                    location TEXT
                )
            ''')
            conn.execute('CREATE TABLE IF NOT EXISTS global_stats (key TEXT PRIMARY KEY, value INTEGER)')
            conn.execute("INSERT OR IGNORE INTO global_stats (key, value) VALUES ('visitor_count', 0)")
            conn.execute('CREATE TABLE IF NOT EXISTS active_sessions (hash TEXT PRIMARY KEY, timestamp REAL)')
        logger.info("Datenbank initialisiert.")
    except Exception as e:
        logger.critical(f"Datenbank Init Fehler: {e}")


def track_visitor_count():
    """Zählt einzigartige Besucher (basiert auf IP + UserAgent Hash für 1h)."""
    visitor_hash = hashlib.sha256(f"{request.remote_addr}-{request.user_agent.string}".encode('utf-8')).hexdigest()
    now = time.time()
    total = 0

    try:
        with get_db() as conn:
            # Alte Sessions löschen (> 1 Stunde)
            conn.execute("DELETE FROM active_sessions WHERE timestamp < ?", (now - 3600,))

            # Prüfen ob Besucher neu ist
            cursor = conn.execute("SELECT 1 FROM active_sessions WHERE hash = ?", (visitor_hash,))
            if not cursor.fetchone():
                conn.execute("INSERT INTO active_sessions (hash, timestamp) VALUES (?, ?)", (visitor_hash, now))
                conn.execute("UPDATE global_stats SET value = value + 1 WHERE key = 'visitor_count'")
            else:
                conn.execute("UPDATE active_sessions SET timestamp = ? WHERE hash = ?", (now, visitor_hash))

            conn.commit()

            # Aktuellen Stand lesen
            row = conn.execute("SELECT value FROM global_stats WHERE key = 'visitor_count'").fetchone()
            if row: total = row['value']
    except Exception as e:
        logger.error(f"Visitor Tracking Fehler: {e}")

    return total


# --- 4. HINTERGRUND SCANNER ---

def scan_worker():
    """Scannt periodisch das Foto-Verzeichnis nach neuen Dateien."""
    logger.info("Scanner Thread gestartet.")

    # Warte kurz, damit Flask fertig starten kann
    time.sleep(2)

    abs_photo_dir = os.path.abspath(CONFIG['PHOTO_DIR'])

    while True:
        try:
            changes_detected = False
            with get_db() as conn:
                for root, dirs, files in os.walk(abs_photo_dir):
                    if '@eaDir' in root: continue  # Synology Thumbnails ignorieren

                    for file in files:
                        if file.lower().endswith(('.jpg', '.jpeg', '.png', '.heic')):
                            full_path = os.path.join(root, file)

                            # Relativer Pfad für DB und URLs
                            rel_path = os.path.relpath(full_path, abs_photo_dir).replace('\\', '/')
                            if rel_path.startswith('./'): rel_path = rel_path[2:]

                            # Prüfen ob bereits in DB
                            exists = conn.execute("SELECT 1 FROM photos WHERE filename=?", (rel_path,)).fetchone()

                            if not exists:
                                # Thumbnail Name generieren (flache Struktur im Cache)
                                flat_name = rel_path.replace('/', '_').replace('\\', '_')
                                if not flat_name.lower().endswith('.jpg'): flat_name += '.jpg'
                                thumb_path = os.path.join(CONFIG['THUMB_DIR'], flat_name)

                                # Thumbnail erstellen
                                generate_thumbnail(full_path, thumb_path)

                                # Metadaten extrahieren
                                timestamp, coords = extract_exif_data(full_path)

                                # Fallback Werte
                                final_ts = timestamp or os.path.getmtime(full_path)
                                lat, lon = coords if coords else (0, 0)
                                loc = get_location_name(lat, lon)

                                conn.execute(
                                    "INSERT INTO photos (filename, lat, lon, timestamp, location) VALUES (?, ?, ?, ?, ?)",
                                    (rel_path, lat, lon, final_ts, loc)
                                )
                                logger.info(f"Neues Foto indexiert: {rel_path}")
                                changes_detected = True

                if changes_detected:
                    conn.commit()

        except Exception as e:
            logger.error(f"Scanner Loop Fehler: {e}")

        # Alle 10 Minuten scannen
        time.sleep(600)


# --- 5. ROUTES & API ---

@app.route('/')
def index():
    # Login-Schutz
    token = request.args.get('token')
    if token == CONFIG['ACCESS_TOKEN']:
        return render_template(
            'index.html',
            token=token,
            visitor_count=track_visitor_count()
        )
    return render_template('login.html', contact_email=CONFIG['CONTACT_EMAIL'])


@app.route('/api/route')
def api_route():
    if request.args.get('token') != CONFIG['ACCESS_TOKEN']: abort(403)

    photos = []
    try:
        with get_db() as conn:
            rows = conn.execute("SELECT * FROM photos ORDER BY timestamp ASC").fetchall()

        for r in rows:
            p = dict(r)
            # Formatierung für Frontend
            p['date_str'] = datetime.fromtimestamp(p['timestamp']).strftime('%d.%m.%Y')
            photos.append(p)
    except Exception as e:
        logger.error(f"API Route Fehler: {e}")
        return jsonify({"error": "DB Error"}), 500

    # Statistik Berechnung
    total_km = 0
    unique_countries = set()
    days = 0

    if photos:
        for i in range(len(photos)):
            # Länder zählen
            loc = photos[i]['location']
            if loc and ',' in loc:
                unique_countries.add(loc.split(',')[-1].strip())

            # Distanz akkumulieren (nur wenn Koordinaten vorhanden)
            if i > 0:
                p1, p2 = photos[i - 1], photos[i]
                if p1['lat'] != 0 and p2['lat'] != 0:
                    total_km += calculate_distance(p1['lat'], p1['lon'], p2['lat'], p2['lon'])

        days = int((photos[-1]['timestamp'] - photos[0]['timestamp']) / 86400) + 1

    return jsonify({
        "stats": {
            "total_km": round(total_km, 1),
            "countries": len(unique_countries),
            "photo_count": len(photos),
            "days": days
        },
        "photos": photos
    })


@app.route('/api/thumb/<path:filename>')
def api_thumb(filename):
    if request.args.get('token') != CONFIG['ACCESS_TOKEN']: abort(403)

    # PATH TRAVERSAL SCHUTZ (Wichtig!)
    base_dir = os.path.abspath(CONFIG['PHOTO_DIR'])
    requested_path = os.path.abspath(os.path.join(base_dir, filename))
    if not os.path.commonpath([base_dir, requested_path]) == base_dir:
        abort(403)

    # 1. Fullscreen Request? -> Originalbild senden
    if request.args.get('size') == 'original':
        if os.path.exists(requested_path):
            return send_file(requested_path)

    # 2. Thumbnail Request
    flat_name = filename.replace('/', '_').replace('\\', '_')
    if not flat_name.lower().endswith('.jpg'): flat_name += '.jpg'
    thumb_path = os.path.join(CONFIG['THUMB_DIR'], flat_name)

    # Wenn Thumbnail existiert, senden
    if os.path.exists(thumb_path):
        return send_file(thumb_path)

    # Fallback: Versuche Original zu senden, wenn kein Thumb da ist
    if os.path.exists(requested_path):
        return send_file(requested_path)

    abort(404)


@app.route('/api/upload', methods=['POST'])
def upload_photo():
    # Admin Token Check
    if request.form.get('admin_token') != CONFIG['ADMIN_TOKEN']:
        return jsonify({'error': 'Ungültiges Passwort'}), 403

    if 'photo' not in request.files:
        return jsonify({'error': 'Keine Datei empfangen'}), 400

    file = request.files['photo']
    if file.filename == '':
        return jsonify({'error': 'Dateiname leer'}), 400

    if file:
        try:
            # Sicherer Dateiname + Timestamp gegen Überschreiben
            filename = secure_filename(file.filename)
            unique_name = f"{int(time.time())}_{filename}"
            save_path = os.path.join(CONFIG['PHOTO_DIR'], unique_name)

            file.save(save_path)
            logger.info(f"Upload gespeichert: {save_path}")

            # Direkt verarbeiten (nicht auf Scanner warten für sofortiges Feedback)
            thumb_path = os.path.join(CONFIG['THUMB_DIR'], unique_name + '.jpg')
            generate_thumbnail(save_path, thumb_path)

            ts, coords = extract_exif_data(save_path)
            final_ts = ts or time.time()
            lat, lon = coords if coords else (0, 0)
            loc = get_location_name(lat, lon)

            # Relativer Pfad für DB (da wir flach im Root speichern)
            rel_path = unique_name

            with get_db() as conn:
                conn.execute(
                    "INSERT INTO photos (filename, lat, lon, timestamp, location) VALUES (?, ?, ?, ?, ?)",
                    (rel_path, lat, lon, final_ts, loc)
                )

            return jsonify({'success': True, 'file': rel_path})

        except Exception as e:
            logger.error(f"Upload Processing Error: {e}")
            return jsonify({'error': str(e)}), 500

    return jsonify({'error': 'Unbekannter Fehler'}), 500


# --- START ---

if __name__ == '__main__':
    # Initialisierung
    init_db()

    # Pre-Load Reverse Geocoder (verhindert Lags beim ersten Upload)
    print("Lade Geodaten...", flush=True)
    rg.search((0, 0))

    # Scanner Thread starten (nur einmal im Main Prozess)
    if os.environ.get("WERKZEUG_RUN_MAIN") == "true" or not app.debug:
        scanner = threading.Thread(target=scan_worker, daemon=True)
        scanner.start()

    app.run(host='0.0.0.0', port=5000, debug=True)
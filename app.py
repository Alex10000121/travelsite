import os
import sqlite3
import threading
import time
import math
import hashlib
from datetime import datetime
from flask import Flask, render_template, request, jsonify, send_file, abort
from PIL import Image, ImageOps
from PIL.ExifTags import TAGS, GPSTAGS
import reverse_geocoder as rg

app = Flask(__name__)

# --- KONFIGURATION ---
PHOTO_DIR = os.environ.get('PHOTO_DIR', './photos')
THUMB_DIR = os.environ.get('THUMB_DIR', './data/thumbs')
DB_PATH = os.environ.get('DB_PATH', './data/trips.db')
ACCESS_TOKEN = os.environ.get('ACCESS_TOKEN', 'geheim123')
CONTACT_EMAIL = os.environ.get('CONTACT_EMAIL', 'deine.email@beispiel.de')

os.makedirs(THUMB_DIR, exist_ok=True)
os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)


# --- HILFSFUNKTIONEN (GEO & MATHE) ---

def calculate_distance(lat1, lon1, lat2, lon2):
    """
    Berechnet die Distanz zwischen zwei Koordinaten (Haversine-Formel).
    Rückgabe in Kilometern.
    """
    R = 6371.0  # Erdradius in km

    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)

    a = math.sin(dlat / 2) ** 2 + \
        math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * \
        math.sin(dlon / 2) ** 2

    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

    return R * c


# --- HILFSFUNKTIONEN (BILD & EXIF) ---

def get_exif_timestamp(path):
    try:
        with Image.open(path) as img:
            exif = img._getexif()
            if not exif: return None
            date_str = exif.get(36867)
            if date_str:
                dt = datetime.strptime(date_str, '%Y:%m:%d %H:%M:%S')
                return dt.timestamp()
    except Exception:
        pass
    return None


def get_decimal_from_dms(dms, ref):
    d = dms[0] + (dms[1] / 60.0) + (dms[2] / 3600.0)
    if ref in ['S', 'W']: d = -d
    return d


def get_exif_gps(path):
    try:
        with Image.open(path) as img:
            exif = img._getexif()
            if not exif: return None
            gps = {}
            for k, v in exif.items():
                if TAGS.get(k) == "GPSInfo":
                    for t in v: gps[GPSTAGS.get(t, t)] = v[t]

            if 'GPSLatitude' in gps:
                lat = get_decimal_from_dms(gps['GPSLatitude'], gps['GPSLatitudeRef'])
                lon = get_decimal_from_dms(gps['GPSLongitude'], gps['GPSLongitudeRef'])
                return (lat, lon)
    except:
        pass
    return None


def get_location_name(lat, lon):
    try:
        results = rg.search((lat, lon))
        if results:
            return f"{results[0]['name']}, {results[0]['cc']}"
    except:
        pass
    return "Unbekannt"


def generate_thumbnail(original_path, thumb_path):
    if os.path.exists(thumb_path):
        return True
    try:
        with Image.open(original_path) as img:
            img = ImageOps.exif_transpose(img)
            if img.mode in ("RGBA", "P"): img = img.convert("RGB")
            img.thumbnail((800, 800))
            img.save(thumb_path, "JPEG", quality=70)
        return True
    except Exception as e:
        print(f"[Thumb Fehler] {original_path}: {e}")
        return False


# --- DATENBANK & TRACKING ---

def init_db():
    """Erstellt alle notwendigen Tabellen beim Start."""
    print("[DB] Initialisiere Datenbank...", flush=True)
    try:
        with sqlite3.connect(DB_PATH) as conn:
            # Tabelle für Fotos
            conn.execute('''CREATE TABLE IF NOT EXISTS photos 
                          (filename TEXT PRIMARY KEY, lat REAL, lon REAL, timestamp REAL, location TEXT)''')

            # Tabelle für Besucher-Statistik
            conn.execute('''CREATE TABLE IF NOT EXISTS global_stats 
                            (key TEXT PRIMARY KEY, value INTEGER)''')
            conn.execute("INSERT OR IGNORE INTO global_stats (key, value) VALUES ('visitor_count', 0)")

            # Temporäre Tabelle für aktive Sessions
            conn.execute('''CREATE TABLE IF NOT EXISTS active_sessions 
                            (hash TEXT PRIMARY KEY, timestamp REAL)''')

        print("[DB] Tabellen erfolgreich initialisiert.", flush=True)
    except Exception as e:
        print(f"[DB Init Error] {e}", flush=True)


def track_visitor_count():
    """
    Zählt Besucher anhand eines anonymisierten Hashes.
    Session-Timeout: 1 Stunde.
    """
    visitor_string = f"{request.remote_addr}-{request.user_agent.string}"
    visitor_hash = hashlib.sha256(visitor_string.encode('utf-8')).hexdigest()
    now = datetime.now().timestamp()
    timeout = 3600

    total_visitors = 0

    try:
        with sqlite3.connect(DB_PATH) as conn:
            # Abgelaufene Sessions bereinigen
            conn.execute("DELETE FROM active_sessions WHERE timestamp < ?", (now - timeout,))

            # Prüfen, ob Besucher bereits aktiv ist
            cursor = conn.execute("SELECT 1 FROM active_sessions WHERE hash = ?", (visitor_hash,))
            if not cursor.fetchone():
                # Neuer Besucher: Eintragen und Zähler erhöhen
                conn.execute("INSERT INTO active_sessions (hash, timestamp) VALUES (?, ?)", (visitor_hash, now))
                conn.execute("UPDATE global_stats SET value = value + 1 WHERE key = 'visitor_count'")
            else:
                # Bekannter Besucher: Zeitstempel aktualisieren
                conn.execute("UPDATE active_sessions SET timestamp = ? WHERE hash = ?", (now, visitor_hash))

            conn.commit()

            # Aktuellen Zählerstand abrufen
            cursor = conn.execute("SELECT value FROM global_stats WHERE key = 'visitor_count'")
            row = cursor.fetchone()
            if row:
                total_visitors = row[0]

    except Exception as e:
        print(f"[Visitor Track Error] {e}")

    return total_visitors


# --- HINTERGRUND-SCANNER ---

def scan_worker():
    print("[Scanner] Lade Geo-Daten...", flush=True)
    rg.search((0, 0))
    abs_photo_dir = os.path.abspath(PHOTO_DIR)
    print(f"[Scanner] Basis-Ordner: {abs_photo_dir}", flush=True)

    while True:
        try:
            with sqlite3.connect(DB_PATH) as conn:
                count = 0
                for root, dirs, files in os.walk(abs_photo_dir):
                    if '@eaDir' in root: continue

                    for file in files:
                        if file.lower().endswith(('.jpg', '.jpeg', '.png', '.heic')):
                            full_path = os.path.join(root, file)
                            rel = os.path.relpath(full_path, abs_photo_dir).replace('\\', '/')
                            if rel.startswith('./'): rel = rel[2:]

                            exists = conn.execute("SELECT 1 FROM photos WHERE filename=?", (rel,)).fetchone()

                            if not exists:
                                flat_name = rel.replace('/', '_')
                                if not flat_name.lower().endswith('.jpg'): flat_name += '.jpg'
                                thumb_path = os.path.join(THUMB_DIR, flat_name)

                                if not os.path.exists(thumb_path):
                                    print(f"[Thumb] Erstelle: {rel}", flush=True)
                                    generate_thumbnail(full_path, thumb_path)

                                coords = get_exif_gps(full_path)
                                if coords:
                                    ts = get_exif_timestamp(full_path)
                                    if not ts: ts = os.path.getmtime(full_path)
                                    loc = get_location_name(coords[0], coords[1])

                                    conn.execute("INSERT OR IGNORE INTO photos VALUES (?, ?, ?, ?, ?)",
                                                 (rel, coords[0], coords[1], ts, loc))
                                    conn.commit()
                                    count += 1
                                    date_readable = datetime.fromtimestamp(ts).strftime('%d.%m.%Y %H:%M')
                                    print(f"[DB] Neu: {rel} ({loc}) am {date_readable}", flush=True)

                if count > 0:
                    print(f"[Scanner] Fertig. {count} neue Fotos.", flush=True)

        except Exception as e:
            print(f"[Scanner Error] {e}", flush=True)

        time.sleep(600)


# --- ROUTEN ---

@app.route('/')
def index():
    req_token = request.args.get('token')

    # Validierung des Zugriffstokens
    if req_token == ACCESS_TOKEN:
        visitor_count = track_visitor_count()
        return render_template('index.html', token=ACCESS_TOKEN, visitor_count=visitor_count)

    # Fallback auf Login-Seite
    return render_template('login.html', contact_email=CONTACT_EMAIL)


@app.route('/api/route')
def api_route():
    if request.args.get('token') != ACCESS_TOKEN: abort(403)

    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute("SELECT * FROM photos ORDER BY timestamp ASC").fetchall()

    photos = [dict(r) for r in rows]

    # --- STATISTIK BERECHNUNG ---
    total_km = 0
    unique_countries = set()
    start_ts = None
    end_ts = None

    if photos:
        start_ts = photos[0]['timestamp']
        end_ts = photos[-1]['timestamp']

        for i in range(len(photos)):
            # Länder anhand des Country-Codes zählen
            loc = photos[i]['location']
            if loc and ',' in loc:
                cc = loc.split(',')[-1].strip()
                unique_countries.add(cc)

            # Distanz zum vorherigen Punkt addieren
            if i > 0:
                prev = photos[i - 1]
                curr = photos[i]
                dist = calculate_distance(prev['lat'], prev['lon'], curr['lat'], curr['lon'])
                total_km += dist

    days = 0
    if start_ts and end_ts:
        days = int((end_ts - start_ts) / 86400) + 1

    response_data = {
        "stats": {
            "total_km": round(total_km, 1),
            "countries": len(unique_countries),
            "photo_count": len(photos),
            "days": days
        },
        "photos": photos
    }

    return jsonify(response_data)


@app.route('/api/thumb/<path:filename>')
def api_thumb(filename):
    if request.args.get('token') != ACCESS_TOKEN: abort(403)

    # Pfade vorbereiten
    safe_base = os.path.abspath(PHOTO_DIR)
    os_filename = filename.replace('/', os.sep).replace('\\', os.sep)
    original_file = os.path.abspath(os.path.join(safe_base, os_filename))

    # --- NEU: Wenn 'original' angefordert wird, sofort das Original senden ---
    if request.args.get('size') == 'original':
        if os.path.exists(original_file) and original_file.startswith(safe_base):
            return send_file(original_file)
    # -------------------------------------------------------------------------

    flat_name = filename.replace('/', '_').replace('\\', '_')
    if not flat_name.lower().endswith('.jpg'): flat_name += '.jpg'

    thumb_path = os.path.join(THUMB_DIR, flat_name)

    if os.path.exists(thumb_path):
        return send_file(thumb_path)

    if os.path.exists(original_file) and original_file.startswith(safe_base):
        return send_file(original_file)

    abort(404)


if __name__ == '__main__':
    # Datenbank initialisieren
    init_db()

    # Scanner im Hintergrund starten
    threading.Thread(target=scan_worker, daemon=True).start()

    print("-" * 50)
    print(f"Server läuft unter: http://127.0.0.1:5000/?token={ACCESS_TOKEN}")
    print("-" * 50)

    app.run(host='0.0.0.0', port=5000)
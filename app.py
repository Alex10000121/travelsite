import os
import sqlite3
import threading
import time
import math
import secrets
from datetime import datetime
from functools import wraps
from flask import Flask, render_template, request, jsonify, send_from_directory, abort, session, redirect, url_for
from PIL import Image, ImageOps
from PIL.ExifTags import TAGS, GPSTAGS
import reverse_geocoder as rg

app = Flask(__name__)

from werkzeug.middleware.proxy_fix import ProxyFix
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_prefix=1)
# --- CONFIG & SICHERHEIT ---
# Generiert einen zufälligen Key für die Session-Verschlüsselung
app.secret_key = os.environ.get('SECRET_KEY', secrets.token_hex(32))

# Pfade für Docker (können über ENV überschrieben werden)
PHOTO_DIR = os.path.abspath(os.environ.get('PHOTO_DIR', '/photos'))
THUMB_DIR = os.path.abspath(os.environ.get('THUMB_DIR', '/data/thumbs'))
DB_PATH = os.path.abspath(os.environ.get('DB_PATH', '/data/trips.db'))

# Zugriff
ACCESS_TOKEN = os.environ.get('ACCESS_TOKEN', 'geheim123')
CONTACT_EMAIL = os.environ.get('CONTACT_EMAIL', 'mail@example.com')

# Ordner erstellen
os.makedirs(THUMB_DIR, exist_ok=True)
os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)


# --- HELPER (MATH & GEO) ---
# Deine originalen Funktionen sind hier wieder vollständig enthalten

def calculate_distance(lat1, lon1, lat2, lon2):
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + \
        math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * \
        math.sin(dlon / 2) ** 2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c


# --- HELPER (IMAGE & EXIF) ---

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


# --- DB HELPER ---

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


# --- SCANNER ---

def scan_worker():
    print("[Scanner] Lade Geo-Daten...", flush=True)
    rg.search((0, 0))  # Warmup
    print(f"[Scanner] Basis-Ordner: {PHOTO_DIR}", flush=True)

    while True:
        try:
            with get_db() as conn:
                # WAL Mode für bessere Performance bei gleichzeitigem Zugriff
                conn.execute("PRAGMA journal_mode=WAL;")
                conn.execute('''CREATE TABLE IF NOT EXISTS photos 
                              (filename TEXT PRIMARY KEY, lat REAL, lon REAL, timestamp REAL, location TEXT)''')
                conn.execute("CREATE INDEX IF NOT EXISTS idx_timestamp ON photos (timestamp ASC)")

                count = 0
                # os.walk folgt jetzt dem globalen PHOTO_DIR
                for root, dirs, files in os.walk(PHOTO_DIR):
                    if '@eaDir' in root: continue

                    for file in files:
                        if file.lower().endswith(('.jpg', '.jpeg', '.png', '.heic')):
                            full_path = os.path.join(root, file)

                            # Relativer Pfad für DB
                            rel = os.path.relpath(full_path, PHOTO_DIR).replace('\\', '/')
                            if rel.startswith('./'): rel = rel[2:]

                            exists = conn.execute("SELECT 1 FROM photos WHERE filename=?", (rel,)).fetchone()

                            if not exists:
                                # Thumbnail Logik
                                flat_name = rel.replace('/', '_')
                                if not flat_name.lower().endswith('.jpg'): flat_name += '.jpg'
                                thumb_path = os.path.join(THUMB_DIR, flat_name)

                                if not os.path.exists(thumb_path):
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
                                    print(f"[DB] Neu: {rel}", flush=True)

                if count > 0:
                    print(f"[Scanner] Fertig. {count} neue Fotos.", flush=True)

        except Exception as e:
            print(f"[Scanner Error] {e}", flush=True)

        time.sleep(600)


# --- SECURITY DECORATOR ---
def login_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        # Prüft, ob das "logged_in" Flag in der Session gesetzt ist
        if not session.get('logged_in'):
            # Wenn nein: Fehler 403 (Forbidden)
            return abort(403)
        return f(*args, **kwargs)

    return decorated_function


# --- ROUTES ---

@app.route('/')
def index():
    # 1. Ist User schon eingeloggt (Cookie)?
    if session.get('logged_in'):
        return render_template('index.html')

    # 2. Kommt User mit Magic Link (?token=...)?
    req_token = request.args.get('token')

    # Sicherer Vergleich des Tokens
    if req_token and secrets.compare_digest(req_token, ACCESS_TOKEN):
        session['logged_in'] = True
        session.permanent = True  # Bleibt bestehen (Standard 31 Tage)

        # Leitet auf "/" um, damit der Token aus der URL verschwindet
        return redirect(url_for('index'))

    # 3. Sonst: Zeige Login-Hinweis (ohne App)
    return render_template('login.html', contact_email=CONTACT_EMAIL)


@app.route('/api/route')
@login_required  # <-- Schützt die Daten API
def api_route():
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM photos ORDER BY timestamp ASC").fetchall()

    photos = [dict(r) for r in rows]

    # --- STATISTIK BERECHNUNG ---
    # (Deine originale Logik, behalten für das Frontend)
    total_km = 0
    unique_countries = set()
    start_ts = None
    end_ts = None
    days = 0

    if photos:
        start_ts = photos[0]['timestamp']
        end_ts = photos[-1]['timestamp']
        days = int((end_ts - start_ts) / 86400) + 1

        for i in range(len(photos)):
            loc = photos[i]['location']
            if loc and ',' in loc:
                cc = loc.split(',')[-1].strip()
                unique_countries.add(cc)

            if i > 0:
                prev = photos[i - 1]
                curr = photos[i]
                dist = calculate_distance(prev['lat'], prev['lon'], curr['lat'], curr['lon'])
                total_km += dist

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
@login_required  # <-- Schützt die Bilder
def api_thumb(filename):
    # --- SICHERHEITS UPDATE: send_from_directory ---
    # Verhindert ../../ Attacken

    flat_name = filename.replace('/', '_').replace('\\', '_')
    if not flat_name.lower().endswith('.jpg'): flat_name += '.jpg'

    # 1. Prüfe Thumbnail im Container-Pfad
    if os.path.exists(os.path.join(THUMB_DIR, flat_name)):
        return send_from_directory(THUMB_DIR, flat_name)

    # 2. Fallback: Originalbild (Langsam, aber funktioniert)
    # Wir müssen hier aufpassen: filename ist z.B. "2024/Italien/bild.jpg"
    # send_from_directory erwartet Ordner und Dateiname getrennt, oder relativen Pfad.
    return send_from_directory(PHOTO_DIR, filename)


# --- START ---

if __name__ == '__main__':
    # Thread starten
    threading.Thread(target=scan_worker, daemon=True).start()

    print("-" * 50)
    print(f"App läuft. Token: {ACCESS_TOKEN}")
    print("-" * 50)

    # app.run nur für lokales Testen. Im Docker übernimmt Gunicorn.
    app.run(host='0.0.0.0', port=5000)
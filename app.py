import os
import sqlite3
import threading
import time
from datetime import datetime
from flask import Flask, render_template, request, jsonify, send_file, abort
from PIL import Image, ImageOps
from PIL.ExifTags import TAGS, GPSTAGS
import reverse_geocoder as rg

app = Flask(__name__)

# --- CONFIG ---
PHOTO_DIR = os.environ.get('PHOTO_DIR', '/photos')
THUMB_DIR = os.environ.get('THUMB_DIR', '/data/thumbs')
DB_PATH = os.environ.get('DB_PATH', '/data/trips.db')
ACCESS_TOKEN = os.environ.get('ACCESS_TOKEN')

os.makedirs(THUMB_DIR, exist_ok=True)


# --- HELPER ---
def get_exif_timestamp(path):
    """Liest das Aufnahmedatum aus den EXIF-Daten"""
    try:
        with Image.open(path) as img:
            exif = img._getexif()
            if not exif: return None

            # Tag 36867 ist "DateTimeOriginal" (Wann wurde der Auslöser gedrückt?)
            # Format ist meistens: "YYYY:MM:DD HH:MM:SS"
            date_str = exif.get(36867)

            if date_str:
                # Wir konvertieren den String in einen Zeitstempel (Zahl)
                dt = datetime.strptime(date_str, '%Y:%m:%d %H:%M:%S')
                return dt.timestamp()
    except Exception as e:
        # print(f"Datum Fehler {path}: {e}")
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
    """Erstellt Thumbnail, falls noch nicht vorhanden"""
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


# --- SCANNER ---

def scan_worker():
    print("[Scanner] Lade Geo-Daten...", flush=True)
    rg.search((0, 0))

    abs_photo_dir = os.path.abspath(PHOTO_DIR)
    print(f"[Scanner] Basis-Ordner: {abs_photo_dir}", flush=True)

    while True:
        try:
            with sqlite3.connect(DB_PATH) as conn:
                conn.execute('''CREATE TABLE IF NOT EXISTS photos 
                              (filename TEXT PRIMARY KEY, lat REAL, lon REAL, timestamp REAL, location TEXT)''')

                count = 0
                for root, dirs, files in os.walk(abs_photo_dir):
                    if '@eaDir' in root: continue

                    for file in files:
                        if file.lower().endswith(('.jpg', '.jpeg', '.png', '.heic')):
                            full_path = os.path.join(root, file)

                            # Pfad normalisieren
                            rel = os.path.relpath(full_path, abs_photo_dir).replace('\\', '/')
                            if rel.startswith('./'): rel = rel[2:]

                            # DB Check (Sparen uns die Arbeit, wenn schon bekannt)
                            exists = conn.execute("SELECT 1 FROM photos WHERE filename=?", (rel,)).fetchone()

                            if not exists:
                                # Thumb Pfad berechnen
                                flat_name = rel.replace('/', '_')
                                if not flat_name.lower().endswith('.jpg'): flat_name += '.jpg'
                                thumb_path = os.path.join(THUMB_DIR, flat_name)

                                # Thumb erstellen
                                if not os.path.exists(thumb_path):
                                    print(f"[Thumb] Erstelle: {rel}", flush=True)
                                    generate_thumbnail(full_path, thumb_path)

                                # GPS holen
                                coords = get_exif_gps(full_path)
                                if coords:
                                    # --- NEU: DATUM LOGIK ---
                                    # 1. Versuche echtes Aufnahmedatum
                                    ts = get_exif_timestamp(full_path)

                                    # 2. Fallback: Datei-Datum (falls EXIF Datum fehlt)
                                    if not ts:
                                        ts = os.path.getmtime(full_path)

                                    loc = get_location_name(coords[0], coords[1])

                                    conn.execute("INSERT OR IGNORE INTO photos VALUES (?, ?, ?, ?, ?)",
                                                 (rel, coords[0], coords[1], ts, loc))
                                    conn.commit()
                                    count += 1

                                    # Kleines Debug, damit du das Datum siehst
                                    date_readable = datetime.fromtimestamp(ts).strftime('%d.%m.%Y %H:%M')
                                    print(f"[DB] Neu: {rel} ({loc}) am {date_readable}", flush=True)

                if count > 0:
                    print(f"[Scanner] Fertig. {count} neue Fotos.", flush=True)

        except Exception as e:
            print(f"[Scanner Error] {e}", flush=True)

        time.sleep(600)

# --- ROUTES ---

@app.route('/')
def index():
    if request.args.get('token') != ACCESS_TOKEN: abort(403)
    return render_template('index.html', token=request.args.get('token'))


@app.route('/api/route')
def api_route():
    # Token prüfen
    if request.args.get('token') != ACCESS_TOKEN: abort(403)

    # Datenbank abfragen
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute("SELECT * FROM photos ORDER BY timestamp ASC").fetchall()

    # Ergebnis als JSON senden
    return jsonify([dict(r) for r in rows])


@app.route('/api/thumb/<path:filename>')
def api_thumb(filename):
    if request.args.get('token') != ACCESS_TOKEN: abort(403)

    # --- STRATEGIE 1: THUMBNAIL SUCHEN ---
    # Wir bauen den "flachen" Namen nach: folder_file.jpg
    flat_name = filename.replace('/', '_').replace('\\', '_')
    if not flat_name.lower().endswith('.jpg'): flat_name += '.jpg'

    thumb_path = os.path.join(THUMB_DIR, flat_name)

    if os.path.exists(thumb_path):
        return send_file(thumb_path)

    # --- STRATEGIE 2: ORIGINAL SUCHEN (Fallback) ---
    safe_base = os.path.abspath(PHOTO_DIR)

    # Windows braucht Backslashes für echte Dateipfade
    os_filename = filename.replace('/', os.sep).replace('\\', os.sep)
    original_file = os.path.abspath(os.path.join(safe_base, os_filename))

    if os.path.exists(original_file) and original_file.startswith(safe_base):
        return send_file(original_file)

    # Wenn beides nicht geht:
    print(f"[404] Bild nicht gefunden. Suche Thumb: {thumb_path} | Suche Orig: {original_file}")
    abort(404)


if __name__ == '__main__':
    threading.Thread(target=scan_worker, daemon=True).start()
    print("-" * 50)
    print(f"Klicke hier zum Starten: http://127.0.0.1:5000/?token={ACCESS_TOKEN}")
    print("-" * 50)

    app.run(host='0.0.0.0', port=5000)


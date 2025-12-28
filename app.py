import os
import sqlite3
import threading
import time
import math
import hashlib
import logging
from datetime import datetime
from multiprocessing import current_process

from flask import Flask, render_template, request, jsonify, send_file, abort
from PIL import Image, ImageOps
from PIL.ExifTags import TAGS, GPSTAGS
import reverse_geocoder as rg
from werkzeug.utils import secure_filename

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

app = Flask(__name__)

CONFIG = {
    'PHOTO_DIR': os.environ.get('PHOTO_DIR', './photos'),
    'THUMB_DIR': os.environ.get('THUMB_DIR', './data/thumbs'),
    'DB_PATH': os.environ.get('DB_PATH', './data/trips.db'),
    'ACCESS_TOKEN': os.environ.get('ACCESS_TOKEN', 'geheim123'),
    'ADMIN_TOKEN': os.environ.get('ADMIN_TOKEN', 'admin_geheim'),
    'CONTACT_EMAIL': os.environ.get('CONTACT_EMAIL', 'deine.email@beispiel.de')
}

os.makedirs(CONFIG['THUMB_DIR'], exist_ok=True)
os.makedirs(os.path.dirname(CONFIG['DB_PATH']), exist_ok=True)


def calculate_distance(lat1, lon1, lat2, lon2):
    try:
        R = 6371.0
        dlat = math.radians(lat2 - lat1)
        dlon = math.radians(lon2 - lon1)
        a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(
            dlon / 2) ** 2
        c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
        return R * c
    except Exception:
        return 0


def get_decimal_from_dms(dms, ref):
    degrees = dms[0] + (dms[1] / 60.0) + (dms[2] / 3600.0)
    if ref in ['S', 'W']:
        degrees = -degrees
    return degrees


def extract_exif_data(image_path):
    timestamp = None
    coords = None

    try:
        with Image.open(image_path) as img:
            exif = img._getexif()
            if not exif:
                return None, None

            date_str = exif.get(36867)
            if date_str:
                try:
                    dt = datetime.strptime(date_str, '%Y:%m:%d %H:%M:%S')
                    timestamp = dt.timestamp()
                except ValueError:
                    pass

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
        logger.warning(f"EXIF read error: {image_path}: {e}")

    return timestamp, coords


def get_location_name(lat, lon):
    if not lat or not lon: return "Unbekannt"
    try:
        results = rg.search((lat, lon))
        if results:
            return f"{results[0]['name']}, {results[0]['cc']}"
    except Exception:
        pass
    return "Unbekannt"


def generate_thumbnail(original_path, thumb_path):
    if os.path.exists(thumb_path):
        return True

    try:
        with Image.open(original_path) as img:
            img = ImageOps.exif_transpose(img)

            if img.mode in ("RGBA", "P"):
                img = img.convert("RGB")

            img.thumbnail((800, 800))
            img.save(thumb_path, "JPEG", quality=70, optimize=True)
        return True
    except Exception as e:
        logger.error(f"Thumbnail generation error {original_path}: {e}")
        return False


def get_db():
    conn = sqlite3.connect(CONFIG['DB_PATH'])
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
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
        logger.info("Database initialized.")
    except Exception as e:
        logger.critical(f"Database init failed: {e}")


def track_visitor_count():
    visitor_hash = hashlib.sha256(f"{request.remote_addr}-{request.user_agent.string}".encode('utf-8')).hexdigest()
    now = time.time()
    total = 0

    try:
        with get_db() as conn:
            conn.execute("DELETE FROM active_sessions WHERE timestamp < ?", (now - 3600,))

            cursor = conn.execute("SELECT 1 FROM active_sessions WHERE hash = ?", (visitor_hash,))
            if not cursor.fetchone():
                conn.execute("INSERT INTO active_sessions (hash, timestamp) VALUES (?, ?)", (visitor_hash, now))
                conn.execute("UPDATE global_stats SET value = value + 1 WHERE key = 'visitor_count'")
            else:
                conn.execute("UPDATE active_sessions SET timestamp = ? WHERE hash = ?", (now, visitor_hash))

            conn.commit()

            row = conn.execute("SELECT value FROM global_stats WHERE key = 'visitor_count'").fetchone()
            if row: total = row['value']
    except Exception as e:
        logger.error(f"Visitor tracking error: {e}")

    return total


def scan_worker():
    time.sleep(3)
    logger.info("Scanner started.")

    abs_photo_dir = os.path.abspath(CONFIG['PHOTO_DIR'])

    while True:
        try:
            changes_detected = False
            with get_db() as conn:
                for root, dirs, files in os.walk(abs_photo_dir):
                    if '@eaDir' in root: continue

                    for file in files:
                        if file.lower().endswith(('.jpg', '.jpeg', '.png', '.heic')):
                            full_path = os.path.join(root, file)

                            rel_path = os.path.relpath(full_path, abs_photo_dir).replace('\\', '/')
                            if rel_path.startswith('./'): rel_path = rel_path[2:]

                            exists = conn.execute("SELECT 1 FROM photos WHERE filename=?", (rel_path,)).fetchone()

                            if not exists:
                                flat_name = rel_path.replace('/', '_').replace('\\', '_')
                                if not flat_name.lower().endswith('.jpg'): flat_name += '.jpg'
                                thumb_path = os.path.join(CONFIG['THUMB_DIR'], flat_name)

                                generate_thumbnail(full_path, thumb_path)
                                timestamp, coords = extract_exif_data(full_path)

                                final_ts = timestamp or os.path.getmtime(full_path)
                                lat, lon = coords if coords else (0, 0)
                                loc = get_location_name(lat, lon)

                                conn.execute(
                                    "INSERT INTO photos (filename, lat, lon, timestamp, location) VALUES (?, ?, ?, ?, ?)",
                                    (rel_path, lat, lon, final_ts, loc)
                                )
                                logger.info(f"Indexed: {rel_path} (GPS: {lat}, {lon})")
                                changes_detected = True

                if changes_detected: conn.commit()

        except Exception as e:
            logger.error(f"Scanner loop error: {e}")

        time.sleep(600)


@app.route('/')
def index():
    token = request.args.get('token')
    if token == CONFIG['ACCESS_TOKEN']:
        return render_template('index.html', token=token, visitor_count=track_visitor_count())
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
            p['date_str'] = datetime.fromtimestamp(p['timestamp']).strftime('%d.%m.%Y')
            photos.append(p)
    except Exception as e:
        logger.error(f"API Route error: {e}")
        return jsonify({"error": "DB Error"}), 500

    total_km = 0
    unique_countries = set()
    days = 0

    if photos:
        for i in range(len(photos)):
            loc = photos[i]['location']
            if loc and ',' in loc:
                unique_countries.add(loc.split(',')[-1].strip())

            if i > 0:
                p1, p2 = photos[i - 1], photos[i]

                lat1, lon1 = p1.get('lat'), p1.get('lon')
                lat2, lon2 = p2.get('lat'), p2.get('lon')

                if (lat1 is not None and lon1 is not None and
                        lat2 is not None and lon2 is not None):

                    if lat1 != 0 and lat2 != 0:
                        total_km += calculate_distance(lat1, lon1, lat2, lon2)

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

    base_dir = os.path.abspath(CONFIG['PHOTO_DIR'])
    requested_path = os.path.abspath(os.path.join(base_dir, filename))
    if not os.path.commonpath([base_dir, requested_path]) == base_dir: abort(403)

    if request.args.get('size') == 'original':
        if os.path.exists(requested_path):
            return send_file(requested_path)

    flat_name = filename.replace('/', '_').replace('\\', '_')
    if not flat_name.lower().endswith('.jpg'): flat_name += '.jpg'
    thumb_path = os.path.join(CONFIG['THUMB_DIR'], flat_name)

    if os.path.exists(thumb_path): return send_file(thumb_path)
    if os.path.exists(requested_path): return send_file(requested_path)
    abort(404)


@app.route('/api/upload', methods=['POST'])
def upload_photo():
    if request.form.get('admin_token') != CONFIG['ADMIN_TOKEN']:
        return jsonify({'error': 'Invalid Password'}), 403

    if 'photo' not in request.files: return jsonify({'error': 'No file'}), 400
    file = request.files['photo']
    if file.filename == '': return jsonify({'error': 'Empty filename'}), 400

    try:
        filename = secure_filename(file.filename)
        unique_name = f"{int(time.time())}_{filename}"
        save_path = os.path.join(CONFIG['PHOTO_DIR'], unique_name)
        file.save(save_path)

        thumb_path = os.path.join(CONFIG['THUMB_DIR'], unique_name + '.jpg')
        generate_thumbnail(save_path, thumb_path)

        ts, coords = extract_exif_data(save_path)

        if coords:
            logger.info(f"EXIF: GPS found for {filename}: {coords}")
        else:
            logger.warning(f"EXIF: NO GPS for {filename}")

        final_ts = ts or time.time()
        lat, lon = coords if coords else (0, 0)
        loc = get_location_name(lat, lon)

        with get_db() as conn:
            conn.execute(
                "INSERT INTO photos (filename, lat, lon, timestamp, location) VALUES (?, ?, ?, ?, ?)",
                (unique_name, lat, lon, final_ts, loc)
            )

        return jsonify({'success': True, 'file': unique_name})

    except Exception as e:
        logger.error(f"Upload error: {e}")
        return jsonify({'error': str(e)}), 500


# --- BACKGROUND SERVICES ---

def start_background_services():
    """Initializes DB and starts background threads. Should only run in MainProcess."""
    init_db()

    # Preload Geocoder to avoid lag on first upload
    # This might still trigger multiprocessing, but since we are inside the guard, it's safer
    rg.search((0, 0))

    threading.Thread(target=scan_worker, daemon=True).start()


# --- STARTUP LOGIC ---

if __name__ == '__main__':
    # Local Development
    print("Starting local...", flush=True)
    start_background_services()
    app.run(host='0.0.0.0', port=5000, debug=True)

elif current_process().name == 'MainProcess':
    # Docker / Gunicorn Production
    # Only run this if we are the Gunicorn Worker, NOT the Reverse Geocoder Child Process
    start_background_services()
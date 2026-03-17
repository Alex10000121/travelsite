import os
import sqlite3
import threading
import time
import math
import hashlib
import logging
from datetime import datetime

from flask import Flask, render_template, request, jsonify, send_file, abort
from PIL import Image, ImageOps
from PIL.ExifTags import TAGS, GPSTAGS
import reverse_geocoder as rg
from werkzeug.utils import secure_filename
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

# Logging Konfiguration
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

app = Flask(__name__)

# Konfiguration
CONFIG = {
    'PHOTO_DIR': os.environ.get('PHOTO_DIR', './photos'),
    'THUMB_DIR': os.environ.get('THUMB_DIR', './data/thumbs'),
    'DB_PATH': os.environ.get('DB_PATH', './data/trips.db'),
    'ACCESS_TOKEN': os.environ.get('ACCESS_TOKEN', 'geheim123'),
    'ADMIN_TOKEN': os.environ.get('ADMIN_TOKEN', 'admin_geheim'),
    'CONTACT_EMAIL': os.environ.get('CONTACT_EMAIL', 'deine.email@beispiel.de')
}

SUPPORTED_EXTENSIONS = ('.jpg', '.jpeg', '.png', '.heic')

os.makedirs(CONFIG['THUMB_DIR'], exist_ok=True)
os.makedirs(os.path.dirname(CONFIG['DB_PATH']), exist_ok=True)


# --- HELFER FUNKTIONEN ---

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
            exif = img.getexif()
            if not exif:
                return None, None

            date_str = exif.get(36867)
            if date_str:
                try:
                    dt = datetime.strptime(date_str, '%Y:%m:%d %H:%M:%S')
                    timestamp = dt.timestamp()
                except ValueError:
                    pass

            gps_info = {GPSTAGS.get(t, t): v for t, v in exif.get_ifd(0x8825).items()}

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


# --- DB ---

def get_db():
    conn = sqlite3.connect(CONFIG['DB_PATH'], timeout=20)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
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


# --- WORKER ---

def index_photo(full_path, abs_photo_dir):
    if '@eaDir' in full_path:
        return
    if not full_path.lower().endswith(SUPPORTED_EXTENSIONS):
        return

    rel_path = os.path.relpath(full_path, abs_photo_dir).replace('\\', '/')
    if rel_path.startswith('./'):
        rel_path = rel_path[2:]

    try:
        with get_db() as conn:
            if conn.execute("SELECT 1 FROM photos WHERE filename=?", (rel_path,)).fetchone():
                return

            flat_name = rel_path.replace('/', '_').replace('\\', '_')
            if not flat_name.lower().endswith('.jpg'):
                flat_name += '.jpg'
            thumb_path = os.path.join(CONFIG['THUMB_DIR'], flat_name)

            timestamp, coords = extract_exif_data(full_path)

            if not coords:
                no_gps_dir = os.path.join(abs_photo_dir, 'no_gps')
                os.makedirs(no_gps_dir, exist_ok=True)
                dest = os.path.join(no_gps_dir, os.path.basename(full_path))
                os.replace(full_path, dest)
                logger.info(f"Moved to no_gps: {os.path.basename(full_path)}")
                return

            lat, lon = coords
            loc = get_location_name(lat, lon)
            final_ts = timestamp or os.path.getmtime(full_path)

            generate_thumbnail(full_path, thumb_path)

            cursor = conn.execute(
                "INSERT OR IGNORE INTO photos (filename, lat, lon, timestamp, location) VALUES (?, ?, ?, ?, ?)",
                (rel_path, lat, lon, final_ts, loc)
            )
            conn.commit()
            if cursor.rowcount:
                logger.info(f"Indexed: {rel_path} (GPS: {lat}, {lon})")
    except Exception as e:
        logger.error(f"Indexing error for {full_path}: {e}")


def wait_for_file(path, retries=10, delay=0.5):
    for _ in range(retries):
        try:
            with open(path, 'rb'):
                return True
        except OSError:
            time.sleep(delay)
    logger.warning(f"File not accessible after {retries} retries: {path}")
    return False


class PhotoEventHandler(FileSystemEventHandler):
    def __init__(self, abs_photo_dir):
        self.abs_photo_dir = abs_photo_dir
        self._pending = {}
        self._lock = threading.Lock()

    def _schedule(self, path):
        with self._lock:
            existing = self._pending.pop(path, None)
            if existing:
                existing.cancel()
            timer = threading.Timer(2.0, self._process, args=(path,))
            self._pending[path] = timer
            timer.start()

    def _process(self, path):
        with self._lock:
            self._pending.pop(path, None)
        if wait_for_file(path):
            index_photo(path, self.abs_photo_dir)

    def on_created(self, event):
        if not event.is_directory:
            self._schedule(event.src_path)

    def on_modified(self, event):
        if not event.is_directory:
            self._schedule(event.src_path)

    def on_moved(self, event):
        if not event.is_directory:
            self._schedule(event.dest_path)


def initial_scan(abs_photo_dir):
    logger.info("Initial scan started.")
    for root, dirs, files in os.walk(abs_photo_dir):
        if '@eaDir' in root:
            continue
        for file in files:
            index_photo(os.path.join(root, file), abs_photo_dir)
    logger.info("Initial scan complete.")


# --- ROUTES ---

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

                if (lat1 is not None and lon1 is not None and lat2 is not None and lon2 is not None):
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
        if os.path.exists(requested_path): return send_file(requested_path)

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

        ts, coords = extract_exif_data(save_path)

        # --- GPS CHECK ---
        lat, lon = None, None
        loc = "Kein Standort"
        missing_gps = True  # Standardmäßig annehmen, dass GPS fehlt

        if coords and not math.isnan(coords[0]) and not math.isnan(coords[1]):
            lat, lon = coords
            loc = get_location_name(lat, lon)
            missing_gps = False
            logger.info(f"EXIF: GPS gefunden für {filename}")
        else:
            logger.info(f"EXIF: Kein GPS für {filename}")

        thumb_path = os.path.join(CONFIG['THUMB_DIR'], unique_name + '.jpg')
        generate_thumbnail(save_path, thumb_path)

        final_ts = ts or time.time()

        with get_db() as conn:
            conn.execute(
                "INSERT INTO photos (filename, lat, lon, timestamp, location) VALUES (?, ?, ?, ?, ?)",
                (unique_name, lat, lon, final_ts, loc)
            )

        return jsonify({'success': True, 'file': unique_name, 'missing_gps': missing_gps})

    except Exception as e:
        if 'save_path' in locals() and os.path.exists(save_path): os.remove(save_path)
        logger.error(f"Upload error: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/update_location', methods=['POST'])
def update_location():
    data = request.json
    if data.get('admin_token') != CONFIG['ADMIN_TOKEN']:
        return jsonify({'error': 'Falsches Passwort'}), 403

    filename = data.get('filename')
    lat = data.get('lat')
    lon = data.get('lon')

    if not filename or lat is None or lon is None:
        return jsonify({'error': 'Daten fehlen'}), 400

    try:
        new_loc = get_location_name(lat, lon)
        with get_db() as conn:
            conn.execute("UPDATE photos SET lat = ?, lon = ?, location = ? WHERE filename = ?",
                         (lat, lon, new_loc, filename))

        logger.info(f"Location update for {filename}: {new_loc}")
        return jsonify({'success': True, 'location': new_loc})

    except Exception as e:
        logger.error(f"Update location error: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/delete', methods=['POST'])
def delete_photo():
    data = request.json
    if data.get('admin_token') != CONFIG['ADMIN_TOKEN']:
        return jsonify({'error': 'Falsches Passwort'}), 403

    filename = data.get('filename')
    if not filename: return jsonify({'error': 'Kein Dateiname'}), 400

    try:

        base_dir = os.path.abspath(CONFIG['PHOTO_DIR'])
        file_path = os.path.abspath(os.path.join(base_dir, filename))


        if not os.path.commonpath([base_dir, file_path]) == base_dir: abort(403)


        flat_name = filename.replace('/', '_').replace('\\', '_')
        if not flat_name.lower().endswith('.jpg'): flat_name += '.jpg'
        thumb_path = os.path.join(CONFIG['THUMB_DIR'], flat_name)


        if os.path.exists(file_path): os.remove(file_path)
        if os.path.exists(thumb_path): os.remove(thumb_path)


        with get_db() as conn:
            conn.execute("DELETE FROM photos WHERE filename=?", (filename,))

        logger.info(f"Deleted photo: {filename}")
        return jsonify({'success': True})

    except Exception as e:
        logger.error(f"Delete error: {e}")
        return jsonify({'error': str(e)}), 500
@app.route('/api/check_login', methods=['POST'])
def check_login():
    data = request.json
    # Wir prüfen einfach, ob das gesendete Passwort mit dem Admin-Token übereinstimmt
    if data.get('admin_token') == CONFIG['ADMIN_TOKEN']:
        return jsonify({'success': True})
    return jsonify({'error': 'Wrong password'}), 403

def start_background_services():
    init_db()
    rg.search((0, 0))

    abs_photo_dir = os.path.abspath(CONFIG['PHOTO_DIR'])
    os.makedirs(abs_photo_dir, exist_ok=True)

    threading.Thread(target=initial_scan, args=(abs_photo_dir,), daemon=True).start()

    event_handler = PhotoEventHandler(abs_photo_dir)
    observer = Observer()
    observer.schedule(event_handler, abs_photo_dir, recursive=True)
    observer.daemon = True
    observer.start()
    logger.info(f"Watching {abs_photo_dir} for new photos.")


if __name__ == '__main__':
    print("Starting local...", flush=True)
    start_background_services()
    app.run(host='0.0.0.0', port=5000, debug=True)

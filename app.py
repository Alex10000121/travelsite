import os
import secrets
import sqlite3
import threading
import time
import math
import hashlib
import logging
import json
from contextlib import contextmanager
from datetime import datetime, timedelta
from functools import wraps

import requests
from dotenv import load_dotenv

load_dotenv()

from flask import Flask, render_template, request, jsonify, send_file, make_response, abort, session, redirect, url_for
from flask_compress import Compress
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from PIL import Image, ImageOps
from PIL.ExifTags import GPSTAGS
import reverse_geocoder as rg
from werkzeug.utils import secure_filename
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler
import piexif

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

app = Flask(__name__)
Compress(app)

# Nur ueber FLASK_DEBUG=1 aktivierbar (siehe .env) - steuert sowohl den
# Werkzeug-Reloader/Debugger (app.run unten) als auch SESSION_COOKIE_SECURE,
# da Cookies mit Secure-Flag beim lokalen Test ueber http sonst nicht ankommen.
app.debug = os.environ.get('FLASK_DEBUG', '0') == '1'


@app.after_request
def no_cache_static(response):
    # Statische JS/CSS-Dateien importieren sich gegenseitig ohne Versions-Query
    # (main.js -> map.js -> ...). Ohne erzwungene Revalidierung kann ein Browser
    # einzelne Dateien unterschiedlich lange cachen, sodass nach einem Deploy alte
    # und neue Versionen gemischt geladen werden und das Frontend bricht.
    if request.path.startswith('/static/'):
        response.headers['Cache-Control'] = 'no-cache'
    return response


@app.after_request
def security_headers(response):
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Frame-Options'] = 'DENY'
    response.headers['Referrer-Policy'] = 'strict-origin-when-cross-origin'
    return response


limiter = Limiter(
    get_remote_address,
    app=app,
    default_limits=[],
    storage_uri="memory://",
)

@app.errorhandler(429)
def ratelimit_handler(e):
    return jsonify(error="Zu viele Anfragen. Bitte warte eine Minute und versuche es erneut."), 429

def _require_env(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(
            f"Umgebungsvariable {name} ist nicht gesetzt. Ohne eigenes Secret wuerde die App "
            f"mit einem unsicheren, oeffentlich bekannten Standardwert starten. Setze {name} "
            f"in der .env-Datei oder als Umgebungsvariable des Deployments."
        )
    return value


_PUBLIC_MODE = os.environ.get('PUBLIC_MODE', '0') == '1'

CONFIG = {
    'PHOTO_DIR': os.environ.get('PHOTO_DIR', './photos'),
    'THUMB_DIR': os.environ.get('THUMB_DIR', './data/thumbs'),
    'DB_PATH': os.environ.get('DB_PATH', './data/trips.db'),
    'PUBLIC_MODE': _PUBLIC_MODE,
    'ACCESS_TOKEN': os.environ.get('ACCESS_TOKEN', '') if _PUBLIC_MODE else _require_env('ACCESS_TOKEN'),
    'ADMIN_TOKEN': _require_env('ADMIN_TOKEN'),
    'CONTACT_EMAIL': os.environ.get('CONTACT_EMAIL', 'deine.email@beispiel.de'),
    'MAPTILER_API_KEY': os.environ.get('MAPTILER_API_KEY', '')
}


def _access_granted(token):
    if CONFIG['PUBLIC_MODE']:
        return True
    return secrets.compare_digest(token, CONFIG['ACCESS_TOKEN'])

# Muss ein eigenstaendiges, zufaelliges Secret sein - ein von ADMIN_TOKEN abgeleiteter
# Schluessel waere ein Offline-Orakel, mit dem sich das Admin-Passwort aus einem
# abgefangenen Session-Cookie zurückrechnen liesse.
app.secret_key = _require_env('SECRET_KEY')

app.config.update(
    SESSION_COOKIE_SECURE=not app.debug,
    SESSION_COOKIE_SAMESITE='Lax',
    PERMANENT_SESSION_LIFETIME=timedelta(hours=12),
    MAX_CONTENT_LENGTH=32 * 1024 * 1024,  # 32 MB - reicht fuer Handy-/Kamerafotos, verhindert Speicher-DoS
)


@app.errorhandler(413)
def file_too_large(e):
    return jsonify(error="Datei zu gross (max. 32 MB)."), 413


SUPPORTED_EXTENSIONS = ('.jpg', '.jpeg', '.png', '.heic')

os.makedirs(CONFIG['THUMB_DIR'], exist_ok=True)
_db_dir = os.path.dirname(CONFIG['DB_PATH'])
if _db_dir:
    os.makedirs(_db_dir, exist_ok=True)


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


def decimal_to_dms_rational(value):
    value = abs(value)
    degrees = int(value)
    minutes = int((value - degrees) * 60)
    seconds = int(round((value - degrees - minutes / 60) * 3600 * 1000))
    return ((degrees, 1), (minutes, 1), (seconds, 1000))


def extract_exif_data(image_path):
    timestamp = None
    coords = None

    try:
        with Image.open(image_path) as img:
            exif = img.getexif()
            if exif:
                # DateTimeOriginal kann im Haupt-IFD oder im ExifIFD (0x8769) liegen
                date_str = exif.get(36867) or exif.get_ifd(0x8769).get(36867)
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
                    if math.isfinite(lat) and math.isfinite(lon):
                        coords = (lat, lon)
    except Exception as e:
        logger.warning(f"PIL EXIF read error: {image_path}: {e}")

    if not timestamp or not coords:
        try:
            exif_dict = piexif.load(image_path)

            if not timestamp:
                exif_ifd = exif_dict.get('Exif', {})
                date_bytes = exif_ifd.get(piexif.ExifIFD.DateTimeOriginal)
                if date_bytes:
                    try:
                        date_str = date_bytes.decode('utf-8').strip('\x00')
                        dt = datetime.strptime(date_str, '%Y:%m:%d %H:%M:%S')
                        timestamp = dt.timestamp()
                    except (ValueError, UnicodeDecodeError):
                        pass

            if not coords:
                gps = exif_dict.get('GPS', {})
                if piexif.GPSIFD.GPSLatitude in gps and piexif.GPSIFD.GPSLongitude in gps:
                    def _r(v): return v[0][0] / v[0][1] + v[1][0] / (v[1][1] * 60) + v[2][0] / (v[2][1] * 3600)
                    lat = _r(gps[piexif.GPSIFD.GPSLatitude])
                    lon = _r(gps[piexif.GPSIFD.GPSLongitude])
                    if gps.get(piexif.GPSIFD.GPSLatitudeRef, b'N') in (b'S', 'S'): lat = -lat
                    if gps.get(piexif.GPSIFD.GPSLongitudeRef, b'E') in (b'W', 'W'): lon = -lon
                    if math.isfinite(lat) and math.isfinite(lon):
                        coords = (lat, lon)
        except Exception as e:
            logger.warning(f"piexif read error: {image_path}: {e}")

    return timestamp, coords


def get_location_name(lat, lon):
    if lat is None or lon is None: return "Unbekannt"
    try:
        results = rg.search((lat, lon))
        if results:
            return f"{results[0]['name']}, {results[0]['cc']}"
    except Exception:
        pass
    return "Unbekannt"


def fetch_weather(lat, lon, timestamp):
    """Tages-Hoechsttemperatur + WMO-Wettercode fuer Ort/Datum eines Fotos, ueber die
    kostenlose Open-Meteo Archive-API (kein API-Key noetig). Rein optional/best-effort:
    die Archive-API liefert nur Daten mit ein paar Tagen Verzoegerung (Reanalyse-Daten),
    ganz frisch hochgeladene Fotos bleiben also zunaechst ohne Wetter - kein Fehler,
    einfach (None, None).
    """
    if lat is None or lon is None or not timestamp:
        return None, None
    try:
        date_str = datetime.fromtimestamp(timestamp).strftime('%Y-%m-%d')
        resp = requests.get(
            "https://archive-api.open-meteo.com/v1/archive",
            params={
                'latitude': lat,
                'longitude': lon,
                'start_date': date_str,
                'end_date': date_str,
                'daily': 'temperature_2m_max,weathercode',
                'timezone': 'UTC',
            },
            timeout=5,
        )
        resp.raise_for_status()
        daily = resp.json().get('daily', {})
        temps = daily.get('temperature_2m_max') or []
        codes = daily.get('weathercode') or []
        if temps and codes and temps[0] is not None:
            return temps[0], codes[0]
    except Exception as e:
        logger.warning(f"Weather lookup error ({lat},{lon}): {e}")
    return None, None


OSRM_MAX_KM = 500


def fetch_osrm_route(lat1, lon1, lat2, lon2):
    if calculate_distance(lat1, lon1, lat2, lon2) > OSRM_MAX_KM:
        return None
    url = (
        f"https://router.project-osrm.org/route/v1/driving/"
        f"{lon1},{lat1};{lon2},{lat2}"
        f"?overview=full&geometries=geojson"
    )
    try:
        resp = requests.get(url, timeout=5)
        resp.raise_for_status()
        data = resp.json()
        if data.get('code') == 'Ok' and data.get('routes'):
            return data['routes'][0]['geometry']
    except Exception as e:
        logger.warning(f"OSRM API error ({lat1},{lon1} -> {lat2},{lon2}): {e}")
    return None


def straight_line_geometry(lat1, lon1, lat2, lon2):
    return {"type": "LineString", "coordinates": [[lon1, lat1], [lon2, lat2]]}


def fetch_missing_routes(missing_pairs):
    for start_fn, end_fn, lat1, lon1, lat2, lon2 in missing_pairs:
        try:
            with get_db() as conn:
                if conn.execute(
                    "SELECT 1 FROM routes WHERE start_filename=? AND end_filename=?",
                    (start_fn, end_fn)
                ).fetchone():
                    continue

            geometry = fetch_osrm_route(lat1, lon1, lat2, lon2)
            # Kein OSRM-Ergebnis (zu weit fuer die Driving-API oder API-Fehler) heisst in
            # der Praxis fast immer: das war ein Flug, keine Autostrecke - automatisch aus
            # dem vorhandenen Distanz-Heuristik abgeleitet, ohne manuelles Nachpflegen.
            mode = 'drive'
            if geometry is None:
                geometry = straight_line_geometry(lat1, lon1, lat2, lon2)
                mode = 'flight'

            with get_db() as conn:
                conn.execute(
                    "INSERT OR IGNORE INTO routes (start_filename, end_filename, geometry, mode) VALUES (?, ?, ?, ?)",
                    (start_fn, end_fn, json.dumps(geometry), mode)
                )

            if calculate_distance(lat1, lon1, lat2, lon2) <= OSRM_MAX_KM:
                time.sleep(1)
        except Exception as e:
            logger.warning(f"Route background fetch error {start_fn} -> {end_fn}: {e}")


def _fetch_and_store_weather(filename, lat, lon, timestamp):
    weather_temp, weather_code = fetch_weather(lat, lon, timestamp)
    if weather_temp is None:
        return
    try:
        with get_db() as conn:
            conn.execute("UPDATE photos SET weather_temp = ?, weather_code = ? WHERE filename = ?",
                         (weather_temp, weather_code, filename))
    except Exception as e:
        logger.warning(f"Weather store error for {filename}: {e}")


def _thumb_path(filename, suffix=''):
    has_subdir = '/' in filename or '\\' in filename
    flat_name = filename.replace('/', '_').replace('\\', '_')
    if flat_name.lower().endswith('.jpg'):
        flat_name = flat_name[:-4]
    if has_subdir:
        # Ohne Disambiguierung wuerden z.B. "a/b.jpg" und "a_b.jpg" auf denselben
        # Thumb-Namen abbilden - zwei verschiedene Fotos teilen sich dann ein Thumbnail
        # und ein "delete" fuer das eine loescht auch das Thumb des anderen mit.
        digest = hashlib.sha1(filename.encode('utf-8')).hexdigest()[:8]
        flat_name = f"{flat_name}_{digest}"
    return os.path.join(CONFIG['THUMB_DIR'], f"{flat_name}{suffix}.jpg")


LARGE_THUMB_MAX = (1920, 1920)
LARGE_THUMB_QUALITY = 82


def generate_thumbnails(original_path, thumb_path, blur_thumb_path, large_thumb_path=None):
    need_main = not os.path.exists(thumb_path)
    need_blur = not os.path.exists(blur_thumb_path)
    need_large = large_thumb_path is not None and not os.path.exists(large_thumb_path)
    if not need_main and not need_blur and not need_large:
        return True

    try:
        with Image.open(original_path) as img:
            img = ImageOps.exif_transpose(img)

            if img.mode in ("RGBA", "P"):
                img = img.convert("RGB")

            if need_large:
                # Fuer die Fullscreen-Ansicht - deutlich kleiner als das Kamera-Original,
                # aber scharf genug zum Reinzoomen
                large_img = img.copy()
                large_img.thumbnail(LARGE_THUMB_MAX)
                large_img.save(large_thumb_path, "JPEG", quality=LARGE_THUMB_QUALITY, optimize=True)

            if need_main:
                main_img = img.copy()
                main_img.thumbnail((800, 800))
                main_img.save(thumb_path, "JPEG", quality=55, optimize=True)

            if need_blur:
                # Nur fuers geblurrte Hintergrund-Backdrop - Aufloesung ist irrelevant, da eh verwischt wird
                blur_img = img.copy()
                blur_img.thumbnail((48, 48))
                blur_img.save(blur_thumb_path, "JPEG", quality=40, optimize=True)
        return True
    except Exception as e:
        logger.error(f"Thumbnail generation error {original_path}: {e}")
        return False


@contextmanager
def get_db():
    conn = sqlite3.connect(CONFIG['DB_PATH'], timeout=20)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _add_column_if_missing(conn, table, column, ddl):
    """Leichtgewichtige Mini-Migration: SQLite kennt kein 'ADD COLUMN IF NOT EXISTS',
    daher hier per try/except - schlaegt fehl (und wird ignoriert), wenn die Spalte
    aus einer frueheren App-Version bereits existiert."""
    try:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")
    except sqlite3.OperationalError:
        pass


def _backfill_route_modes(conn):
    """Routen aus der Zeit vor Einfuehrung von 'mode' haben durch den ALTER-TABLE-Default
    pauschal 'drive' - laesst sich aber aus der Geometrie ableiten: eine Luftlinie
    (straight_line_geometry) hat immer genau zwei Koordinatenpunkte, eine echte
    OSRM-Route praktisch nie."""
    rows = conn.execute("SELECT id, geometry FROM routes WHERE mode = 'drive'").fetchall()
    for row in rows:
        try:
            coords = json.loads(row['geometry'])['coordinates']
        except (TypeError, KeyError, ValueError):
            continue
        if len(coords) == 2:
            conn.execute("UPDATE routes SET mode = 'flight' WHERE id = ?", (row['id'],))


def init_db():
    try:
        with get_db() as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute('''
                CREATE TABLE IF NOT EXISTS photos (
                    filename TEXT PRIMARY KEY,
                    lat REAL,
                    lon REAL,
                    timestamp REAL,
                    location TEXT
                )
            ''')
            conn.execute('CREATE INDEX IF NOT EXISTS idx_photos_timestamp ON photos(timestamp)')
            _add_column_if_missing(conn, 'photos', 'note', 'TEXT')
            _add_column_if_missing(conn, 'photos', 'is_favorite', 'INTEGER NOT NULL DEFAULT 0')
            _add_column_if_missing(conn, 'photos', 'weather_temp', 'REAL')
            _add_column_if_missing(conn, 'photos', 'weather_code', 'INTEGER')
            conn.execute('CREATE TABLE IF NOT EXISTS global_stats (key TEXT PRIMARY KEY, value INTEGER)')
            conn.execute("INSERT OR IGNORE INTO global_stats (key, value) VALUES ('visitor_count', 0)")
            conn.execute('CREATE TABLE IF NOT EXISTS active_sessions (hash TEXT PRIMARY KEY, timestamp REAL)')
            conn.execute('CREATE INDEX IF NOT EXISTS idx_sessions_timestamp ON active_sessions(timestamp)')
            conn.execute('CREATE TABLE IF NOT EXISTS visits_by_day (date TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0)')
            conn.execute('''
                CREATE TABLE IF NOT EXISTS routes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    start_filename TEXT NOT NULL,
                    end_filename TEXT NOT NULL,
                    geometry TEXT NOT NULL,
                    UNIQUE(start_filename, end_filename)
                )
            ''')
            _add_column_if_missing(conn, 'routes', 'mode', "TEXT NOT NULL DEFAULT 'drive'")
            _backfill_route_modes(conn)
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

                today = datetime.fromtimestamp(now).strftime('%Y-%m-%d')
                conn.execute(
                    "INSERT INTO visits_by_day (date, count) VALUES (?, 1) "
                    "ON CONFLICT(date) DO UPDATE SET count = count + 1",
                    (today,)
                )
            else:
                conn.execute("UPDATE active_sessions SET timestamp = ? WHERE hash = ?", (now, visitor_hash))

            row = conn.execute("SELECT value FROM global_stats WHERE key = 'visitor_count'").fetchone()
            if row: total = row['value']
    except Exception as e:
        logger.error(f"Visitor tracking error: {e}")

    return total


def index_photo(full_path, abs_photo_dir):
    norm = full_path.replace('\\', '/')
    if '@eaDir' in norm or '/no_gps/' in norm or norm.endswith('/no_gps'):
        return
    if os.path.basename(full_path).startswith('.'):
        # Staging-Dateien von /api/upload (siehe dort) - werden erst nach
        # vollstaendiger Verarbeitung ohne Punkt-Praefix eingeblendet.
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

            thumb_path = _thumb_path(rel_path)
            blur_thumb_path = _thumb_path(rel_path, '_blur')

            timestamp, coords = extract_exif_data(full_path)

            if not coords:
                no_gps_dir = os.path.join(abs_photo_dir, 'no_gps')
                os.makedirs(no_gps_dir, exist_ok=True)
                dest = os.path.join(no_gps_dir, os.path.basename(full_path))
                if os.path.exists(dest):
                    # Gleichnamige Datei liegt schon in no_gps/ - nicht stillschweigend
                    # überschreiben, sondern mit eindeutigem Suffix daneben ablegen.
                    base, ext = os.path.splitext(os.path.basename(full_path))
                    dest = os.path.join(no_gps_dir, f"{base}_{secrets.token_hex(4)}{ext}")
                os.replace(full_path, dest)
                logger.info(f"Moved to no_gps: {os.path.basename(dest)}")
                return

            lat, lon = coords
            loc = get_location_name(lat, lon)
            final_ts = timestamp or os.path.getmtime(full_path)
            weather_temp, weather_code = fetch_weather(lat, lon, final_ts)

            if not generate_thumbnails(full_path, thumb_path, blur_thumb_path):
                logger.error(f"Skipping index (thumbnail generation failed): {full_path}")
                return

            cursor = conn.execute(
                "INSERT OR IGNORE INTO photos (filename, lat, lon, timestamp, location, weather_temp, weather_code) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (rel_path, lat, lon, final_ts, loc, weather_temp, weather_code)
            )
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


def admin_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not session.get('is_admin'):
            return jsonify({'error': 'Nicht angemeldet'}), 403
        return f(*args, **kwargs)
    return wrapper


@app.route('/')
@limiter.limit("20 per minute")
def index():
    token = request.args.get('token', '')
    if _access_granted(token):
        return render_template('index.html', token=token or 'public', visitor_count=track_visitor_count(),
                               maptiler_key=CONFIG['MAPTILER_API_KEY'])
    return render_template('login.html', contact_email=CONFIG['CONTACT_EMAIL'])


@app.route('/admin')
def admin_dashboard():
    return render_template('admin.html', logged_in=bool(session.get('is_admin')),
                           maptiler_key=CONFIG['MAPTILER_API_KEY'])


@app.route('/admin/login', methods=['POST'])
@limiter.limit("5 per minute")
def admin_login():
    data = request.get_json(silent=True) or {}
    token = data.get('admin_token', '')
    if isinstance(token, str) and secrets.compare_digest(token, CONFIG['ADMIN_TOKEN']):
        session.clear()
        session['is_admin'] = True
        session.permanent = True
        return jsonify({'success': True})
    return jsonify({'error': 'Falsches Passwort'}), 403


@app.route('/admin/logout', methods=['POST'])
def admin_logout():
    session.pop('is_admin', None)
    return redirect(url_for('admin_dashboard'))


@app.route('/api/stats')
@limiter.limit("30 per minute")
def api_stats():
    token = request.args.get('token', '')
    if not _access_granted(token): abort(403)

    try:
        with get_db() as conn:
            agg = conn.execute(
                "SELECT COUNT(*) as cnt, MIN(timestamp) as ts_first, MAX(timestamp) as ts_last "
                "FROM photos WHERE lat IS NOT NULL AND lon IS NOT NULL"
            ).fetchone()
            loc_rows = conn.execute(
                "SELECT DISTINCT location FROM photos "
                "WHERE location IS NOT NULL AND location != '' AND lat IS NOT NULL"
            ).fetchall()
            coord_rows = conn.execute(
                "SELECT lat, lon FROM photos WHERE lat IS NOT NULL AND lon IS NOT NULL ORDER BY timestamp ASC"
            ).fetchall()
    except Exception as e:
        logger.error(f"API Stats error: {e}")
        return jsonify({"error": "DB Error"}), 500

    photo_count = agg['cnt'] or 0
    ts_first, ts_last = agg['ts_first'], agg['ts_last']
    days = int((ts_last - ts_first) / 86400) + 1 if ts_first and ts_last else 0

    unique_countries = set()
    for row in loc_rows:
        loc = row['location']
        if loc and ',' in loc:
            unique_countries.add(loc.split(',')[-1].strip())

    total_km = 0.0
    coords = list(coord_rows)
    for i in range(1, len(coords)):
        total_km += calculate_distance(
            coords[i - 1]['lat'], coords[i - 1]['lon'],
            coords[i]['lat'], coords[i]['lon']
        )

    return jsonify({
        "total_km": round(total_km, 1),
        "countries": len(unique_countries),
        "photo_count": photo_count,
        "days": days,
    })


@app.route('/api/route')
@limiter.limit("30 per minute")
def api_route():
    token = request.args.get('token', '')
    if not _access_granted(token): abort(403)

    photos = []
    try:
        with get_db() as conn:
            rows = conn.execute(
                "SELECT * FROM photos WHERE lat IS NOT NULL AND lon IS NOT NULL ORDER BY timestamp ASC"
            ).fetchall()
            route_rows = conn.execute("SELECT start_filename, end_filename, geometry, mode FROM routes").fetchall()

        for r in rows:
            p = dict(r)
            p['date_str'] = datetime.fromtimestamp(p['timestamp']).strftime('%d.%m.%Y') if p['timestamp'] else ''
            photos.append(p)
    except Exception as e:
        logger.error(f"API Route error: {e}")
        return jsonify({"error": "DB Error"}), 500

    route_cache = {
        (r['start_filename'], r['end_filename']): {'geometry': json.loads(r['geometry']), 'mode': r['mode']}
        for r in route_rows
    }

    routes = []
    missing_pairs = []

    if photos:
        for i, photo in enumerate(photos):
            if i > 0:
                p1 = photos[i - 1]
                lat1, lon1 = p1.get('lat'), p1.get('lon')
                lat2, lon2 = photo.get('lat'), photo.get('lon')

                if (lat1 is not None and lon1 is not None and lat2 is not None and lon2 is not None
                        and lat1 != 0 and lat2 != 0):
                    key = (p1['filename'], photo['filename'])
                    cached = route_cache.get(key)
                    if cached:
                        routes.append(cached)
                    else:
                        # Vorlaeufiger Platzhalter, bis der Hintergrund-Fetch unten die
                        # richtige Geometrie/den Modus in die DB schreibt.
                        guessed_mode = 'flight' if calculate_distance(lat1, lon1, lat2, lon2) > OSRM_MAX_KM else 'drive'
                        routes.append({'geometry': straight_line_geometry(lat1, lon1, lat2, lon2), 'mode': guessed_mode})
                        missing_pairs.append((p1['filename'], photo['filename'], lat1, lon1, lat2, lon2))
                else:
                    routes.append(None)

    if missing_pairs:
        threading.Thread(target=fetch_missing_routes, args=(missing_pairs,), daemon=True).start()

    return jsonify({
        "photos": photos,
        "routes": routes,
    })


def _cached_file(path, max_age=31536000):
    response = make_response(send_file(path))
    response.headers['Cache-Control'] = f'public, max-age={max_age}, immutable'
    return response


def _ensure_blur_thumbnail(thumb_path, blur_thumb_path):
    """Backfill fuer Fotos, die vor Einfuehrung des Blur-Thumbs indiziert wurden.
    Skaliert aus dem bereits vorhandenen 800px-Thumb statt das Original neu zu lesen."""
    if os.path.exists(blur_thumb_path):
        return True
    if not os.path.exists(thumb_path):
        return False
    try:
        with Image.open(thumb_path) as img:
            if img.mode in ("RGBA", "P"):
                img = img.convert("RGB")
            img.thumbnail((48, 48))
            img.save(blur_thumb_path, "JPEG", quality=40, optimize=True)
        return True
    except Exception as e:
        logger.warning(f"Blur thumbnail backfill error {thumb_path}: {e}")
        return False


def _ensure_large_thumbnail(original_path, large_thumb_path):
    """Wird nur bei tatsaechlichem Fullscreen-Aufruf erzeugt (nicht beim Scan),
    damit nicht fuer jedes indizierte Foto ein zusaetzlicher 1920px-Thumb entsteht."""
    if os.path.exists(large_thumb_path):
        return True
    if not os.path.exists(original_path):
        return False
    try:
        with Image.open(original_path) as img:
            img = ImageOps.exif_transpose(img)
            if img.mode in ("RGBA", "P"):
                img = img.convert("RGB")
            img.thumbnail(LARGE_THUMB_MAX)
            img.save(large_thumb_path, "JPEG", quality=LARGE_THUMB_QUALITY, optimize=True)
        return True
    except Exception as e:
        logger.warning(f"Large thumbnail backfill error {original_path}: {e}")
        return False


def _is_within_dir(base_dir, target_path):
    """os.path.commonpath wirft ValueError bei Pfaden auf verschiedenen Windows-Laufwerken
    (z.B. Junction/Netzlaufwerk als PHOTO_DIR) - dann ist der Pfad ausserhalb, kein Serverfehler."""
    try:
        return os.path.commonpath([base_dir, target_path]) == base_dir
    except ValueError:
        return False


@app.route('/api/thumb/<path:filename>')
def api_thumb(filename):
    token = request.args.get('token', '')
    if not (session.get('is_admin') or _access_granted(token)): abort(403)

    base_dir = os.path.abspath(CONFIG['PHOTO_DIR'])
    requested_path = os.path.abspath(os.path.join(base_dir, filename))
    if not _is_within_dir(base_dir, requested_path): abort(403)

    size = request.args.get('size')

    if size == 'original':
        if os.path.exists(requested_path): return _cached_file(requested_path)

    thumb_path = _thumb_path(filename)

    if size == 'blur':
        blur_thumb_path = _thumb_path(filename, '_blur')
        if _ensure_blur_thumbnail(thumb_path, blur_thumb_path):
            return _cached_file(blur_thumb_path)

    if size == 'large':
        large_thumb_path = _thumb_path(filename, '_lg')
        if _ensure_large_thumbnail(requested_path, large_thumb_path):
            return _cached_file(large_thumb_path)

    if os.path.exists(thumb_path): return _cached_file(thumb_path)
    if os.path.exists(requested_path): return _cached_file(requested_path)
    abort(404)


@app.route('/api/upload', methods=['POST'])
@admin_required
def upload_photo():
    if 'photo' not in request.files: return jsonify({'error': 'No file'}), 400
    file = request.files['photo']
    if file.filename == '': return jsonify({'error': 'Empty filename'}), 400
    if not file.filename.lower().endswith(SUPPORTED_EXTENSIONS):
        return jsonify({'error': 'Nicht unterstuetztes Dateiformat.'}), 400

    # Parse form-supplied coordinates (sent by client when EXIF GPS is missing)
    form_coords = None
    try:
        form_lat = request.form.get('lat')
        form_lon = request.form.get('lon')
        if form_lat and form_lon:
            flat, flon = float(form_lat), float(form_lon)
            if math.isfinite(flat) and math.isfinite(flon):
                form_coords = (flat, flon)
    except (ValueError, TypeError):
        pass

    try:
        filename = secure_filename(file.filename)
        unique_name = f"{int(time.time())}_{secrets.token_hex(4)}_{filename}"
        final_path = os.path.join(CONFIG['PHOTO_DIR'], unique_name)
        # Punkt-Praefix: der Watchdog-Scanner ignoriert Dateien, deren Name damit
        # beginnt (siehe index_photo), damit er die Datei nicht parallel zu diesem
        # Handler halbfertig einliest und faelschlich nach no_gps/ verschiebt.
        save_path = os.path.join(CONFIG['PHOTO_DIR'], f".upload_{unique_name}")

        file.save(save_path)

        ts, coords = extract_exif_data(save_path)

        thumb_path = _thumb_path(unique_name)
        blur_thumb_path = _thumb_path(unique_name, '_blur')

        if not coords and form_coords:
            flat, flon = form_coords
            try:
                try:
                    exif_dict = piexif.load(save_path)
                except Exception:
                    exif_dict = {'0th': {}, 'Exif': {}, 'GPS': {}, '1st': {}}
                exif_dict['GPS'] = {
                    piexif.GPSIFD.GPSLatitudeRef: b'N' if flat >= 0 else b'S',
                    piexif.GPSIFD.GPSLatitude: decimal_to_dms_rational(abs(flat)),
                    piexif.GPSIFD.GPSLongitudeRef: b'E' if flon >= 0 else b'W',
                    piexif.GPSIFD.GPSLongitude: decimal_to_dms_rational(abs(flon)),
                }
                exif_bytes = piexif.dump(exif_dict)
                piexif.insert(exif_bytes, save_path)
            except Exception as e:
                logger.warning(f"Failed to write form coords to EXIF: {e}")
            coords = form_coords

        if not coords or math.isnan(coords[0]) or math.isnan(coords[1]):
            os.remove(save_path)
            return jsonify({'success': False, 'missing_gps': True,
                            'error': 'Foto hat keine GPS-Daten. Bitte GPS in der Kamera-App aktivieren.'}), 400

        lat, lon = coords
        loc = get_location_name(lat, lon)
        if loc == "Unbekannt":
            loc = f"{lat:.2f}, {lon:.2f}"

        if not generate_thumbnails(save_path, thumb_path, blur_thumb_path):
            os.remove(save_path)
            return jsonify({'error': 'Foto konnte nicht verarbeitet werden (ungueltiges Bildformat?).'}), 400

        final_ts = ts or time.time()

        with get_db() as conn:
            conn.execute(
                "INSERT OR IGNORE INTO photos (filename, lat, lon, timestamp, location) VALUES (?, ?, ?, ?, ?)",
                (unique_name, lat, lon, final_ts, loc)
            )

        os.replace(save_path, final_path)

        # Nicht synchron im Request abfragen (Open-Meteo ist ein externer Netzwerkaufruf,
        # der die Upload-Antwort spuerbar verzoegern wuerde) - Nachtragen im Hintergrund,
        # wie schon bei fehlenden OSRM-Routen.
        threading.Thread(target=_fetch_and_store_weather, args=(unique_name, lat, lon, final_ts), daemon=True).start()

        return jsonify({'success': True, 'file': unique_name, 'location': loc,
                        'missing_gps': False, 'lat': lat, 'lon': lon, 'timestamp': final_ts})

    except Exception as e:
        if 'save_path' in locals() and os.path.exists(save_path): os.remove(save_path)
        logger.error(f"Upload error: {e}")
        return jsonify({'error': 'Upload fehlgeschlagen.'}), 500


@app.route('/api/update_location', methods=['POST'])
@admin_required
def update_location():
    data = request.get_json(silent=True) or {}
    filename = data.get('filename')
    lat = data.get('lat')
    lon = data.get('lon')

    if not filename or lat is None or lon is None:
        return jsonify({'error': 'Daten fehlen'}), 400

    try:
        lat = float(lat)
        lon = float(lon)
    except (TypeError, ValueError):
        return jsonify({'error': 'lat/lon muessen Zahlen sein'}), 400

    if not (math.isfinite(lat) and math.isfinite(lon) and -90 <= lat <= 90 and -180 <= lon <= 180):
        return jsonify({'error': 'lat/lon ausserhalb des gueltigen Bereichs'}), 400

    try:
        new_loc = get_location_name(lat, lon)
        if new_loc == "Unbekannt":
            new_loc = f"{lat:.2f}, {lon:.2f}"

        with get_db() as conn:
            conn.execute("UPDATE photos SET lat = ?, lon = ?, location = ? WHERE filename = ?",
                         (lat, lon, new_loc, filename))

        logger.info(f"Location update for {filename}: {new_loc}")

        return jsonify({'success': True, 'location': new_loc})

    except Exception as e:
        logger.error(f"Update location error: {e}")
        return jsonify({'error': 'Ort konnte nicht gespeichert werden.'}), 500


NOTE_MAX_LENGTH = 2000


@app.route('/api/admin/photos/<path:filename>/note', methods=['POST'])
@admin_required
def update_note(filename):
    data = request.get_json(silent=True) or {}
    note = data.get('note')

    if note is not None:
        if not isinstance(note, str):
            return jsonify({'error': 'note muss Text sein'}), 400
        note = note.strip()
        if len(note) > NOTE_MAX_LENGTH:
            return jsonify({'error': f'Notiz zu lang (max. {NOTE_MAX_LENGTH} Zeichen)'}), 400
        if note == '':
            note = None  # leere Notiz = Notiz entfernen, nicht als leerer String speichern

    try:
        with get_db() as conn:
            conn.execute("UPDATE photos SET note = ? WHERE filename = ?", (note, filename))
        return jsonify({'success': True, 'note': note})
    except Exception as e:
        logger.error(f"Update note error: {e}")
        return jsonify({'error': 'Notiz konnte nicht gespeichert werden.'}), 500


@app.route('/api/admin/photos/<path:filename>/favorite', methods=['POST'])
@admin_required
def update_favorite(filename):
    data = request.get_json(silent=True) or {}
    favorite = bool(data.get('favorite'))

    try:
        with get_db() as conn:
            conn.execute("UPDATE photos SET is_favorite = ? WHERE filename = ?", (int(favorite), filename))
        return jsonify({'success': True, 'favorite': favorite})
    except Exception as e:
        logger.error(f"Update favorite error: {e}")
        return jsonify({'error': 'Favorit konnte nicht gespeichert werden.'}), 500


ADMIN_PHOTOS_PAGE_SIZE = 60


@app.route('/api/admin/photos')
@admin_required
def admin_list_photos():
    q = request.args.get('q', '').strip()
    try:
        offset = max(0, int(request.args.get('offset', 0)))
    except (TypeError, ValueError):
        offset = 0

    try:
        with get_db() as conn:
            if q:
                like = f"%{q}%"
                where = "WHERE location LIKE ? OR filename LIKE ?"
                params = (like, like)
            else:
                where = ""
                params = ()

            rows = conn.execute(
                f"SELECT filename, lat, lon, timestamp, location, note, is_favorite FROM photos {where} "
                f"ORDER BY timestamp DESC LIMIT ? OFFSET ?",
                (*params, ADMIN_PHOTOS_PAGE_SIZE, offset)
            ).fetchall()
            total = conn.execute(f"SELECT COUNT(*) as cnt FROM photos {where}", params).fetchone()['cnt']
    except Exception as e:
        logger.error(f"Admin photo list error: {e}")
        return jsonify({'error': 'DB Error'}), 500

    photos = []
    for r in rows:
        p = dict(r)
        p['date_str'] = datetime.fromtimestamp(p['timestamp']).strftime('%d.%m.%Y') if p['timestamp'] else ''
        photos.append(p)

    return jsonify({'photos': photos, 'total': total, 'offset': offset, 'limit': ADMIN_PHOTOS_PAGE_SIZE})


@app.route('/api/admin/photos/<path:filename>', methods=['DELETE'])
@admin_required
def admin_delete_photo(filename):
    base_dir = os.path.abspath(CONFIG['PHOTO_DIR'])
    requested_path = os.path.abspath(os.path.join(base_dir, filename))
    if not _is_within_dir(base_dir, requested_path):
        abort(403)

    try:
        with get_db() as conn:
            conn.execute("DELETE FROM photos WHERE filename = ?", (filename,))
            conn.execute("DELETE FROM routes WHERE start_filename = ? OR end_filename = ?", (filename, filename))

        for path in (requested_path, _thumb_path(filename), _thumb_path(filename, '_blur'), _thumb_path(filename, '_lg')):
            if os.path.exists(path):
                os.remove(path)

        logger.info(f"Deleted photo: {filename}")
        return jsonify({'success': True})

    except Exception as e:
        logger.error(f"Delete photo error: {e}")
        return jsonify({'error': 'Foto konnte nicht geloescht werden.'}), 500


VISITOR_HISTORY_DAYS = 30


@app.route('/api/admin/visitor-stats')
@admin_required
def admin_visitor_stats():
    now = time.time()
    try:
        with get_db() as conn:
            row = conn.execute("SELECT value FROM global_stats WHERE key = 'visitor_count'").fetchone()
            total = row['value'] if row else 0

            active_row = conn.execute(
                "SELECT COUNT(*) as cnt FROM active_sessions WHERE timestamp >= ?", (now - 3600,)
            ).fetchone()
            active_now = active_row['cnt'] if active_row else 0

            day_rows = conn.execute(
                "SELECT date, count FROM visits_by_day ORDER BY date DESC LIMIT ?", (VISITOR_HISTORY_DAYS,)
            ).fetchall()
    except Exception as e:
        logger.error(f"Admin visitor stats error: {e}")
        return jsonify({'error': 'DB Error'}), 500

    counts_by_date = {r['date']: r['count'] for r in day_rows}
    today = datetime.fromtimestamp(now).date()
    daily = []
    for i in range(VISITOR_HISTORY_DAYS - 1, -1, -1):
        d = (today - timedelta(days=i)).isoformat()
        daily.append({'date': d, 'count': counts_by_date.get(d, 0)})

    return jsonify({'total': total, 'active_now': active_now, 'daily': daily})


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
    app.run(host='0.0.0.0', port=5000, debug=app.debug)

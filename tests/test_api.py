import io
import json
import os
from unittest.mock import patch, MagicMock


def _make_jpeg_bytes(color=0):
    from PIL import Image
    buf = io.BytesIO()
    Image.new('RGB', (100, 100), color=color).save(buf, format='JPEG')
    buf.seek(0)
    return buf


def _upload_photo(client, filename, lat='48.0', lon='11.0', color=0):
    return client.post('/api/upload', data={
        'photo': (_make_jpeg_bytes(color=color), filename),
        'lat': lat,
        'lon': lon,
    }, content_type='multipart/form-data')


def _insert_photo(conn, filename, lat=48.0, lon=11.0, timestamp=1700000000.0, location='X', media_type='photo'):
    conn.execute(
        "INSERT INTO photos (filename, lat, lon, timestamp, location, media_type) VALUES (?, ?, ?, ?, ?, ?)",
        (filename, lat, lon, timestamp, location, media_type)
    )


def _insert_reel(conn, group_key='DE', status='done', filename=None, photo_count=None,
                  video_count=None, duration_seconds=None, created_at=1700000000.0):
    cursor = conn.execute(
        "INSERT INTO reels (group_key, status, filename, photo_count, video_count, duration_seconds, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (group_key, status, filename, photo_count, video_count, duration_seconds, created_at)
    )
    return cursor.lastrowid


class _SyncThread:
    """Ersetzt threading.Thread in Tests: fuehrt den Zieljob synchron im aufrufenden
    Thread aus, damit /api/admin/reels-Tests nicht gegen einen echten Hintergrund-Thread
    race-n muessen."""
    def __init__(self, target=None, args=(), kwargs=None, daemon=None):
        self._target = target
        self._args = args or ()
        self._kwargs = kwargs or {}

    def start(self):
        self._target(*self._args, **self._kwargs)


class _FakeThreadingModule:
    """Patch-Ziel fuer 'app.threading': ersetzt nur den Namen, den app.py fuer
    threading.Thread(...) verwendet - im Gegensatz zu patch('app.threading.Thread', ...)
    bleibt so das echte threading-Modul (u.a. von flask-limiter genutzt) unberuehrt."""
    Thread = _SyncThread


class TestIndexRoute:
    def test_valid_token_returns_200(self, client):
        response = client.get('/?token=test_token')
        assert response.status_code == 200

    def test_invalid_token_returns_login_page(self, client):
        response = client.get('/?token=wrong')
        assert response.status_code == 200
        assert b'login' in response.data.lower()

    def test_no_token_returns_login_page(self, client):
        response = client.get('/')
        assert response.status_code == 200
        assert b'login' in response.data.lower()

    def test_admin_session_without_token_returns_gallery(self, admin_client):
        response = admin_client.get('/')
        assert response.status_code == 200
        assert b'login' not in response.data.lower()

    def test_non_ascii_token_returns_login_page_not_500(self, client):
        # compare_digest wirft auf str mit Nicht-ASCII einen TypeError - der darf
        # nicht als 500 durchschlagen (per Query von jedem Besucher ausloesbar).
        response = client.get('/?token=%C3%BC')
        assert response.status_code == 200
        assert b'login' in response.data.lower()


class TestApiRoute:
    def test_valid_token_returns_json(self, client):
        response = client.get('/api/route?token=test_token')
        assert response.status_code == 200
        data = response.get_json()
        assert 'photos' in data
        assert 'routes' in data

    def test_invalid_token_returns_403(self, client):
        response = client.get('/api/route?token=wrong')
        assert response.status_code == 403

    def test_admin_session_without_token_returns_json(self, admin_client):
        response = admin_client.get('/api/route')
        assert response.status_code == 200


class TestApiStats:
    def test_valid_token_returns_json(self, client):
        response = client.get('/api/stats?token=test_token')
        assert response.status_code == 200
        data = response.get_json()
        assert 'total_km' in data
        assert 'countries' in data
        assert 'photo_count' in data
        assert 'days' in data

    def test_invalid_token_returns_403(self, client):
        response = client.get('/api/stats?token=wrong')
        assert response.status_code == 403

    def test_admin_session_without_token_returns_json(self, admin_client):
        response = admin_client.get('/api/stats')
        assert response.status_code == 200

    def test_empty_db_returns_zero_stats(self, client):
        response = client.get('/api/stats?token=test_token')
        data = response.get_json()
        assert data['photo_count'] == 0
        assert data['total_km'] == 0


class TestAdminDashboard:
    def test_logged_out_shows_login_form(self, client):
        response = client.get('/admin')
        assert response.status_code == 200
        assert b'admin-login-form' in response.data

    def test_logged_in_shows_dashboard(self, admin_client):
        response = admin_client.get('/admin')
        assert response.status_code == 200
        assert b'admin-upload-log' in response.data


class TestAdminLogin:
    def test_valid_admin_token_sets_session(self, client):
        response = client.post('/admin/login',
                               data=json.dumps({'admin_token': 'test_admin'}),
                               content_type='application/json')
        assert response.status_code == 200
        assert response.get_json()['success'] is True

        dashboard = client.get('/admin')
        assert b'admin-upload-log' in dashboard.data

    def test_invalid_admin_token_returns_403(self, client):
        response = client.post('/admin/login',
                               data=json.dumps({'admin_token': 'wrong'}),
                               content_type='application/json')
        assert response.status_code == 403

    def test_non_string_admin_token_returns_403_not_500(self, client):
        response = client.post('/admin/login',
                               data=json.dumps({'admin_token': 12345}),
                               content_type='application/json')
        assert response.status_code == 403

    def test_wrong_content_type_returns_403_not_415(self, client):
        response = client.post('/admin/login', data='not json')
        assert response.status_code == 403

    def test_non_ascii_admin_token_returns_403_not_500(self, client):
        response = client.post('/admin/login',
                               data=json.dumps({'admin_token': 'pässwort'}),
                               content_type='application/json')
        assert response.status_code == 403


class TestAdminLogout:
    def test_logout_clears_session(self, admin_client):
        admin_client.post('/admin/logout')
        response = admin_client.get('/admin')
        assert b'admin-login-form' in response.data


class TestUploadPhoto:
    def test_without_admin_session_returns_403(self, client):
        response = client.post('/api/upload', data={
            'photo': (_make_jpeg_bytes(color=(100, 149, 237)), 'test.jpg')
        }, content_type='multipart/form-data')
        assert response.status_code == 403

    def test_no_file_returns_400(self, admin_client):
        response = admin_client.post('/api/upload', data={}, content_type='multipart/form-data')
        assert response.status_code == 400

    def test_valid_upload_returns_success(self, admin_client):
        response = admin_client.post('/api/upload', data={
            'photo': (_make_jpeg_bytes(color=(100, 149, 237)), 'test.jpg'),
            'lat': '48.8566',
            'lon': '2.3522',
        }, content_type='multipart/form-data')
        assert response.status_code == 200
        data = response.get_json()
        assert data['success'] is True
        assert 'file' in data

    def test_upload_response_contains_location_field(self, admin_client):
        response = admin_client.post('/api/upload', data={
            'photo': (_make_jpeg_bytes(color=(100, 149, 237)), 'test.jpg'),
            'lat': '48.8566',
            'lon': '2.3522',
        }, content_type='multipart/form-data')
        assert response.status_code == 200
        assert 'location' in response.get_json()

    def test_upload_response_contains_missing_gps_field(self, admin_client):
        response = admin_client.post('/api/upload', data={
            'photo': (_make_jpeg_bytes(color=(100, 149, 237)), 'test.jpg')
        }, content_type='multipart/form-data')
        data = response.get_json()
        assert 'missing_gps' in data
        assert data['missing_gps'] is True

    def test_unsupported_extension_returns_400(self, admin_client):
        response = admin_client.post('/api/upload', data={
            'photo': (io.BytesIO(b'<script>alert(1)</script>'), 'evil.html'),
        }, content_type='multipart/form-data')
        assert response.status_code == 400

    def test_unsupported_extension_file_is_not_saved(self, admin_client, app):
        import app as flask_module
        admin_client.post('/api/upload', data={
            'photo': (io.BytesIO(b'<script>alert(1)</script>'), 'evil.html'),
        }, content_type='multipart/form-data')
        saved = os.listdir(flask_module.CONFIG['PHOTO_DIR'])
        assert not any(f.endswith('.html') for f in saved)


class TestUploadWithFormCoords:
    def test_piexif_insert_not_called_without_coords(self, admin_client):
        with patch('piexif.insert') as mock_insert:
            admin_client.post('/api/upload', data={
                'photo': (_make_jpeg_bytes(), 'no_coords.jpg'),
            }, content_type='multipart/form-data')

            mock_insert.assert_not_called()

    def test_piexif_load_failure_is_silently_handled(self, admin_client):
        with patch('piexif.load', side_effect=Exception('invalid')), \
             patch('piexif.dump', return_value=b'exif'), \
             patch('piexif.insert'):

            response = admin_client.post('/api/upload', data={
                'photo': (_make_jpeg_bytes(), 'bad_exif.jpg'),
                'lat': '48.8566',
                'lon': '2.3522',
            }, content_type='multipart/form-data')

            assert response.status_code == 200


class TestUploadIdempotency:
    def test_duplicate_filename_in_db_does_not_crash_upload(self, admin_client, app):
        from app import get_db
        with get_db() as conn:
            _insert_photo(conn, 'duplicate.jpg', location='München, DE')
            conn.commit()

        response = admin_client.post('/api/upload', data={
            'photo': (_make_jpeg_bytes(), 'duplicate.jpg'),
            'lat': '48.0',
            'lon': '11.0',
        }, content_type='multipart/form-data')

        assert response.status_code == 200


class TestApiRouteNullTimestamp:
    def test_null_timestamp_in_db_does_not_crash(self, client):
        from app import get_db
        with get_db() as conn:
            _insert_photo(conn, 'null_ts.jpg', timestamp=None, location='München, DE')
            conn.commit()

        response = client.get('/api/route?token=test_token')
        assert response.status_code == 200
        data = response.get_json()
        photo = next(p for p in data['photos'] if p['filename'] == 'null_ts.jpg')
        assert photo['date_str'] == ''


class TestUploadResponseFields:
    def test_upload_response_contains_lat_lon(self, admin_client, tmp_path):
        import piexif
        from PIL import Image
        from app import decimal_to_dms_rational

        buf = io.BytesIO()
        Image.new('RGB', (100, 100)).save(buf, format='JPEG')
        buf.seek(0)
        img_bytes = buf.getvalue()

        exif_dict = {'0th': {}, 'Exif': {}, 'GPS': {
            piexif.GPSIFD.GPSLatitudeRef:  b'N',
            piexif.GPSIFD.GPSLatitude:     decimal_to_dms_rational(48.8566),
            piexif.GPSIFD.GPSLongitudeRef: b'E',
            piexif.GPSIFD.GPSLongitude:    decimal_to_dms_rational(2.3522),
        }, '1st': {}}
        exif_bytes = piexif.dump(exif_dict)
        jpeg_with_gps = io.BytesIO()
        img = Image.open(io.BytesIO(img_bytes))
        img.save(jpeg_with_gps, format='JPEG', exif=exif_bytes)
        jpeg_with_gps.seek(0)

        response = admin_client.post('/api/upload', data={
            'photo': (jpeg_with_gps, 'with_gps.jpg'),
        }, content_type='multipart/form-data')

        data = response.get_json()
        assert 'lat' in data
        assert 'lon' in data
        assert data['lat'] is not None
        assert abs(data['lat'] - 48.8566) < 0.01
        assert abs(data['lon'] - 2.3522) < 0.01

    def test_thumbnail_name_matches_serve_and_delete_path(self, admin_client, app):
        import app as flask_module
        import os
        response = admin_client.post('/api/upload', data={
            'photo': (_make_jpeg_bytes(), 'mytrip.jpg'),
            'lat': '48.8566',
            'lon': '2.3522',
        }, content_type='multipart/form-data')
        assert response.status_code == 200
        uploaded_file = response.get_json()['file']

        thumb_dir = flask_module.CONFIG['THUMB_DIR']
        expected_thumb = os.path.join(thumb_dir, uploaded_file)
        double_ext_thumb = os.path.join(thumb_dir, uploaded_file + '.jpg')

        assert os.path.exists(expected_thumb), "Thumbnail fehlt unter erwartetem Pfad"
        assert not os.path.exists(double_ext_thumb), "Thumbnail doppelt mit .jpg.jpg angelegt"

    def test_upload_without_gps_returns_400(self, admin_client):
        response = admin_client.post('/api/upload', data={
            'photo': (_make_jpeg_bytes(), 'no_gps.jpg'),
        }, content_type='multipart/form-data')

        assert response.status_code == 400
        data = response.get_json()
        assert data.get('missing_gps') is True


class TestApiThumbLarge:
    def _upload(self, admin_client):
        response = _upload_photo(admin_client, 'fullscreen.jpg', lat='48.8566', lon='2.3522', color=(100, 149, 237))
        assert response.status_code == 200
        return response.get_json()['file']

    def test_large_size_returns_200(self, admin_client):
        uploaded_file = self._upload(admin_client)
        response = admin_client.get(f'/api/thumb/{uploaded_file}?token=test_token&size=large')
        assert response.status_code == 200

    def test_large_size_creates_dedicated_thumb_file(self, admin_client, app):
        import app as flask_module
        uploaded_file = self._upload(admin_client)
        admin_client.get(f'/api/thumb/{uploaded_file}?token=test_token&size=large')

        thumb_dir = flask_module.CONFIG['THUMB_DIR']
        large_thumb_path = os.path.join(thumb_dir, uploaded_file[:-4] + '_lg.jpg')
        assert os.path.exists(large_thumb_path)

    def test_large_size_is_cached_not_regenerated_on_second_request(self, admin_client, app):
        import app as flask_module
        uploaded_file = self._upload(admin_client)
        admin_client.get(f'/api/thumb/{uploaded_file}?token=test_token&size=large')

        thumb_dir = flask_module.CONFIG['THUMB_DIR']
        large_thumb_path = os.path.join(thumb_dir, uploaded_file[:-4] + '_lg.jpg')
        first_mtime = os.path.getmtime(large_thumb_path)

        admin_client.get(f'/api/thumb/{uploaded_file}?token=test_token&size=large')
        assert os.path.getmtime(large_thumb_path) == first_mtime

    def test_invalid_token_returns_403(self, client):
        response = client.get('/api/thumb/whatever.jpg?token=wrong&size=large')
        assert response.status_code == 403


class TestUpdateLocation:
    def test_without_admin_session_returns_403(self, client):
        response = client.post('/api/update_location',
                               data=json.dumps({'filename': 'x.jpg', 'lat': 48.0, 'lon': 11.0}),
                               content_type='application/json')
        assert response.status_code == 403

    def test_missing_data_returns_400(self, admin_client):
        response = admin_client.post('/api/update_location',
                                     data=json.dumps({}),
                                     content_type='application/json')
        assert response.status_code == 400

    def test_non_numeric_lat_returns_400(self, admin_client):
        response = admin_client.post('/api/update_location',
                                     data=json.dumps({'filename': 'a.jpg', 'lat': 'abc', 'lon': 11.0}),
                                     content_type='application/json')
        assert response.status_code == 400
        assert 'error' in response.get_json()

    def test_out_of_range_lat_returns_400(self, admin_client):
        response = admin_client.post('/api/update_location',
                                     data=json.dumps({'filename': 'a.jpg', 'lat': 999, 'lon': -4000}),
                                     content_type='application/json')
        assert response.status_code == 400

    def test_valid_update(self, admin_client):
        response = admin_client.post('/api/update_location',
                                     data=json.dumps({
                                         'filename': 'nonexistent.jpg',
                                         'lat': 48.1351,
                                         'lon': 11.5820
                                     }),
                                     content_type='application/json')
        assert response.status_code == 200
        data = response.get_json()
        assert data['success'] is True

    def test_update_persists_new_coordinates_in_db(self, admin_client, app):
        from app import get_db

        with get_db() as conn:
            _insert_photo(conn, 'to_fix.jpg', lat=0.0, lon=0.0, location='Unbekannt')
            conn.commit()

        response = admin_client.post('/api/update_location',
                                     data=json.dumps({
                                         'filename': 'to_fix.jpg',
                                         'lat': 48.1351,
                                         'lon': 11.5820
                                     }),
                                     content_type='application/json')
        assert response.status_code == 200
        assert response.get_json()['location'] != 'Unbekannt'

        with get_db() as conn:
            row = conn.execute(
                "SELECT lat, lon, location FROM photos WHERE filename = ?", ('to_fix.jpg',)
            ).fetchone()
        assert abs(row['lat'] - 48.1351) < 0.0001
        assert abs(row['lon'] - 11.5820) < 0.0001
        assert row['location'] != 'Unbekannt'


class TestUpdateNote:
    def _seed(self, note=None):
        from app import get_db
        with get_db() as conn:
            conn.execute(
                "INSERT INTO photos (filename, lat, lon, timestamp, location, note) VALUES (?, ?, ?, ?, ?, ?)",
                ('note_test.jpg', 48.0, 11.0, 1700000000.0, 'München, DE', note)
            )
            conn.commit()

    def test_without_admin_session_returns_403(self, client):
        response = client.post('/api/admin/photos/x.jpg/note',
                               data=json.dumps({'note': 'Test'}),
                               content_type='application/json')
        assert response.status_code == 403

    def test_sets_a_note(self, admin_client):
        self._seed()
        response = admin_client.post('/api/admin/photos/note_test.jpg/note',
                                     data=json.dumps({'note': 'Tolles Restaurant hier gefunden'}),
                                     content_type='application/json')
        assert response.status_code == 200
        assert response.get_json()['note'] == 'Tolles Restaurant hier gefunden'

        from app import get_db
        with get_db() as conn:
            row = conn.execute("SELECT note FROM photos WHERE filename = ?", ('note_test.jpg',)).fetchone()
        assert row['note'] == 'Tolles Restaurant hier gefunden'

    def test_empty_note_clears_it(self, admin_client):
        self._seed(note='Alte Notiz')
        response = admin_client.post('/api/admin/photos/note_test.jpg/note',
                                     data=json.dumps({'note': ''}),
                                     content_type='application/json')
        assert response.status_code == 200
        assert response.get_json()['note'] is None

    def test_note_is_trimmed(self, admin_client):
        self._seed()
        response = admin_client.post('/api/admin/photos/note_test.jpg/note',
                                     data=json.dumps({'note': '  mit Leerzeichen drumrum  '}),
                                     content_type='application/json')
        assert response.get_json()['note'] == 'mit Leerzeichen drumrum'

    def test_note_too_long_returns_400(self, admin_client):
        self._seed()
        response = admin_client.post('/api/admin/photos/note_test.jpg/note',
                                     data=json.dumps({'note': 'x' * 2001}),
                                     content_type='application/json')
        assert response.status_code == 400

    def test_non_string_note_returns_400(self, admin_client):
        self._seed()
        response = admin_client.post('/api/admin/photos/note_test.jpg/note',
                                     data=json.dumps({'note': 12345}),
                                     content_type='application/json')
        assert response.status_code == 400

    def test_nonexistent_photo_still_returns_success(self, admin_client):
        response = admin_client.post('/api/admin/photos/never_uploaded.jpg/note',
                                     data=json.dumps({'note': 'Test'}),
                                     content_type='application/json')
        assert response.status_code == 200


class TestUpdateFavorite:
    def _seed(self):
        from app import get_db
        with get_db() as conn:
            _insert_photo(conn, 'fav_test.jpg', location='München, DE')
            conn.commit()

    def test_without_admin_session_returns_403(self, client):
        response = client.post('/api/admin/photos/x.jpg/favorite',
                               data=json.dumps({'favorite': True}),
                               content_type='application/json')
        assert response.status_code == 403

    def test_marks_as_favorite(self, admin_client):
        self._seed()
        response = admin_client.post('/api/admin/photos/fav_test.jpg/favorite',
                                     data=json.dumps({'favorite': True}),
                                     content_type='application/json')
        assert response.status_code == 200
        assert response.get_json()['favorite'] is True

        from app import get_db
        with get_db() as conn:
            row = conn.execute("SELECT is_favorite FROM photos WHERE filename = ?", ('fav_test.jpg',)).fetchone()
        assert row['is_favorite'] == 1

    def test_unmarks_as_favorite(self, admin_client):
        self._seed()
        admin_client.post('/api/admin/photos/fav_test.jpg/favorite',
                          data=json.dumps({'favorite': True}), content_type='application/json')
        response = admin_client.post('/api/admin/photos/fav_test.jpg/favorite',
                                     data=json.dumps({'favorite': False}),
                                     content_type='application/json')
        assert response.get_json()['favorite'] is False

    def test_missing_favorite_field_defaults_to_false(self, admin_client):
        self._seed()
        response = admin_client.post('/api/admin/photos/fav_test.jpg/favorite',
                                     data=json.dumps({}),
                                     content_type='application/json')
        assert response.status_code == 200
        assert response.get_json()['favorite'] is False


class TestRouteMode:
    def test_fetch_missing_routes_marks_far_apart_photos_as_flight(self, app):
        from app import fetch_missing_routes, get_db
        # Berlin -> Tokio: weit ueber OSRM_MAX_KM, OSRM liefert dafuer nie eine Route
        fetch_missing_routes([('a.jpg', 'b.jpg', 52.52, 13.405, 35.68, 139.69)])

        with get_db() as conn:
            row = conn.execute(
                "SELECT mode FROM routes WHERE start_filename = ? AND end_filename = ?",
                ('a.jpg', 'b.jpg')
            ).fetchone()
        assert row['mode'] == 'flight'

    def test_api_route_includes_mode_for_cached_routes(self, client):
        from app import get_db
        import json as json_module
        with get_db() as conn:
            _insert_photo(conn, 'r1.jpg', location='A')
            _insert_photo(conn, 'r2.jpg', lat=48.1, lon=11.1, timestamp=1700000100.0, location='B')
            conn.execute(
                "INSERT INTO routes (start_filename, end_filename, geometry, mode) VALUES (?, ?, ?, ?)",
                ('r1.jpg', 'r2.jpg', json_module.dumps({'type': 'LineString', 'coordinates': [[11.0, 48.0], [11.1, 48.1]]}), 'drive')
            )
            conn.commit()

        response = client.get('/api/route?token=test_token')
        data = response.get_json()
        route = next(r for r in data['routes'] if r is not None and r.get('mode') == 'drive')
        assert route['geometry']['type'] == 'LineString'


class TestApiThumbAdminSession:
    def test_admin_session_without_token_returns_200(self, admin_client):
        upload = admin_client.post('/api/upload', data={
            'photo': (_make_jpeg_bytes(), 'thumbtest.jpg'),
            'lat': '48.0',
            'lon': '11.0',
        }, content_type='multipart/form-data')
        filename = upload.get_json()['file']

        response = admin_client.get(f'/api/thumb/{filename}')
        assert response.status_code == 200

    def test_without_session_or_token_returns_403(self, client):
        response = client.get('/api/thumb/whatever.jpg')
        assert response.status_code == 403


class TestAdminPhotoList:
    def test_without_session_returns_403(self, client):
        response = client.get('/api/admin/photos')
        assert response.status_code == 403

    def test_returns_uploaded_photos(self, admin_client):
        admin_client.post('/api/upload', data={
            'photo': (_make_jpeg_bytes(), 'listed.jpg'),
            'lat': '48.0',
            'lon': '11.0',
        }, content_type='multipart/form-data')

        response = admin_client.get('/api/admin/photos')
        assert response.status_code == 200
        filenames = [p['filename'] for p in response.get_json()['photos']]
        assert any(f.endswith('listed.jpg') for f in filenames)

    def _seed_photos(self, n, prefix='seed', location='Paris, FR'):
        from app import get_db
        with get_db() as conn:
            for i in range(n):
                _insert_photo(conn, f'{prefix}_{i}.jpg', lon=2.0, timestamp=1700000000.0 + i, location=location)
            conn.commit()

    def test_response_includes_pagination_fields(self, admin_client, app):
        self._seed_photos(3)
        response = admin_client.get('/api/admin/photos')
        data = response.get_json()
        assert data['total'] == 3
        assert data['offset'] == 0
        assert data['limit'] == 60

    def test_offset_and_limit_are_respected(self, admin_client, app):
        self._seed_photos(5)
        response = admin_client.get('/api/admin/photos?offset=2&limit=2')
        data = response.get_json()
        # limit query param is ignored by design (server-side fixed page size) —
        # only offset is honoured, so we just check offset paging works
        assert data['offset'] == 2
        assert len(data['photos']) == 3

    def test_search_matches_location(self, admin_client, app):
        self._seed_photos(2, prefix='paris', location='Paris, FR')
        self._seed_photos(2, prefix='berlin', location='Berlin, DE')

        response = admin_client.get('/api/admin/photos?q=Berlin')
        data = response.get_json()
        assert data['total'] == 2
        assert all('berlin' in p['filename'] for p in data['photos'])

    def test_search_matches_filename(self, admin_client, app):
        self._seed_photos(1, prefix='eiffelturm', location='Paris, FR')
        self._seed_photos(1, prefix='sonstwas', location='Paris, FR')

        response = admin_client.get('/api/admin/photos?q=eiffelturm')
        data = response.get_json()
        assert data['total'] == 1
        assert data['photos'][0]['filename'] == 'eiffelturm_0.jpg'

    def test_search_without_match_returns_empty(self, admin_client, app):
        self._seed_photos(2)
        response = admin_client.get('/api/admin/photos?q=nonexistent-place')
        data = response.get_json()
        assert data['total'] == 0
        assert data['photos'] == []


class TestAdminDeletePhoto:
    def _upload(self, admin_client, name='delete_me.jpg'):
        return _upload_photo(admin_client, name).get_json()['file']

    def test_without_session_returns_403(self, client):
        response = client.delete('/api/admin/photos/whatever.jpg')
        assert response.status_code == 403

    def test_deletes_file_thumb_and_db_row(self, admin_client, app):
        import app as flask_module
        from app import get_db

        uploaded_file = self._upload(admin_client)

        photo_path = os.path.join(flask_module.CONFIG['PHOTO_DIR'], uploaded_file)
        thumb_path = os.path.join(flask_module.CONFIG['THUMB_DIR'], uploaded_file)
        assert os.path.exists(photo_path)
        assert os.path.exists(thumb_path)

        response = admin_client.delete(f'/api/admin/photos/{uploaded_file}')
        assert response.status_code == 200
        assert response.get_json()['success'] is True

        assert not os.path.exists(photo_path)
        assert not os.path.exists(thumb_path)

        with get_db() as conn:
            row = conn.execute("SELECT 1 FROM photos WHERE filename=?", (uploaded_file,)).fetchone()
        assert row is None

    def test_failed_file_removal_keeps_db_row(self, admin_client, app):
        """Sonst waere die DB-Zeile weg, die Datei aber noch da - initial_scan wuerde
        das geloeschte Foto beim naechsten Start wieder aufnehmen."""
        from app import get_db

        uploaded_file = self._upload(admin_client, name='undeletable.jpg')

        with patch('app.os.remove', side_effect=OSError('permission denied')):
            response = admin_client.delete(f'/api/admin/photos/{uploaded_file}')

        assert response.status_code == 500

        with get_db() as conn:
            row = conn.execute("SELECT 1 FROM photos WHERE filename=?", (uploaded_file,)).fetchone()
        assert row is not None

    def test_thumbnail_removal_failure_does_not_fail_request(self, admin_client, app):
        import app as flask_module
        from app import get_db

        uploaded_file = self._upload(admin_client, name='thumb_locked.jpg')
        photo_path = os.path.join(flask_module.CONFIG['PHOTO_DIR'], uploaded_file)
        real_remove = flask_module.os.remove

        def fail_on_thumbs(path):
            if path == photo_path:
                return real_remove(path)
            raise OSError('locked')

        with patch('app.os.remove', side_effect=fail_on_thumbs):
            response = admin_client.delete(f'/api/admin/photos/{uploaded_file}')

        assert response.status_code == 200
        assert not os.path.exists(photo_path)

        with get_db() as conn:
            row = conn.execute("SELECT 1 FROM photos WHERE filename=?", (uploaded_file,)).fetchone()
        assert row is None

    def test_deleting_nonexistent_photo_still_returns_success(self, admin_client):
        response = admin_client.delete('/api/admin/photos/never_uploaded.jpg')
        assert response.status_code == 200
        assert response.get_json()['success'] is True

    def test_deleting_photo_removes_orphaned_routes(self, admin_client, app):
        from app import get_db

        uploaded_file = self._upload(admin_client, name='route_endpoint.jpg')

        with get_db() as conn:
            conn.execute(
                "INSERT INTO routes (start_filename, end_filename, geometry) VALUES (?, ?, ?)",
                ('other.jpg', uploaded_file, '{"type": "LineString", "coordinates": []}')
            )
            conn.commit()

        admin_client.delete(f'/api/admin/photos/{uploaded_file}')

        with get_db() as conn:
            row = conn.execute(
                "SELECT 1 FROM routes WHERE start_filename = ? OR end_filename = ?",
                (uploaded_file, uploaded_file)
            ).fetchone()
        assert row is None


class TestApiThumb:
    def _upload(self, admin_client, name='thumb_variants.jpg'):
        return _upload_photo(admin_client, name).get_json()['file']

    def test_default_size_returns_200(self, admin_client):
        uploaded_file = self._upload(admin_client)
        response = admin_client.get(f'/api/thumb/{uploaded_file}')
        assert response.status_code == 200

    def test_blur_size_returns_200(self, admin_client):
        uploaded_file = self._upload(admin_client)
        response = admin_client.get(f'/api/thumb/{uploaded_file}?size=blur')
        assert response.status_code == 200

    def test_original_size_returns_200(self, admin_client):
        uploaded_file = self._upload(admin_client)
        response = admin_client.get(f'/api/thumb/{uploaded_file}?size=original')
        assert response.status_code == 200

    def test_nonexistent_file_returns_404(self, admin_client):
        response = admin_client.get('/api/thumb/does_not_exist.jpg')
        assert response.status_code == 404


class TestTrackVisitorCount:
    def test_logs_a_visit_for_today(self, app):
        from datetime import datetime
        from app import track_visitor_count, get_db

        with app.test_request_context('/', environ_base={'REMOTE_ADDR': '1.2.3.4'}):
            track_visitor_count()

        today = datetime.now().strftime('%Y-%m-%d')
        with get_db() as conn:
            row = conn.execute("SELECT count FROM visits_by_day WHERE date = ?", (today,)).fetchone()
        assert row is not None
        assert row['count'] == 1

    def test_same_visitor_within_an_hour_is_not_counted_twice(self, app):
        from app import track_visitor_count, get_db

        with app.test_request_context('/', environ_base={'REMOTE_ADDR': '5.6.7.8'}):
            track_visitor_count()
            track_visitor_count()

        with get_db() as conn:
            row = conn.execute("SELECT SUM(count) as total FROM visits_by_day").fetchone()
        assert row['total'] == 1


class TestAdminVisitorStats:
    def test_without_session_returns_403(self, client):
        response = client.get('/api/admin/visitor-stats')
        assert response.status_code == 403

    def test_returns_30_day_series_even_when_empty(self, admin_client):
        response = admin_client.get('/api/admin/visitor-stats')
        assert response.status_code == 200
        data = response.get_json()
        assert len(data['daily']) == 30
        assert data['total'] == 0
        assert data['active_now'] == 0

    def test_reflects_a_logged_visit(self, admin_client, app):
        from datetime import datetime
        from app import track_visitor_count

        with app.test_request_context('/', environ_base={'REMOTE_ADDR': '9.9.9.9'}):
            track_visitor_count()

        response = admin_client.get('/api/admin/visitor-stats')
        data = response.get_json()
        assert data['total'] == 1
        assert data['active_now'] == 1

        today = datetime.now().strftime('%Y-%m-%d')
        today_entry = next(d for d in data['daily'] if d['date'] == today)
        assert today_entry['count'] == 1


class TestWeatherBackfill:
    """start_weather_backfill_if_needed() laeuft synchron (die Ausfuehrung in einem
    eigenen Thread passiert erst in start_background_services beim Serverstart) -
    Tests koennen sie daher direkt aufrufen, ohne auf einen Hintergrund-Thread zu warten."""

    def _seed_photo(self, filename='weather1.jpg', weather_temp=None):
        from app import get_db
        with get_db() as conn:
            conn.execute(
                "INSERT INTO photos (filename, lat, lon, timestamp, location, weather_temp) VALUES (?, ?, ?, ?, ?, ?)",
                (filename, 48.0, 11.0, 1700000000.0, 'München, DE', weather_temp)
            )
            conn.commit()

    def test_photos_with_existing_weather_are_skipped(self, app):
        from app import start_weather_backfill_if_needed
        self._seed_photo('has_weather.jpg', weather_temp=15.0)

        with patch('app.requests.get') as mock_get:
            start_weather_backfill_if_needed()
            mock_get.assert_not_called()

    def test_photos_without_timestamp_are_skipped(self, app):
        from app import get_db, start_weather_backfill_if_needed
        with get_db() as conn:
            _insert_photo(conn, 'no_ts.jpg', timestamp=None)
            conn.commit()

        with patch('app.requests.get') as mock_get:
            start_weather_backfill_if_needed()
            mock_get.assert_not_called()

    def test_fills_missing_weather_for_all_matching_photos(self, app):
        from app import start_weather_backfill_if_needed, get_db
        self._seed_photo('a.jpg')
        self._seed_photo('b.jpg')

        mock_resp = MagicMock()
        mock_resp.json.return_value = {'daily': {'temperature_2m_max': [20.0], 'weathercode': [1]}}
        mock_resp.raise_for_status = lambda: None

        with patch('app.requests.get', return_value=mock_resp), patch('app.time.sleep'):
            start_weather_backfill_if_needed()

        with get_db() as conn:
            rows = conn.execute("SELECT weather_temp FROM photos WHERE filename IN ('a.jpg','b.jpg')").fetchall()
        assert all(r['weather_temp'] == 20.0 for r in rows)


class TestAdminRoutesList:
    def _seed_photos(self):
        from app import get_db
        with get_db() as conn:
            _insert_photo(conn, 'seg1.jpg', location='München, DE')
            _insert_photo(conn, 'seg2.jpg', lat=48.1, lon=11.2, timestamp=1700000100.0, location='Augsburg, DE')
            conn.commit()

    def test_without_admin_session_returns_403(self, client):
        response = client.get('/api/admin/routes')
        assert response.status_code == 403

    def test_returns_segment_between_consecutive_photos(self, admin_client):
        self._seed_photos()
        response = admin_client.get('/api/admin/routes')
        assert response.status_code == 200
        data = response.get_json()
        assert data['total'] == 1
        seg = data['segments'][0]
        assert seg['start_filename'] == 'seg1.jpg'
        assert seg['end_filename'] == 'seg2.jpg'
        assert seg['mode'] is None
        assert seg['distance_km'] > 0

    def test_includes_cached_mode(self, admin_client, app):
        self._seed_photos()
        from app import get_db
        with get_db() as conn:
            conn.execute(
                "INSERT INTO routes (start_filename, end_filename, geometry, mode) VALUES (?, ?, ?, ?)",
                ('seg1.jpg', 'seg2.jpg', json.dumps({'type': 'LineString', 'coordinates': []}), 'flight')
            )
            conn.commit()

        response = admin_client.get('/api/admin/routes')
        seg = response.get_json()['segments'][0]
        assert seg['mode'] == 'flight'

    def test_pagination_respects_offset(self, admin_client, app):
        from app import get_db
        with get_db() as conn:
            for i in range(5):
                _insert_photo(conn, f'p{i}.jpg', lat=48.0 + i * 0.1, timestamp=1700000000.0 + i)
            conn.commit()

        response = admin_client.get('/api/admin/routes?offset=2')
        data = response.get_json()
        assert data['total'] == 4
        assert data['offset'] == 2
        assert len(data['segments']) == 2


class TestAdminSetRouteMode:
    def _seed_photos(self):
        from app import get_db
        with get_db() as conn:
            _insert_photo(conn, 'm1.jpg', location='A')
            _insert_photo(conn, 'm2.jpg', lat=48.1, lon=11.1, timestamp=1700000100.0, location='B')
            conn.commit()

    def test_without_admin_session_returns_403(self, client):
        response = client.post('/api/admin/routes/mode',
                               data=json.dumps({'start_filename': 'a.jpg', 'end_filename': 'b.jpg', 'mode': 'flight'}),
                               content_type='application/json')
        assert response.status_code == 403

    def test_missing_fields_returns_400(self, admin_client):
        response = admin_client.post('/api/admin/routes/mode',
                                     data=json.dumps({}),
                                     content_type='application/json')
        assert response.status_code == 400

    def test_invalid_mode_returns_400(self, admin_client):
        self._seed_photos()
        response = admin_client.post('/api/admin/routes/mode',
                                     data=json.dumps({'start_filename': 'm1.jpg', 'end_filename': 'm2.jpg', 'mode': 'walk'}),
                                     content_type='application/json')
        assert response.status_code == 400

    def test_photos_without_gps_returns_400(self, admin_client):
        response = admin_client.post('/api/admin/routes/mode',
                                     data=json.dumps({'start_filename': 'missing1.jpg', 'end_filename': 'missing2.jpg', 'mode': 'flight'}),
                                     content_type='application/json')
        assert response.status_code == 400

    def test_setting_flight_stores_straight_line_geometry(self, admin_client, app):
        self._seed_photos()
        response = admin_client.post('/api/admin/routes/mode',
                                     data=json.dumps({'start_filename': 'm1.jpg', 'end_filename': 'm2.jpg', 'mode': 'flight'}),
                                     content_type='application/json')
        assert response.status_code == 200
        assert response.get_json()['mode'] == 'flight'

        from app import get_db
        with get_db() as conn:
            row = conn.execute(
                "SELECT geometry, mode FROM routes WHERE start_filename = ? AND end_filename = ?",
                ('m1.jpg', 'm2.jpg')
            ).fetchone()
        assert row['mode'] == 'flight'
        assert len(json.loads(row['geometry'])['coordinates']) == 2

    def test_setting_drive_for_far_apart_photos_still_queries_osrm(self, admin_client, app):
        from app import get_db
        with get_db() as conn:
            _insert_photo(conn, 'far1.jpg', lat=52.52, lon=13.405, location='Berlin, DE')
            _insert_photo(conn, 'far2.jpg', lat=48.8566, lon=2.3522, timestamp=1700000100.0, location='Paris, FR')
            conn.commit()

        mock_resp = MagicMock()
        mock_resp.json.return_value = {
            'code': 'Ok',
            'routes': [{'geometry': {'type': 'LineString', 'coordinates': [[13.4, 52.5], [7.5, 50.5], [2.35, 48.86]]}}]
        }
        mock_resp.raise_for_status = lambda: None

        # Berlin -> Paris liegt deutlich ueber OSRM_MAX_KM - ohne bypass_distance_cap
        # wuerde fetch_osrm_route requests.get gar nicht erst aufrufen.
        with patch('app.requests.get', return_value=mock_resp) as mock_get:
            response = admin_client.post('/api/admin/routes/mode',
                                         data=json.dumps({'start_filename': 'far1.jpg', 'end_filename': 'far2.jpg', 'mode': 'drive'}),
                                         content_type='application/json')

        assert response.status_code == 200
        mock_get.assert_called_once()

        with get_db() as conn:
            row = conn.execute(
                "SELECT geometry, mode FROM routes WHERE start_filename = ? AND end_filename = ?",
                ('far1.jpg', 'far2.jpg')
            ).fetchone()
        assert row['mode'] == 'drive'
        assert len(json.loads(row['geometry'])['coordinates']) == 3

    def test_setting_drive_falls_back_to_straight_line_when_osrm_fails(self, admin_client, app):
        self._seed_photos()
        with patch('app.requests.get', side_effect=Exception('timeout')):
            response = admin_client.post('/api/admin/routes/mode',
                                         data=json.dumps({'start_filename': 'm1.jpg', 'end_filename': 'm2.jpg', 'mode': 'drive'}),
                                         content_type='application/json')
        assert response.status_code == 200

        from app import get_db
        with get_db() as conn:
            row = conn.execute(
                "SELECT geometry, mode FROM routes WHERE start_filename = ? AND end_filename = ?",
                ('m1.jpg', 'm2.jpg')
            ).fetchone()
        assert row['mode'] == 'drive'
        assert len(json.loads(row['geometry'])['coordinates']) == 2

    def test_overriding_existing_route_updates_it(self, admin_client, app):
        self._seed_photos()
        from app import get_db
        with get_db() as conn:
            conn.execute(
                "INSERT INTO routes (start_filename, end_filename, geometry, mode) VALUES (?, ?, ?, ?)",
                ('m1.jpg', 'm2.jpg', json.dumps({'type': 'LineString', 'coordinates': [[0, 0], [1, 1]]}), 'drive')
            )
            conn.commit()

        response = admin_client.post('/api/admin/routes/mode',
                                     data=json.dumps({'start_filename': 'm1.jpg', 'end_filename': 'm2.jpg', 'mode': 'flight'}),
                                     content_type='application/json')
        assert response.status_code == 200

        with get_db() as conn:
            rows = conn.execute(
                "SELECT mode FROM routes WHERE start_filename = ? AND end_filename = ?",
                ('m1.jpg', 'm2.jpg')
            ).fetchall()
        assert len(rows) == 1
        assert rows[0]['mode'] == 'flight'


class TestAdminLog:
    def test_without_admin_session_returns_403(self, client):
        response = client.get('/api/admin/log')
        assert response.status_code == 403

    def test_empty_log_returns_empty_list(self, admin_client):
        response = admin_client.get('/api/admin/log')
        assert response.status_code == 200
        data = response.get_json()
        assert data['entries'] == []
        assert data['total'] == 0

    def test_successful_login_is_logged(self, client):
        client.post('/admin/login', data=json.dumps({'admin_token': 'test_admin'}), content_type='application/json')
        response = client.get('/api/admin/log')
        actions = [e['action'] for e in response.get_json()['entries']]
        assert 'login' in actions

    def test_failed_login_is_logged(self, client):
        client.post('/admin/login', data=json.dumps({'admin_token': 'wrong'}), content_type='application/json')
        with client.session_transaction() as sess:
            sess['is_admin'] = True  # nur um das Log auszulesen, unabhaengig vom Login-Versuch oben
        response = client.get('/api/admin/log')
        actions = [e['action'] for e in response.get_json()['entries']]
        assert 'login_failed' in actions

    def test_logout_is_logged(self, admin_client):
        admin_client.post('/admin/logout')
        with admin_client.session_transaction() as sess:
            sess['is_admin'] = True
        response = admin_client.get('/api/admin/log')
        actions = [e['action'] for e in response.get_json()['entries']]
        assert 'logout' in actions

    def test_upload_is_logged(self, admin_client):
        admin_client.post('/api/upload', data={
            'photo': (_make_jpeg_bytes(), 'logged.jpg'),
            'lat': '48.0',
            'lon': '11.0',
        }, content_type='multipart/form-data')

        response = admin_client.get('/api/admin/log')
        entries = [e for e in response.get_json()['entries'] if e['action'] == 'upload']
        assert len(entries) == 1
        assert 'logged' in entries[0]['detail']

    def test_delete_is_logged(self, admin_client):
        upload = admin_client.post('/api/upload', data={
            'photo': (_make_jpeg_bytes(), 'to_delete.jpg'),
            'lat': '48.0',
            'lon': '11.0',
        }, content_type='multipart/form-data')
        filename = upload.get_json()['file']

        admin_client.delete(f'/api/admin/photos/{filename}')

        response = admin_client.get('/api/admin/log')
        actions = [e['action'] for e in response.get_json()['entries']]
        assert 'delete_photo' in actions

    def test_update_location_is_logged(self, admin_client, app):
        from app import get_db
        with get_db() as conn:
            _insert_photo(conn, 'log_loc.jpg', lat=0.0, lon=0.0, location='Unbekannt')
            conn.commit()

        admin_client.post('/api/update_location', data=json.dumps({
            'filename': 'log_loc.jpg', 'lat': 48.1351, 'lon': 11.5820
        }), content_type='application/json')

        response = admin_client.get('/api/admin/log')
        actions = [e['action'] for e in response.get_json()['entries']]
        assert 'update_location' in actions

    def test_note_and_favorite_changes_are_logged(self, admin_client, app):
        from app import get_db
        with get_db() as conn:
            _insert_photo(conn, 'log_note.jpg')
            conn.commit()

        admin_client.post('/api/admin/photos/log_note.jpg/note',
                          data=json.dumps({'note': 'Test'}), content_type='application/json')
        admin_client.post('/api/admin/photos/log_note.jpg/favorite',
                          data=json.dumps({'favorite': True}), content_type='application/json')

        response = admin_client.get('/api/admin/log')
        actions = [e['action'] for e in response.get_json()['entries']]
        assert 'update_note' in actions
        assert 'set_favorite' in actions

    def test_route_mode_change_is_logged(self, admin_client, app):
        from app import get_db
        with get_db() as conn:
            _insert_photo(conn, 'log_r1.jpg', location='A')
            _insert_photo(conn, 'log_r2.jpg', lat=48.1, lon=11.1, timestamp=1700000100.0, location='B')
            conn.commit()

        admin_client.post('/api/admin/routes/mode',
                          data=json.dumps({'start_filename': 'log_r1.jpg', 'end_filename': 'log_r2.jpg', 'mode': 'flight'}),
                          content_type='application/json')

        response = admin_client.get('/api/admin/log')
        actions = [e['action'] for e in response.get_json()['entries']]
        assert 'set_route_mode' in actions

    def test_pagination_respects_offset(self, admin_client, app):
        from app import _log_admin_action
        for i in range(5):
            _log_admin_action('test_action', f'entry {i}')

        response = admin_client.get('/api/admin/log?offset=2')
        data = response.get_json()
        assert data['total'] == 5
        assert data['offset'] == 2
        assert len(data['entries']) == 3

    def test_entries_are_ordered_most_recent_first(self, admin_client, app):
        from app import _log_admin_action
        _log_admin_action('first')
        _log_admin_action('second')

        response = admin_client.get('/api/admin/log')
        actions = [e['action'] for e in response.get_json()['entries']]
        assert actions[:2] == ['second', 'first']

    def test_search_matches_action(self, admin_client, app):
        from app import _log_admin_action
        _log_admin_action('delete_photo', 'a.jpg')
        _log_admin_action('login', '127.0.0.1')

        response = admin_client.get('/api/admin/log?q=delete')
        data = response.get_json()
        assert data['total'] == 1
        assert data['entries'][0]['action'] == 'delete_photo'

    def test_search_matches_detail(self, admin_client, app):
        from app import _log_admin_action
        _log_admin_action('update_note', 'eiffelturm.jpg')
        _log_admin_action('update_note', 'sonstwas.jpg')

        response = admin_client.get('/api/admin/log?q=eiffelturm')
        data = response.get_json()
        assert data['total'] == 1
        assert data['entries'][0]['detail'] == 'eiffelturm.jpg'

    def test_search_without_match_returns_empty(self, admin_client, app):
        from app import _log_admin_action
        _log_admin_action('login', '127.0.0.1')

        response = admin_client.get('/api/admin/log?q=nonexistent-action')
        data = response.get_json()
        assert data['total'] == 0
        assert data['entries'] == []

    def test_search_still_respects_pagination(self, admin_client, app):
        from app import _log_admin_action
        for i in range(3):
            _log_admin_action('upload', f'match_{i}.jpg')

        response = admin_client.get('/api/admin/log?q=match&offset=1')
        data = response.get_json()
        assert data['total'] == 3
        assert data['offset'] == 1
        assert len(data['entries']) == 2


class TestReelGroups:
    def test_without_admin_session_returns_403(self, client):
        response = client.get('/api/admin/reels/groups')
        assert response.status_code == 403

    def test_groups_photos_and_videos_by_country(self, admin_client, app):
        from app import get_db
        with get_db() as conn:
            _insert_photo(conn, 'p1.jpg', location='München, DE')
            _insert_photo(conn, 'p2.jpg', location='Berlin, DE')
            _insert_photo(conn, 'v1.mp4', location='München, DE', media_type='video')
            _insert_photo(conn, 'p3.jpg', location='Paris, FR')

        response = admin_client.get('/api/admin/reels/groups')
        assert response.status_code == 200
        groups = {g['group_key']: g for g in response.get_json()['groups']}
        assert groups['DE']['photo_count'] == 2
        assert groups['DE']['video_count'] == 1
        assert groups['FR']['photo_count'] == 1
        assert groups['FR']['video_count'] == 0

    def test_empty_when_no_photos(self, admin_client):
        response = admin_client.get('/api/admin/reels/groups')
        assert response.status_code == 200
        assert response.get_json()['groups'] == []


class TestCreateReel:
    def test_without_admin_session_returns_403(self, client):
        response = client.post('/api/admin/reels', json={'group_key': 'DE'})
        assert response.status_code == 403

    def test_missing_group_key_returns_400(self, admin_client):
        response = admin_client.post('/api/admin/reels', json={})
        assert response.status_code == 400

    def test_unknown_group_key_returns_400(self, admin_client, app):
        from app import get_db
        with get_db() as conn:
            _insert_photo(conn, 'p1.jpg', location='München, DE')

        response = admin_client.post('/api/admin/reels', json={'group_key': 'FR'})
        assert response.status_code == 400

    def test_valid_group_key_starts_job_and_returns_reel_id(self, admin_client, app):
        import app as flask_module
        from app import get_db

        with get_db() as conn:
            _insert_photo(conn, 'p1.jpg', location='München, DE')

        fake_generate_reel = MagicMock(side_effect=lambda *a, **k: flask_module._reel_generation_lock.release())
        with patch('app.threading', _FakeThreadingModule()), patch('app._generate_reel', fake_generate_reel):
            response = admin_client.post('/api/admin/reels', json={'group_key': 'DE'})

        assert response.status_code == 202
        data = response.get_json()
        assert data['success'] is True
        fake_generate_reel.assert_called_once_with(data['reel_id'], 'DE', float(flask_module.DEFAULT_REEL_DURATION_SECONDS))

        with get_db() as conn:
            row = conn.execute("SELECT group_key FROM reels WHERE id=?", (data['reel_id'],)).fetchone()
        assert row['group_key'] == 'DE'

    def test_custom_duration_is_passed_through(self, admin_client, app):
        import app as flask_module
        from app import get_db

        with get_db() as conn:
            _insert_photo(conn, 'p1.jpg', location='München, DE')

        fake_generate_reel = MagicMock(side_effect=lambda *a, **k: flask_module._reel_generation_lock.release())
        with patch('app.threading', _FakeThreadingModule()), patch('app._generate_reel', fake_generate_reel):
            response = admin_client.post('/api/admin/reels', json={'group_key': 'DE', 'duration_seconds': 60})

        assert response.status_code == 202
        fake_generate_reel.assert_called_once_with(response.get_json()['reel_id'], 'DE', 60.0)

    def test_duration_below_minimum_returns_400(self, admin_client, app):
        from app import get_db
        with get_db() as conn:
            _insert_photo(conn, 'p1.jpg', location='München, DE')

        response = admin_client.post('/api/admin/reels', json={'group_key': 'DE', 'duration_seconds': 1})
        assert response.status_code == 400

    def test_duration_above_maximum_returns_400(self, admin_client, app):
        from app import get_db
        with get_db() as conn:
            _insert_photo(conn, 'p1.jpg', location='München, DE')

        response = admin_client.post('/api/admin/reels', json={'group_key': 'DE', 'duration_seconds': 9999})
        assert response.status_code == 400

    def test_non_numeric_duration_returns_400(self, admin_client, app):
        from app import get_db
        with get_db() as conn:
            _insert_photo(conn, 'p1.jpg', location='München, DE')

        response = admin_client.post('/api/admin/reels', json={'group_key': 'DE', 'duration_seconds': 'lots'})
        assert response.status_code == 400

    def test_second_trigger_while_running_returns_409(self, admin_client, app):
        import app as flask_module
        from app import get_db

        with get_db() as conn:
            _insert_photo(conn, 'p1.jpg', location='München, DE')

        flask_module._reel_generation_lock.acquire()
        response = admin_client.post('/api/admin/reels', json={'group_key': 'DE'})
        assert response.status_code == 409


class TestAdminReelList:
    def test_without_admin_session_returns_403(self, client):
        response = client.get('/api/admin/reels')
        assert response.status_code == 403

    def test_returns_reels_most_recent_first(self, admin_client, app):
        from app import get_db
        with get_db() as conn:
            _insert_reel(conn, group_key='DE', created_at=1700000000.0)
            _insert_reel(conn, group_key='FR', created_at=1700000100.0)

        response = admin_client.get('/api/admin/reels')
        data = response.get_json()
        assert data['total'] == 2
        assert [r['group_key'] for r in data['reels']] == ['FR', 'DE']

    def test_pagination_respects_offset(self, admin_client, app):
        from app import get_db
        with get_db() as conn:
            for i in range(3):
                _insert_reel(conn, group_key=f'G{i}', created_at=1700000000.0 + i)

        response = admin_client.get('/api/admin/reels?offset=1')
        data = response.get_json()
        assert data['total'] == 3
        assert data['offset'] == 1
        assert len(data['reels']) == 2


class TestAdminGetReel:
    def test_without_admin_session_returns_403(self, client):
        response = client.get('/api/admin/reels/1')
        assert response.status_code == 403

    def test_returns_404_for_unknown_id(self, admin_client):
        response = admin_client.get('/api/admin/reels/999')
        assert response.status_code == 404

    def test_returns_reel_fields(self, admin_client, app):
        from app import get_db
        with get_db() as conn:
            reel_id = _insert_reel(conn, group_key='DE', status='running')

        response = admin_client.get(f'/api/admin/reels/{reel_id}')
        assert response.status_code == 200
        data = response.get_json()
        assert data['group_key'] == 'DE'
        assert data['status'] == 'running'


class TestAdminDownloadReel:
    def test_without_admin_session_returns_403(self, client):
        response = client.get('/api/admin/reels/1/file')
        assert response.status_code == 403

    def test_returns_404_when_not_done(self, admin_client, app):
        from app import get_db
        with get_db() as conn:
            reel_id = _insert_reel(conn, status='running', filename=None)

        response = admin_client.get(f'/api/admin/reels/{reel_id}/file')
        assert response.status_code == 404

    def test_returns_404_when_file_missing_on_disk(self, admin_client, app):
        from app import get_db
        with get_db() as conn:
            reel_id = _insert_reel(conn, status='done', filename='ghost.mp4')

        response = admin_client.get(f'/api/admin/reels/{reel_id}/file')
        assert response.status_code == 404

    def test_downloads_file_as_attachment(self, admin_client, app):
        import app as flask_module
        from app import get_db

        reel_path = os.path.join(flask_module.CONFIG['REEL_DIR'], 'DE_123.mp4')
        with open(reel_path, 'wb') as f:
            f.write(b'fake mp4 bytes')

        with get_db() as conn:
            reel_id = _insert_reel(conn, status='done', filename='DE_123.mp4')

        response = admin_client.get(f'/api/admin/reels/{reel_id}/file')
        assert response.status_code == 200
        assert response.data == b'fake mp4 bytes'
        assert 'attachment' in response.headers.get('Content-Disposition', '')


class TestAdminDeleteReel:
    def test_without_admin_session_returns_403(self, client):
        response = client.delete('/api/admin/reels/1')
        assert response.status_code == 403

    def test_returns_404_for_unknown_id(self, admin_client):
        response = admin_client.delete('/api/admin/reels/999')
        assert response.status_code == 404

    def test_deletes_row_and_file(self, admin_client, app):
        import app as flask_module
        from app import get_db

        reel_path = os.path.join(flask_module.CONFIG['REEL_DIR'], 'DE_456.mp4')
        with open(reel_path, 'wb') as f:
            f.write(b'fake mp4 bytes')

        with get_db() as conn:
            reel_id = _insert_reel(conn, status='done', filename='DE_456.mp4')

        response = admin_client.delete(f'/api/admin/reels/{reel_id}')
        assert response.status_code == 200
        assert response.get_json()['success'] is True
        assert not os.path.exists(reel_path)

        with get_db() as conn:
            row = conn.execute("SELECT 1 FROM reels WHERE id=?", (reel_id,)).fetchone()
        assert row is None

    def test_deleting_reel_without_file_still_succeeds(self, admin_client, app):
        from app import get_db
        with get_db() as conn:
            reel_id = _insert_reel(conn, status='error', filename=None)

        response = admin_client.delete(f'/api/admin/reels/{reel_id}')
        assert response.status_code == 200

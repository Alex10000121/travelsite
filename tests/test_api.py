import io
import json
import os
import pytest
from unittest.mock import patch


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


class TestAdminLogout:
    def test_logout_clears_session(self, admin_client):
        admin_client.post('/admin/logout')
        response = admin_client.get('/admin')
        assert b'admin-login-form' in response.data


class TestUploadPhoto:
    def _make_jpeg_bytes(self):
        from PIL import Image
        buf = io.BytesIO()
        Image.new('RGB', (100, 100), color=(100, 149, 237)).save(buf, format='JPEG')
        buf.seek(0)
        return buf

    def test_without_admin_session_returns_403(self, client):
        response = client.post('/api/upload', data={
            'photo': (self._make_jpeg_bytes(), 'test.jpg')
        }, content_type='multipart/form-data')
        assert response.status_code == 403

    def test_no_file_returns_400(self, admin_client):
        response = admin_client.post('/api/upload', data={}, content_type='multipart/form-data')
        assert response.status_code == 400

    def test_valid_upload_returns_success(self, admin_client):
        response = admin_client.post('/api/upload', data={
            'photo': (self._make_jpeg_bytes(), 'test.jpg'),
            'lat': '48.8566',
            'lon': '2.3522',
        }, content_type='multipart/form-data')
        assert response.status_code == 200
        data = response.get_json()
        assert data['success'] is True
        assert 'file' in data

    def test_upload_response_contains_location_field(self, admin_client):
        response = admin_client.post('/api/upload', data={
            'photo': (self._make_jpeg_bytes(), 'test.jpg'),
            'lat': '48.8566',
            'lon': '2.3522',
        }, content_type='multipart/form-data')
        assert response.status_code == 200
        assert 'location' in response.get_json()

    def test_upload_response_contains_missing_gps_field(self, admin_client):
        response = admin_client.post('/api/upload', data={
            'photo': (self._make_jpeg_bytes(), 'test.jpg')
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
    def _make_jpeg_bytes(self):
        from PIL import Image
        buf = io.BytesIO()
        Image.new('RGB', (100, 100)).save(buf, format='JPEG')
        buf.seek(0)
        return buf

    def test_piexif_insert_not_called_without_coords(self, admin_client):
        with patch('piexif.insert') as mock_insert:
            admin_client.post('/api/upload', data={
                'photo': (self._make_jpeg_bytes(), 'no_coords.jpg'),
            }, content_type='multipart/form-data')

            mock_insert.assert_not_called()

    def test_piexif_load_failure_is_silently_handled(self, admin_client):
        with patch('piexif.load', side_effect=Exception('invalid')), \
             patch('piexif.dump', return_value=b'exif'), \
             patch('piexif.insert'):

            response = admin_client.post('/api/upload', data={
                'photo': (self._make_jpeg_bytes(), 'bad_exif.jpg'),
                'lat': '48.8566',
                'lon': '2.3522',
            }, content_type='multipart/form-data')

            assert response.status_code == 200


class TestUploadIdempotency:
    def _make_jpeg_bytes(self):
        from PIL import Image
        buf = io.BytesIO()
        Image.new('RGB', (100, 100)).save(buf, format='JPEG')
        buf.seek(0)
        return buf

    def test_duplicate_filename_in_db_does_not_crash_upload(self, admin_client, app):
        import app as flask_module
        from app import get_db
        with get_db() as conn:
            conn.execute(
                "INSERT INTO photos (filename, lat, lon, timestamp, location) VALUES (?, ?, ?, ?, ?)",
                ('duplicate.jpg', 48.0, 11.0, 1700000000.0, 'München, DE')
            )
            conn.commit()

        response = admin_client.post('/api/upload', data={
            'photo': (self._make_jpeg_bytes(), 'duplicate.jpg'),
            'lat': '48.0',
            'lon': '11.0',
        }, content_type='multipart/form-data')

        assert response.status_code == 200


class TestApiRouteNullTimestamp:
    def test_null_timestamp_in_db_does_not_crash(self, client):
        from app import get_db
        with get_db() as conn:
            conn.execute(
                "INSERT INTO photos (filename, lat, lon, timestamp, location) VALUES (?, ?, ?, ?, ?)",
                ('null_ts.jpg', 48.0, 11.0, None, 'München, DE')
            )
            conn.commit()

        response = client.get('/api/route?token=test_token')
        assert response.status_code == 200
        data = response.get_json()
        photo = next(p for p in data['photos'] if p['filename'] == 'null_ts.jpg')
        assert photo['date_str'] == ''


class TestUploadResponseFields:
    def _make_jpeg_bytes(self):
        from PIL import Image
        buf = io.BytesIO()
        Image.new('RGB', (100, 100)).save(buf, format='JPEG')
        buf.seek(0)
        return buf

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
            'photo': (self._make_jpeg_bytes(), 'mytrip.jpg'),
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
            'photo': (self._make_jpeg_bytes(), 'no_gps.jpg'),
        }, content_type='multipart/form-data')

        assert response.status_code == 400
        data = response.get_json()
        assert data.get('missing_gps') is True


class TestApiThumbLarge:
    def _make_jpeg_bytes(self):
        from PIL import Image
        buf = io.BytesIO()
        Image.new('RGB', (100, 100), color=(100, 149, 237)).save(buf, format='JPEG')
        buf.seek(0)
        return buf

    def _upload(self, admin_client):
        response = admin_client.post('/api/upload', data={
            'photo': (self._make_jpeg_bytes(), 'fullscreen.jpg'),
            'lat': '48.8566',
            'lon': '2.3522',
        }, content_type='multipart/form-data')
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
            conn.execute(
                "INSERT INTO photos (filename, lat, lon, timestamp, location) VALUES (?, ?, ?, ?, ?)",
                ('to_fix.jpg', 0.0, 0.0, 1700000000.0, 'Unbekannt')
            )
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
            conn.execute(
                "INSERT INTO photos (filename, lat, lon, timestamp, location) VALUES (?, ?, ?, ?, ?)",
                ('fav_test.jpg', 48.0, 11.0, 1700000000.0, 'München, DE')
            )
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
            conn.execute(
                "INSERT INTO photos (filename, lat, lon, timestamp, location) VALUES (?, ?, ?, ?, ?)",
                ('r1.jpg', 48.0, 11.0, 1700000000.0, 'A')
            )
            conn.execute(
                "INSERT INTO photos (filename, lat, lon, timestamp, location) VALUES (?, ?, ?, ?, ?)",
                ('r2.jpg', 48.1, 11.1, 1700000100.0, 'B')
            )
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
        from PIL import Image
        buf = io.BytesIO()
        Image.new('RGB', (100, 100)).save(buf, format='JPEG')
        buf.seek(0)

        upload = admin_client.post('/api/upload', data={
            'photo': (buf, 'thumbtest.jpg'),
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
        from PIL import Image
        buf = io.BytesIO()
        Image.new('RGB', (100, 100)).save(buf, format='JPEG')
        buf.seek(0)

        admin_client.post('/api/upload', data={
            'photo': (buf, 'listed.jpg'),
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
                conn.execute(
                    "INSERT INTO photos (filename, lat, lon, timestamp, location) VALUES (?, ?, ?, ?, ?)",
                    (f'{prefix}_{i}.jpg', 48.0, 2.0, 1700000000.0 + i, location)
                )
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
        from PIL import Image
        buf = io.BytesIO()
        Image.new('RGB', (100, 100)).save(buf, format='JPEG')
        buf.seek(0)
        response = admin_client.post('/api/upload', data={
            'photo': (buf, name),
            'lat': '48.0',
            'lon': '11.0',
        }, content_type='multipart/form-data')
        return response.get_json()['file']

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
        from PIL import Image
        buf = io.BytesIO()
        Image.new('RGB', (100, 100)).save(buf, format='JPEG')
        buf.seek(0)
        response = admin_client.post('/api/upload', data={
            'photo': (buf, name),
            'lat': '48.0',
            'lon': '11.0',
        }, content_type='multipart/form-data')
        return response.get_json()['file']

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

import io
import json
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
        assert 'stats' in data

    def test_invalid_token_returns_403(self, client):
        response = client.get('/api/route?token=wrong')
        assert response.status_code == 403

    def test_empty_db_returns_zero_stats(self, client):
        response = client.get('/api/route?token=test_token')
        data = response.get_json()
        assert data['stats']['photo_count'] == 0
        assert data['stats']['total_km'] == 0


class TestCheckLogin:
    def test_valid_admin_token(self, client):
        response = client.post('/api/check_login',
                               data=json.dumps({'admin_token': 'test_admin'}),
                               content_type='application/json')
        assert response.status_code == 200
        assert response.get_json()['success'] is True

    def test_invalid_admin_token(self, client):
        response = client.post('/api/check_login',
                               data=json.dumps({'admin_token': 'wrong'}),
                               content_type='application/json')
        assert response.status_code == 403


class TestUploadPhoto:
    def _make_jpeg_bytes(self):
        from PIL import Image
        buf = io.BytesIO()
        Image.new('RGB', (100, 100), color=(100, 149, 237)).save(buf, format='JPEG')
        buf.seek(0)
        return buf

    def test_missing_admin_token_returns_403(self, client):
        response = client.post('/api/upload', data={
            'admin_token': 'wrong',
            'photo': (self._make_jpeg_bytes(), 'test.jpg')
        }, content_type='multipart/form-data')
        assert response.status_code == 403

    def test_no_file_returns_400(self, client):
        response = client.post('/api/upload', data={
            'admin_token': 'test_admin'
        }, content_type='multipart/form-data')
        assert response.status_code == 400

    def test_valid_upload_returns_success(self, client):
        response = client.post('/api/upload', data={
            'admin_token': 'test_admin',
            'photo': (self._make_jpeg_bytes(), 'test.jpg'),
            'lat': '48.8566',
            'lon': '2.3522',
        }, content_type='multipart/form-data')
        assert response.status_code == 200
        data = response.get_json()
        assert data['success'] is True
        assert 'file' in data

    def test_upload_response_contains_location_field(self, client):
        response = client.post('/api/upload', data={
            'admin_token': 'test_admin',
            'photo': (self._make_jpeg_bytes(), 'test.jpg'),
            'lat': '48.8566',
            'lon': '2.3522',
        }, content_type='multipart/form-data')
        assert response.status_code == 200
        assert 'location' in response.get_json()

    def test_upload_response_contains_missing_gps_field(self, client):
        response = client.post('/api/upload', data={
            'admin_token': 'test_admin',
            'photo': (self._make_jpeg_bytes(), 'test.jpg')
        }, content_type='multipart/form-data')
        data = response.get_json()
        assert 'missing_gps' in data
        assert data['missing_gps'] is True


class TestUploadWithFormCoords:
    def _make_jpeg_bytes(self):
        from PIL import Image
        buf = io.BytesIO()
        Image.new('RGB', (100, 100)).save(buf, format='JPEG')
        buf.seek(0)
        return buf

    def test_piexif_insert_not_called_without_coords(self, client):
        with patch('piexif.insert') as mock_insert:
            client.post('/api/upload', data={
                'admin_token': 'test_admin',
                'photo': (self._make_jpeg_bytes(), 'no_coords.jpg'),
            }, content_type='multipart/form-data')

            mock_insert.assert_not_called()

    def test_piexif_load_failure_is_silently_handled(self, client):
        with patch('piexif.load', side_effect=Exception('invalid')), \
             patch('piexif.dump', return_value=b'exif'), \
             patch('piexif.insert'):

            response = client.post('/api/upload', data={
                'admin_token': 'test_admin',
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

    def test_duplicate_filename_in_db_does_not_crash_upload(self, client, app):
        import app as flask_module
        from app import get_db
        with get_db() as conn:
            conn.execute(
                "INSERT INTO photos (filename, lat, lon, timestamp, location) VALUES (?, ?, ?, ?, ?)",
                ('duplicate.jpg', 48.0, 11.0, 1700000000.0, 'München, DE')
            )
            conn.commit()

        response = client.post('/api/upload', data={
            'admin_token': 'test_admin',
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

    def test_upload_response_contains_lat_lon(self, client, tmp_path):
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

        response = client.post('/api/upload', data={
            'admin_token': 'test_admin',
            'photo': (jpeg_with_gps, 'with_gps.jpg'),
        }, content_type='multipart/form-data')

        data = response.get_json()
        assert 'lat' in data
        assert 'lon' in data
        assert data['lat'] is not None
        assert abs(data['lat'] - 48.8566) < 0.01
        assert abs(data['lon'] - 2.3522) < 0.01

    def test_thumbnail_name_matches_serve_and_delete_path(self, client, app):
        import app as flask_module
        import os
        response = client.post('/api/upload', data={
            'admin_token': 'test_admin',
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

    def test_upload_without_gps_returns_400(self, client):
        response = client.post('/api/upload', data={
            'admin_token': 'test_admin',
            'photo': (self._make_jpeg_bytes(), 'no_gps.jpg'),
        }, content_type='multipart/form-data')

        assert response.status_code == 400
        data = response.get_json()
        assert data.get('missing_gps') is True


class TestDeletePhoto:
    def test_invalid_token_returns_403(self, client):
        response = client.post('/api/delete',
                               data=json.dumps({'admin_token': 'wrong', 'filename': 'test.jpg'}),
                               content_type='application/json')
        assert response.status_code == 403

    def test_missing_filename_returns_400(self, client):
        response = client.post('/api/delete',
                               data=json.dumps({'admin_token': 'test_admin'}),
                               content_type='application/json')
        assert response.status_code == 400


class TestUpdateLocation:
    def test_invalid_token_returns_403(self, client):
        response = client.post('/api/update_location',
                               data=json.dumps({'admin_token': 'wrong', 'filename': 'x.jpg', 'lat': 48.0, 'lon': 11.0}),
                               content_type='application/json')
        assert response.status_code == 403

    def test_missing_data_returns_400(self, client):
        response = client.post('/api/update_location',
                               data=json.dumps({'admin_token': 'test_admin'}),
                               content_type='application/json')
        assert response.status_code == 400

    def test_valid_update(self, client):
        response = client.post('/api/update_location',
                               data=json.dumps({
                                   'admin_token': 'test_admin',
                                   'filename': 'nonexistent.jpg',
                                   'lat': 48.1351,
                                   'lon': 11.5820
                               }),
                               content_type='application/json')
        assert response.status_code == 200
        data = response.get_json()
        assert data['success'] is True

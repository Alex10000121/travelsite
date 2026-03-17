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
            'photo': (self._make_jpeg_bytes(), 'test.jpg')
        }, content_type='multipart/form-data')
        assert response.status_code == 200
        data = response.get_json()
        assert data['success'] is True
        assert 'file' in data

    def test_upload_response_contains_location_field(self, client):
        response = client.post('/api/upload', data={
            'admin_token': 'test_admin',
            'photo': (self._make_jpeg_bytes(), 'test.jpg')
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

    def test_piexif_insert_called_when_coords_provided(self, client):
        with patch('piexif.load') as mock_load, \
             patch('piexif.dump', return_value=b'exif'), \
             patch('piexif.insert') as mock_insert:
            mock_load.return_value = {'0th': {}, 'Exif': {}, 'GPS': {}, '1st': {}}

            client.post('/api/upload', data={
                'admin_token': 'test_admin',
                'photo': (self._make_jpeg_bytes(), 'coords.jpg'),
                'lat': '48.8566',
                'lon': '2.3522',
                'timestamp': '1689418800',
            }, content_type='multipart/form-data')

            mock_insert.assert_called_once()

    def test_upload_with_coords_returns_success(self, client):
        with patch('piexif.load') as mock_load, \
             patch('piexif.dump', return_value=b'exif'), \
             patch('piexif.insert'):
            mock_load.return_value = {'0th': {}, 'Exif': {}, 'GPS': {}, '1st': {}}

            response = client.post('/api/upload', data={
                'admin_token': 'test_admin',
                'photo': (self._make_jpeg_bytes(), 'coords.jpg'),
                'lat': '48.8566',
                'lon': '2.3522',
            }, content_type='multipart/form-data')

            assert response.status_code == 200
            data = response.get_json()
            assert data['success'] is True
            assert data['missing_gps'] is False
            assert 'location' in data

    def test_upload_with_coords_location_is_not_unbekannt(self, client):
        with patch('piexif.load') as mock_load, \
             patch('piexif.dump', return_value=b'exif'), \
             patch('piexif.insert'), \
             patch('app.get_location_name', return_value='Unbekannt'):
            mock_load.return_value = {'0th': {}, 'Exif': {}, 'GPS': {}, '1st': {}}

            response = client.post('/api/upload', data={
                'admin_token': 'test_admin',
                'photo': (self._make_jpeg_bytes(), 'coords.jpg'),
                'lat': '48.8566',
                'lon': '2.3522',
            }, content_type='multipart/form-data')

            data = response.get_json()
            assert data['location'] != 'Unbekannt'
            assert '48.86' in data['location']
            assert '2.35' in data['location']

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

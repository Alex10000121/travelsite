import io
import json
import pytest


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

import os
import pytest
import app as flask_module
from app import app as flask_app, init_db


@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.setitem(flask_module.CONFIG, 'DB_PATH', str(tmp_path / 'test.db'))
    monkeypatch.setitem(flask_module.CONFIG, 'PHOTO_DIR', str(tmp_path / 'photos'))
    monkeypatch.setitem(flask_module.CONFIG, 'THUMB_DIR', str(tmp_path / 'thumbs'))
    monkeypatch.setitem(flask_module.CONFIG, 'ACCESS_TOKEN', 'test_token')
    monkeypatch.setitem(flask_module.CONFIG, 'ADMIN_TOKEN', 'test_admin')

    os.makedirs(flask_module.CONFIG['PHOTO_DIR'], exist_ok=True)
    os.makedirs(flask_module.CONFIG['THUMB_DIR'], exist_ok=True)

    init_db()

    flask_app.config['TESTING'] = True
    yield flask_app


@pytest.fixture
def client(app):
    return app.test_client()

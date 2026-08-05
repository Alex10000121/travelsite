import os
import pytest

# Muss vor dem ersten "import app" gesetzt sein - app.py bricht ohne diese
# Variablen jetzt bewusst mit RuntimeError ab (siehe app._require_env).
os.environ.setdefault('SECRET_KEY', 'test-secret-key-not-for-production')
os.environ.setdefault('ADMIN_TOKEN', 'test_admin')
os.environ.setdefault('ACCESS_TOKEN', 'test_token')

import app as flask_module
from app import app as flask_app, init_db, limiter


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

    # Der Limiter ist ein Modul-Singleton, sein Storage ("memory://") ueberlebt sonst
    # ueber Testgrenzen hinweg - ohne Reset wuerden sich z.B. wiederholte
    # /admin/login-Tests gegenseitig den 5-pro-Minute-Rate-Limit aufbrauchen.
    limiter.reset()

    flask_app.config['TESTING'] = True
    yield flask_app


@pytest.fixture
def client(app):
    return app.test_client()


@pytest.fixture
def admin_client(client):
    """Client mit bereits gesetzter Admin-Session.
    Setzt die Session direkt statt über /admin/login, damit Tests nicht
    gemeinsam gegen dessen Rate-Limit laufen (das hat eigene Tests in TestAdminLogin)."""
    with client.session_transaction() as sess:
        sess['is_admin'] = True
    return client

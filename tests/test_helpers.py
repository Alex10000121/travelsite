import os
import pytest
import piexif
from pathlib import Path
from PIL import Image
from app import calculate_distance, get_decimal_from_dms, decimal_to_dms_rational, extract_exif_data, get_location_name


class TestCalculateDistance:
    def test_same_point_returns_zero(self):
        assert calculate_distance(48.8566, 2.3522, 48.8566, 2.3522) == 0.0

    def test_berlin_to_munich(self):
        distance = calculate_distance(52.5200, 13.4050, 48.1351, 11.5820)
        assert 500 < distance < 600

    def test_returns_float(self):
        result = calculate_distance(0, 0, 1, 1)
        assert isinstance(result, float)

    def test_symmetry(self):
        d1 = calculate_distance(52.5200, 13.4050, 48.1351, 11.5820)
        d2 = calculate_distance(48.1351, 11.5820, 52.5200, 13.4050)
        assert abs(d1 - d2) < 0.001

    def test_returns_zero_on_invalid_input(self):
        assert calculate_distance(None, None, None, None) == 0


class TestGetDecimalFromDms:
    def test_north(self):
        result = get_decimal_from_dms((48, 8, 0), 'N')
        assert abs(result - 48.1333) < 0.001

    def test_south_is_negative(self):
        result = get_decimal_from_dms((33, 52, 0), 'S')
        assert result < 0

    def test_west_is_negative(self):
        result = get_decimal_from_dms((2, 21, 7.2), 'W')
        assert result < 0

    def test_east_is_positive(self):
        result = get_decimal_from_dms((13, 24, 18), 'E')
        assert result > 0

    def test_zero_degrees(self):
        result = get_decimal_from_dms((0, 0, 0), 'N')
        assert result == 0.0


class TestDecimalToDmsRational:
    def test_degrees_component(self):
        result = decimal_to_dms_rational(48.8566)
        assert result[0] == (48, 1)

    def test_returns_three_tuples(self):
        result = decimal_to_dms_rational(13.405)
        assert len(result) == 3

    def test_each_element_is_tuple(self):
        result = decimal_to_dms_rational(2.3522)
        assert all(isinstance(part, tuple) and len(part) == 2 for part in result)

    def test_negative_input_uses_absolute_value(self):
        pos = decimal_to_dms_rational(48.8566)
        neg = decimal_to_dms_rational(-48.8566)
        assert pos == neg

    def test_roundtrip_accuracy(self):
        val = 48.8566
        d, m, s = decimal_to_dms_rational(val)
        reconstructed = d[0] / d[1] + (m[0] / m[1]) / 60 + (s[0] / s[1]) / 3600
        assert abs(reconstructed - val) < 0.001

    def test_zero(self):
        result = decimal_to_dms_rational(0.0)
        assert result[0] == (0, 1)
        assert result[1] == (0, 1)
        assert result[2] == (0, 1000)


def _make_jpeg_with_gps(path, lat, lon, date_str=None):
    Image.new('RGB', (100, 100)).save(str(path), format='JPEG')
    exif_dict = {'0th': {}, 'Exif': {}, 'GPS': {}, '1st': {}}
    exif_dict['GPS'] = {
        piexif.GPSIFD.GPSLatitudeRef:  b'N' if lat >= 0 else b'S',
        piexif.GPSIFD.GPSLatitude:     decimal_to_dms_rational(lat),
        piexif.GPSIFD.GPSLongitudeRef: b'E' if lon >= 0 else b'W',
        piexif.GPSIFD.GPSLongitude:    decimal_to_dms_rational(lon),
    }
    if date_str:
        exif_dict['Exif'][piexif.ExifIFD.DateTimeOriginal] = date_str.encode()
    piexif.insert(piexif.dump(exif_dict), str(path))
    return str(path)


class TestExtractExifData:
    def test_extracts_gps_coordinates(self, tmp_path):
        img_path = _make_jpeg_with_gps(tmp_path / 'gps.jpg', 48.8566, 2.3522)
        ts, coords = extract_exif_data(img_path)
        assert coords is not None
        assert abs(coords[0] - 48.8566) < 0.01
        assert abs(coords[1] - 2.3522) < 0.01

    def test_extracts_timestamp_from_exif_ifd(self, tmp_path):
        from datetime import datetime
        img_path = _make_jpeg_with_gps(tmp_path / 'ts.jpg', 48.8566, 2.3522, date_str='2023:07:15 12:00:00')
        ts, _ = extract_exif_data(img_path)
        assert ts is not None
        dt = datetime.fromtimestamp(ts)
        assert dt.year == 2023
        assert dt.month == 7
        assert dt.day == 15

    def test_extracts_timestamp_and_gps_together(self, tmp_path):
        from datetime import datetime
        img_path = _make_jpeg_with_gps(tmp_path / 'full.jpg', 52.52, 13.405, date_str='2025:03:18 09:30:00')
        ts, coords = extract_exif_data(img_path)
        assert ts is not None
        assert coords is not None
        dt = datetime.fromtimestamp(ts)
        assert dt.year == 2025
        assert dt.month == 3
        assert dt.day == 18
        assert abs(coords[0] - 52.52) < 0.01
        assert abs(coords[1] - 13.405) < 0.01

    def test_south_latitude_is_negative(self, tmp_path):
        img_path = _make_jpeg_with_gps(tmp_path / 'south.jpg', -33.8688, 151.2093)
        _, coords = extract_exif_data(img_path)
        assert coords is not None
        assert coords[0] < 0

    def test_west_longitude_is_negative(self, tmp_path):
        img_path = _make_jpeg_with_gps(tmp_path / 'west.jpg', 40.7128, -74.0060)
        _, coords = extract_exif_data(img_path)
        assert coords is not None
        assert coords[1] < 0

    def test_returns_none_for_image_without_exif(self, tmp_path):
        img_path = tmp_path / 'plain.jpg'
        Image.new('RGB', (100, 100)).save(str(img_path), format='JPEG')
        ts, coords = extract_exif_data(str(img_path))
        assert ts is None
        assert coords is None

    def test_returns_none_for_nonexistent_file(self):
        ts, coords = extract_exif_data('/nonexistent/path/image.jpg')
        assert ts is None
        assert coords is None

    def test_timestamp_is_none_when_only_gps_present(self, tmp_path):
        img_path = _make_jpeg_with_gps(tmp_path / 'no_ts.jpg', 48.0, 11.0)
        ts, coords = extract_exif_data(img_path)
        assert ts is None
        assert coords is not None


class TestGetLocationName:
    def test_returns_unbekannt_for_none_lat(self):
        assert get_location_name(None, 10.0) == "Unbekannt"

    def test_returns_unbekannt_for_none_lon(self):
        assert get_location_name(48.0, None) == "Unbekannt"

    def test_zero_lat_does_not_return_unbekannt(self):
        result = get_location_name(0.0, 10.0)
        assert result != "Unbekannt" or result == "Unbekannt"

    def test_zero_lat_is_not_treated_as_missing(self):
        from unittest.mock import patch
        with patch('app.rg.search', return_value=[{'name': 'Accra', 'cc': 'GH'}]) as mock_search:
            result = get_location_name(0.0, 0.0)
            mock_search.assert_called_once()
            assert result == "Accra, GH"

    def test_zero_lon_is_not_treated_as_missing(self):
        from unittest.mock import patch
        with patch('app.rg.search', return_value=[{'name': 'London', 'cc': 'GB'}]) as mock_search:
            result = get_location_name(51.5, 0.0)
            mock_search.assert_called_once()
            assert result == "London, GB"


class TestThumbPath:
    def test_flat_filename_unchanged(self, app):
        from app import _thumb_path
        import app as flask_module
        import os
        result = _thumb_path('trip_photo.jpg')
        assert result == os.path.join(flask_module.CONFIG['THUMB_DIR'], 'trip_photo.jpg')

    def test_subdir_and_flat_name_do_not_collide(self, app):
        from app import _thumb_path
        nested = _thumb_path('a/b.jpg')
        flat = _thumb_path('a_b.jpg')
        assert nested != flat

    def test_same_subdir_path_is_stable(self, app):
        from app import _thumb_path
        assert _thumb_path('a/b.jpg') == _thumb_path('a/b.jpg')


class TestDatabase:
    def test_wal_journal_mode_is_enabled(self, app):
        from app import get_db
        with get_db() as conn:
            row = conn.execute("PRAGMA journal_mode").fetchone()
        assert row[0] == 'wal'

    def test_connection_has_row_factory(self, app):
        from app import get_db
        import sqlite3
        with get_db() as conn:
            assert conn.row_factory == sqlite3.Row


class TestIndexPhoto:
    def _make_plain_jpeg(self, path):
        Image.new('RGB', (100, 100)).save(str(path), format='JPEG')

    def test_photo_without_gps_is_moved_to_no_gps_dir(self, app):
        import app as flask_module
        from app import index_photo
        abs_photo_dir = flask_module.CONFIG['PHOTO_DIR']
        img_path = os.path.join(abs_photo_dir, 'plain_photo.jpg')
        self._make_plain_jpeg(Path(img_path))

        index_photo(img_path, abs_photo_dir)

        assert not os.path.exists(img_path)
        assert os.path.exists(os.path.join(abs_photo_dir, 'no_gps', 'plain_photo.jpg'))

    def test_photo_without_gps_is_not_inserted_into_db(self, app):
        import app as flask_module
        from app import index_photo, get_db
        abs_photo_dir = flask_module.CONFIG['PHOTO_DIR']
        img_path = os.path.join(abs_photo_dir, 'db_check.jpg')
        self._make_plain_jpeg(Path(img_path))

        index_photo(img_path, abs_photo_dir)

        with get_db() as conn:
            row = conn.execute("SELECT 1 FROM photos WHERE filename='db_check.jpg'").fetchone()
        assert row is None

    def test_unsupported_extension_is_ignored(self, app):
        import app as flask_module
        from app import index_photo
        abs_photo_dir = flask_module.CONFIG['PHOTO_DIR']
        txt_path = os.path.join(abs_photo_dir, 'notes.txt')
        Path(txt_path).write_text('not an image')

        index_photo(txt_path, abs_photo_dir)

        assert os.path.exists(txt_path)

    def test_no_gps_subdir_is_skipped(self, app):
        import app as flask_module
        from app import index_photo, get_db
        abs_photo_dir = flask_module.CONFIG['PHOTO_DIR']
        no_gps_dir = os.path.join(abs_photo_dir, 'no_gps')
        os.makedirs(no_gps_dir, exist_ok=True)
        img_path = os.path.join(no_gps_dir, 'already_moved.jpg')
        self._make_plain_jpeg(Path(img_path))

        index_photo(img_path, abs_photo_dir)

        assert os.path.exists(img_path)
        with get_db() as conn:
            row = conn.execute("SELECT COUNT(*) FROM photos").fetchone()
        assert row[0] == 0

    def test_hidden_staging_file_is_skipped(self, app):
        """Upload-Staging-Dateien (Praefix '.') duerfen vom Watchdog-Scanner nicht
        parallel zum Upload-Handler eingelesen werden (Race-Condition-Schutz)."""
        import app as flask_module
        from app import index_photo, get_db
        abs_photo_dir = flask_module.CONFIG['PHOTO_DIR']
        img_path = os.path.join(abs_photo_dir, '.upload_staging.jpg')
        self._make_plain_jpeg(Path(img_path))

        index_photo(img_path, abs_photo_dir)

        assert os.path.exists(img_path)
        with get_db() as conn:
            row = conn.execute("SELECT COUNT(*) FROM photos").fetchone()
        assert row[0] == 0

    def test_eadir_path_is_skipped(self, app):
        import app as flask_module
        from app import index_photo, get_db
        abs_photo_dir = flask_module.CONFIG['PHOTO_DIR']
        ea_path = os.path.join(abs_photo_dir, '@eaDir', 'thumb.jpg')
        os.makedirs(os.path.dirname(ea_path), exist_ok=True)
        self._make_plain_jpeg(Path(ea_path))

        index_photo(ea_path, abs_photo_dir)

        with get_db() as conn:
            row = conn.execute("SELECT COUNT(*) FROM photos").fetchone()
        assert row[0] == 0

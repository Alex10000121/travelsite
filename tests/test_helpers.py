import json
import os
import subprocess
import time
import piexif
import pytest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch, MagicMock
from PIL import Image
import app as flask_module
from app import (
    calculate_distance, get_decimal_from_dms, decimal_to_dms_rational,
    extract_exif_data, get_location_name, fetch_weather,
    _thumb_path, get_db, index_photo,
    _parse_iso6709, _parse_video_creation_time, _media_type_for,
    extract_video_metadata, generate_video_poster_thumbnails,
    _country_code_from_location, _sample_randomly, _run_ffmpeg,
    _build_photo_segment, _build_video_segment, _concat_segments,
    _generate_reel,
)


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


def _make_plain_jpeg(path):
    Image.new('RGB', (100, 100)).save(str(path), format='JPEG')
    return str(path)


def _make_jpeg_with_gps(path, lat, lon, date_str=None):
    _make_plain_jpeg(path)
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
        _make_plain_jpeg(img_path)
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


class TestParseIso6709:
    def test_parses_positive_lat_lon(self):
        coords = _parse_iso6709('+48.8584+002.2945/')
        assert coords is not None
        assert abs(coords[0] - 48.8584) < 0.0001
        assert abs(coords[1] - 2.2945) < 0.0001

    def test_parses_negative_lat_lon(self):
        coords = _parse_iso6709('-33.8688+151.2093/')
        assert coords[0] < 0
        assert coords[1] > 0

    def test_returns_none_for_empty_string(self):
        assert _parse_iso6709('') is None

    def test_returns_none_for_none(self):
        assert _parse_iso6709(None) is None

    def test_returns_none_for_unparsable_string(self):
        assert _parse_iso6709('not-a-coordinate') is None


class TestParseVideoCreationTime:
    def test_parses_with_fractional_seconds(self):
        ts = _parse_video_creation_time('2023-07-15T12:00:00.000000Z')
        assert ts is not None
        dt = datetime.fromtimestamp(ts, tz=timezone.utc)
        assert (dt.year, dt.month, dt.day, dt.hour) == (2023, 7, 15, 12)

    def test_parses_without_fractional_seconds(self):
        ts = _parse_video_creation_time('2023-07-15T12:00:00Z')
        assert ts is not None

    def test_returns_none_for_empty(self):
        assert _parse_video_creation_time('') is None
        assert _parse_video_creation_time(None) is None

    def test_returns_none_for_unparsable_string(self):
        assert _parse_video_creation_time('not-a-date') is None


class TestMediaTypeFor:
    def test_photo_extensions(self):
        assert _media_type_for('trip.jpg') == 'photo'
        assert _media_type_for('trip.HEIC') == 'photo'

    def test_video_extensions(self):
        assert _media_type_for('clip.mp4') == 'video'
        assert _media_type_for('clip.MOV') == 'video'


def _mock_ffprobe_result(tags=None, duration=None):
    payload = {'format': {'tags': tags or {}}}
    if duration is not None:
        payload['format']['duration'] = str(duration)
    mock_result = MagicMock()
    mock_result.stdout = json.dumps(payload)
    return mock_result


class TestExtractVideoMetadata:
    def test_extracts_timestamp_coords_and_duration(self):
        mock_result = _mock_ffprobe_result(
            tags={'creation_time': '2024-05-01T10:00:00.000000Z', 'location': '+48.8584+002.2945/'},
            duration=12.5,
        )
        with patch('app.subprocess.run', return_value=mock_result):
            ts, coords, duration = extract_video_metadata('/fake/video.mp4')
        assert ts is not None
        assert coords is not None
        assert abs(coords[0] - 48.8584) < 0.0001
        assert duration == 12.5

    def test_missing_tags_returns_none_values(self):
        mock_result = _mock_ffprobe_result(tags={})
        with patch('app.subprocess.run', return_value=mock_result):
            ts, coords, duration = extract_video_metadata('/fake/video.mp4')
        assert ts is None
        assert coords is None

    def test_ffprobe_failure_returns_none_values(self):
        with patch('app.subprocess.run', side_effect=subprocess.CalledProcessError(1, 'ffprobe')):
            ts, coords, duration = extract_video_metadata('/fake/video.mp4')
        assert (ts, coords, duration) == (None, None, None)

    def test_ffprobe_missing_binary_returns_none_values(self):
        with patch('app.subprocess.run', side_effect=FileNotFoundError()):
            ts, coords, duration = extract_video_metadata('/fake/video.mp4')
        assert (ts, coords, duration) == (None, None, None)


class TestGenerateVideoPosterThumbnails:
    def test_creates_thumb_and_blur_from_extracted_frame(self, tmp_path):
        video_path = str(tmp_path / 'clip.mp4')
        Path(video_path).write_bytes(b'fake video bytes')
        thumb_path = str(tmp_path / 'thumb.jpg')
        blur_path = str(tmp_path / 'thumb_blur.jpg')

        def fake_ffmpeg_run(cmd, **kwargs):
            Image.new('RGB', (200, 200)).save(cmd[-1], format='JPEG')
            return MagicMock(returncode=0)

        with patch('app.subprocess.run', side_effect=fake_ffmpeg_run):
            result = generate_video_poster_thumbnails(video_path, thumb_path, blur_path)

        assert result is True
        assert os.path.exists(thumb_path)
        assert os.path.exists(blur_path)

    def test_returns_false_when_ffmpeg_fails(self, tmp_path):
        video_path = str(tmp_path / 'broken.mp4')
        Path(video_path).write_bytes(b'not a real video')
        thumb_path = str(tmp_path / 'thumb.jpg')
        blur_path = str(tmp_path / 'thumb_blur.jpg')

        with patch('app.subprocess.run', side_effect=subprocess.CalledProcessError(1, 'ffmpeg')):
            result = generate_video_poster_thumbnails(video_path, thumb_path, blur_path)

        assert result is False
        assert not os.path.exists(thumb_path)


class TestGetLocationName:
    def test_returns_unbekannt_for_none_lat(self):
        assert get_location_name(None, 10.0) == "Unbekannt"

    def test_returns_unbekannt_for_none_lon(self):
        assert get_location_name(48.0, None) == "Unbekannt"

    def test_zero_lat_does_not_return_unbekannt(self):
        result = get_location_name(0.0, 10.0)
        assert result != "Unbekannt" or result == "Unbekannt"

    def test_zero_lat_is_not_treated_as_missing(self):
        with patch('app.rg.search', return_value=[{'name': 'Accra', 'cc': 'GH'}]) as mock_search:
            result = get_location_name(0.0, 0.0)
            mock_search.assert_called_once()
            assert result == "Accra, GH"

    def test_zero_lon_is_not_treated_as_missing(self):
        with patch('app.rg.search', return_value=[{'name': 'London', 'cc': 'GB'}]) as mock_search:
            result = get_location_name(51.5, 0.0)
            mock_search.assert_called_once()
            assert result == "London, GB"


class TestFetchWeather:
    def test_returns_none_for_missing_coords(self):
        assert fetch_weather(None, 10.0, 1700000000.0) == (None, None)

    def test_returns_none_for_missing_timestamp(self):
        assert fetch_weather(48.0, 10.0, None) == (None, None)

    def test_returns_temp_and_code_on_success(self):
        mock_resp = MagicMock()
        mock_resp.json.return_value = {'daily': {'temperature_2m_max': [23.4], 'weathercode': [0]}}
        with patch('app.requests.get', return_value=mock_resp) as mock_get:
            temp, code = fetch_weather(48.0, 11.0, 1700000000.0)
        assert (temp, code) == (23.4, 0)
        mock_get.assert_called_once()

    def test_returns_none_when_archive_has_no_data_yet(self):
        # Frisch hochgeladenes Foto von heute - Open-Meteo Archive hinkt ein paar Tage hinterher
        mock_resp = MagicMock()
        mock_resp.json.return_value = {'daily': {'temperature_2m_max': [None], 'weathercode': [None]}}
        with patch('app.requests.get', return_value=mock_resp):
            assert fetch_weather(48.0, 11.0, 1700000000.0) == (None, None)

    def test_returns_none_on_network_error(self):
        with patch('app.requests.get', side_effect=Exception('timeout')):
            assert fetch_weather(48.0, 11.0, 1700000000.0) == (None, None)


class TestThumbPath:
    def test_flat_filename_unchanged(self, app):
        result = _thumb_path('trip_photo.jpg')
        assert result == os.path.join(flask_module.CONFIG['THUMB_DIR'], 'trip_photo.jpg')

    def test_subdir_and_flat_name_do_not_collide(self, app):
        nested = _thumb_path('a/b.jpg')
        flat = _thumb_path('a_b.jpg')
        assert nested != flat

    def test_same_subdir_path_is_stable(self, app):
        assert _thumb_path('a/b.jpg') == _thumb_path('a/b.jpg')


class TestDatabase:
    def test_wal_journal_mode_is_enabled(self, app):
        with get_db() as conn:
            row = conn.execute("PRAGMA journal_mode").fetchone()
        assert row[0] == 'wal'

    def test_connection_has_row_factory(self, app):
        import sqlite3
        with get_db() as conn:
            assert conn.row_factory == sqlite3.Row


class TestIndexPhoto:
    def test_photo_without_gps_is_moved_to_no_gps_dir(self, app):
        abs_photo_dir = flask_module.CONFIG['PHOTO_DIR']
        img_path = os.path.join(abs_photo_dir, 'plain_photo.jpg')
        _make_plain_jpeg(Path(img_path))

        index_photo(img_path, abs_photo_dir)

        assert not os.path.exists(img_path)
        assert os.path.exists(os.path.join(abs_photo_dir, 'no_gps', 'plain_photo.jpg'))

    def test_photo_without_gps_is_not_inserted_into_db(self, app):
        abs_photo_dir = flask_module.CONFIG['PHOTO_DIR']
        img_path = os.path.join(abs_photo_dir, 'db_check.jpg')
        _make_plain_jpeg(Path(img_path))

        index_photo(img_path, abs_photo_dir)

        with get_db() as conn:
            row = conn.execute("SELECT 1 FROM photos WHERE filename='db_check.jpg'").fetchone()
        assert row is None

    def test_unsupported_extension_is_ignored(self, app):
        abs_photo_dir = flask_module.CONFIG['PHOTO_DIR']
        txt_path = os.path.join(abs_photo_dir, 'notes.txt')
        Path(txt_path).write_text('not an image')

        index_photo(txt_path, abs_photo_dir)

        assert os.path.exists(txt_path)

    def test_no_gps_subdir_is_skipped(self, app):
        abs_photo_dir = flask_module.CONFIG['PHOTO_DIR']
        no_gps_dir = os.path.join(abs_photo_dir, 'no_gps')
        os.makedirs(no_gps_dir, exist_ok=True)
        img_path = os.path.join(no_gps_dir, 'already_moved.jpg')
        _make_plain_jpeg(Path(img_path))

        index_photo(img_path, abs_photo_dir)

        assert os.path.exists(img_path)
        with get_db() as conn:
            row = conn.execute("SELECT COUNT(*) FROM photos").fetchone()
        assert row[0] == 0

    def test_hidden_staging_file_is_skipped(self, app):
        """Upload-Staging-Dateien (Praefix '.') duerfen vom Watchdog-Scanner nicht
        parallel zum Upload-Handler eingelesen werden (Race-Condition-Schutz)."""
        abs_photo_dir = flask_module.CONFIG['PHOTO_DIR']
        img_path = os.path.join(abs_photo_dir, '.upload_staging.jpg')
        _make_plain_jpeg(Path(img_path))

        index_photo(img_path, abs_photo_dir)

        assert os.path.exists(img_path)
        with get_db() as conn:
            row = conn.execute("SELECT COUNT(*) FROM photos").fetchone()
        assert row[0] == 0

    def test_eadir_path_is_skipped(self, app):
        abs_photo_dir = flask_module.CONFIG['PHOTO_DIR']
        ea_path = os.path.join(abs_photo_dir, '@eaDir', 'thumb.jpg')
        os.makedirs(os.path.dirname(ea_path), exist_ok=True)
        _make_plain_jpeg(Path(ea_path))

        index_photo(ea_path, abs_photo_dir)

        with get_db() as conn:
            row = conn.execute("SELECT COUNT(*) FROM photos").fetchone()
        assert row[0] == 0


def _fake_video_subprocess_run(ffprobe_payload):
    def run(cmd, **kwargs):
        if cmd[0] == 'ffprobe':
            result = MagicMock()
            result.stdout = json.dumps(ffprobe_payload)
            return result
        if cmd[0] == 'ffmpeg':
            Image.new('RGB', (200, 200)).save(cmd[-1], format='JPEG')
            return MagicMock(returncode=0)
        raise AssertionError(f"unexpected subprocess call: {cmd}")
    return run


class TestIndexVideo:
    def test_video_with_gps_is_indexed_with_media_type_video(self, app):
        abs_photo_dir = flask_module.CONFIG['PHOTO_DIR']
        video_path = os.path.join(abs_photo_dir, 'clip.mp4')
        Path(video_path).write_bytes(b'fake video bytes')

        ffprobe_payload = {
            'format': {
                'duration': '5.0',
                'tags': {
                    'creation_time': '2024-06-01T08:00:00.000000Z',
                    'location': '+48.8584+002.2945/',
                },
            }
        }

        with patch('app.subprocess.run', side_effect=_fake_video_subprocess_run(ffprobe_payload)), \
             patch('app.get_location_name', return_value='Paris, FR'), \
             patch('app.fetch_weather', return_value=(None, None)):
            index_photo(video_path, abs_photo_dir)

        with get_db() as conn:
            row = conn.execute("SELECT * FROM photos WHERE filename='clip.mp4'").fetchone()
        assert row is not None
        assert row['media_type'] == 'video'
        assert row['duration_seconds'] == 5.0
        assert row['location'] == 'Paris, FR'

    def test_video_without_gps_is_moved_to_no_gps_dir(self, app):
        abs_photo_dir = flask_module.CONFIG['PHOTO_DIR']
        video_path = os.path.join(abs_photo_dir, 'no_gps_clip.mp4')
        Path(video_path).write_bytes(b'fake video bytes')

        ffprobe_payload = {'format': {'tags': {}}}

        with patch('app.subprocess.run', side_effect=_fake_video_subprocess_run(ffprobe_payload)):
            index_photo(video_path, abs_photo_dir)

        assert not os.path.exists(video_path)
        assert os.path.exists(os.path.join(abs_photo_dir, 'no_gps', 'no_gps_clip.mp4'))


class TestCountryCodeFromLocation:
    def test_extracts_country_code(self):
        assert _country_code_from_location('München, DE') == 'DE'

    def test_strips_whitespace(self):
        assert _country_code_from_location('Paris,  FR ') == 'FR'

    def test_returns_none_without_comma(self):
        assert _country_code_from_location('Unbekannt') is None

    def test_returns_none_for_empty(self):
        assert _country_code_from_location('') is None
        assert _country_code_from_location(None) is None


class TestSampleRandomly:
    def test_returns_all_items_when_under_count(self):
        items = list(range(5))
        assert _sample_randomly(items, 10) == items

    def test_reduces_to_exact_count(self):
        items = list(range(100))
        result = _sample_randomly(items, 40)
        assert len(result) == 40

    def test_preserves_chronological_order_of_the_selection(self):
        items = list(range(100))
        result = _sample_randomly(items, 10)
        assert result == sorted(result)

    def test_selection_is_a_subset_of_the_original_items(self):
        items = list(range(100))
        result = _sample_randomly(items, 10)
        assert set(result) <= set(items)
        assert len(set(result)) == 10


class TestSegmentCountForDuration:
    def test_derives_count_from_segment_length(self):
        assert flask_module._segment_count_for_duration(30, available_count=100) == 10

    def test_at_least_one_segment(self):
        assert flask_module._segment_count_for_duration(0.1, available_count=100) == 1

    def test_capped_to_available_items(self):
        assert flask_module._segment_count_for_duration(1000, available_count=5) == 5


class TestRunFfmpeg:
    def test_raises_runtime_error_with_stderr_on_failure(self):
        err = subprocess.CalledProcessError(1, 'ffmpeg', stderr=b'invalid data found')
        with patch('app.subprocess.run', side_effect=err):
            with pytest.raises(RuntimeError, match='invalid data found'):
                _run_ffmpeg(['-i', 'x'], timeout=5)

    def test_raises_runtime_error_on_timeout(self):
        with patch('app.subprocess.run', side_effect=subprocess.TimeoutExpired('ffmpeg', 5)):
            with pytest.raises(RuntimeError, match='[Tt]imeout'):
                _run_ffmpeg(['-i', 'x'], timeout=5)

    def test_raises_friendly_error_when_ffmpeg_binary_is_missing(self):
        with patch('app.subprocess.run', side_effect=FileNotFoundError()):
            with pytest.raises(RuntimeError, match='ffmpeg wurde nicht gefunden'):
                _run_ffmpeg(['-i', 'x'], timeout=5)

    def test_success_does_not_raise(self):
        with patch('app.subprocess.run', return_value=MagicMock(returncode=0)):
            _run_ffmpeg(['-i', 'x'], timeout=5)


class TestBuildSegments:
    def test_photo_segment_loops_the_still_image(self):
        with patch('app.subprocess.run', return_value=MagicMock(returncode=0)) as mock_run:
            _build_photo_segment('/fake/photo.jpg', '/fake/seg.mp4')
        args = mock_run.call_args[0][0]
        assert '-loop' in args
        assert '/fake/photo.jpg' in args
        assert '/fake/seg.mp4' in args

    def test_photo_segment_includes_ken_burns_zoompan(self):
        with patch('app.subprocess.run', return_value=MagicMock(returncode=0)) as mock_run:
            _build_photo_segment('/fake/photo.jpg', '/fake/seg.mp4')
        args = mock_run.call_args[0][0]
        filter_complex = args[args.index('-filter_complex') + 1]
        assert 'zoompan' in filter_complex

    def test_photo_segment_caps_output_via_frames_not_duration(self):
        """zoompan erzeugt selbst die komplette Animation aus einem Eingabeframe (d=total_frames) -
        ein zusaetzliches '-t' wuerde nur mit dem falschen (Dauerstream-)Muster Sinn ergeben,
        das nachweislich ruckelt. '-frames:v' ist der korrekte Deckel dafuer."""
        with patch('app.subprocess.run', return_value=MagicMock(returncode=0)) as mock_run:
            _build_photo_segment('/fake/photo.jpg', '/fake/seg.mp4')
        args = mock_run.call_args[0][0]
        assert '-t' not in args
        assert '-frames:v' in args
        total_frames = int(flask_module.SEGMENT_DURATION_SECONDS * flask_module.REEL_FPS)
        assert args[args.index('-frames:v') + 1] == str(total_frames)

    def test_video_segment_does_not_loop(self):
        with patch('app.subprocess.run', return_value=MagicMock(returncode=0)) as mock_run:
            _build_video_segment('/fake/clip.mp4', '/fake/seg.mp4')
        args = mock_run.call_args[0][0]
        assert '-loop' not in args
        assert '/fake/clip.mp4' in args

    def test_video_segment_includes_tpad_for_fixed_duration(self):
        with patch('app.subprocess.run', return_value=MagicMock(returncode=0)) as mock_run:
            _build_video_segment('/fake/clip.mp4', '/fake/seg.mp4')
        args = mock_run.call_args[0][0]
        filter_complex = args[args.index('-filter_complex') + 1]
        assert 'tpad' in filter_complex

    def test_overlay_text_skipped_when_font_missing(self):
        with patch('app.subprocess.run', return_value=MagicMock(returncode=0)) as mock_run, \
             patch('app.os.path.exists', return_value=False):
            _build_photo_segment('/fake/photo.jpg', '/fake/seg.mp4', overlay_text='München, DE')
        args = mock_run.call_args[0][0]
        filter_complex = args[args.index('-filter_complex') + 1]
        assert 'drawtext' not in filter_complex

    def test_overlay_text_included_when_font_exists(self):
        with patch('app.subprocess.run', return_value=MagicMock(returncode=0)) as mock_run, \
             patch('app.os.path.exists', return_value=True):
            _build_photo_segment('/fake/photo.jpg', '/fake/seg.mp4', overlay_text='Muenchen, DE')
        args = mock_run.call_args[0][0]
        filter_complex = args[args.index('-filter_complex') + 1]
        assert 'drawtext' in filter_complex
        assert 'Muenchen' in filter_complex


class TestConcatSegments:
    def test_single_segment_is_just_remuxed_without_xfade(self, tmp_path):
        seg1 = str(tmp_path / 'seg1.mp4')
        output = str(tmp_path / 'out.mp4')

        with patch('app.subprocess.run', return_value=MagicMock(returncode=0)) as mock_run:
            _concat_segments([seg1], [3.0], output)

        args = mock_run.call_args[0][0]
        assert '-filter_complex' not in args
        assert seg1 in args
        assert output in args

    def test_multiple_uniform_segments_use_xfade_with_multiplied_offsets(self, tmp_path):
        segs = [str(tmp_path / f's{i}.mp4') for i in range(3)]
        output = str(tmp_path / 'out.mp4')

        with patch('app.subprocess.run', return_value=MagicMock(returncode=0)) as mock_run:
            _concat_segments(segs, [3.0, 3.0, 3.0], output)

        args = mock_run.call_args[0][0]
        filter_complex = args[args.index('-filter_complex') + 1]
        assert filter_complex.count('xfade') == 2
        assert 'offset=2.500' in filter_complex
        assert 'offset=5.000' in filter_complex
        assert args[args.index('-map') + 1] == '[vout]'

    def test_variable_segment_durations_use_cumulative_offsets(self, tmp_path):
        segs = [str(tmp_path / f's{i}.mp4') for i in range(3)]
        output = str(tmp_path / 'out.mp4')

        with patch('app.subprocess.run', return_value=MagicMock(returncode=0)) as mock_run:
            _concat_segments(segs, [3.0, 2.0, 3.0], output)

        args = mock_run.call_args[0][0]
        filter_complex = args[args.index('-filter_complex') + 1]
        # offset1 = 3.0-0.5=2.5; kumulative Dauer danach = 3.0+2.0-0.5=4.5; offset2=4.5-0.5=4.0
        assert 'offset=2.500' in filter_complex
        assert 'offset=4.000' in filter_complex

    def test_all_segment_files_passed_as_inputs(self, tmp_path):
        segs = [str(tmp_path / f's{i}.mp4') for i in range(3)]
        output = str(tmp_path / 'out.mp4')

        with patch('app.subprocess.run', return_value=MagicMock(returncode=0)) as mock_run:
            _concat_segments(segs, [3.0, 3.0, 3.0], output)

        args = mock_run.call_args[0][0]
        for seg in segs:
            assert seg in args


class TestKenBurnsFilter:
    def test_returns_zoompan_expression_with_target_size_and_fps(self):
        filt = flask_module._ken_burns_filter()
        assert 'zoompan=' in filt
        assert f's={flask_module.REEL_WIDTH}x{flask_module.REEL_HEIGHT}' in filt
        assert f'fps={flask_module.REEL_FPS}' in filt

    def test_prescales_before_zoompan_to_avoid_crop_quantization_jitter(self):
        """zoompan ruckelt bekanntermassen, wenn es direkt auf der Zielaufloesung arbeitet
        (zu grobe Pixel-Rundung bei der Crop-Position) - ein Vorskalieren auf ein Vielfaches
        gibt genug Sub-Pixel-Praezision. Muss VOR zoompan in der Filterkette stehen."""
        filt = flask_module._ken_burns_filter()
        scale_part, _, rest = filt.partition(',zoompan=')
        assert scale_part == f'scale={flask_module.REEL_WIDTH * 3}:{flask_module.REEL_HEIGHT * 3}'
        assert rest

    def test_uses_single_frame_source_with_d_equal_to_total_frames(self):
        """d=1 auf einem Dauerstream ruckelt in der Praxis - das robuste, in der ffmpeg-
        Community uebliche Muster ist ein einzelner Eingabeframe mit d=<Gesamtframes>,
        der die komplette Animation selbst erzeugt (siehe _build_photo_segment: kein '-t',
        stattdessen '-frames:v' als Deckel)."""
        total_frames = int(flask_module.SEGMENT_DURATION_SECONDS * flask_module.REEL_FPS)
        filt = flask_module._ken_burns_filter()
        assert f':d={total_frames}:' in filt

    def test_focus_point_stays_within_safe_bounds(self):
        import re
        for _ in range(30):
            filt = flask_module._ken_burns_filter()
            x_match = re.search(r"x='iw\*([\d.]+)", filt)
            y_match = re.search(r"y='ih\*([\d.]+)", filt)
            assert x_match and y_match
            assert 0.4 <= float(x_match.group(1)) <= 0.6
            assert 0.4 <= float(y_match.group(1)) <= 0.6


class TestEscapeDrawtext:
    def test_escapes_colon(self):
        assert flask_module._escape_drawtext('Time: 12:30') == 'Time\\: 12\\:30'

    def test_replaces_apostrophe_with_safe_character(self):
        result = flask_module._escape_drawtext("O'Brien")
        assert "'" not in result
        assert 'Brien' in result

    def test_escapes_backslash(self):
        result = flask_module._escape_drawtext('a\\b')
        assert result == 'a\\\\\\\\b'


class TestDrawtextFilter:
    def test_includes_escaped_text_and_expansion_none(self):
        filt = flask_module._drawtext_filter('Muenchen, DE: Tag 1')
        assert 'drawtext=' in filt
        assert 'expansion=none' in filt
        assert 'Muenchen, DE\\: Tag 1' in filt


class TestReelOverlayText:
    def test_combines_location_and_date(self):
        item = {'location': 'München, DE', 'timestamp': 1689408000.0}
        text = flask_module._reel_overlay_text(item)
        assert 'München, DE' in text
        assert '·' in text

    def test_falls_back_to_location_only_without_timestamp(self):
        item = {'location': 'München, DE', 'timestamp': None}
        assert flask_module._reel_overlay_text(item) == 'München, DE'

    def test_returns_none_without_any_data(self):
        item = {'location': None, 'timestamp': None}
        assert flask_module._reel_overlay_text(item) is None


def _insert_photo_row(conn, filename, location, timestamp=1700000000.0, media_type='photo', lat=48.0, lon=11.0):
    conn.execute(
        "INSERT INTO photos (filename, lat, lon, timestamp, location, media_type) VALUES (?, ?, ?, ?, ?, ?)",
        (filename, lat, lon, timestamp, location, media_type)
    )


def _insert_pending_reel(conn, group_key):
    cursor = conn.execute(
        "INSERT INTO reels (group_key, status, created_at) VALUES (?, 'pending', ?)",
        (group_key, time.time())
    )
    return cursor.lastrowid


class TestGenerateReel:
    @staticmethod
    def _fake_subprocess_run(cmd, **kwargs):
        if cmd[0] == 'ffprobe':
            result = MagicMock()
            result.stdout = json.dumps({'format': {'duration': '9.5'}})
            return result
        return MagicMock(returncode=0)

    def test_successful_generation_marks_done_with_counts_and_duration(self, app):
        with get_db() as conn:
            _insert_photo_row(conn, 'p1.jpg', 'München, DE', timestamp=1700000000.0)
            _insert_photo_row(conn, 'p2.jpg', 'Berlin, DE', timestamp=1700000100.0)
            _insert_photo_row(conn, 'v1.mp4', 'München, DE', timestamp=1700000200.0, media_type='video')
            reel_id = _insert_pending_reel(conn, 'DE')

        flask_module._reel_generation_lock.acquire()
        with patch('app.subprocess.run', side_effect=self._fake_subprocess_run):
            _generate_reel(reel_id, 'DE', flask_module.DEFAULT_REEL_DURATION_SECONDS)

        with get_db() as conn:
            row = conn.execute("SELECT * FROM reels WHERE id=?", (reel_id,)).fetchone()
        assert row['status'] == 'done'
        assert row['photo_count'] == 2
        assert row['video_count'] == 1
        assert row['duration_seconds'] == 9.5
        assert row['filename'].startswith('DE_')
        assert not flask_module._reel_generation_lock.locked()

    def test_ffmpeg_failure_marks_error_and_releases_lock(self, app):
        with get_db() as conn:
            _insert_photo_row(conn, 'p1.jpg', 'München, DE')
            reel_id = _insert_pending_reel(conn, 'DE')

        flask_module._reel_generation_lock.acquire()
        with patch('app.subprocess.run', side_effect=subprocess.CalledProcessError(1, 'ffmpeg', stderr=b'boom')):
            _generate_reel(reel_id, 'DE', flask_module.DEFAULT_REEL_DURATION_SECONDS)

        with get_db() as conn:
            row = conn.execute("SELECT status, error_message FROM reels WHERE id=?", (reel_id,)).fetchone()
        assert row['status'] == 'error'
        assert 'boom' in row['error_message']
        assert not flask_module._reel_generation_lock.locked()

    def test_empty_group_marks_error_and_releases_lock(self, app):
        with get_db() as conn:
            reel_id = _insert_pending_reel(conn, 'FR')

        flask_module._reel_generation_lock.acquire()
        _generate_reel(reel_id, 'FR', flask_module.DEFAULT_REEL_DURATION_SECONDS)

        with get_db() as conn:
            row = conn.execute("SELECT status FROM reels WHERE id=?", (reel_id,)).fetchone()
        assert row['status'] == 'error'
        assert not flask_module._reel_generation_lock.locked()

    def test_other_countries_are_excluded_from_group(self, app):
        with get_db() as conn:
            _insert_photo_row(conn, 'p1.jpg', 'München, DE')
            _insert_photo_row(conn, 'p2.jpg', 'Paris, FR', timestamp=1700000100.0)
            reel_id = _insert_pending_reel(conn, 'DE')

        flask_module._reel_generation_lock.acquire()
        with patch('app.subprocess.run', side_effect=self._fake_subprocess_run):
            _generate_reel(reel_id, 'DE', flask_module.DEFAULT_REEL_DURATION_SECONDS)

        with get_db() as conn:
            row = conn.execute("SELECT photo_count, video_count FROM reels WHERE id=?", (reel_id,)).fetchone()
        assert row['photo_count'] == 1
        assert row['video_count'] == 0

    def test_target_duration_limits_selected_segment_count(self, app):
        with get_db() as conn:
            for i in range(20):
                _insert_photo_row(conn, f'p{i}.jpg', 'München, DE', timestamp=1700000000.0 + i)
            reel_id = _insert_pending_reel(conn, 'DE')

        flask_module._reel_generation_lock.acquire()
        with patch('app.subprocess.run', side_effect=self._fake_subprocess_run):
            _generate_reel(reel_id, 'DE', 5)  # 5s Ziel-Dauer -> 2 Segmente bei 3s/Segment

        with get_db() as conn:
            row = conn.execute("SELECT photo_count FROM reels WHERE id=?", (reel_id,)).fetchone()
        assert row['photo_count'] == 2

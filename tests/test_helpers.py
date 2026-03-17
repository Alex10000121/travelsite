import pytest
from app import calculate_distance, get_decimal_from_dms


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

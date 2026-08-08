import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../static/api.js', () => ({
    uploadPhoto: vi.fn(),
}));

import { AdminUploadCard } from '../../static/admin-upload.js';

function makeMockMap() {
    return {
        getCenter:          vi.fn(() => ({ lat: 50, lon: 10 })),
        resize:             vi.fn(),
        setFixMarker:       vi.fn(),
        removeFixMarker:    vi.fn(),
        hasFixMarker:       vi.fn(() => true),
        getFixMarkerLatLng: vi.fn(() => ({ lat: 51.0, lon: 13.5 })),
        onMapClick:         null,
    };
}

function makeDom() {
    return {
        fileInput:     document.createElement('input'),
        chooseBtn:     document.createElement('button'),
        gpsPicker:     document.createElement('div'),
        gpsConfirmBtn: document.createElement('button'),
        progressWrap:  document.createElement('div'),
        progressFill:  document.createElement('div'),
        progressText:  document.createElement('p'),
        log:           document.createElement('ul'),
    };
}

function makeCard(mapOverride) {
    return new AdminUploadCard(makeDom(), mapOverride ?? makeMockMap());
}

describe('Kartenklick-Weiterleitung', () => {
    it('setzt map.onMapClick, das nur im Picker-Modus einen Marker setzt', () => {
        const map = makeMockMap();
        const card = makeCard(map);

        map.onMapClick(48.8, 2.3);
        expect(map.setFixMarker).not.toHaveBeenCalled();

        card._locationPickResolve = vi.fn();
        map.onMapClick(48.8, 2.3);
        expect(map.setFixMarker).toHaveBeenCalledWith(48.8, 2.3);
    });
});

describe('_pickLocation / _confirmGpsPick', () => {
    beforeEach(() => {
        vi.stubGlobal('alert', vi.fn());
    });

    it('zeigt das GPS-Picker-Panel und setzt einen Marker im Kartenzentrum', () => {
        const map = makeMockMap();
        map.getCenter.mockReturnValue({ lat: 48.0, lon: 11.0 });
        const card = makeCard(map);

        card._pickLocation();

        expect(card._dom.gpsPicker.style.display).toBe('block');
        expect(map.setFixMarker).toHaveBeenCalledWith(48.0, 11.0);
        // Ohne resize() bliebe die Karte 0x0, weil der Container aus display:none kommt.
        expect(map.resize).toHaveBeenCalled();
    });

    it('löst das Promise mit den bestätigten Koordinaten auf', async () => {
        const map = makeMockMap();
        const card = makeCard(map);

        const pending = card._pickLocation();
        card._confirmGpsPick();

        const result = await pending;
        expect(result).toEqual({ lat: 51.0, lon: 13.5 });
        expect(map.removeFixMarker).toHaveBeenCalled();
        expect(card._dom.gpsPicker.style.display).toBe('none');
    });

    it('warnt und löst nicht auf, wenn kein Marker gesetzt ist', () => {
        const map = makeMockMap();
        map.hasFixMarker.mockReturnValue(false);
        const card = makeCard(map);

        card._pickLocation();
        card._confirmGpsPick();

        expect(alert).toHaveBeenCalled();
        expect(map.removeFixMarker).not.toHaveBeenCalled();
    });
});

describe('_logEntry', () => {
    it('fügt neue Einträge oben in die Liste ein', () => {
        const card = makeCard();

        card._logEntry('erstes.jpg hochgeladen', true);
        card._logEntry('zweites.jpg fehlgeschlagen', false);

        const items = card._dom.log.querySelectorAll('li');
        expect(items).toHaveLength(2);
        expect(items[0].textContent).toBe('zweites.jpg fehlgeschlagen');
        expect(items[0].className).toBe('admin-log-error');
        expect(items[1].className).toBe('admin-log-ok');
    });
});

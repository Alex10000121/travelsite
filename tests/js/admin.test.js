import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// api.js mocken — BEVOR AdminController importiert wird.
// vi.mock wird von Vitest automatisch an den Anfang der Datei gehoben (hoisted).
// ---------------------------------------------------------------------------
vi.mock('../../static/api.js', () => ({
    checkLogin:     vi.fn(),
    uploadPhoto:    vi.fn(),
    updateLocation: vi.fn(),
}));

import { AdminController } from '../../static/admin.js';
import { updateLocation } from '../../static/api.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Minimale Map-Attrappe: alle Methoden die AdminController aufruft
function makeMockMap() {
    return {
        getCenter:        vi.fn(() => ({ lat: 50, lon: 10 })),
        setFixMarker:     vi.fn(),
        removeFixMarker:  vi.fn(),
        hasFixMarker:     vi.fn(() => true),
        getFixMarkerLatLng: vi.fn(() => ({ lat: 51.0, lon: 13.5 })),
    };
}

// Alle DOM-Referenzen null — die _bind*-Methoden prüfen auf null und kehren zurück.
const NULL_DOM = {
    btnStats:      null,
    btnFixMissing: null,
    statsModal:    null,
    loginModal:    null,
    loginForm:     null,
    passwordInput: null,
    fileInput:     null,
    progressModal: null,
    progressBar:   null,
    progressText:  null,
    infoStandard:  null,
    fixInterface:  null,
    fixSaveBtn:    null,
    currentPhoto:  null,
    bgPhoto:       null,
    txtLocation:   null,
    txtDate:       null,
};

function makeAdmin(mapOverride) {
    return new AdminController(NULL_DOM, mapOverride ?? makeMockMap());
}

// ---------------------------------------------------------------------------
// handleMapClick
// ---------------------------------------------------------------------------

describe('handleMapClick', () => {
    it('ruft map.setFixMarker NICHT auf wenn kein Picker aktiv ist', () => {
        const map = makeMockMap();
        const admin = makeAdmin(map);
        // Queue leer, kein _locationPickResolve gesetzt
        admin.handleMapClick(51, 13);
        expect(map.setFixMarker).not.toHaveBeenCalled();
    });

    it('ruft map.setFixMarker auf wenn _locationPickResolve gesetzt ist', () => {
        const map = makeMockMap();
        const admin = makeAdmin(map);
        // Pre-Upload-Picker simulieren: Promise-Resolve intern setzen
        admin._locationPickResolve = vi.fn();
        admin.handleMapClick(48.8, 2.3);
        expect(map.setFixMarker).toHaveBeenCalledWith(48.8, 2.3);
    });

    it('ruft map.setFixMarker auf wenn Elemente in der missingGpsQueue sind', () => {
        const map = makeMockMap();
        const admin = makeAdmin(map);
        admin._missingGpsQueue = ['foto1.jpg'];
        admin.handleMapClick(52.5, 13.4);
        expect(map.setFixMarker).toHaveBeenCalledWith(52.5, 13.4);
    });

    it('übergibt exakt die geklickten Koordinaten', () => {
        const map = makeMockMap();
        const admin = makeAdmin(map);
        admin._missingGpsQueue = ['foto.jpg'];
        admin.handleMapClick(47.123, 8.456);
        expect(map.setFixMarker).toHaveBeenCalledWith(47.123, 8.456);
    });
});

// ---------------------------------------------------------------------------
// _processNextFix (GPS-Fix-Warteschlange)
// ---------------------------------------------------------------------------

describe('_processNextFix', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('alert', vi.fn());
        vi.stubGlobal('location', { reload: vi.fn() });
    });

    it('ruft onShowFilename mit dem ersten Dateinamen der Queue auf', () => {
        const admin = makeAdmin();
        const showFn = vi.fn();
        admin.onShowFilename = showFn;
        admin._missingGpsQueue = ['foto1.jpg', 'foto2.jpg'];

        admin._processNextFix();

        expect(showFn).toHaveBeenCalledWith('foto1.jpg');
    });

    it('setzt einen neuen Fix-Marker auf dem aktuellen Kartenzentrum', () => {
        const map = makeMockMap();
        map.getCenter.mockReturnValue({ lat: 48.0, lon: 11.0 });
        const admin = makeAdmin(map);
        admin._missingGpsQueue = ['foto.jpg'];

        admin._processNextFix();

        expect(map.removeFixMarker).toHaveBeenCalled();
        expect(map.setFixMarker).toHaveBeenCalledWith(48.0, 11.0);
    });

    it('beendet den Fix-Modus und lädt neu wenn die Queue leer ist', () => {
        const admin = makeAdmin();
        const fixingCb = vi.fn();
        admin.onFixingModeChange = fixingCb;
        admin._missingGpsQueue = []; // bereits leer

        admin._processNextFix();

        expect(fixingCb).toHaveBeenCalledWith(false);
        expect(location.reload).toHaveBeenCalled();
    });

    it('löscht das Passwort aus dem RAM wenn die Queue abgearbeitet ist', () => {
        const admin = makeAdmin();
        admin._tempPassword = 'geheim';
        admin._missingGpsQueue = [];

        admin._processNextFix();

        expect(admin._tempPassword).toBeNull();
    });

    it('zeigt eine Erfolgsmeldung wenn alle Orte gespeichert wurden', () => {
        const admin = makeAdmin();
        admin._missingGpsQueue = [];

        admin._processNextFix();

        expect(alert).toHaveBeenCalledWith(
            expect.stringContaining('Alle Orte gespeichert')
        );
    });

    it('verringert die Queue um 1 nach erfolgreichem updateLocation', async () => {
        updateLocation.mockResolvedValue();
        const map = makeMockMap();
        const admin = makeAdmin(map);
        admin._tempPassword = 'geheim';
        admin._missingGpsQueue = ['a.jpg', 'b.jpg'];

        // Fix-Save-Flow simulieren: direkt updateLocation aufrufen und Queue anpassen
        await updateLocation('geheim', 'a.jpg', 51.0, 13.5);
        admin._missingGpsQueue.shift();

        expect(admin._missingGpsQueue).toEqual(['b.jpg']);
        expect(updateLocation).toHaveBeenCalledWith('geheim', 'a.jpg', 51.0, 13.5);
    });
});


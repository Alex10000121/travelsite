import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../static/api.js', () => ({
    fetchAdminPhotos: vi.fn(),
    deletePhoto:      vi.fn(),
    updateLocation:   vi.fn(),
}));

import { AdminPhotoManager } from '../../static/admin-manage.js';
import { fetchAdminPhotos, deletePhoto, updateLocation } from '../../static/api.js';

function makeMockMap() {
    return {
        setFixMarker:       vi.fn(),
        removeFixMarker:    vi.fn(),
        hasFixMarker:       vi.fn(() => true),
        getFixMarkerLatLng: vi.fn(() => ({ lat: 51.0, lon: 13.5 })),
    };
}

function makeDom() {
    return {
        list:       document.createElement('ul'),
        modal:      document.createElement('div'),
        closeBtn:   document.createElement('button'),
        confirmBtn: document.createElement('button'),
    };
}

// Der Konstruktor stößt selbst einen load() an (fire-and-forget). Ohne das
// abzuwarten würde dessen Resolve später mitten im Test die Liste zurücksetzen.
async function makeManager(mapOverride) {
    fetchAdminPhotos.mockResolvedValue([]);
    const mgr = new AdminPhotoManager(makeDom(), mapOverride ?? makeMockMap());
    await mgr.load();
    return mgr;
}

const PHOTOS = [
    { filename: 'a.jpg', lat: 48.8, lon: 2.3,  location: 'Paris, FR',  date_str: '01.01.2024' },
    { filename: 'b.jpg', lat: 52.5, lon: 13.4, location: 'Berlin, DE', date_str: '02.01.2024' },
];

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('alert', vi.fn());
    vi.stubGlobal('confirm', vi.fn(() => true));
});

describe('_render', () => {
    it('rendert für jedes Foto ein Listenelement mit Ort und Datum', async () => {
        const mgr = await makeManager();
        mgr._render(PHOTOS);

        const items = mgr._dom.list.querySelectorAll('.admin-photo-item');
        expect(items).toHaveLength(2);
        expect(items[0].querySelector('.admin-photo-location').textContent).toBe('Paris, FR');
        expect(items[1].querySelector('.admin-photo-date').textContent).toBe('02.01.2024');
    });
});

describe('load', () => {
    it('zeigt einen Alert wenn das Laden fehlschlägt', async () => {
        fetchAdminPhotos.mockRejectedValue(new Error('Netzwerkfehler'));
        const mgr = new AdminPhotoManager(makeDom(), makeMockMap());

        await mgr.load();

        expect(alert).toHaveBeenCalledWith('Netzwerkfehler');
    });
});

describe('_openFixModal / _closeModal', () => {
    it('setzt den Marker auf die Foto-Koordinaten und zeigt das Modal', async () => {
        const map = makeMockMap();
        const mgr = await makeManager(map);

        mgr._openFixModal(PHOTOS[0]);

        expect(map.setFixMarker).toHaveBeenCalledWith(48.8, 2.3);
        expect(mgr._dom.modal.classList.contains('show')).toBe(true);
        expect(mgr._activeFilename).toBe('a.jpg');
    });

    it('entfernt den Marker und blendet das Modal wieder aus', async () => {
        const map = makeMockMap();
        const mgr = await makeManager(map);
        mgr._openFixModal(PHOTOS[0]);

        mgr._closeModal();

        expect(map.removeFixMarker).toHaveBeenCalled();
        expect(mgr._dom.modal.classList.contains('show')).toBe(false);
        expect(mgr._activeFilename).toBeNull();
    });
});

describe('_confirmFix', () => {
    it('speichert die Position des aktiven Fotos und lädt die Liste neu', async () => {
        updateLocation.mockResolvedValue();
        const map = makeMockMap();
        const mgr = await makeManager(map);
        mgr._openFixModal(PHOTOS[0]);

        await mgr._confirmFix();

        expect(updateLocation).toHaveBeenCalledWith('a.jpg', 51.0, 13.5);
        expect(fetchAdminPhotos).toHaveBeenCalled();
    });

    it('warnt und speichert nicht, wenn kein Marker gesetzt ist', async () => {
        const map = makeMockMap();
        map.hasFixMarker.mockReturnValue(false);
        const mgr = await makeManager(map);
        mgr._openFixModal(PHOTOS[0]);

        await mgr._confirmFix();

        expect(alert).toHaveBeenCalled();
        expect(updateLocation).not.toHaveBeenCalled();
    });
});

describe('_handleDelete', () => {
    it('löscht nach Bestätigung und entfernt das Element aus der Liste', async () => {
        deletePhoto.mockResolvedValue();
        const mgr = await makeManager();
        const li = document.createElement('li');
        mgr._dom.list.appendChild(li);

        await mgr._handleDelete(PHOTOS[0], li);

        expect(confirm).toHaveBeenCalled();
        expect(deletePhoto).toHaveBeenCalledWith('a.jpg');
        expect(mgr._dom.list.contains(li)).toBe(false);
    });

    it('löscht nicht, wenn die Bestätigung abgelehnt wird', async () => {
        confirm.mockReturnValue(false);
        const mgr = await makeManager();
        const li = document.createElement('li');
        mgr._dom.list.appendChild(li);

        await mgr._handleDelete(PHOTOS[0], li);

        expect(deletePhoto).not.toHaveBeenCalled();
        expect(mgr._dom.list.contains(li)).toBe(true);
    });
});

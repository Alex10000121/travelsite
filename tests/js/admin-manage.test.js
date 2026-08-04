import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../static/api.js', () => ({
    fetchAdminPhotos: vi.fn(),
    deletePhoto:      vi.fn(),
    updateLocation:   vi.fn(),
    updateNote:       vi.fn(),
    setFavorite:      vi.fn(),
}));

import { AdminPhotoManager } from '../../static/admin-manage.js';
import { fetchAdminPhotos, deletePhoto, updateLocation, updateNote, setFavorite } from '../../static/api.js';

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
        list:        document.createElement('ul'),
        searchInput: document.createElement('input'),
        loadMoreBtn: document.createElement('button'),
        modal:       document.createElement('div'),
        closeBtn:    document.createElement('button'),
        confirmBtn:  document.createElement('button'),
    };
}

function emptyPage() {
    return { photos: [], total: 0, offset: 0, limit: 60 };
}

// Der Konstruktor stößt selbst einen load() an (fire-and-forget). Ohne das
// abzuwarten würde dessen Resolve später mitten im Test die Liste zurücksetzen.
async function makeManager(mapOverride) {
    fetchAdminPhotos.mockResolvedValue(emptyPage());
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

    it('hängt bei append an, statt die Liste zu ersetzen', async () => {
        const mgr = await makeManager();
        mgr._render([PHOTOS[0]]);
        mgr._render([PHOTOS[1]], { append: true });

        expect(mgr._dom.list.querySelectorAll('.admin-photo-item')).toHaveLength(2);
    });
});

describe('load', () => {
    it('zeigt einen Alert wenn das Laden fehlschlägt', async () => {
        fetchAdminPhotos.mockRejectedValue(new Error('Netzwerkfehler'));
        const mgr = new AdminPhotoManager(makeDom(), makeMockMap());

        await mgr.load();

        expect(alert).toHaveBeenCalledWith('Netzwerkfehler');
    });

    it('blendet den Weitere-laden-Button ein, solange noch Seiten fehlen', async () => {
        fetchAdminPhotos.mockResolvedValue({ photos: PHOTOS, total: 5, offset: 0, limit: 2 });
        const mgr = new AdminPhotoManager(makeDom(), makeMockMap());

        await mgr.load();

        expect(mgr._dom.loadMoreBtn.style.display).toBe('');
    });

    it('blendet den Weitere-laden-Button aus, sobald alle Seiten geladen sind', async () => {
        fetchAdminPhotos.mockResolvedValue({ photos: PHOTOS, total: 2, offset: 0, limit: 60 });
        const mgr = new AdminPhotoManager(makeDom(), makeMockMap());

        await mgr.load();

        expect(mgr._dom.loadMoreBtn.style.display).toBe('none');
    });

    it('lädt bei reset:false die nächste Seite ab dem aktuellen Offset', async () => {
        const mgr = await makeManager();
        mgr._offset = 60;
        fetchAdminPhotos.mockResolvedValue({ photos: [PHOTOS[0]], total: 61, offset: 60, limit: 60 });

        await mgr.load({ reset: false });

        expect(fetchAdminPhotos).toHaveBeenCalledWith({ q: '', offset: 60 });
    });

    it('klickt man auf Weitere laden, wird load({reset:false}) ausgelöst', async () => {
        const mgr = await makeManager();
        fetchAdminPhotos.mockClear();
        fetchAdminPhotos.mockResolvedValue(emptyPage());

        mgr._dom.loadMoreBtn.click();
        await vi.waitFor(() => expect(fetchAdminPhotos).toHaveBeenCalled());

        expect(fetchAdminPhotos.mock.calls[0][0]).toEqual({ q: '', offset: 0 });
    });
});

describe('Suche (_onSearchInput)', () => {
    beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
    afterEach(() => vi.useRealTimers());

    it('lädt debounced neu ab Seite 1, sobald ins Suchfeld getippt wird', async () => {
        const mgr = await makeManager();
        fetchAdminPhotos.mockClear();
        fetchAdminPhotos.mockResolvedValue({ photos: [PHOTOS[1]], total: 1, offset: 0, limit: 60 });

        mgr._dom.searchInput.value = 'Berlin';
        mgr._dom.searchInput.dispatchEvent(new Event('input'));

        expect(fetchAdminPhotos).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(300);

        expect(fetchAdminPhotos).toHaveBeenCalledWith({ q: 'Berlin', offset: 0 });
    });

    it('feuert bei schnellem Tippen nur eine Anfrage (Debounce)', async () => {
        const mgr = await makeManager();
        fetchAdminPhotos.mockClear();
        fetchAdminPhotos.mockResolvedValue(emptyPage());

        for (const value of ['B', 'Be', 'Ber', 'Berl']) {
            mgr._dom.searchInput.value = value;
            mgr._dom.searchInput.dispatchEvent(new Event('input'));
            await vi.advanceTimersByTimeAsync(100);
        }
        await vi.advanceTimersByTimeAsync(300);

        expect(fetchAdminPhotos).toHaveBeenCalledTimes(1);
        expect(fetchAdminPhotos).toHaveBeenCalledWith({ q: 'Berl', offset: 0 });
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

describe('Favorit-Button', () => {
    it('markiert ein Foto als Favorit und aktualisiert den Button', async () => {
        setFavorite.mockResolvedValue();
        const mgr = await makeManager();
        const photo = { ...PHOTOS[0], is_favorite: false };
        mgr._render([photo]);

        const favBtn = mgr._dom.list.querySelector('.admin-fav-btn');
        expect(favBtn.classList.contains('active')).toBe(false);

        favBtn.click();
        await vi.waitFor(() => expect(setFavorite).toHaveBeenCalledWith('a.jpg', true));

        expect(favBtn.classList.contains('active')).toBe(true);
        expect(photo.is_favorite).toBe(true);
    });

    it('entfernt die Favoriten-Markierung bei erneutem Klick', async () => {
        setFavorite.mockResolvedValue();
        const mgr = await makeManager();
        const photo = { ...PHOTOS[0], is_favorite: true };
        mgr._render([photo]);

        const favBtn = mgr._dom.list.querySelector('.admin-fav-btn');
        expect(favBtn.classList.contains('active')).toBe(true);

        favBtn.click();
        await vi.waitFor(() => expect(setFavorite).toHaveBeenCalledWith('a.jpg', false));

        expect(favBtn.classList.contains('active')).toBe(false);
    });

    it('zeigt einen Alert, wenn das Speichern fehlschlägt', async () => {
        setFavorite.mockRejectedValue(new Error('Netzwerkfehler'));
        const mgr = await makeManager();
        mgr._render([{ ...PHOTOS[0], is_favorite: false }]);

        mgr._dom.list.querySelector('.admin-fav-btn').click();
        await vi.waitFor(() => expect(alert).toHaveBeenCalledWith('Netzwerkfehler'));
    });
});

describe('Notiz-Editor', () => {
    it('ist zunächst eingeklappt und öffnet sich per Klick auf den Notiz-Button', async () => {
        const mgr = await makeManager();
        mgr._render([PHOTOS[0]]);

        const editor = mgr._dom.list.querySelector('.admin-note-editor');
        expect(editor.style.display).toBe('none');

        mgr._dom.list.querySelector('.admin-note-btn').click();
        expect(editor.style.display).toBe('flex');
    });

    it('zeigt eine vorhandene Notiz im Textfeld an', async () => {
        const mgr = await makeManager();
        mgr._render([{ ...PHOTOS[0], note: 'Tolles Restaurant hier gefunden' }]);

        const textarea = mgr._dom.list.querySelector('.admin-note-input');
        expect(textarea.value).toBe('Tolles Restaurant hier gefunden');
    });

    it('speichert eine neue Notiz und klappt den Editor danach zu', async () => {
        updateNote.mockResolvedValue();
        const mgr = await makeManager();
        const photo = { ...PHOTOS[0], note: null };
        mgr._render([photo]);

        const editor = mgr._dom.list.querySelector('.admin-note-editor');
        const textarea = editor.querySelector('.admin-note-input');
        textarea.value = 'Neue Notiz';

        editor.querySelector('.admin-note-save-btn').click();
        await vi.waitFor(() => expect(updateNote).toHaveBeenCalledWith('a.jpg', 'Neue Notiz'));

        expect(photo.note).toBe('Neue Notiz');
        expect(editor.style.display).toBe('none');
    });

    it('zeigt einen Alert, wenn das Speichern der Notiz fehlschlägt', async () => {
        updateNote.mockRejectedValue(new Error('Notiz zu lang'));
        const mgr = await makeManager();
        mgr._render([PHOTOS[0]]);

        mgr._dom.list.querySelector('.admin-note-save-btn').click();
        await vi.waitFor(() => expect(alert).toHaveBeenCalledWith('Notiz zu lang'));
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

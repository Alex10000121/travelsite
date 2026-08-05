import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../static/api.js', () => ({
    fetchAdminRoutes: vi.fn(),
    setRouteMode:     vi.fn(),
}));

import { AdminRouteManager } from '../../static/admin-routes.js';
import { fetchAdminRoutes, setRouteMode } from '../../static/api.js';

function makeDom() {
    return {
        list:        document.createElement('ul'),
        loadMoreBtn: document.createElement('button'),
    };
}

function emptyPage() {
    return { segments: [], total: 0, offset: 0, limit: 50 };
}

const SEGMENTS = [
    { start_filename: 'a.jpg', end_filename: 'b.jpg', start_location: 'Paris, FR', end_location: 'Berlin, DE', distance_km: 878.3, mode: 'drive' },
    { start_filename: 'b.jpg', end_filename: 'c.jpg', start_location: 'Berlin, DE', end_location: 'Tokio, JP', distance_km: 8926.1, mode: null },
];

// Der Konstruktor stößt selbst einen load() an (fire-and-forget), siehe admin-manage.test.js.
async function loadedManager(page) {
    fetchAdminRoutes.mockResolvedValue(page);
    const mgr = new AdminRouteManager(makeDom());
    await mgr.load();
    return mgr;
}

function makeManager() {
    return loadedManager(emptyPage());
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('alert', vi.fn());
});

describe('_render', () => {
    it('rendert für jeden Abschnitt ein Listenelement mit Ort und Distanz', async () => {
        const mgr = await makeManager();
        mgr._render(SEGMENTS);

        const items = mgr._dom.list.querySelectorAll('.admin-route-item');
        expect(items).toHaveLength(2);
        expect(items[0].querySelector('.admin-route-label').textContent).toBe('Paris, FR → Berlin, DE');
        expect(items[0].querySelector('.admin-route-distance').textContent).toBe('878.3 km');
    });

    it('markiert den aktuellen Modus als aktiv', async () => {
        const mgr = await makeManager();
        mgr._render([SEGMENTS[0]]);

        const [driveBtn, flightBtn] = mgr._dom.list.querySelectorAll('.admin-mode-btn');
        expect(driveBtn.classList.contains('active')).toBe(true);
        expect(flightBtn.classList.contains('active')).toBe(false);
    });

    it('markiert keinen Button, solange der Modus noch nicht berechnet wurde', async () => {
        const mgr = await makeManager();
        mgr._render([SEGMENTS[1]]);

        const buttons = mgr._dom.list.querySelectorAll('.admin-mode-btn');
        expect([...buttons].some(b => b.classList.contains('active'))).toBe(false);
    });
});

describe('load', () => {
    it('zeigt einen Alert, wenn das Laden fehlschlägt', async () => {
        fetchAdminRoutes.mockRejectedValue(new Error('Netzwerkfehler'));
        const mgr = new AdminRouteManager(makeDom());

        await mgr.load();

        expect(alert).toHaveBeenCalledWith('Netzwerkfehler');
    });

    it('blendet den Weitere-laden-Button ein, solange noch Seiten fehlen', async () => {
        const mgr = await loadedManager({ segments: SEGMENTS, total: 5, offset: 0, limit: 2 });

        expect(mgr._dom.loadMoreBtn.style.display).toBe('');
    });

    it('blendet den Button aus, sobald alle Seiten geladen sind', async () => {
        const mgr = await loadedManager({ segments: SEGMENTS, total: 2, offset: 0, limit: 50 });

        expect(mgr._dom.loadMoreBtn.style.display).toBe('none');
    });

    it('klickt man auf Weitere laden, wird ab dem aktuellen Offset weitergeladen', async () => {
        const mgr = await makeManager();
        mgr._offset = 50;
        fetchAdminRoutes.mockClear();
        fetchAdminRoutes.mockResolvedValue(emptyPage());

        mgr._dom.loadMoreBtn.click();
        await vi.waitFor(() => expect(fetchAdminRoutes).toHaveBeenCalledWith({ offset: 50 }));
    });
});

describe('Modus-Umschalter', () => {
    it('setzt den Modus auf Flug und aktualisiert die Buttons', async () => {
        setRouteMode.mockResolvedValue();
        const mgr = await makeManager();
        const segment = { ...SEGMENTS[0] };
        mgr._render([segment]);

        const [driveBtn, flightBtn] = mgr._dom.list.querySelectorAll('.admin-mode-btn');
        flightBtn.click();

        await vi.waitFor(() => expect(setRouteMode).toHaveBeenCalledWith('a.jpg', 'b.jpg', 'flight'));
        expect(flightBtn.classList.contains('active')).toBe(true);
        expect(driveBtn.classList.contains('active')).toBe(false);
        expect(segment.mode).toBe('flight');
    });

    it('zeigt einen Alert, wenn das Speichern fehlschlägt', async () => {
        setRouteMode.mockRejectedValue(new Error('Modus konnte nicht gespeichert werden.'));
        const mgr = await makeManager();
        mgr._render([SEGMENTS[1]]);

        mgr._dom.list.querySelector('.admin-mode-btn').click();
        await vi.waitFor(() => expect(alert).toHaveBeenCalledWith('Modus konnte nicht gespeichert werden.'));
    });
});

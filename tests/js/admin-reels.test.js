import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../static/api.js', () => ({
    fetchReelGroups:  vi.fn(),
    createReel:       vi.fn(),
    fetchAdminReels:  vi.fn(),
    fetchReelStatus:  vi.fn(),
    deleteReel:       vi.fn(),
    reelDownloadUrl:  vi.fn((id) => `/api/admin/reels/${id}/file`),
}));

import { AdminReelManager } from '../../static/admin-reels.js';
import { fetchReelGroups, createReel, fetchAdminReels, fetchReelStatus, deleteReel } from '../../static/api.js';

function makeDom() {
    const durationInput = document.createElement('input');
    durationInput.type = 'number';
    durationInput.value = '30';
    return {
        groupSelect:   document.createElement('select'),
        durationInput,
        createBtn:     document.createElement('button'),
        list:          document.createElement('ul'),
        loadMoreBtn:   document.createElement('button'),
    };
}

function emptyPage() {
    return { reels: [], total: 0, offset: 0, limit: 20 };
}

const REELS = [
    { id: 1, group_key: 'DE', status: 'done', filename: 'DE_1.mp4', photo_count: 12, video_count: 2, duration_seconds: 42.3 },
    { id: 2, group_key: 'FR', status: 'error', filename: null, error_message: 'ffmpeg fehlgeschlagen: boom' },
];

// Der Konstruktor stößt selbst _loadGroups()/load() an (fire-and-forget), siehe admin-routes.test.js.
async function loadedManager(page, groups = []) {
    fetchReelGroups.mockResolvedValue({ groups });
    fetchAdminReels.mockResolvedValue(page);
    const mgr = new AdminReelManager(makeDom());
    await mgr.load();
    await mgr._loadGroups();
    return mgr;
}

function makeManager() {
    return loadedManager(emptyPage());
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('alert', vi.fn());
});

describe('Länder-Dropdown', () => {
    it('rendert eine Option pro Gruppe mit Foto-/Videoanzahl', async () => {
        const mgr = await loadedManager(emptyPage(), [
            { group_key: 'DE', photo_count: 12, video_count: 2 },
            { group_key: 'FR', photo_count: 3, video_count: 0 },
        ]);

        const options = mgr._dom.groupSelect.querySelectorAll('option');
        expect(options).toHaveLength(2);
        expect(options[0].value).toBe('DE');
        expect(options[0].textContent).toBe('Deutschland (12 Fotos, 2 Videos)');
        expect(mgr._dom.groupSelect.disabled).toBe(false);
    });

    it('blendet die Videoanzahl aus, wenn eine Gruppe keine Videos enthält', async () => {
        const mgr = await loadedManager(emptyPage(), [{ group_key: 'FR', photo_count: 3, video_count: 0 }]);

        const option = mgr._dom.groupSelect.querySelector('option');
        expect(option.textContent).toBe('Frankreich (3 Fotos)');
    });

    it('deaktiviert das Dropdown, wenn keine Gruppen vorhanden sind', async () => {
        const mgr = await loadedManager(emptyPage(), []);
        expect(mgr._dom.groupSelect.disabled).toBe(true);
    });

    it('zeigt einen Alert, wenn das Laden der Gruppen fehlschlägt', async () => {
        fetchReelGroups.mockRejectedValue(new Error('Verbindungsfehler beim Laden der Reel-Gruppen.'));
        fetchAdminReels.mockResolvedValue(emptyPage());
        const mgr = new AdminReelManager(makeDom());

        await mgr._loadGroups();
        expect(alert).toHaveBeenCalledWith('Verbindungsfehler beim Laden der Reel-Gruppen.');
    });
});

describe('_render', () => {
    it('rendert für jedes Reel Gruppe, Status und Beschreibung', async () => {
        const mgr = await makeManager();
        mgr._render(REELS);

        const items = mgr._dom.list.querySelectorAll('.admin-log-item');
        expect(items).toHaveLength(2);
        expect(items[0].querySelector('.admin-log-action').textContent).toBe('DE');
        expect(items[0].querySelector('.admin-reel-status').textContent).toBe('Fertig');
        expect(items[0].querySelector('.admin-log-detail').textContent).toBe('12 Fotos · 2 Videos · 42s');
    });

    it('zeigt die Fehlermeldung bei status=error an', async () => {
        const mgr = await makeManager();
        mgr._render([REELS[1]]);

        const detail = mgr._dom.list.querySelector('.admin-log-detail');
        expect(detail.textContent).toBe('ffmpeg fehlgeschlagen: boom');
        expect(mgr._dom.list.querySelector('.admin-reel-status').textContent).toBe('Fehler');
    });

    it('zeigt einen Download-Link nur bei status=done', async () => {
        const mgr = await makeManager();
        mgr._render(REELS);

        const items = mgr._dom.list.querySelectorAll('.admin-log-item');
        expect(items[0].querySelector('.admin-reel-download-btn')).not.toBeNull();
        expect(items[1].querySelector('.admin-reel-download-btn')).toBeNull();
    });

    it('setzt data-reel-id für spätere In-Place-Updates', async () => {
        const mgr = await makeManager();
        mgr._render([REELS[0]]);

        const item = mgr._dom.list.querySelector('.admin-log-item');
        expect(item.dataset.reelId).toBe('1');
    });
});

describe('load', () => {
    it('zeigt einen Alert, wenn das Laden fehlschlägt', async () => {
        fetchAdminReels.mockRejectedValue(new Error('Netzwerkfehler'));
        const mgr = new AdminReelManager(makeDom());

        await mgr.load();
        expect(alert).toHaveBeenCalledWith('Netzwerkfehler');
    });

    it('blendet den Weitere-laden-Button ein, solange noch Reels fehlen', async () => {
        const mgr = await loadedManager({ reels: REELS, total: 5, offset: 0, limit: 2 });
        expect(mgr._dom.loadMoreBtn.style.display).toBe('');
    });

    it('blendet den Button aus, sobald alle Reels geladen sind', async () => {
        const mgr = await loadedManager({ reels: REELS, total: 2, offset: 0, limit: 20 });
        expect(mgr._dom.loadMoreBtn.style.display).toBe('none');
    });

    it('klickt man auf Weitere laden, wird ab dem aktuellen Offset weitergeladen', async () => {
        const mgr = await makeManager();
        mgr._offset = 20;
        fetchAdminReels.mockClear();
        fetchAdminReels.mockResolvedValue(emptyPage());

        mgr._dom.loadMoreBtn.click();
        await vi.waitFor(() => expect(fetchAdminReels).toHaveBeenCalledWith({ offset: 20 }));
    });
});

describe('Reel erstellen', () => {
    it('startet die Erstellung für die ausgewählte Gruppe mit der eingestellten Dauer', async () => {
        const mgr = await loadedManager(emptyPage(), [{ group_key: 'DE', photo_count: 1, video_count: 0 }]);
        mgr._dom.groupSelect.value = 'DE';
        mgr._dom.durationInput.value = '60';

        createReel.mockResolvedValue({ success: true, reel_id: 42 });
        fetchAdminReels.mockClear();
        fetchAdminReels.mockResolvedValue(emptyPage());

        mgr._dom.createBtn.click();
        await vi.waitFor(() => expect(createReel).toHaveBeenCalledWith('DE', 60));
        await vi.waitFor(() => expect(fetchAdminReels).toHaveBeenCalled());
        await vi.waitFor(() => expect(mgr._dom.createBtn.disabled).toBe(false));
    });

    it('fällt bei leerer/ungültiger Dauer auf den Standardwert zurück', async () => {
        const mgr = await loadedManager(emptyPage(), [{ group_key: 'DE', photo_count: 1, video_count: 0 }]);
        mgr._dom.groupSelect.value = 'DE';
        mgr._dom.durationInput.value = '';

        createReel.mockResolvedValue({ success: true, reel_id: 42 });
        fetchAdminReels.mockResolvedValue(emptyPage());

        mgr._dom.createBtn.click();
        await vi.waitFor(() => expect(createReel).toHaveBeenCalledWith('DE', 30));
    });

    it('tut nichts ohne ausgewählte Gruppe', async () => {
        const mgr = await makeManager();
        mgr._dom.groupSelect.value = '';

        mgr._dom.createBtn.click();
        await Promise.resolve();
        expect(createReel).not.toHaveBeenCalled();
    });

    it('zeigt einen Alert, wenn das Starten fehlschlägt (z.B. 409 bei laufendem Job)', async () => {
        const mgr = await loadedManager(emptyPage(), [{ group_key: 'DE', photo_count: 1, video_count: 0 }]);
        mgr._dom.groupSelect.value = 'DE';
        createReel.mockRejectedValue(new Error('Es laeuft bereits eine Reel-Generierung. Bitte warten.'));

        mgr._dom.createBtn.click();
        await vi.waitFor(() => expect(alert).toHaveBeenCalledWith('Es laeuft bereits eine Reel-Generierung. Bitte warten.'));
        expect(mgr._dom.createBtn.disabled).toBe(false);
    });
});

describe('Löschen', () => {
    it('löscht das Reel und lädt die Liste neu', async () => {
        const mgr = await makeManager();
        mgr._render([REELS[0]]);
        fetchAdminReels.mockClear();
        fetchAdminReels.mockResolvedValue(emptyPage());
        deleteReel.mockResolvedValue();

        mgr._dom.list.querySelector('.admin-delete-btn').click();
        await vi.waitFor(() => expect(deleteReel).toHaveBeenCalledWith(1));
        await vi.waitFor(() => expect(fetchAdminReels).toHaveBeenCalled());
    });

    it('zeigt einen Alert, wenn das Löschen fehlschlägt', async () => {
        const mgr = await makeManager();
        mgr._render([REELS[0]]);
        deleteReel.mockRejectedValue(new Error('Reel konnte nicht gelöscht werden.'));

        mgr._dom.list.querySelector('.admin-delete-btn').click();
        await vi.waitFor(() => expect(alert).toHaveBeenCalledWith('Reel konnte nicht gelöscht werden.'));
    });
});

describe('Polling laufender Jobs', () => {
    beforeEach(() => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }));

    it('aktualisiert ein pending Reel in-place, bis es fertig ist', async () => {
        const pending = { id: 7, group_key: 'DE', status: 'pending' };
        const mgr = await loadedManager({ reels: [pending], total: 1, offset: 0, limit: 20 });

        expect(mgr._dom.list.querySelector('.admin-reel-status').textContent).toBe('Wartet');

        fetchReelStatus.mockResolvedValue({ id: 7, group_key: 'DE', status: 'done', filename: 'DE_7.mp4', photo_count: 4, video_count: 1 });
        await vi.advanceTimersByTimeAsync(3000);

        expect(fetchReelStatus).toHaveBeenCalledWith(7);
        const item = mgr._dom.list.querySelector('[data-reel-id="7"]');
        expect(item.querySelector('.admin-reel-status').textContent).toBe('Fertig');
        expect(item.querySelector('.admin-reel-download-btn')).not.toBeNull();
    });

    it('stoppt das Polling, sobald der Job fertig ist', async () => {
        const pending = { id: 8, group_key: 'DE', status: 'pending' };
        const mgr = await loadedManager({ reels: [pending], total: 1, offset: 0, limit: 20 });

        fetchReelStatus.mockResolvedValue({ id: 8, group_key: 'DE', status: 'done', filename: 'DE_8.mp4' });
        await vi.advanceTimersByTimeAsync(3000);
        expect(fetchReelStatus).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(3000);
        expect(fetchReelStatus).toHaveBeenCalledTimes(1);
    });

    it('startet kein zweites Polling-Intervall für dasselbe Reel', async () => {
        const pending = { id: 9, group_key: 'DE', status: 'running' };
        const mgr = await loadedManager({ reels: [pending], total: 1, offset: 0, limit: 20 });

        mgr._pollReel(9);
        fetchReelStatus.mockResolvedValue({ id: 9, group_key: 'DE', status: 'running' });

        await vi.advanceTimersByTimeAsync(3000);
        expect(fetchReelStatus).toHaveBeenCalledTimes(1);
    });
});

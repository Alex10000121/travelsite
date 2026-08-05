import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../static/api.js', () => ({
    fetchAdminLog: vi.fn(),
}));

import { AdminLog } from '../../static/admin-log.js';
import { fetchAdminLog } from '../../static/api.js';

function makeDom() {
    return {
        list:        document.createElement('ul'),
        searchInput: document.createElement('input'),
        countEl:     document.createElement('p'),
        loadMoreBtn: document.createElement('button'),
    };
}

function emptyPage() {
    return { entries: [], total: 0, offset: 0, limit: 50 };
}

const ENTRIES = [
    { action: 'upload', detail: 'a.jpg (Paris, FR)', datetime_str: '01.01.2026 10:00:00' },
    { action: 'delete_photo', detail: 'b.jpg', datetime_str: '01.01.2026 09:00:00' },
    { action: 'some_future_action', detail: null, datetime_str: '01.01.2026 08:00:00' },
];

// Der Konstruktor stößt selbst einen load() an (fire-and-forget), siehe admin-manage.test.js.
async function makeLog(page = emptyPage()) {
    fetchAdminLog.mockResolvedValue(page);
    const log = new AdminLog(makeDom());
    await log.load();
    return log;
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('alert', vi.fn());
});

describe('_render', () => {
    it('rendert für jeden Eintrag ein Listenelement mit Aktion, Detail und Zeit', async () => {
        const log = await makeLog();
        log._render(ENTRIES);

        const items = log._dom.list.querySelectorAll('.admin-log-item');
        expect(items).toHaveLength(3);
        expect(items[0].querySelector('.admin-log-action').textContent).toBe('Foto hochgeladen');
        expect(items[0].querySelector('.admin-log-detail').textContent).toBe('a.jpg (Paris, FR)');
        expect(items[0].querySelector('.admin-log-time').textContent).toBe('01.01.2026 10:00:00');
    });

    it('übersetzt bekannte Aktionen in lesbare Labels', async () => {
        const log = await makeLog();
        log._render([ENTRIES[1]]);

        expect(log._dom.list.querySelector('.admin-log-action').textContent).toBe('Foto gelöscht');
    });

    it('fällt bei unbekannter Aktion auf den rohen Wert zurück', async () => {
        const log = await makeLog();
        log._render([ENTRIES[2]]);

        expect(log._dom.list.querySelector('.admin-log-action').textContent).toBe('some_future_action');
    });

    it('zeigt ein leeres Detail-Feld, wenn kein Detail vorhanden ist', async () => {
        const log = await makeLog();
        log._render([ENTRIES[2]]);

        expect(log._dom.list.querySelector('.admin-log-detail').textContent).toBe('');
    });
});

describe('load', () => {
    it('zeigt einen Alert, wenn das Laden fehlschlägt', async () => {
        fetchAdminLog.mockRejectedValue(new Error('Netzwerkfehler'));
        const log = new AdminLog(makeDom());

        await log.load();

        expect(alert).toHaveBeenCalledWith('Netzwerkfehler');
    });

    it('blendet den Weitere-laden-Button ein, solange noch Seiten fehlen', async () => {
        const log = await makeLog({ entries: ENTRIES, total: 10, offset: 0, limit: 3 });

        expect(log._dom.loadMoreBtn.style.display).toBe('');
    });

    it('blendet den Button aus, sobald alle Seiten geladen sind', async () => {
        const log = await makeLog({ entries: ENTRIES, total: 3, offset: 0, limit: 50 });

        expect(log._dom.loadMoreBtn.style.display).toBe('none');
    });

    it('klickt man auf Weitere laden, wird ab dem aktuellen Offset weitergeladen', async () => {
        const log = await makeLog();
        log._offset = 50;
        fetchAdminLog.mockClear();
        fetchAdminLog.mockResolvedValue(emptyPage());

        log._dom.loadMoreBtn.click();
        await vi.waitFor(() => expect(fetchAdminLog).toHaveBeenCalledWith({ q: '', offset: 50 }));
    });
});

describe('Zähler (_updateCount)', () => {
    it('zeigt "Keine Einträge" bei leerem Ergebnis', async () => {
        const log = await makeLog();

        expect(log._dom.countEl.textContent).toBe('Keine Einträge');
    });

    it('zeigt die geladene Anzahl von der Gesamtzahl', async () => {
        const log = await makeLog({ entries: ENTRIES, total: 10, offset: 0, limit: 3 });

        expect(log._dom.countEl.textContent).toBe('3 von 10 Einträgen geladen');
    });
});

describe('Suche (_onSearchInput)', () => {
    beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
    afterEach(() => vi.useRealTimers());

    it('lädt debounced neu ab Seite 1, sobald ins Suchfeld getippt wird', async () => {
        const log = await makeLog();
        fetchAdminLog.mockClear();
        fetchAdminLog.mockResolvedValue({ entries: [ENTRIES[1]], total: 1, offset: 0, limit: 50 });

        log._dom.searchInput.value = 'delete';
        log._dom.searchInput.dispatchEvent(new Event('input'));

        expect(fetchAdminLog).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(300);

        expect(fetchAdminLog).toHaveBeenCalledWith({ q: 'delete', offset: 0 });
    });

    it('feuert bei schnellem Tippen nur eine Anfrage (Debounce)', async () => {
        const log = await makeLog();
        fetchAdminLog.mockClear();
        fetchAdminLog.mockResolvedValue(emptyPage());

        for (const value of ['l', 'lo', 'log', 'logi']) {
            log._dom.searchInput.value = value;
            log._dom.searchInput.dispatchEvent(new Event('input'));
            await vi.advanceTimersByTimeAsync(100);
        }
        await vi.advanceTimersByTimeAsync(300);

        expect(fetchAdminLog).toHaveBeenCalledTimes(1);
        expect(fetchAdminLog).toHaveBeenCalledWith({ q: 'logi', offset: 0 });
    });
});

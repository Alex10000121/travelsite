// Log-Feature der /admin-Seite: zeigt das Admin-Aktionsprotokoll (siehe admin_log-Tabelle
// in app.py) - Login/Logout, Uploads, Loeschungen, GPS-/Notiz-/Favoriten-Aenderungen,
// Routen-Overrides. Serverseitig durchsuchbar und paginiert, analog zu admin-manage.js.

import { fetchAdminLog } from './api.js';
import { SEARCH_DEBOUNCE_MS, debounce, tryOrAlert, updateLoadMoreVisibility, renderInto, createSpan } from './dom-utils.js';

const ACTION_LABELS = {
    login: 'Login',
    login_failed: 'Fehlgeschlagener Login',
    logout: 'Logout',
    upload: 'Foto hochgeladen',
    update_location: 'GPS korrigiert',
    update_note: 'Notiz geändert',
    set_favorite: 'Als Favorit markiert',
    unset_favorite: 'Favorit entfernt',
    delete_photo: 'Foto gelöscht',
    set_route_mode: 'Routen-Modus geändert',
};

export class AdminLog {

    /**
     * @param {object} dom
     * @param {HTMLElement} dom.list        - <ul> für die Protokoll-Liste
     * @param {HTMLInputElement} dom.searchInput
     * @param {HTMLElement} dom.countEl     - zeigt "X von Y Einträgen" an
     * @param {HTMLElement} dom.loadMoreBtn
     */
    constructor(dom) {
        this._dom = dom;
        this._query = '';
        this._offset = 0;
        this._total = 0;

        const triggerSearch = debounce(() => {
            this._query = dom.searchInput.value.trim();
            this.load({ reset: true });
        }, SEARCH_DEBOUNCE_MS);

        dom.loadMoreBtn?.addEventListener('click', () => this.load({ reset: false }));
        dom.searchInput?.addEventListener('input', triggerSearch);

        this.load();
    }

    async load({ reset = true } = {}) {
        await tryOrAlert(async () => {
            const page = await fetchAdminLog({
                q: this._query,
                offset: reset ? 0 : this._offset,
            });

            this._offset = page.offset + page.entries.length;
            this._total = page.total;

            this._render(page.entries, { append: !reset });
            updateLoadMoreVisibility(this._dom.loadMoreBtn, this._offset, this._total);
            this._updateCount();
        });
    }

    _updateCount() {
        const { countEl } = this._dom;
        if (!countEl) return;
        countEl.textContent = this._total === 0
            ? 'Keine Einträge'
            : `${this._offset} von ${this._total} Einträgen geladen`;
    }

    _render(entries, opts) {
        renderInto(this._dom.list, entries, (entry) => this._buildItem(entry), opts);
    }

    _buildItem(entry) {
        const li = document.createElement('li');
        li.className = 'admin-log-item';

        li.append(
            createSpan('admin-log-action', ACTION_LABELS[entry.action] || entry.action),
            createSpan('admin-log-detail', entry.detail || ''),
            createSpan('admin-log-time', entry.datetime_str),
        );
        return li;
    }
}

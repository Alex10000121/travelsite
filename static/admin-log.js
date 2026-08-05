// Log-Feature der /admin-Seite: zeigt das Admin-Aktionsprotokoll (siehe admin_log-Tabelle
// in app.py) - Login/Logout, Uploads, Loeschungen, GPS-/Notiz-/Favoriten-Aenderungen,
// Routen-Overrides. Serverseitig durchsuchbar und paginiert, analog zu admin-manage.js.

import { fetchAdminLog } from './api.js';

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

const SEARCH_DEBOUNCE_MS = 300;

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
        this._searchTimer = null;

        dom.loadMoreBtn?.addEventListener('click', () => this.load({ reset: false }));
        dom.searchInput?.addEventListener('input', () => this._onSearchInput());

        this.load();
    }

    async load({ reset = true } = {}) {
        try {
            const data = await fetchAdminLog({
                q: this._query,
                offset: reset ? 0 : this._offset,
            });

            this._offset = data.offset + data.entries.length;
            this._total = data.total;

            this._render(data.entries, { append: !reset });
            this._updateLoadMoreVisibility();
            this._updateCount();
        } catch (err) {
            alert(err.message);
        }
    }

    _onSearchInput() {
        clearTimeout(this._searchTimer);
        this._searchTimer = setTimeout(() => {
            this._query = this._dom.searchInput.value.trim();
            this.load({ reset: true });
        }, SEARCH_DEBOUNCE_MS);
    }

    _updateLoadMoreVisibility() {
        const { loadMoreBtn } = this._dom;
        if (!loadMoreBtn) return;
        loadMoreBtn.style.display = this._offset < this._total ? '' : 'none';
    }

    _updateCount() {
        const { countEl } = this._dom;
        if (!countEl) return;
        countEl.textContent = this._total === 0
            ? 'Keine Einträge'
            : `${this._offset} von ${this._total} Einträgen geladen`;
    }

    _render(entries, { append = false } = {}) {
        const { list } = this._dom;
        if (!list) return;

        if (!append) list.innerHTML = '';

        const fragment = document.createDocumentFragment();
        for (const entry of entries) {
            fragment.appendChild(this._buildItem(entry));
        }
        list.appendChild(fragment);
    }

    _buildItem(entry) {
        const li = document.createElement('li');
        li.className = 'admin-log-item';

        const action = this._span('admin-log-action', ACTION_LABELS[entry.action] || entry.action);
        const detail = this._span('admin-log-detail', entry.detail || '');
        const time = this._span('admin-log-time', entry.datetime_str);

        li.append(action, detail, time);
        return li;
    }

    _span(className, text) {
        const el = document.createElement('span');
        el.className = className;
        el.textContent = text;
        return el;
    }
}

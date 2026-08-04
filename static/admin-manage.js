// Verwaltungs-Feature der /admin-Seite: bestehende Fotos durchsuchen/auflisten,
// GPS nachträglich korrigieren (Mini-Karte im Modal) und löschen.
//
// Serverseitig paginiert (siehe api.js) statt alle Fotos auf einmal zu laden —
// bei mehreren hundert/tausend Fotos würde das sonst hunderte Thumbnail-Requests
// und DOM-Knoten in einem Schlag erzeugen.

import { fetchAdminPhotos, deletePhoto, updateLocation } from './api.js';
import { encodeFilenamePath } from './filename-utils.js';

const SEARCH_DEBOUNCE_MS = 300;

export class AdminPhotoManager {

    /**
     * @param {object} dom
     * @param {HTMLElement} dom.list        - <ul> für die Foto-Liste
     * @param {HTMLInputElement} dom.searchInput
     * @param {HTMLElement} dom.loadMoreBtn
     * @param {HTMLElement} dom.modal       - Fix-GPS-Modal (.modal-overlay)
     * @param {HTMLElement} dom.closeBtn    - Modal schließen
     * @param {HTMLElement} dom.confirmBtn  - Position speichern
     *
     * @param {import('./map.js').MapController} map - Mini-Karte im Modal
     */
    constructor(dom, map) {
        this._dom = dom;
        this._map = map;
        this._activeFilename = null;

        this._query = '';
        this._offset = 0;
        this._limit = 60;
        this._total = 0;
        this._searchTimer = null;

        dom.closeBtn?.addEventListener('click', () => this._closeModal());
        dom.confirmBtn?.addEventListener('click', () => this._confirmFix());
        dom.searchInput?.addEventListener('input', () => this._onSearchInput());
        dom.loadMoreBtn?.addEventListener('click', () => this.load({ reset: false }));

        this.load();
    }

    /**
     * @param {object} [opts]
     * @param {boolean} [opts.reset=true] - true: Liste ersetzen (neue Suche/Erststart),
     *                                       false: nächste Seite anhängen
     */
    async load({ reset = true } = {}) {
        try {
            const data = await fetchAdminPhotos({
                q: this._query,
                offset: reset ? 0 : this._offset,
            });

            this._offset = data.offset + data.photos.length;
            this._total = data.total;
            this._limit = data.limit;

            this._render(data.photos, { append: !reset });
            this._updateLoadMoreVisibility();
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

    _render(photos, { append = false } = {}) {
        const { list } = this._dom;
        if (!list) return;

        if (!append) list.innerHTML = '';

        const fragment = document.createDocumentFragment();
        for (const photo of photos) {
            fragment.appendChild(this._buildItem(photo));
        }
        list.appendChild(fragment);
    }

    _buildItem(photo) {
        const li = document.createElement('li');
        li.className = 'admin-photo-item';

        const img = document.createElement('img');
        img.src = `/api/thumb/${encodeFilenamePath(photo.filename)}?size=blur`;
        img.loading = 'lazy';
        img.alt = '';
        li.appendChild(img);

        const info = document.createElement('div');
        info.className = 'admin-photo-info';

        const loc = document.createElement('span');
        loc.className = 'admin-photo-location';
        loc.textContent = photo.location || 'Unbekannt';

        const date = document.createElement('span');
        date.className = 'admin-photo-date';
        date.textContent = photo.date_str || '';

        info.append(loc, date);
        li.appendChild(info);

        const actions = document.createElement('div');
        actions.className = 'admin-photo-actions';

        const fixBtn = document.createElement('button');
        fixBtn.type = 'button';
        fixBtn.className = 'admin-fix-btn';
        fixBtn.textContent = '📍 GPS';
        fixBtn.addEventListener('click', () => this._openFixModal(photo));

        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'admin-delete-btn';
        delBtn.textContent = '🗑 Löschen';
        delBtn.addEventListener('click', () => this._handleDelete(photo, li));

        actions.append(fixBtn, delBtn);
        li.appendChild(actions);

        return li;
    }

    _openFixModal(photo) {
        this._activeFilename = photo.filename;
        this._dom.modal?.classList.add('show');
        if (photo.lat != null && photo.lon != null) {
            this._map.setFixMarker(photo.lat, photo.lon);
        }
    }

    _closeModal() {
        this._map.removeFixMarker();
        this._activeFilename = null;
        this._dom.modal?.classList.remove('show');
    }

    async _confirmFix() {
        if (!this._map.hasFixMarker()) {
            alert('Bitte Karte verschieben, um eine Position zu setzen.');
            return;
        }

        const pos = this._map.getFixMarkerLatLng();
        const filename = this._activeFilename;

        try {
            await updateLocation(filename, pos.lat, pos.lon);
            this._closeModal();
            await this.load({ reset: true });
        } catch (err) {
            alert(err.message);
        }
    }

    async _handleDelete(photo, liElement) {
        const label = photo.location || photo.filename;
        if (!confirm(`"${label}" wirklich löschen? Das kann nicht rückgängig gemacht werden.`)) return;

        try {
            await deletePhoto(photo.filename);
            liElement.remove();
            this._total = Math.max(0, this._total - 1);
            this._offset = Math.max(0, this._offset - 1);
            this._updateLoadMoreVisibility();
        } catch (err) {
            alert(err.message);
        }
    }
}

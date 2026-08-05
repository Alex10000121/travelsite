// Verwaltungs-Feature der /admin-Seite: bestehende Fotos durchsuchen/auflisten,
// GPS nachträglich korrigieren (Mini-Karte im Modal) und löschen.
//
// Serverseitig paginiert (siehe api.js) statt alle Fotos auf einmal zu laden —
// bei mehreren hundert/tausend Fotos würde das sonst hunderte Thumbnail-Requests
// und DOM-Knoten in einem Schlag erzeugen.

import { fetchAdminPhotos, deletePhoto, updateLocation, updateNote, setFavorite } from './api.js';
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

        const row = document.createElement('div');
        row.className = 'admin-photo-row';

        const img = document.createElement('img');
        img.src = `/api/thumb/${encodeFilenamePath(photo.filename)}?size=blur`;
        img.loading = 'lazy';
        img.alt = '';
        row.appendChild(img);

        const info = document.createElement('div');
        info.className = 'admin-photo-info';

        const loc = document.createElement('span');
        loc.className = 'admin-photo-location';
        loc.textContent = photo.location || 'Unbekannt';

        const date = document.createElement('span');
        date.className = 'admin-photo-date';
        date.textContent = photo.date_str || '';

        info.append(loc, date);
        row.appendChild(info);

        const actions = document.createElement('div');
        actions.className = 'admin-photo-actions';

        // Icon-only statt Text-Buttons: bei vier Aktionen nebeneinander sprengt
        // Text ("★ Favorit", "📍 GPS", ...) die Kartenbreite und ueberlappt die
        // Info-Spalte bzw. schneidet den letzten Button ab. Tooltip via title/aria-label.
        const favBtn = document.createElement('button');
        favBtn.type = 'button';
        favBtn.className = 'admin-fav-btn';
        this._renderFavBtn(favBtn, !!photo.is_favorite);
        favBtn.addEventListener('click', async () => {
            const next = !photo.is_favorite;
            try {
                await setFavorite(photo.filename, next);
                photo.is_favorite = next;
                this._renderFavBtn(favBtn, next);
            } catch (err) {
                alert(err.message);
            }
        });

        const fixBtn = this._createIconButton('admin-fix-btn', '📍', 'GPS-Position korrigieren');
        fixBtn.addEventListener('click', () => this._openFixModal(photo));

        const noteBtn = this._createIconButton('admin-note-btn', '📝', 'Notiz');

        const delBtn = this._createIconButton('admin-delete-btn', '🗑', 'Löschen');
        delBtn.addEventListener('click', () => this._handleDelete(photo, li));

        actions.append(favBtn, fixBtn, noteBtn, delBtn);
        row.appendChild(actions);
        li.appendChild(row);

        const noteEditor = this._buildNoteEditor(photo);
        noteBtn.addEventListener('click', () => {
            noteEditor.style.display = noteEditor.style.display === 'none' ? 'flex' : 'none';
        });
        li.appendChild(noteEditor);

        return li;
    }

    /** Optionale Notiz - eingeklappt per Default, damit die Liste nicht ueberladen wirkt. */
    _buildNoteEditor(photo) {
        const wrap = document.createElement('div');
        wrap.className = 'admin-note-editor';
        wrap.style.display = 'none';

        const textarea = document.createElement('textarea');
        textarea.className = 'admin-note-input';
        textarea.placeholder = 'Notiz zu diesem Foto (optional)…';
        textarea.value = photo.note || '';
        textarea.maxLength = 2000;

        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'admin-note-save-btn';
        saveBtn.textContent = 'Speichern';
        saveBtn.addEventListener('click', async () => {
            try {
                await updateNote(photo.filename, textarea.value);
                photo.note = textarea.value.trim() || null;
                wrap.style.display = 'none';
            } catch (err) {
                alert(err.message);
            }
        });

        wrap.append(textarea, saveBtn);
        return wrap;
    }

    _createIconButton(className, text, title) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = className;
        btn.textContent = text;
        btn.title = title;
        btn.setAttribute('aria-label', title);
        return btn;
    }

    _renderFavBtn(btn, active) {
        btn.textContent = active ? '★' : '☆';
        btn.title = active ? 'Favorit entfernen' : 'Als Favorit markieren';
        btn.setAttribute('aria-label', btn.title);
        btn.classList.toggle('active', active);
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

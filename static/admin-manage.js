// Verwaltungs-Feature der /admin-Seite: bestehende Fotos durchsuchen/auflisten,
// GPS nachträglich korrigieren (Mini-Karte im Modal) und löschen.
//
// Serverseitig paginiert (siehe api.js) statt alle Fotos auf einmal zu laden —
// bei mehreren hundert/tausend Fotos würde das sonst hunderte Thumbnail-Requests
// und DOM-Knoten in einem Schlag erzeugen.

import { fetchAdminPhotos, deletePhoto, updateLocation, updateNote, setFavorite } from './api.js';
import { buildThumbUrl } from './filename-utils.js';
import {
    SEARCH_DEBOUNCE_MS, debounce, tryOrAlert, updateLoadMoreVisibility,
    renderInto, createButton, createSpan, createLazyImage,
} from './dom-utils.js';

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

        const triggerSearch = debounce(() => {
            this._query = dom.searchInput.value.trim();
            this.load({ reset: true });
        }, SEARCH_DEBOUNCE_MS);

        dom.closeBtn?.addEventListener('click', () => this._closeModal());
        dom.confirmBtn?.addEventListener('click', () => this._confirmFix());
        dom.searchInput?.addEventListener('input', triggerSearch);
        dom.loadMoreBtn?.addEventListener('click', () => this.load({ reset: false }));

        this.load();
    }

    /**
     * @param {object} [opts]
     * @param {boolean} [opts.reset=true] - true: Liste ersetzen (neue Suche/Erststart),
     *                                       false: nächste Seite anhängen
     */
    async load({ reset = true } = {}) {
        await tryOrAlert(async () => {
            const page = await fetchAdminPhotos({
                q: this._query,
                offset: reset ? 0 : this._offset,
            });

            this._offset = page.offset + page.photos.length;
            this._total = page.total;
            this._limit = page.limit;

            this._render(page.photos, { append: !reset });
            updateLoadMoreVisibility(this._dom.loadMoreBtn, this._offset, this._total);
        });
    }

    _render(photos, opts) {
        renderInto(this._dom.list, photos, (photo) => this._buildItem(photo), opts);
    }

    _buildItem(photo) {
        const li = document.createElement('li');
        li.className = 'admin-photo-item';

        const row = document.createElement('div');
        row.className = 'admin-photo-row';
        row.appendChild(createLazyImage(buildThumbUrl(photo.filename, { size: 'blur' })));
        row.appendChild(this._buildInfo(photo));

        const noteEditor = this._buildNoteEditor(photo);
        row.appendChild(this._buildActions(photo, li, noteEditor));

        li.append(row, noteEditor);
        return li;
    }

    _buildInfo(photo) {
        const info = document.createElement('div');
        info.className = 'admin-photo-info';
        info.append(
            createSpan('admin-photo-location', photo.location || 'Unbekannt'),
            createSpan('admin-photo-date', photo.date_str || ''),
        );
        return info;
    }

    // Icon-only statt Text-Buttons: bei vier Aktionen nebeneinander sprengt
    // Text ("★ Favorit", "📍 GPS", ...) die Kartenbreite und ueberlappt die
    // Info-Spalte bzw. schneidet den letzten Button ab. Tooltip via title/aria-label.
    _buildActions(photo, liElement, noteEditor) {
        const actions = document.createElement('div');
        actions.className = 'admin-photo-actions';

        const fixBtn = this._createIconButton('admin-fix-btn', '📍', 'GPS-Position korrigieren');
        fixBtn.addEventListener('click', () => this._openFixModal(photo));

        const noteBtn = this._createIconButton('admin-note-btn', '📝', 'Notiz');
        noteBtn.addEventListener('click', () => {
            noteEditor.style.display = noteEditor.style.display === 'none' ? 'flex' : 'none';
        });

        const delBtn = this._createIconButton('admin-delete-btn', '🗑', 'Löschen');
        delBtn.addEventListener('click', () => this._handleDelete(photo, liElement));

        actions.append(this._buildFavoriteButton(photo), fixBtn, noteBtn, delBtn);
        return actions;
    }

    _buildFavoriteButton(photo) {
        const favBtn = document.createElement('button');
        favBtn.type = 'button';
        favBtn.className = 'admin-fav-btn';
        this._renderFavBtn(favBtn, !!photo.is_favorite);
        favBtn.addEventListener('click', () => tryOrAlert(async () => {
            const next = !photo.is_favorite;
            await setFavorite(photo.filename, next);
            photo.is_favorite = next;
            this._renderFavBtn(favBtn, next);
        }));
        return favBtn;
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

        const saveBtn = createButton('admin-note-save-btn', 'Speichern');
        saveBtn.addEventListener('click', () => tryOrAlert(async () => {
            await updateNote(photo.filename, textarea.value);
            photo.note = textarea.value.trim() || null;
            wrap.style.display = 'none';
        }));

        wrap.append(textarea, saveBtn);
        return wrap;
    }

    _createIconButton(className, text, title) {
        const btn = createButton(className, text);
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

        await tryOrAlert(async () => {
            await updateLocation(filename, pos.lat, pos.lon);
            this._closeModal();
            await this.load({ reset: true });
        });
    }

    async _handleDelete(photo, liElement) {
        const label = photo.location || photo.filename;
        if (!confirm(`"${label}" wirklich löschen? Das kann nicht rückgängig gemacht werden.`)) return;

        await tryOrAlert(async () => {
            await deletePhoto(photo.filename);
            liElement.remove();
            this._total = Math.max(0, this._total - 1);
            this._offset = Math.max(0, this._offset - 1);
            updateLoadMoreVisibility(this._dom.loadMoreBtn, this._offset, this._total);
        });
    }
}

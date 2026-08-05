// Routen-Verwaltung der /admin-Seite: zeigt automatisch erkannte Fahrt-/Flugstrecken
// zwischen aufeinanderfolgenden Fotos und erlaubt eine manuelle Korrektur des Modus,
// falls die automatische Erkennung (Distanz-Heuristik / OSRM-Ergebnis) danebenlag.
//
// Serverseitig paginiert (siehe api.js), analog zu admin-manage.js.

import { fetchAdminRoutes, setRouteMode } from './api.js';
import { encodeFilenamePath } from './filename-utils.js';

export class AdminRouteManager {

    /**
     * @param {object} dom
     * @param {HTMLElement} dom.list        - <ul> für die Streckenliste
     * @param {HTMLElement} dom.loadMoreBtn
     */
    constructor(dom) {
        this._dom = dom;
        this._offset = 0;
        this._total = 0;

        dom.loadMoreBtn?.addEventListener('click', () => this.load({ reset: false }));

        this.load();
    }

    async load({ reset = true } = {}) {
        try {
            const data = await fetchAdminRoutes({ offset: reset ? 0 : this._offset });

            this._offset = data.offset + data.segments.length;
            this._total = data.total;

            this._render(data.segments, { append: !reset });
            this._updateLoadMoreVisibility();
        } catch (err) {
            alert(err.message);
        }
    }

    _updateLoadMoreVisibility() {
        const { loadMoreBtn } = this._dom;
        if (!loadMoreBtn) return;
        loadMoreBtn.style.display = this._offset < this._total ? '' : 'none';
    }

    _render(segments, { append = false } = {}) {
        const { list } = this._dom;
        if (!list) return;

        if (!append) list.innerHTML = '';

        const fragment = document.createDocumentFragment();
        for (const segment of segments) {
            fragment.appendChild(this._buildItem(segment));
        }
        list.appendChild(fragment);
    }

    _buildThumbImg(filename) {
        const img = document.createElement('img');
        img.src = `/api/thumb/${encodeFilenamePath(filename)}?size=blur`;
        img.loading = 'lazy';
        img.alt = '';
        return img;
    }

    _buildModeButton(text) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'admin-mode-btn';
        btn.textContent = text;
        return btn;
    }

    _buildItem(segment) {
        const li = document.createElement('li');
        li.className = 'admin-route-item';

        const row = document.createElement('div');
        row.className = 'admin-route-row';

        const startImg = this._buildThumbImg(segment.start_filename);
        const endImg = this._buildThumbImg(segment.end_filename);

        const info = document.createElement('div');
        info.className = 'admin-route-info';

        const label = document.createElement('span');
        label.className = 'admin-route-label';
        label.textContent = `${segment.start_location || 'Unbekannt'} → ${segment.end_location || 'Unbekannt'}`;

        const distance = document.createElement('span');
        distance.className = 'admin-route-distance';
        distance.textContent = `${segment.distance_km} km`;

        info.append(label, distance);

        const modeToggle = document.createElement('div');
        modeToggle.className = 'admin-mode-toggle';

        const driveBtn = this._buildModeButton('🚗 Fahrt');
        const flightBtn = this._buildModeButton('✈️ Flug');

        const applyActiveState = (mode) => {
            driveBtn.classList.toggle('active', mode === 'drive');
            flightBtn.classList.toggle('active', mode === 'flight');
        };
        applyActiveState(segment.mode);

        const handleSetMode = async (mode) => {
            driveBtn.disabled = true;
            flightBtn.disabled = true;
            try {
                await setRouteMode(segment.start_filename, segment.end_filename, mode);
                segment.mode = mode;
                applyActiveState(mode);
            } catch (err) {
                alert(err.message);
            } finally {
                driveBtn.disabled = false;
                flightBtn.disabled = false;
            }
        };

        driveBtn.addEventListener('click', () => handleSetMode('drive'));
        flightBtn.addEventListener('click', () => handleSetMode('flight'));

        modeToggle.append(driveBtn, flightBtn);

        row.append(startImg, endImg, info, modeToggle);
        li.appendChild(row);
        return li;
    }
}

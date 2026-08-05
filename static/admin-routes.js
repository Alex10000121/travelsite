// Routen-Verwaltung der /admin-Seite: zeigt automatisch erkannte Fahrt-/Flugstrecken
// zwischen aufeinanderfolgenden Fotos und erlaubt eine manuelle Korrektur des Modus,
// falls die automatische Erkennung (Distanz-Heuristik / OSRM-Ergebnis) danebenlag.
//
// Serverseitig paginiert (siehe api.js), analog zu admin-manage.js.

import { fetchAdminRoutes, setRouteMode } from './api.js';
import { buildThumbUrl } from './filename-utils.js';
import { tryOrAlert, updateLoadMoreVisibility, renderInto, createButton, createSpan, createLazyImage } from './dom-utils.js';

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
        await tryOrAlert(async () => {
            const page = await fetchAdminRoutes({ offset: reset ? 0 : this._offset });

            this._offset = page.offset + page.segments.length;
            this._total = page.total;

            this._render(page.segments, { append: !reset });
            updateLoadMoreVisibility(this._dom.loadMoreBtn, this._offset, this._total);
        });
    }

    _render(segments, opts) {
        renderInto(this._dom.list, segments, (segment) => this._buildItem(segment), opts);
    }

    _buildItem(segment) {
        const li = document.createElement('li');
        li.className = 'admin-route-item';

        const row = document.createElement('div');
        row.className = 'admin-route-row';
        row.append(
            createLazyImage(buildThumbUrl(segment.start_filename, { size: 'blur' })),
            createLazyImage(buildThumbUrl(segment.end_filename, { size: 'blur' })),
            this._buildInfo(segment),
            this._buildModeToggle(segment),
        );

        li.appendChild(row);
        return li;
    }

    _buildInfo(segment) {
        const info = document.createElement('div');
        info.className = 'admin-route-info';
        info.append(
            createSpan('admin-route-label', `${segment.start_location || 'Unbekannt'} → ${segment.end_location || 'Unbekannt'}`),
            createSpan('admin-route-distance', `${segment.distance_km} km`),
        );
        return info;
    }

    _buildModeToggle(segment) {
        const modeToggle = document.createElement('div');
        modeToggle.className = 'admin-mode-toggle';

        const driveBtn = createButton('admin-mode-btn', '🚗 Fahrt');
        const flightBtn = createButton('admin-mode-btn', '✈️ Flug');

        const applyActiveState = (mode) => {
            driveBtn.classList.toggle('active', mode === 'drive');
            flightBtn.classList.toggle('active', mode === 'flight');
        };
        applyActiveState(segment.mode);

        const handleSetMode = async (mode) => {
            driveBtn.disabled = true;
            flightBtn.disabled = true;
            await tryOrAlert(async () => {
                await setRouteMode(segment.start_filename, segment.end_filename, mode);
                segment.mode = mode;
                applyActiveState(mode);
            });
            driveBtn.disabled = false;
            flightBtn.disabled = false;
        };

        driveBtn.addEventListener('click', () => handleSetMode('drive'));
        flightBtn.addEventListener('click', () => handleSetMode('flight'));

        modeToggle.append(driveBtn, flightBtn);
        return modeToggle;
    }
}

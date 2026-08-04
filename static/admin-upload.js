// Upload-Feature der /admin-Seite: Dateiauswahl, EXIF-GPS-Lesen,
// Mini-Karte als Fallback-Picker, Fortschrittsanzeige.

import { uploadPhoto } from './api.js';

async function readExifFromFile(file) {
    try {
        if (typeof exifr === 'undefined') return null;
        const gps = await exifr.gps(file);
        if (gps && isFinite(gps.latitude) && isFinite(gps.longitude)) {
            return { lat: gps.latitude, lon: gps.longitude };
        }
    } catch (e) {
        console.warn('exifr GPS read failed:', e);
    }
    return null;
}

export class AdminUploadCard {

    /**
     * @param {object} dom
     * @param {HTMLInputElement} dom.fileInput
     * @param {HTMLElement}      dom.chooseBtn
     * @param {HTMLElement}      dom.gpsPicker
     * @param {HTMLElement}      dom.gpsConfirmBtn
     * @param {HTMLElement}      dom.progressWrap
     * @param {HTMLElement}      dom.progressFill
     * @param {HTMLElement}      dom.progressText
     * @param {HTMLElement}      dom.log
     *
     * @param {import('./map.js').MapController} map - Mini-Karte für den GPS-Fallback-Picker
     */
    constructor(dom, map) {
        this._dom = dom;
        this._map = map;
        this._locationPickResolve = null;

        this._map.onMapClick = (lat, lon) => {
            if (this._locationPickResolve) this._map.setFixMarker(lat, lon);
        };

        dom.chooseBtn?.addEventListener('click', () => dom.fileInput?.click());
        dom.fileInput?.addEventListener('change', () => this._runUpload());
        dom.gpsConfirmBtn?.addEventListener('click', () => this._confirmGpsPick());
    }

    _pickLocation() {
        return new Promise((resolve) => {
            this._locationPickResolve = resolve;
            if (this._dom.gpsPicker) this._dom.gpsPicker.style.display = 'block';
            const center = this._map.getCenter();
            this._map.setFixMarker(center.lat, center.lon);
        });
    }

    _confirmGpsPick() {
        if (!this._map.hasFixMarker()) {
            alert('Bitte Karte verschieben, um eine Position zu setzen.');
            return;
        }
        const pos = this._map.getFixMarkerLatLng();
        const resolve = this._locationPickResolve;
        this._locationPickResolve = null;

        this._map.removeFixMarker();
        if (this._dom.gpsPicker) this._dom.gpsPicker.style.display = 'none';

        resolve?.(pos);
    }

    _logEntry(text, ok) {
        const { log } = this._dom;
        if (!log) return;
        const li = document.createElement('li');
        li.className = ok ? 'admin-log-ok' : 'admin-log-error';
        li.textContent = text;
        log.prepend(li);
    }

    async _runUpload() {
        const { fileInput, progressWrap, progressFill, progressText } = this._dom;
        const files = fileInput.files;
        if (files.length === 0) return;

        if (progressWrap) progressWrap.style.display = 'block';
        if (progressFill) progressFill.style.width = '0%';

        const totalFiles = files.length;

        for (let i = 0; i < totalFiles; i++) {
            if (progressText) progressText.innerText = `Lade Bild ${i + 1} von ${totalFiles} hoch...`;

            const file = files[i];

            let lat = null, lon = null;
            const gpsFromExif = await readExifFromFile(file);
            if (gpsFromExif) {
                lat = gpsFromExif.lat;
                lon = gpsFromExif.lon;
            } else {
                const picked = await this._pickLocation();
                lat = picked.lat;
                lon = picked.lon;
            }

            const formData = new FormData();
            formData.append('photo', file);
            formData.append('lat', lat);
            formData.append('lon', lon);

            try {
                const json = await uploadPhoto(formData);
                this._logEntry(`✔ ${file.name} → ${json.location || ''}`, true);
            } catch (err) {
                if (err.status === 403) {
                    alert('Sitzung abgelaufen. Bitte erneut anmelden.');
                    window.location.reload();
                    return;
                }
                this._logEntry(`✘ ${file.name}: ${err.message}`, false);
            }

            if (progressFill) progressFill.style.width = `${Math.round(((i + 1) / totalFiles) * 100)}%`;
        }

        fileInput.value = '';
        if (progressWrap) progressWrap.style.display = 'none';
    }
}

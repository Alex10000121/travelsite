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
            this._map.resize();
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

            const sessionExpired = await this._uploadFile(files[i]);
            if (sessionExpired) return;

            if (progressFill) progressFill.style.width = `${Math.round(((i + 1) / totalFiles) * 100)}%`;
        }

        fileInput.value = '';
        if (progressWrap) progressWrap.style.display = 'none';
    }

    async _resolveLocation(file) {
        const gpsFromExif = await readExifFromFile(file);
        return gpsFromExif ?? this._pickLocation();
    }

    /** @returns {Promise<boolean>} true, wenn die Session abgelaufen ist und der Upload-Vorgang abgebrochen wurde. */
    async _uploadFile(file) {
        const { lat, lon } = await this._resolveLocation(file);

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
                return true;
            }
            this._logEntry(`✘ ${file.name}: ${err.message}`, false);
        }
        return false;
    }
}

// Admin-Logik: Login, Upload, GPS-Fix-Assistent, Datenbereinigung.
// Keine Abhängigkeit zu gallery.js — Kommunikation nur über Callbacks.

import { checkLogin, uploadPhoto, updateLocation } from './api.js';

// ---------------------------------------------------------------------------
// Hilfsfunktion: countryCode aus Location-String ableiten
// (wird nur für das Zusammenstellen des Foto-Objekts nach Upload benötigt)
// ---------------------------------------------------------------------------
function extractCountryCode(locationString) {
    if (!locationString) return 'UNK';
    const parts = locationString.split(',');
    return parts.length > 1 ? parts[parts.length - 1].trim() : 'UNK';
}

// ---------------------------------------------------------------------------
// Hilfsfunktion: GPS aus EXIF lesen (benötigt globale `exifr`-Library)
// ---------------------------------------------------------------------------
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

export class AdminController {

    /**
     * @param {object} dom
     * @param {HTMLElement}       dom.btnStats        - Statistik-Button (Doppelklick → Upload)
     * @param {HTMLElement}       dom.statsModal      - Statistik-Modal
     * @param {HTMLElement}       dom.loginModal      - Login-Modal
     * @param {HTMLFormElement}   dom.loginForm       - Login-Formular
     * @param {HTMLInputElement}  dom.passwordInput   - Passwort-Eingabefeld
     * @param {HTMLInputElement}  dom.fileInput       - Verstecktes File-Input
     * @param {HTMLElement}       dom.progressModal   - Fortschritts-Overlay
     * @param {HTMLElement}       dom.progressBar     - Fortschrittsbalken (fill)
     * @param {HTMLElement}       dom.progressText    - Fortschritts-Text
     * @param {HTMLElement}       dom.infoStandard    - Standard-Info-Panel
     * @param {HTMLElement}       dom.fixInterface    - GPS-Fix-Interface-Panel
     * @param {HTMLElement}       dom.fixSaveBtn      - "Ort speichern"-Button
     * @param {HTMLImageElement}  dom.currentPhoto    - Haupt-Foto (für Pre-Upload-Vorschau)
     * @param {HTMLImageElement}  dom.bgPhoto         - Hintergrund-Foto (für Vorschau)
     * @param {HTMLElement}       dom.txtLocation     - Ort-Textfeld (für Vorschau-Label)
     * @param {HTMLElement}       dom.txtDate         - Datum-Textfeld (für Vorschau-Label)
     *
     * @param {import('./map.js').MapController} map  - MapController-Instanz
     */
    constructor(dom, map) {
        this._dom = dom;
        this._map = map;

        // Passwort wird nur für die Dauer einer Aktion im RAM gehalten
        this._tempPassword = null;

        this._loginAction = 'upload';

        // Doppelklick-Timer für den Stats-Button
        this._clickTimer = null;

        // Fotos ohne GPS, die nach dem Upload noch gefixed werden müssen
        // (Post-Upload-Modus, veraltet — heute wird GPS vor dem Upload abgefragt)
        this._missingGpsQueue = [];

        // Promise-Resolve für den Pre-Upload Ort-Picker
        this._locationPickResolve = null;

        /** @type {function(photos: Array): void}  Aufgerufen nach erfolgreichem Upload */
        this._onUploadComplete = null;

        /** @type {function(active: boolean): void}  Aufgerufen wenn Fix-Modus an/aus geht */
        this._onFixingModeChange = null;

        this._bindStatsButton();
        this._bindLoginForm();
        this._bindFileInput();
        this._bindFixSaveButton();
    }

    // -------------------------------------------------------------------------
    // Callbacks
    // -------------------------------------------------------------------------

    /** @param {function(uploadedPhotos: Array): void} fn */
    set onUploadComplete(fn) { this._onUploadComplete = fn; }

    /** @param {function(active: boolean): void} fn */
    set onFixingModeChange(fn) { this._onFixingModeChange = fn; }

    // -------------------------------------------------------------------------
    // Öffentliche Methoden
    // -------------------------------------------------------------------------

    // -------------------------------------------------------------------------
    // Login-Modal
    // -------------------------------------------------------------------------

    _openLoginModal() {
        const { loginModal, passwordInput } = this._dom;
        if (loginModal) {
            loginModal.classList.add('show');
            setTimeout(() => passwordInput?.focus(), 100);
        } else {
            // Fallback wenn kein Login-Modal im DOM vorhanden
            const pw = prompt('Admin Passwort:');
            if (pw) this._handleLoginSuccess(pw);
        }
    }

    _closeLoginModal() {
        this._dom.loginModal?.classList.remove('show');
    }

    _bindLoginForm() {
        const { loginForm, passwordInput } = this._dom;
        if (!loginForm) return;

        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const pw  = passwordInput.value;
            const btn = loginForm.querySelector('button');
            if (!pw) return;

            const originalText   = btn.innerText;
            btn.innerText        = 'Prüfe...';
            btn.disabled         = true;
            btn.style.opacity    = '0.7';

            try {
                await checkLogin(pw);         // wirft bei falschem Passwort
                this._handleLoginSuccess(pw);
                passwordInput.value = '';
            } catch (err) {
                alert(`⛔️ ${err.message}`);
                passwordInput.value = '';
                passwordInput.focus();
            } finally {
                btn.innerText     = originalText;
                btn.disabled      = false;
                btn.style.opacity = '1';
            }
        });
    }

    _handleLoginSuccess(password) {
        this._tempPassword = password;   // nur im RAM, kein sessionStorage!
        this._closeLoginModal();

        if (this._loginAction === 'upload') {
            this._dom.fileInput?.click();
        }
    }

    // -------------------------------------------------------------------------
    // Stats-Button: Einfachklick → Statistik, Doppelklick → Upload-Login
    // -------------------------------------------------------------------------

    _bindStatsButton() {
        const { btnStats, statsModal } = this._dom;
        if (!btnStats) return;

        btnStats.addEventListener('click', (e) => {
            e.preventDefault();

            if (this._clickTimer) {
                clearTimeout(this._clickTimer);
                this._clickTimer    = null;
                this._loginAction   = 'upload';
                this._openLoginModal();
            } else {
                this._clickTimer = setTimeout(() => {
                    statsModal?.classList.add('show');
                    this._clickTimer = null;
                }, 300);
            }
        });
    }

    // -------------------------------------------------------------------------
    // Pre-Upload Ort-Picker (Karte zeigen, Marker platzieren, Promise resolven)
    // -------------------------------------------------------------------------

    /**
     * Zeigt das Fix-Interface und wartet, bis der Nutzer einen Ort bestätigt.
     * Gibt { lat, lon } zurück.
     * @returns {Promise<{lat: number, lon: number}>}
     */
    _pickLocation() {
        return new Promise((resolve) => {
            this._locationPickResolve = resolve;
            const { infoStandard, fixInterface } = this._dom;
            if (infoStandard) infoStandard.style.display = 'none';
            if (fixInterface)  fixInterface.style.display = 'block';

            const center = this._map.getCenter();
            this._map.setFixMarker(center.lat, center.lon);
        });
    }

    // -------------------------------------------------------------------------
    // Upload-Prozess
    // -------------------------------------------------------------------------

    _bindFileInput() {
        const { fileInput } = this._dom;
        if (!fileInput) return;

        fileInput.addEventListener('change', () => this._runUpload());
    }

    async _runUpload() {
        const { fileInput, progressModal, progressBar, progressText,
                currentPhoto, bgPhoto, txtLocation, txtDate } = this._dom;

        const files = fileInput.files;

        if (files.length === 0 || !this._tempPassword) {
            this._tempPassword  = null;
            fileInput.value     = '';
            return;
        }

        if (progressModal) progressModal.classList.add('show');
        if (progressBar)   progressBar.style.width = '0%';

        this._missingGpsQueue = [];
        const uploadedPhotos  = [];
        let successCount = 0;
        let errorCount   = 0;
        const totalFiles = files.length;
        const password   = this._tempPassword;

        for (let i = 0; i < totalFiles; i++) {
            if (progressText) {
                progressText.innerText = `Lade Bild ${i + 1} von ${totalFiles} hoch...`;
            }

            const file = files[i];

            // --- GPS aus EXIF lesen oder Nutzer fragen ---
            let formLat = null, formLon = null;
            const gpsFromExif = await readExifFromFile(file);

            if (gpsFromExif) {
                formLat = gpsFromExif.lat;
                formLon = gpsFromExif.lon;
            } else {
                // Fortschritts-Modal kurz ausblenden, Vorschau anzeigen
                progressModal?.classList.remove('show');

                const previewUrl = URL.createObjectURL(file);
                if (currentPhoto) { currentPhoto.src = previewUrl; currentPhoto.style.opacity = '1'; }
                if (bgPhoto)      { bgPhoto.src = previewUrl;      bgPhoto.style.opacity = '1'; }
                if (txtLocation)    txtLocation.innerText = file.name;
                if (txtDate)        txtDate.innerText = `Bild ${i + 1} von ${totalFiles} – Ort wählen`;

                const picked = await this._pickLocation();
                URL.revokeObjectURL(previewUrl);
                formLat = picked.lat;
                formLon = picked.lon;

                progressModal?.classList.add('show');
                if (progressText) progressText.innerText = `Lade Bild ${i + 1} von ${totalFiles} hoch...`;
            }

            // --- FormData zusammenstellen und hochladen ---
            const formData = new FormData();
            formData.append('photo', file);
            formData.append('admin_token', password);
            if (formLat !== null && formLon !== null) {
                formData.append('lat', formLat);
                formData.append('lon', formLon);
            }

            try {
                const json = await uploadPhoto(formData);

                successCount++;
                const ts = json.timestamp ?? null;
                const d  = ts ? new Date(ts * 1000) : null;
                uploadedPhotos.push({
                    filename:    json.file,
                    lat:         json.lat    ?? null,
                    lon:         json.lon    ?? null,
                    location:    json.location || '',
                    timestamp:   ts,
                    date_str:    d
                        ? `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`
                        : '',
                    countryCode: extractCountryCode(json.location || '')
                });

            } catch (err) {
                errorCount++;

                if (err.status === 403) {
                    alert('Falsches Passwort.');
                    this._tempPassword = null;
                    break;
                }

                if (err.missing_gps) {
                    alert(`⚠️ ${file.name}\nKeine GPS-Daten gefunden. Bitte GPS in der Kamera aktivieren.`);
                } else {
                    alert(err.message);
                }
            }

            if (progressBar) {
                progressBar.style.width = `${Math.round(((i + 1) / totalFiles) * 100)}%`;
            }
        }

        fileInput.value = '';
        progressModal?.classList.remove('show');

        // --- Nach dem Upload: ggf. Fix-Prozess starten, sonst fertig ---
        if (this._missingGpsQueue.length > 0) {
            this._startFixingProcess(password);
        } else {
            this._tempPassword = null;

            if (successCount > 0) {
                this._onUploadComplete?.(uploadedPhotos);
                setTimeout(() => location.reload(), 1500);
            } else if (errorCount > 0) {
                alert('Es traten Fehler auf (siehe Konsole).');
            }
        }
    }

    // -------------------------------------------------------------------------
    // Post-Upload GPS-Fix-Assistent
    // (für den Fall, dass der Server selbst fehlende GPS meldet —
    //  heute wird GPS bereits vor dem Upload abgefragt, aber der Pfad bleibt erhalten)
    // -------------------------------------------------------------------------

    _startFixingProcess(password) {
        this._tempPassword = password;
        this._onFixingModeChange?.(true);

        const { statsModal, infoStandard, fixInterface } = this._dom;
        statsModal?.classList.remove('show');
        if (infoStandard) infoStandard.style.display = 'none';
        if (fixInterface)  fixInterface.style.display  = 'block';

        this._processNextFix();
    }

    _processNextFix() {
        if (this._missingGpsQueue.length === 0) {
            this._tempPassword = null;
            this._onFixingModeChange?.(false);
            alert('Großartig! Alle Orte gespeichert.');
            location.reload();
            return;
        }

        const filename = this._missingGpsQueue[0];

        // Bild im Galerie-Panel anzeigen — via Callback, da admin.js kein gallery kennt
        this._onShowFilename?.(filename);

        this._map.removeFixMarker();
        const center = this._map.getCenter();
        this._map.setFixMarker(center.lat, center.lon);
    }

    /**
     * Optionaler Callback: wird aufgerufen, wenn der Fix-Assistent ein bestimmtes
     * Bild (Dateiname) anzeigen möchte. Verbindet admin.js mit gallery.js ohne
     * direkte Abhängigkeit.
     * @param {function(filename: string): void} fn
     */
    set onShowFilename(fn) { this._onShowFilename = fn; }

    /**
     * Wird von main.js aufgerufen, wenn der Nutzer auf die Karte klickt.
     * Setzt den Fix-Marker nur, wenn gerade ein Picker aktiv ist.
     * @param {number} lat
     * @param {number} lon
     */
    handleMapClick(lat, lon) {
        const inPickerMode = this._locationPickResolve !== null
                          || this._missingGpsQueue.length > 0;
        if (inPickerMode) {
            this._map.setFixMarker(lat, lon);
        }
    }

    // -------------------------------------------------------------------------
    // Fix-Save-Button (Ort bestätigen)
    // -------------------------------------------------------------------------

    _bindFixSaveButton() {
        const { fixSaveBtn } = this._dom;
        if (!fixSaveBtn) return;

        fixSaveBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            e.preventDefault();

            if (!this._map.hasFixMarker()) {
                alert('Bitte Karte verschieben um Marker zu setzen.');
                return;
            }

            const pos = this._map.getFixMarkerLatLng();

            // --- Modus A: Pre-Upload-Picker (pickLocation()-Promise resolven) ---
            if (this._locationPickResolve) {
                const resolve           = this._locationPickResolve;
                this._locationPickResolve = null;

                this._map.removeFixMarker();
                const { fixInterface, infoStandard } = this._dom;
                if (fixInterface)  fixInterface.style.display  = 'none';
                if (infoStandard) infoStandard.style.display = 'block';

                resolve({ lat: pos.lat, lon: pos.lon });
                return;
            }

            // --- Modus B: Post-Upload-Fix (Koordinaten via API speichern) ---
            const filename = this._missingGpsQueue[0];
            const password = this._tempPassword;

            try {
                await updateLocation(password, filename, pos.lat, pos.lon);
                this._missingGpsQueue.shift();
                this._processNextFix();
            } catch (err) {
                alert(err.message);
            }
        });
    }
}

// Foto-Anzeige, Navigation, Swipe-Gesten und Tastatur-Events.
// Keine Abhängigkeit zu Leaflet oder API.

export class GalleryController {

    /**
     * @param {object} dom
     * @param {HTMLImageElement}  dom.currentPhoto  - Haupt-Foto-Element
     * @param {HTMLImageElement}  dom.bgPhoto       - Hintergrund-Blur-Element
     * @param {HTMLElement}       dom.txtLocation   - Ort-Textfeld
     * @param {HTMLElement}       dom.txtDate       - Datum-Textfeld
     * @param {HTMLElement|null}  dom.galleryPanel  - Touch-Ziel für Swipe-Gesten
     * @param {string} token - Öffentlicher Lese-Token für Thumb-URLs
     */
    constructor(dom, token) {
        this._dom   = dom;
        this._token = token;

        this._photos       = [];
        this._currentIndex = 0;
        this._isFixingMode = false;
        this._displayTimer = null;

        /** @type {function(index: number, photo: object): void} */
        this._onPhotoChange = null;

        this._bindKeyboard();
        this._bindTouch();
        this._bindFullscreen();
    }

    // -------------------------------------------------------------------------
    // Callback
    // -------------------------------------------------------------------------

    /**
     * Wird nach jeder Navigationsaktion aufgerufen.
     * Erlaubt dem Aufrufer (main.js), die Karte zu synchronisieren.
     * @param {function(index: number, photo: object): void} fn
     */
    set onPhotoChange(fn) { this._onPhotoChange = fn; }

    // -------------------------------------------------------------------------
    // Daten laden
    // -------------------------------------------------------------------------

    /**
     * Übergibt die Foto-Liste an die Galerie und zeigt das erste Bild.
     * Jedes Foto-Objekt muss mindestens { filename, location, date_str, countryCode } haben.
     * @param {Array<object>} photos
     * @param {number} [startIndex=0]
     */
    loadPhotos(photos, startIndex = 0) {
        this._photos       = photos;
        this._currentIndex = startIndex;
        if (photos.length > 0) this._update();
    }

    /**
     * Setzt den aktuellen Index von außen (z.B. bei Klick auf Karten-Marker).
     * @param {number} index
     */
    setIndex(index) {
        if (!this._photos.length || this._isFixingMode) return;
        this._currentIndex = index;
        this._update();
    }

    /** Gibt den aktuellen Index zurück. */
    get currentIndex() { return this._currentIndex; }

    /** Gibt das aktuell angezeigte Foto-Objekt zurück. */
    get currentPhoto() { return this._photos[this._currentIndex] ?? null; }

    // -------------------------------------------------------------------------
    // Fix-Modus (GPS-Assistent blockiert Navigation)
    // -------------------------------------------------------------------------

    /**
     * @param {boolean} active
     */
    setFixingMode(active) {
        this._isFixingMode = active;
    }

    // -------------------------------------------------------------------------
    // Navigation
    // -------------------------------------------------------------------------

    /**
     * Wechselt zum nächsten (+1) oder vorherigen (-1) Foto.
     * @param {number} direction  +1 oder -1
     */
    changePhoto(direction) {
        if (!this._photos.length || this._isFixingMode) return;
        const total = this._photos.length;
        this._currentIndex = (this._currentIndex + direction + total) % total;
        this._update();
    }

    /**
     * Springt zum ersten Foto des nächsten (+1) oder vorherigen (-1) Landes.
     * @param {number} direction  +1 oder -1
     */
    changeLocation(direction) {
        if (!this._photos.length || this._isFixingMode) return;

        const photos = this._photos;
        const total  = photos.length;
        const currentCountry = photos[this._currentIndex].countryCode;
        let index = this._currentIndex;
        let steps = 0;

        if (direction === 1) {
            // Vorwärts: erstes Foto suchen, das einem anderen Land gehört
            while (steps < total) {
                index = (index + 1) % total;
                if (photos[index].countryCode !== currentCountry) {
                    this._currentIndex = index;
                    this._update();
                    return;
                }
                steps++;
            }
        } else {
            // Rückwärts: zum Anfang des vorherigen Landes springen

            // Schritt 1: Anfang des aktuellen Landes finden
            while (steps < total) {
                const prev = (index - 1 + total) % total;
                if (photos[prev].countryCode !== currentCountry) break;
                index = prev;
                steps++;
            }

            // Schritt 2: ein weiteres Foto zurück = letztes Foto des Ziel-Landes
            index = (index - 1 + total) % total;
            const targetCountry = photos[index].countryCode;

            // Schritt 3: Anfang des Ziel-Landes suchen
            steps = 0;
            while (steps < total) {
                const prev = (index - 1 + total) % total;
                if (photos[prev].countryCode !== targetCountry) break;
                index = prev;
                steps++;
            }

            this._currentIndex = index;
            this._update();
        }
    }

    // -------------------------------------------------------------------------
    // UI-Update
    // -------------------------------------------------------------------------

    /**
     * Aktualisiert Bild, Ort und Datum für den aktuellen Index
     * und feuert den onPhotoChange-Callback.
     */
    _update() {
        const photo = this._photos[this._currentIndex];
        if (!photo) return;

        this._displayImage(photo.filename);

        if (!this._isFixingMode) {
            this._setText(this._dom.txtLocation, photo.location || 'Unbekannt');
            this._setText(this._dom.txtDate, photo.date_str || 'Datum unbekannt');
        }

        this._onPhotoChange?.(this._currentIndex, photo);
    }

    /**
     * Tauscht das angezeigte Bild mit einer kurzen Fade-Transition aus.
     * @param {string} filename
     */
    _displayImage(filename) {
        const { currentPhoto: imgEl, bgPhoto: bgEl } = this._dom;
        const url     = `/api/thumb/${filename}?token=${this._token}`;
        const blurUrl = `${url}&size=blur`;

        if (imgEl) {
            imgEl.classList.remove('is-fullscreen');
            imgEl.style.opacity = 0;
        }
        if (bgEl) bgEl.style.opacity = 0;

        // Download läuft schon während des Fade-Outs statt erst danach zu starten,
        // damit der spätere src-Swap aus dem Browser-Cache kommt statt neu zu laden.
        new Image().src = url;
        new Image().src = blurUrl;

        clearTimeout(this._displayTimer);
        this._displayTimer = setTimeout(() => {
            if (imgEl) {
                imgEl.src          = url;
                imgEl.style.display = 'block';
                imgEl.onload       = () => { imgEl.style.opacity = 1; };
            }
            if (bgEl) {
                bgEl.src          = blurUrl;
                bgEl.style.display = 'block';
                bgEl.onload       = () => { bgEl.style.opacity = 1; };
            }
        }, 150);
    }

    _setText(el, text) {
        if (el) el.innerText = text;
    }

    // -------------------------------------------------------------------------
    // Interne Event-Bindungen (einmalig im Konstruktor)
    // -------------------------------------------------------------------------

    _bindKeyboard() {
        document.addEventListener('keydown', (e) => {
            if (this._isFixingMode) return;
            if (e.key === 'ArrowLeft')  this.changePhoto(-1);
            if (e.key === 'ArrowRight') this.changePhoto(1);
            if (e.key === 'ArrowUp')   { e.preventDefault(); this.changeLocation(-1); }
            if (e.key === 'ArrowDown') { e.preventDefault(); this.changeLocation(1); }
        });
    }

    _bindTouch() {
        const zone = this._dom.galleryPanel;
        if (!zone) return;

        let tX = 0, tY = 0;

        zone.addEventListener('touchstart', (e) => {
            tX = e.changedTouches[0].screenX;
            tY = e.changedTouches[0].screenY;
        }, { passive: false });

        zone.addEventListener('touchend', (e) => {
            if (this._isFixingMode) return;
            const xDiff = e.changedTouches[0].screenX - tX;
            const yDiff = e.changedTouches[0].screenY - tY;

            if (Math.abs(xDiff) > Math.abs(yDiff)) {
                if (Math.abs(xDiff) > 50) this.changePhoto(xDiff < 0 ? 1 : -1);
            } else {
                if (Math.abs(yDiff) > 50) this.changeLocation(yDiff < 0 ? 1 : -1);
            }
        }, { passive: false });
    }

    _bindFullscreen() {
        const imgEl = this._dom.currentPhoto;
        if (!imgEl) return;

        imgEl.addEventListener('click', () => {
            if (this._isFixingMode) return;

            if (imgEl.classList.contains('is-fullscreen')) {
                imgEl.classList.remove('is-fullscreen');
            } else {
                const photo = this.currentPhoto;
                if (photo) {
                    imgEl.src = `/api/thumb/${photo.filename}?token=${this._token}&size=large`;
                }
                imgEl.classList.add('is-fullscreen');
            }
        });
    }
}

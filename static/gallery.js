// Foto-Anzeige, Navigation, Swipe-Gesten und Tastatur-Events.
// Keine Abhängigkeit zu Leaflet oder API.

import { encodeFilenamePath } from './filename-utils.js';

// WMO-Wettercode -> Emoji (Open-Meteo liefert den Rohcode, siehe fetch_weather in app.py).
// Nur grobe Kategorien, kein Anspruch auf Vollstaendigkeit aller ~30 WMO-Codes.
const WEATHER_ICON_GROUPS = [
    { codes: [0], icon: '☀️' },
    { codes: [1, 2], icon: '🌤️' },
    { codes: [3], icon: '☁️' },
    { codes: [45, 48], icon: '🌫️' },
    { codes: [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82], icon: '🌧️' },
    { codes: [71, 73, 75, 77, 85, 86], icon: '❄️' },
    { codes: [95, 96, 99], icon: '⛈️' },
];

function weatherEmoji(code) {
    return WEATHER_ICON_GROUPS.find(g => g.codes.includes(code))?.icon ?? '🌡️';
}

export class GalleryController {

    /**
     * @param {object} dom
     * @param {HTMLImageElement}  dom.currentPhoto   - Haupt-Foto-Element
     * @param {HTMLImageElement}  dom.bgPhoto        - Hintergrund-Blur-Element
     * @param {HTMLElement}       dom.txtLocation    - Ort-Textfeld
     * @param {HTMLElement}       dom.txtDate        - Datum-Textfeld
     * @param {HTMLElement}       [dom.txtWeather]   - Wetter-Badge (optional, nur wenn Daten vorhanden)
     * @param {HTMLElement}       [dom.txtNote]      - Notiz-Text (optional, nur wenn gesetzt)
     * @param {HTMLElement}       [dom.favoriteBadge] - Favoriten-Stern (optional)
     * @param {HTMLElement|null}  dom.galleryPanel   - Touch-Ziel für Swipe-Gesten
     * @param {string} token - Öffentlicher Lese-Token für Thumb-URLs
     */
    constructor(dom, token) {
        this._dom   = dom;
        this._token = token;

        this._photos       = [];
        this._currentIndex = 0;
        this._displayTimer = null;

        /** @type {function(index: number, photo: object): void} */
        this._onPhotoChange = null;

        this._bindKeyboard();
        this._bindTouch();
        this._bindFullscreen();
        this._bindFilmstrip();
    }

    /**
     * Wird nach jeder Navigationsaktion aufgerufen.
     * Erlaubt dem Aufrufer (main.js), die Karte zu synchronisieren.
     * @param {function(index: number, photo: object): void} fn
     */
    set onPhotoChange(fn) { this._onPhotoChange = fn; }

    /**
     * Übergibt die Foto-Liste an die Galerie und zeigt das erste Bild.
     * Jedes Foto-Objekt muss mindestens { filename, location, date_str, countryCode } haben.
     * @param {Array<object>} photos
     * @param {number} [startIndex=0]
     */
    loadPhotos(photos, startIndex = 0) {
        this._photos       = photos;
        this._currentIndex = startIndex;
        this._renderFilmstrip();
        if (photos.length > 0) this._update();
    }

    /**
     * Setzt den aktuellen Index von außen (z.B. bei Klick auf Karten-Marker).
     * @param {number} index
     */
    setIndex(index) {
        if (!this._photos.length) return;
        this._currentIndex = index;
        this._update();
    }

    /** Gibt den aktuellen Index zurück. */
    get currentIndex() { return this._currentIndex; }

    /** Gibt das aktuell angezeigte Foto-Objekt zurück. */
    get currentPhoto() { return this._photos[this._currentIndex] ?? null; }

    /**
     * Wechselt zum nächsten (+1) oder vorherigen (-1) Foto.
     * @param {number} direction  +1 oder -1
     */
    changePhoto(direction) {
        if (!this._photos.length) return;
        const total = this._photos.length;
        this._currentIndex = (this._currentIndex + direction + total) % total;
        this._update();
    }

    /**
     * Springt zum ersten Foto des nächsten (+1) oder vorherigen (-1) Landes.
     * @param {number} direction  +1 oder -1
     */
    changeLocation(direction) {
        if (!this._photos.length) return;

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

    /**
     * Aktualisiert Bild, Ort und Datum für den aktuellen Index
     * und feuert den onPhotoChange-Callback.
     */
    _update() {
        const photo = this._photos[this._currentIndex];
        if (!photo) return;

        this._displayImage(photo.filename);
        this._syncFilmstripActive();

        this._setText(this._dom.txtLocation, photo.location || 'Unbekannt');
        this._setText(this._dom.txtDate, photo.date_str || 'Datum unbekannt');
        this._updateFavoriteBadge(photo);
        this._updateOptionalText(this._dom.txtWeather, this._weatherText(photo));
        this._updateOptionalText(this._dom.txtNote, photo.note);

        this._onPhotoChange?.(this._currentIndex, photo);
    }

    /**
     * Tauscht das angezeigte Bild mit einer kurzen Fade-Transition aus.
     * @param {string} filename
     */
    _displayImage(filename) {
        const { currentPhoto: imgEl, bgPhoto: bgEl } = this._dom;
        const url     = `/api/thumb/${encodeFilenamePath(filename)}?token=${this._token}`;
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

                // Ken-Burns-Animation pro Foto neu starten (sonst läuft sie einfach weiter/bleibt stehen)
                imgEl.style.animation = 'none';
                void imgEl.offsetWidth;
                imgEl.style.animation = '';
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

    /**
     * Blendet ein optionales Textfeld (Wetter/Notiz) nur ein, wenn Inhalt vorhanden ist.
     * Immer ein expliziter display-Wert statt '' - sonst faellt die Anzeige auf ein
     * CSS-Standard-display:none zurueck (Ausgangszustand vor dem ersten _update()).
     */
    _updateOptionalText(el, text) {
        if (!el) return;
        if (text) {
            el.innerText = text;
            el.style.display = 'block';
        } else {
            el.innerText = '';
            el.style.display = 'none';
        }
    }

    _updateFavoriteBadge(photo) {
        const el = this._dom.favoriteBadge;
        if (el) el.style.display = photo.is_favorite ? 'block' : 'none';
    }

    /** @returns {string|null} z.B. "☀️ 24°C", oder null falls keine Wetterdaten vorhanden. */
    _weatherText(photo) {
        if (photo.weather_temp == null || photo.weather_code == null) return null;
        return `${weatherEmoji(photo.weather_code)} ${Math.round(photo.weather_temp)}°C`;
    }

    _bindKeyboard() {
        document.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowLeft')  this.changePhoto(-1);
            if (e.key === 'ArrowRight') this.changePhoto(1);
            if (e.key === 'ArrowUp')   { e.preventDefault(); this.changeLocation(-1); }
            if (e.key === 'ArrowDown') { e.preventDefault(); this.changeLocation(1); }
        });
    }

    _bindTouch() {
        const zone = this._dom.galleryPanel;
        if (!zone) return;

        let tX = 0, tY = 0, startedInFilmstrip = false;

        zone.addEventListener('touchstart', (e) => {
            tX = e.changedTouches[0].screenX;
            tY = e.changedTouches[0].screenY;
            // Swipes, die im Filmstrip beginnen, sollen nur dessen natives
            // Scrollen ausloesen, nicht das Foto wechseln.
            startedInFilmstrip = !!e.target.closest?.('.filmstrip');
        }, { passive: false });

        zone.addEventListener('touchend', (e) => {
            if (startedInFilmstrip) return;
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
            if (imgEl.classList.contains('is-fullscreen')) {
                imgEl.classList.remove('is-fullscreen');
            } else {
                const photo = this.currentPhoto;
                if (photo) {
                    imgEl.src = `/api/thumb/${encodeFilenamePath(photo.filename)}?token=${this._token}&size=large`;
                }
                imgEl.classList.add('is-fullscreen');
            }
        });
    }

    /** Baut die Miniaturleiste einmal pro geladener Fotoliste auf. */
    _renderFilmstrip() {
        const strip = this._dom.filmstrip;
        if (!strip) return;

        strip.innerHTML = '';
        const fragment = document.createDocumentFragment();

        this._photos.forEach((photo, i) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'filmstrip-item';
            btn.dataset.index = String(i);
            btn.setAttribute('role', 'option');
            btn.setAttribute('aria-label', photo.location || `Foto ${i + 1}`);

            const img = document.createElement('img');
            img.src = `/api/thumb/${encodeFilenamePath(photo.filename)}?token=${this._token}&size=blur`;
            img.loading = 'lazy';
            img.alt = '';

            btn.appendChild(img);
            fragment.appendChild(btn);
        });

        strip.appendChild(fragment);
    }

    /** Markiert das aktuelle Foto in der Filmstrip-Leiste und scrollt es in Sicht. */
    _syncFilmstripActive() {
        const strip = this._dom.filmstrip;
        if (!strip) return;

        const prevActive = strip.querySelector('.filmstrip-item.active');
        prevActive?.classList.remove('active');

        const activeEl = strip.children[this._currentIndex];
        if (activeEl) {
            activeEl.classList.add('active');
            activeEl.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
        }
    }

    /** Klick auf ein Filmstrip-Thumbnail springt direkt zu diesem Foto. */
    _bindFilmstrip() {
        const strip = this._dom.filmstrip;
        if (!strip) return;

        strip.addEventListener('click', (e) => {
            const btn = e.target.closest('.filmstrip-item');
            if (!btn) return;
            this.setIndex(Number(btn.dataset.index));
        });
    }
}

// Einstiegspunkt: instanziiert alle Module und verdrahtet ihre Callbacks.

import { fetchRoute, fetchStats } from './api.js';
import { MapController }   from './map.js';
import { GalleryController } from './gallery.js';
import { createClickDispatcher } from './click-timer.js';

// =============================================================================
// 1. TOKEN
// =============================================================================

const TOKEN = document.body.dataset.token;
if (!TOKEN) {
    console.error('KRITISCH: Kein Token im Body-Dataset gefunden.');
    throw new Error('Kein Token — App kann nicht starten.');
}

// =============================================================================
// 2. DOM-REFERENZEN
// =============================================================================

const dom = {
    // Karte
    map:            document.getElementById('map'),

    // Galerie / Foto-Anzeige
    currentPhoto:   document.getElementById('current-photo'),
    bgPhoto:        document.getElementById('bg-photo'),
    txtLocation:    document.getElementById('photo-location'),
    txtDate:        document.getElementById('photo-date'),
    galleryPanel:   document.querySelector('.gallery-panel'),
    filmstrip:      document.getElementById('filmstrip'),

    // Buttons
    btnStats:       document.getElementById('open-stats'),
    btnHelp:        document.getElementById('open-help'),
    // Modals
    statsModal:     document.getElementById('stats-modal'),
    countryList:    document.getElementById('country-list'),
    tutorialModal:  document.getElementById('tutorial-modal'),

    // Schließen-Buttons
    btnCloseStats:    document.getElementById('close-stats'),
    btnCloseTutorial: document.getElementById('close-tutorial'),
};

// =============================================================================
// 3. MODULE INSTANZIIEREN
// =============================================================================

const map = new MapController(dom.map, {
    center: [50, 10],
    zoom:   6,
    flyDuration: 1.5,
});

const gallery = new GalleryController({
    currentPhoto: dom.currentPhoto,
    bgPhoto:      dom.bgPhoto,
    txtLocation:  dom.txtLocation,
    txtDate:      dom.txtDate,
    galleryPanel: dom.galleryPanel,
    filmstrip:    dom.filmstrip,
}, TOKEN);

// =============================================================================
// 4. CALLBACKS VERKNÜPFEN
// =============================================================================

// Galerie ↔ Karte: Foto-Wechsel → Karte folgt
gallery.onPhotoChange = (index, photo) => {
    map.setActiveMarker(index, photo);
};

// Karte ↔ Galerie: Marker-Klick → Galerie springt hin
map.onMarkerClick = (index) => {
    gallery.setIndex(index);
};

// =============================================================================
// 5. HTML-BUTTONS: window.changePhoto / window.changeLocation
//    Die onclick-Attribute im HTML rufen diese globalen Funktionen auf.
//    Sie delegieren direkt an die Gallery-Instanz.
// =============================================================================

window.changePhoto    = (dir) => gallery.changePhoto(dir);
window.changeLocation = (dir) => gallery.changeLocation(dir);

// =============================================================================
// 6. DATEN VOM SERVER LADEN
// =============================================================================

async function init() {
    // Stats sofort laden (kleiner Request, erscheint schnell)
    fetchStats(TOKEN).then(stats => {
        animateValue('stat-km',       0, stats.total_km, 1500);
        setStatText('stat-countries', stats.countries);
        setStatText('stat-days',       stats.days);
        setStatText('stat-photos',     stats.photo_count);
    }).catch(() => {});

    try {
        const { photos, routes } = await fetchRoute(TOKEN);

        if (!photos || photos.length === 0) {
            console.warn('Keine Fotos vom Server erhalten.');
            return;
        }

        const allPhotos = photos.map(p => ({
            ...p,
            countryCode: extractCountryCode(p.location),
        }));

        map.renderPhotos(allPhotos, routes || []);
        gallery.loadPhotos(allPhotos, 0);
        renderCountryList(summarizeCountries(allPhotos));

    } catch (err) {
        console.error('Fehler beim Laden der Reisedaten:', err);
    }
}

init();

// =============================================================================
// 7. MODAL-EVENTS (nicht modul-spezifisch)
// =============================================================================

// Stats-Modal öffnen (Einzelklick) / Admin-Bereich öffnen (Doppelklick)
dom.btnStats?.addEventListener('click', createClickDispatcher({
    onSingleClick: () => dom.statsModal?.classList.add('show'),
    onDoubleClick: () => { window.location.href = '/admin'; },
}));
dom.btnCloseStats?.addEventListener('click', () =>
    dom.statsModal?.classList.remove('show'));
dom.statsModal?.addEventListener('click', (e) => {
    if (e.target === dom.statsModal) dom.statsModal.classList.remove('show');
});

// Tutorial: beim ersten Besuch automatisch anzeigen
if (dom.tutorialModal && !localStorage.getItem('tutorial_seen')) {
    setTimeout(() => dom.tutorialModal.classList.add('show'), 1000);
}
dom.btnCloseTutorial?.addEventListener('click', () => {
    dom.tutorialModal?.classList.remove('show');
    localStorage.setItem('tutorial_seen', 'true');
});
dom.btnHelp?.addEventListener('click', () => {
    dom.statsModal?.classList.remove('show');
    dom.tutorialModal?.classList.add('show');
});

// =============================================================================
// HILFSFUNKTIONEN (nur für main.js)
// =============================================================================

function extractCountryCode(locationString) {
    if (!locationString) return 'UNK';
    const parts = locationString.split(',');
    return parts.length > 1 ? parts[parts.length - 1].trim() : 'UNK';
}

/**
 * Zaehlt die Fotos pro Land - Grundlage fuer die Länder-Liste im Stats-Modal.
 * Reihenfolge = Reihenfolge des ersten Fotos je Land (photos ist zeitlich sortiert).
 * @param {Array<object>} photos - müssen countryCode enthalten
 * @returns {Array<{code: string, count: number}>}
 */
function summarizeCountries(photos) {
    const byCountry = new Map();
    for (const p of photos) {
        if (p.countryCode === 'UNK') continue;
        byCountry.set(p.countryCode, (byCountry.get(p.countryCode) || 0) + 1);
    }
    return [...byCountry.entries()].map(([code, count]) => ({ code, count }));
}

/** Wandelt einen ISO-3166-1-alpha-2-Code in das Flaggen-Emoji um (z.B. "FR" -> 🇫🇷). */
function flagEmoji(code) {
    return code.toUpperCase().replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)));
}

let regionNames = null;
try { regionNames = new Intl.DisplayNames(['de'], { type: 'region' }); } catch (_) { /* alter Browser */ }

/** Lokalisierter Ländername, mit dem Code als Fallback falls Intl.DisplayNames fehlt. */
function countryName(code) {
    try {
        return regionNames?.of(code) || code;
    } catch (_) {
        return code;
    }
}

/**
 * Rendert die Länder-Liste (Flagge + Name + Fotoanzahl) im Stats-Modal.
 * @param {Array<{code: string, count: number}>} countries
 */
function renderCountryList(countries) {
    const list = dom.countryList;
    if (!list) return;

    list.innerHTML = '';
    const fragment = document.createDocumentFragment();

    for (const { code, count } of countries) {
        const li = document.createElement('li');

        const flag = document.createElement('span');
        flag.className = 'country-flag';
        flag.textContent = flagEmoji(code);
        flag.setAttribute('aria-hidden', 'true');

        const name = document.createElement('span');
        name.className = 'country-name';
        name.textContent = countryName(code);

        const photoCount = document.createElement('span');
        photoCount.className = 'country-count';
        photoCount.textContent = `${count} Foto${count === 1 ? '' : 's'}`;

        li.append(flag, name, photoCount);
        fragment.appendChild(li);
    }

    list.appendChild(fragment);
}

function setStatText(id, value) {
    const el = document.getElementById(id);
    if (el) el.innerText = value;
}

function animateValue(id, start, end, duration) {
    const el = document.getElementById(id);
    if (!el) return;
    let startTs = null;
    const step = (ts) => {
        if (!startTs) startTs = ts;
        const progress = Math.min((ts - startTs) / duration, 1);
        el.innerHTML = Math.floor(progress * (end - start) + start).toLocaleString('de-DE');
        if (progress < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
}

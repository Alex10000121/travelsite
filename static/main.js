import { fetchRoute, fetchStats } from './api.js';
import { MapController }   from './map.js';
import { GalleryController } from './gallery.js';
import { createClickDispatcher } from './click-timer.js';
import { renderInto } from './dom-utils.js';

const TOKEN = document.body.dataset.token;
if (!TOKEN) {
    console.error('KRITISCH: Kein Token im Body-Dataset gefunden.');
    throw new Error('Kein Token — App kann nicht starten.');
}

const dom = {
    map:            document.getElementById('map'),

    currentPhoto:   document.getElementById('current-photo'),
    bgPhoto:        document.getElementById('bg-photo'),
    txtLocation:    document.getElementById('photo-location'),
    txtDate:        document.getElementById('photo-date'),
    txtWeather:     document.getElementById('photo-weather'),
    txtNote:        document.getElementById('photo-note'),
    favoriteBadge:  document.getElementById('photo-favorite'),
    galleryPanel:   document.querySelector('.gallery-panel'),
    filmstrip:      document.getElementById('filmstrip'),

    btnStats:       document.getElementById('open-stats'),
    btnHelp:        document.getElementById('open-help'),
    statsModal:     document.getElementById('stats-modal'),
    countryList:    document.getElementById('country-list'),
    tutorialModal:  document.getElementById('tutorial-modal'),

    btnCloseStats:    document.getElementById('close-stats'),
    btnCloseTutorial: document.getElementById('close-tutorial'),
};

const map = new MapController(dom.map, {
    center: [50, 10],
    zoom:   6,
    flyDuration: 1.5,
    token: TOKEN,
    showPinsToggle: true,
});

const gallery = new GalleryController({
    currentPhoto: dom.currentPhoto,
    bgPhoto:      dom.bgPhoto,
    txtLocation:  dom.txtLocation,
    txtDate:      dom.txtDate,
    txtWeather:   dom.txtWeather,
    txtNote:      dom.txtNote,
    favoriteBadge: dom.favoriteBadge,
    galleryPanel: dom.galleryPanel,
    filmstrip:    dom.filmstrip,
}, TOKEN);

gallery.onPhotoChange = (index, photo) => {
    map.setActiveMarker(index, photo);
};

map.onMarkerClick = (index) => {
    gallery.setIndex(index);
};

// Die onclick-Attribute im HTML (window.changePhoto/changeLocation) rufen diese
// globalen Funktionen auf und delegieren direkt an die Gallery-Instanz.
window.changePhoto    = (dir) => gallery.changePhoto(dir);
window.changeLocation = (dir) => gallery.changeLocation(dir);

async function init() {
    // Bewusst nicht awaited: soll parallel zu fetchRoute laufen statt die
    // (fuer die Kernfunktion nicht kritischen) Stats erst danach zu laden.
    loadStats();

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
        renderCountryList(summarizeCountries(allPhotos));
        gallery.loadPhotos(allPhotos, findStartIndexForLastCountry(allPhotos));

    } catch (err) {
        console.error('Fehler beim Laden der Reisedaten:', err);
    }
}

/**
 * Index des ersten Fotos des zuletzt besuchten Landes (photos ist zeitlich sortiert,
 * "zuletzt besucht" = Land des letzten Fotos).
 * @param {Array<object>} photos - muessen countryCode enthalten
 * @returns {number}
 */
function findStartIndexForLastCountry(photos) {
    if (!photos.length) return 0;
    const lastCountry = photos[photos.length - 1].countryCode;
    const index = photos.findIndex(p => p.countryCode === lastCountry);
    return index === -1 ? 0 : index;
}

async function loadStats() {
    try {
        const stats = await fetchStats(TOKEN);
        animateValue('stat-km',       0, stats.total_km, 1500);
        setStatText('stat-countries', stats.countries);
        setStatText('stat-days',       stats.days);
        setStatText('stat-photos',     stats.photo_count);
    } catch (_) {
        // Stats sind nur ein "Nice-to-have" oben auf der Seite - ein Fehler hier
        // soll die restliche App (Galerie/Karte) nicht beeintraechtigen.
    }
}

init();

dom.btnStats?.addEventListener('click', createClickDispatcher({
    onSingleClick: () => dom.statsModal?.classList.add('show'),
    onDoubleClick: () => { window.location.href = '/admin'; },
}));
dom.btnCloseStats?.addEventListener('click', () =>
    dom.statsModal?.classList.remove('show'));
dom.statsModal?.addEventListener('click', (e) => {
    if (e.target === dom.statsModal) dom.statsModal.classList.remove('show');
});

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

function extractCountryCode(locationString) {
    if (!locationString) return 'UNK';
    const parts = locationString.split(',');
    return parts.length > 1 ? parts[parts.length - 1].trim() : 'UNK';
}

/**
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

// Kein Emoji-Flag (String.fromCodePoint(127397 + ...)) - Windows rendert
// Regional-Indicator-Symbole grundsaetzlich nicht als Flaggenbild, sondern nur
// als zwei Buchstaben in Kaestchen (Segoe UI Emoji hat bewusst keine Flaggen-
// Glyphen). Echtes Bild von flagcdn.com stattdessen, siehe renderCountryList.
function flagUrl(code) {
    return `https://flagcdn.com/24x18/${code.toLowerCase()}.png`;
}

let regionNames = null;
try { regionNames = new Intl.DisplayNames(['de'], { type: 'region' }); } catch (_) { /* alter Browser */ }

function countryName(code) {
    try {
        return regionNames?.of(code) || code;
    } catch (_) {
        return code;
    }
}

/**
 * @param {Array<{code: string, count: number}>} countries
 */
function renderCountryList(countries) {
    renderInto(dom.countryList, countries, buildCountryItem);
}

function buildCountryItem({ code, count }) {
    const li = document.createElement('li');

    const flag = document.createElement('img');
    flag.className = 'country-flag';
    flag.src = flagUrl(code);
    flag.alt = '';
    flag.loading = 'lazy';
    flag.setAttribute('aria-hidden', 'true');
    // Ungueltiger/unbekannter Code (z.B. Fallback-Koordinaten statt Ortsname) ->
    // Bild durch den rohen Code ersetzen statt ein kaputtes Icon zu zeigen.
    flag.addEventListener('error', () => { flag.replaceWith(document.createTextNode(code)); }, { once: true });

    const name = document.createElement('span');
    name.className = 'country-name';
    name.textContent = countryName(code);

    const photoCount = document.createElement('span');
    photoCount.className = 'country-count';
    photoCount.textContent = `${count} Foto${count === 1 ? '' : 's'}`;

    li.append(flag, name, photoCount);
    return li;
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

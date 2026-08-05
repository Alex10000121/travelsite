// Gemeinsame DOM-Bausteine der Admin-Listen (Fotos, Routen, Protokoll): alle drei
// rendern serverseitig paginierte Listen nach demselben Muster (Fragment aufbauen,
// Weitere-laden-Button ein-/ausblenden, Suche debounced, Fehler als Alert anzeigen).

export const SEARCH_DEBOUNCE_MS = 300;

/**
 * Verzögert Aufrufe von fn, bis für delayMs kein erneuter Aufruf mehr kam
 * (z.B. um bei jedem Tastendruck im Suchfeld nicht sofort neu zu laden).
 * @param {function} fn
 * @param {number} delayMs
 * @returns {function} Debounced Version von fn
 */
export function debounce(fn, delayMs) {
    let timer = null;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), delayMs);
    };
}

/**
 * Führt action aus und zeigt bei einem Fehler dessen Nachricht als Alert an,
 * statt die Exception weiterzureichen. Einheitliches Fehlerverhalten für alle
 * nicht-kritischen Admin-Aktionen (Laden, Speichern, Löschen).
 * @param {function(): Promise<void>} action
 */
export async function tryOrAlert(action) {
    try {
        await action();
    } catch (err) {
        alert(err.message);
    }
}

/**
 * Blendet den "Weitere laden"-Button ein, solange serverseitig noch mehr
 * Einträge verfügbar sind als bereits geladen wurden.
 * @param {HTMLElement} loadMoreBtn
 * @param {number} offset
 * @param {number} total
 */
export function updateLoadMoreVisibility(loadMoreBtn, offset, total) {
    if (!loadMoreBtn) return;
    loadMoreBtn.style.display = offset < total ? '' : 'none';
}

/**
 * Rendert items als DOM-Elemente in container - ersetzt dessen Inhalt, außer
 * append ist true (dann wird angehängt, für "Weitere laden").
 * @param {HTMLElement} container
 * @param {Array} items
 * @param {function(item: *, index: number): HTMLElement} buildItem
 * @param {object} [opts]
 * @param {boolean} [opts.append=false]
 */
export function renderInto(container, items, buildItem, { append = false } = {}) {
    if (!container) return;
    if (!append) container.innerHTML = '';

    const fragment = document.createDocumentFragment();
    items.forEach((item, index) => fragment.appendChild(buildItem(item, index)));
    container.appendChild(fragment);
}

/** @returns {HTMLButtonElement} type="button"-Button mit Klasse und Text. */
export function createButton(className, text) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.textContent = text;
    return btn;
}

/** @returns {HTMLSpanElement} Span mit Klasse und Textinhalt. */
export function createSpan(className, text) {
    const el = document.createElement('span');
    el.className = className;
    el.textContent = text;
    return el;
}

/** @returns {HTMLImageElement} Lazy-geladenes Bild ohne Alt-Text (dekorative Thumbnails). */
export function createLazyImage(src) {
    const img = document.createElement('img');
    img.src = src;
    img.loading = 'lazy';
    img.alt = '';
    return img;
}

// Alle fetch-Aufrufe zum Backend.
// Jede Funktion wirft bei Fehler einen Error — kein fetch() außerhalb dieser Datei.

import { encodeFilenamePath } from './filename-utils.js';

/**
 * Lädt Reisestatistiken (km, Länder, Tage, Fotos) – leichtgewichtig, schnell.
 * @param {string} token
 * @returns {Promise<{total_km: number, countries: number, photo_count: number, days: number}>}
 */
export async function fetchStats(token) {
    const res = await fetch(`/api/stats?token=${token}`);
    if (!res.ok) {
        throw new Error(`Fehler beim Laden der Statistiken (HTTP ${res.status})`);
    }
    return res.json();
}

/**
 * Lädt alle Routendaten (Fotos + Routen) vom Server.
 * @param {string} token - Öffentlicher Lese-Token aus data-token
 * @returns {Promise<{photos: Array, routes: Array}>}
 */
export async function fetchRoute(token) {
    const res = await fetch(`/api/route?token=${token}`);
    if (!res.ok) {
        throw new Error(`Fehler beim Laden der Route (HTTP ${res.status})`);
    }
    return res.json();
}

/**
 * Meldet sich im Admin-Bereich an (setzt bei Erfolg eine Server-Session).
 * @param {string} password - Das eingegebene Passwort
 * @returns {Promise<void>} - Löst auf bei Erfolg, wirft Error bei falschem Passwort oder Netzwerkfehler
 */
export async function adminLogin(password) {
    let res;
    try {
        res = await fetch('/admin/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ admin_token: password })
        });
    } catch (err) {
        throw new Error('Verbindungsfehler zum Server.');
    }

    if (!res.ok) {
        throw new Error('Falsches Passwort.');
    }
}

/**
 * Lädt ein einzelnes Foto hoch. Auth läuft über die Admin-Session (Cookie).
 * @param {FormData} formData - Muss 'photo' und optional 'lat'/'lon' enthalten
 * @returns {Promise<Object>} - Die JSON-Antwort des Servers (file, lat, lon, location, timestamp, …)
 */
export async function uploadPhoto(formData) {
    let res;
    try {
        res = await fetch('/api/upload', {
            method: 'POST',
            body: formData
        });
    } catch (err) {
        throw new Error(`Netzwerkfehler beim Upload: ${err.message}`);
    }

    const json = await res.json().catch(() => ({}));

    if (!res.ok) {
        const err = new Error(json.error || `Upload fehlgeschlagen (HTTP ${res.status})`);
        err.status = res.status;
        err.missing_gps = json.missing_gps ?? false;
        throw err;
    }

    return json;
}

/**
 * Speichert nachträglich GPS-Koordinaten für ein bereits hochgeladenes Foto.
 * Auth läuft über die Admin-Session (Cookie).
 * @param {string} filename - Dateiname des Fotos
 * @param {number} lat - Breitengrad
 * @param {number} lon - Längengrad
 * @returns {Promise<void>} - Löst auf bei Erfolg, wirft Error bei Misserfolg
 */
export async function updateLocation(filename, lat, lon) {
    let res;
    try {
        res = await fetch('/api/update_location', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename, lat, lon })
        });
    } catch (err) {
        throw new Error(`Netzwerkfehler beim Speichern des Ortes: ${err.message}`);
    }

    if (!res.ok) {
        throw new Error(`Ort konnte nicht gespeichert werden (HTTP ${res.status}). Sitzung evtl. abgelaufen?`);
    }
}

/**
 * Lädt eine Seite Fotos für die Admin-Verwaltungsansicht (inkl. Ort/Datum),
 * optional gefiltert nach Ort/Dateiname. Serverseitig paginiert, damit bei
 * vielen hundert Fotos nicht alles auf einmal geladen/gerendert wird.
 * @param {object} [opts]
 * @param {string} [opts.q] - Suchbegriff (Ort oder Dateiname)
 * @param {number} [opts.offset]
 * @returns {Promise<{photos: Array, total: number, offset: number, limit: number}>}
 */
export async function fetchAdminPhotos({ q = '', offset = 0 } = {}) {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (offset) params.set('offset', String(offset));

    let res;
    try {
        res = await fetch(`/api/admin/photos?${params.toString()}`);
    } catch (err) {
        throw new Error('Verbindungsfehler beim Laden der Fotos.');
    }

    if (!res.ok) {
        throw new Error(`Fotos konnten nicht geladen werden (HTTP ${res.status}).`);
    }
    return res.json();
}

/**
 * Löscht ein Foto inkl. Original, Thumbnails und DB-Eintrag.
 * @param {string} filename
 * @returns {Promise<void>}
 */
export async function deletePhoto(filename) {
    let res;
    try {
        res = await fetch(`/api/admin/photos/${encodeFilenamePath(filename)}`, { method: 'DELETE' });
    } catch (err) {
        throw new Error(`Netzwerkfehler beim Löschen: ${err.message}`);
    }

    if (!res.ok) {
        throw new Error(`Foto konnte nicht gelöscht werden (HTTP ${res.status}).`);
    }
}

/**
 * Lädt Besucherzahlen für das Admin-Dashboard: Gesamt, aktuell aktive Sessions
 * und den Tagesverlauf der letzten 30 Tage.
 * @returns {Promise<{total: number, active_now: number, daily: Array<{date: string, count: number}>}>}
 */
export async function fetchVisitorStats() {
    let res;
    try {
        res = await fetch('/api/admin/visitor-stats');
    } catch (err) {
        throw new Error('Verbindungsfehler beim Laden der Besucherzahlen.');
    }

    if (!res.ok) {
        throw new Error(`Besucherzahlen konnten nicht geladen werden (HTTP ${res.status}).`);
    }
    return res.json();
}

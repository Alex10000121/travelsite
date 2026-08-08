// Alle fetch-Aufrufe zum Backend.
// Jede Funktion wirft bei Fehler einen Error — kein fetch() außerhalb dieser Datei.

import { encodeFilenamePath } from './filename-utils.js';

/**
 * Führt fetch aus und bündelt Netzwerkfehler (DNS/Offline/CORS) in einen Error
 * mit nutzerfreundlicher Nachricht, statt die rohe TypeError von fetch durchzureichen.
 * @param {string} url
 * @param {RequestInit} [options]
 * @param {string|function(Error): string} networkErrorMessage - Text, oder Funktion die ihn aus dem Fehler baut
 * @returns {Promise<Response>}
 */
async function safeFetch(url, options, networkErrorMessage) {
    try {
        return await fetch(url, options);
    } catch (err) {
        const message = typeof networkErrorMessage === 'function' ? networkErrorMessage(err) : networkErrorMessage;
        throw new Error(message);
    }
}

/** @returns {Promise<Object>} Geparster JSON-Body, oder {} falls die Antwort keinen (gültigen) JSON-Body hat. */
async function parseJsonSafe(res) {
    return res.json().catch(() => ({}));
}

/**
 * Lädt Reisestatistiken (km, Länder, Tage, Fotos) – leichtgewichtig, schnell.
 * @param {string} token
 * @returns {Promise<{total_km: number, countries: number, photo_count: number, days: number}>}
 */
export async function fetchStats(token) {
    const res = await safeFetch(`/api/stats?token=${token}`, undefined, 'Verbindungsfehler beim Laden der Statistiken.');
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
    const res = await safeFetch(`/api/route?token=${token}`, undefined, 'Verbindungsfehler beim Laden der Route.');
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
    const res = await safeFetch('/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ admin_token: password })
    }, 'Verbindungsfehler zum Server.');

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
    const res = await safeFetch('/api/upload', {
        method: 'POST',
        body: formData
    }, (err) => `Netzwerkfehler beim Upload: ${err.message}`);

    const json = await parseJsonSafe(res);

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
 * @returns {Promise<void>}
 */
export async function updateLocation(filename, lat, lon) {
    const res = await safeFetch('/api/update_location', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, lat, lon })
    }, (err) => `Netzwerkfehler beim Speichern des Ortes: ${err.message}`);

    if (!res.ok) {
        throw new Error(`Ort konnte nicht gespeichert werden (HTTP ${res.status}). Sitzung evtl. abgelaufen?`);
    }
}

/**
 * Speichert eine optionale Notiz für ein Foto. Leerer String entfernt die Notiz.
 * @param {string} filename
 * @param {string} note
 * @returns {Promise<void>}
 */
export async function updateNote(filename, note) {
    const res = await safeFetch(`/api/admin/photos/${encodeFilenamePath(filename)}/note`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note })
    }, (err) => `Netzwerkfehler beim Speichern der Notiz: ${err.message}`);

    if (!res.ok) {
        const json = await parseJsonSafe(res);
        throw new Error(json.error || `Notiz konnte nicht gespeichert werden (HTTP ${res.status}).`);
    }
}

/**
 * Markiert ein Foto als Favorit oder entfernt die Markierung.
 * @param {string} filename
 * @param {boolean} favorite
 * @returns {Promise<void>}
 */
export async function setFavorite(filename, favorite) {
    const res = await safeFetch(`/api/admin/photos/${encodeFilenamePath(filename)}/favorite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ favorite })
    }, (err) => `Netzwerkfehler beim Speichern des Favoriten: ${err.message}`);

    if (!res.ok) {
        throw new Error(`Favorit konnte nicht gespeichert werden (HTTP ${res.status}).`);
    }
}

function buildPaginationParams({ q = '', offset = 0 } = {}) {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (offset) params.set('offset', String(offset));
    return params;
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
    const params = buildPaginationParams({ q, offset });

    const res = await safeFetch(`/api/admin/photos?${params.toString()}`, undefined, 'Verbindungsfehler beim Laden der Fotos.');
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
    const res = await safeFetch(`/api/admin/photos/${encodeFilenamePath(filename)}`, { method: 'DELETE' },
        (err) => `Netzwerkfehler beim Löschen: ${err.message}`);

    if (!res.ok) {
        throw new Error(`Foto konnte nicht gelöscht werden (HTTP ${res.status}).`);
    }
}

/**
 * Lädt eine Seite der Streckenabschnitte zwischen aufeinanderfolgenden Fotos für die
 * Admin-Routenverwaltung, serverseitig paginiert.
 * @param {object} [opts]
 * @param {number} [opts.offset]
 * @returns {Promise<{segments: Array, total: number, offset: number, limit: number}>}
 */
export async function fetchAdminRoutes({ offset = 0 } = {}) {
    const params = buildPaginationParams({ offset });

    const res = await safeFetch(`/api/admin/routes?${params.toString()}`, undefined, 'Verbindungsfehler beim Laden der Routen.');
    if (!res.ok) {
        throw new Error(`Routen konnten nicht geladen werden (HTTP ${res.status}).`);
    }
    return res.json();
}

/**
 * Überschreibt den automatisch erkannten Modus (Fahrt/Flug) eines Streckenabschnitts.
 * @param {string} startFilename
 * @param {string} endFilename
 * @param {'drive'|'flight'} mode
 * @returns {Promise<void>}
 */
export async function setRouteMode(startFilename, endFilename, mode) {
    const res = await safeFetch('/api/admin/routes/mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ start_filename: startFilename, end_filename: endFilename, mode })
    }, (err) => `Netzwerkfehler beim Speichern des Modus: ${err.message}`);

    if (!res.ok) {
        const json = await parseJsonSafe(res);
        throw new Error(json.error || `Modus konnte nicht gespeichert werden (HTTP ${res.status}).`);
    }
}

/**
 * Lädt Besucherzahlen für das Admin-Dashboard: Gesamt, aktuell aktive Sessions
 * und den Tagesverlauf der letzten 30 Tage.
 * @returns {Promise<{total: number, active_now: number, daily: Array<{date: string, count: number}>}>}
 */
export async function fetchVisitorStats() {
    const res = await safeFetch('/api/admin/visitor-stats', undefined, 'Verbindungsfehler beim Laden der Besucherzahlen.');
    if (!res.ok) {
        throw new Error(`Besucherzahlen konnten nicht geladen werden (HTTP ${res.status}).`);
    }
    return res.json();
}

/**
 * Lädt eine Seite des Admin-Aktionsprotokolls (Login/Logout, Uploads, Änderungen, Löschungen),
 * optional gefiltert nach Aktion/Detail, serverseitig paginiert.
 * @param {object} [opts]
 * @param {string} [opts.q] - Suchbegriff (Aktion oder Detail)
 * @param {number} [opts.offset]
 * @returns {Promise<{entries: Array, total: number, offset: number, limit: number}>}
 */
export async function fetchAdminLog({ q = '', offset = 0 } = {}) {
    const params = buildPaginationParams({ q, offset });

    const res = await safeFetch(`/api/admin/log?${params.toString()}`, undefined, 'Verbindungsfehler beim Laden des Protokolls.');
    if (!res.ok) {
        throw new Error(`Protokoll konnte nicht geladen werden (HTTP ${res.status}).`);
    }
    return res.json();
}

/**
 * Lädt die verfügbaren Trip-Reel-Gruppen (Länder) mit Foto-/Videoanzahl.
 * @returns {Promise<{groups: Array<{group_key: string, photo_count: number, video_count: number}>}>}
 */
export async function fetchReelGroups() {
    const res = await safeFetch('/api/admin/reels/groups', undefined, 'Verbindungsfehler beim Laden der Reel-Gruppen.');
    if (!res.ok) {
        throw new Error(`Reel-Gruppen konnten nicht geladen werden (HTTP ${res.status}).`);
    }
    return res.json();
}

/**
 * Startet die Erstellung eines Trip Reels für eine Gruppe (Land) im Hintergrund -
 * der Fortschritt wird über fetchReelStatus()/fetchAdminReels() abgefragt. Die Ziel-Dauer
 * bestimmt serverseitig nur die Segmentanzahl (zufällig ausgewählt, chronologisch sortiert) -
 * die tatsächliche Dauer des fertigen Reels kann leicht abweichen.
 * @param {string} groupKey
 * @param {number} durationSeconds - Gewünschte Ziel-Dauer des Reels in Sekunden
 * @returns {Promise<{success: boolean, reel_id: number}>}
 */
export async function createReel(groupKey, durationSeconds) {
    const res = await safeFetch('/api/admin/reels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ group_key: groupKey, duration_seconds: durationSeconds })
    }, (err) => `Netzwerkfehler beim Starten des Reels: ${err.message}`);

    const json = await parseJsonSafe(res);
    if (!res.ok) {
        throw new Error(json.error || `Reel konnte nicht gestartet werden (HTTP ${res.status}).`);
    }
    return json;
}

/**
 * Lädt eine Seite der erstellten Trip Reels (neueste zuerst), serverseitig paginiert.
 * @param {object} [opts]
 * @param {number} [opts.offset]
 * @returns {Promise<{reels: Array, total: number, offset: number, limit: number}>}
 */
export async function fetchAdminReels({ offset = 0 } = {}) {
    const params = buildPaginationParams({ offset });

    const res = await safeFetch(`/api/admin/reels?${params.toString()}`, undefined, 'Verbindungsfehler beim Laden der Reels.');
    if (!res.ok) {
        throw new Error(`Reels konnten nicht geladen werden (HTTP ${res.status}).`);
    }
    return res.json();
}

/**
 * Fragt den aktuellen Status eines einzelnen Reel-Jobs ab (fürs Polling während der Erstellung).
 * @param {number} reelId
 * @returns {Promise<Object>}
 */
export async function fetchReelStatus(reelId) {
    const res = await safeFetch(`/api/admin/reels/${reelId}`, undefined, 'Verbindungsfehler beim Abfragen des Reel-Status.');
    if (!res.ok) {
        throw new Error(`Reel-Status konnte nicht geladen werden (HTTP ${res.status}).`);
    }
    return res.json();
}

/**
 * URL zum Download eines fertigen Reels - direkter Link (Content-Disposition: attachment
 * serverseitig), kein Fetch/Player noetig.
 * @param {number} reelId
 * @returns {string}
 */
export function reelDownloadUrl(reelId) {
    return `/api/admin/reels/${reelId}/file`;
}

/**
 * Löscht einen Reel-Job inklusive generierter Videodatei.
 * @param {number} reelId
 * @returns {Promise<void>}
 */
export async function deleteReel(reelId) {
    const res = await safeFetch(`/api/admin/reels/${reelId}`, { method: 'DELETE' },
        (err) => `Netzwerkfehler beim Löschen: ${err.message}`);

    if (!res.ok) {
        throw new Error(`Reel konnte nicht gelöscht werden (HTTP ${res.status}).`);
    }
}

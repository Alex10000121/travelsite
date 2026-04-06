// Kapselt die gesamte Leaflet-Logik (benötigt globales `L` und markercluster-Plugin).
// Keine Abhängigkeit zu API oder globalem State.

const STYLES = {
    active: {
        radius: 10,
        fillColor: '#3b82f6',
        color: null,   // wird im Konstruktor gesetzt (Dark-Mode abhängig)
        weight: 4,
        fillOpacity: 1
    },
    inactive: {
        radius: 6,
        fillColor: '#64748b',
        color: null,
        weight: 1,
        fillOpacity: 0.6
    },
    line: {
        color: '#3b82f6',
        weight: 3,
        opacity: 0.5,
        dashArray: '5, 10'
    }
};

export class MapController {

    /**
     * @param {HTMLElement} mapElement   - Das #map-DOM-Element
     * @param {object}      [options]
     * @param {number[]}    [options.center=[50,10]]   - Initiales Kartenzentrum [lat, lon]
     * @param {number}      [options.zoom=6]           - Initialer Zoom-Level
     * @param {number}      [options.flyDuration=1.5]  - Dauer der flyTo-Animation (Sekunden)
     */
    constructor(mapElement, options = {}) {
        const isDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
        const borderColor = isDark ? '#1e293b' : '#fff';

        this._styles = {
            ...STYLES,
            active:   { ...STYLES.active,   color: borderColor },
            inactive: { ...STYLES.inactive, color: borderColor }
        };

        this._tileUrl = isDark
            ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
            : 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png';

        this._flyDuration  = options.flyDuration ?? 1.5;
        this._markers      = [];   // Index-synchron mit photos-Array; null wenn kein GPS
        this._clusterGroup = null;
        this._fixMarker    = null;

        // Leaflet-Karte initialisieren
        this._map = L.map(mapElement, { zoomControl: false })
            .setView(options.center ?? [50, 10], options.zoom ?? 6);

        L.control.zoom({ position: 'bottomright' }).addTo(this._map);

        L.tileLayer(this._tileUrl, {
            attribution: '&copy; OpenStreetMap &copy; CARTO',
            maxZoom: 19
        }).addTo(this._map);

        // Karten-Klick: wird nach außen delegiert (z.B. für Fix-Modus)
        this._map.on('click', (e) => {
            this._onMapClick?.(e.latlng.lat, e.latlng.lng);
        });
    }

    // -------------------------------------------------------------------------
    // Callbacks (werden von außen gesetzt)
    // -------------------------------------------------------------------------

    /**
     * Wird aufgerufen, wenn der Nutzer auf einen Foto-Marker klickt.
     * @param {function(index: number): void} fn
     */
    set onMarkerClick(fn) { this._onMarkerClick = fn; }

    /**
     * Wird aufgerufen, wenn der Nutzer auf die Karte klickt (ohne Marker).
     * @param {function(lat: number, lon: number): void} fn
     */
    set onMapClick(fn) { this._onMapClick = fn; }

    // -------------------------------------------------------------------------
    // Fotos rendern
    // -------------------------------------------------------------------------

    /**
     * Zeichnet Polyline + geclusterte Marker für alle Fotos.
     * Bereits vorhandene Marker werden vorher entfernt.
     *
     * @param {Array<{lat: number|null, lon: number|null}>} photos
     */
    renderPhotos(photos) {
        this._clearPhotos();

        const validCoords = photos
            .filter(p => p.lat != null && p.lon != null)
            .map(p => [p.lat, p.lon]);

        if (validCoords.length > 0) {
            L.polyline(validCoords, this._styles.line).addTo(this._map);
        }

        const cluster = L.markerClusterGroup({
            showCoverageOnHover: false,
            spiderfyDistanceMultiplier: 2
        });

        photos.forEach((photo, index) => {
            if (photo.lat == null || photo.lon == null) {
                this._markers.push(null);
                return;
            }

            const marker = L.circleMarker([photo.lat, photo.lon], { ...this._styles.inactive });

            marker.on('click', () => {
                this._onMarkerClick?.(index);
            });

            cluster.addLayer(marker);
            this._markers.push(marker);
        });

        this._map.addLayer(cluster);
        this._clusterGroup = cluster;
    }

    // -------------------------------------------------------------------------
    // Aktiven Marker hervorheben & Karte fokussieren
    // -------------------------------------------------------------------------

    /**
     * Hebt den Marker am angegebenen Index aktiv hervor, alle anderen inaktiv.
     * Fliegt mit der Karte zum aktiven Marker.
     *
     * @param {number} activeIndex
     * @param {{lat: number, lon: number}} photo - Koordinaten des aktiven Fotos
     */
    setActiveMarker(activeIndex, photo) {
        this._markers.forEach((marker, index) => {
            if (!marker) return;
            marker.setStyle(
                index === activeIndex ? this._styles.active : this._styles.inactive
            );
            if (index === activeIndex && marker.bringToFront) {
                marker.bringToFront();
            }
        });

        const targetMarker = this._markers[activeIndex];
        if (!targetMarker) return;

        if (this._clusterGroup) {
            this._clusterGroup.zoomToShowLayer(targetMarker, () => {});
        } else if (photo?.lat != null && photo?.lon != null) {
            this._map.flyTo(
                [photo.lat, photo.lon],
                10,
                { animate: true, duration: this._flyDuration }
            );
        }
    }

    // -------------------------------------------------------------------------
    // Fix-Marker (GPS nachträglich setzen)
    // -------------------------------------------------------------------------

    /**
     * Setzt oder verschiebt den draggbaren Fix-Marker auf der Karte.
     * @param {number} lat
     * @param {number} lon
     */
    setFixMarker(lat, lon) {
        if (this._fixMarker) {
            this._fixMarker.setLatLng([lat, lon]);
        } else {
            this._fixMarker = L.marker([lat, lon], {
                draggable: true,
                autoPan: true
            }).addTo(this._map);
        }
        this._map.panTo([lat, lon]);
    }

    /**
     * Entfernt den Fix-Marker von der Karte.
     */
    removeFixMarker() {
        if (this._fixMarker) {
            this._map.removeLayer(this._fixMarker);
            this._fixMarker = null;
        }
    }

    /**
     * Gibt die aktuelle Position des Fix-Markers zurück.
     * @returns {{lat: number, lon: number}|null}
     */
    getFixMarkerLatLng() {
        if (!this._fixMarker) return null;
        const ll = this._fixMarker.getLatLng();
        return { lat: ll.lat, lon: ll.lng };
    }

    /**
     * Gibt zurück, ob momentan ein Fix-Marker auf der Karte liegt.
     * @returns {boolean}
     */
    hasFixMarker() {
        return this._fixMarker !== null;
    }

    // -------------------------------------------------------------------------
    // Hilfsmethoden
    // -------------------------------------------------------------------------

    /**
     * Gibt das aktuelle Kartenzentrum zurück.
     * @returns {{lat: number, lon: number}}
     */
    getCenter() {
        const c = this._map.getCenter();
        return { lat: c.lat, lon: c.lng };
    }

    // Interne Hilfsmethode: entfernt alle gerenderten Foto-Marker
    _clearPhotos() {
        if (this._clusterGroup) {
            this._map.removeLayer(this._clusterGroup);
            this._clusterGroup = null;
        }
        this._markers = [];
    }
}

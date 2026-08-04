import { encodeFilenamePath } from './filename-utils.js';

const MAPTILER_KEY = document.body.dataset.maptilerKey || '';
const MAPTILER_STYLE_URL = MAPTILER_KEY
    ? `https://api.maptiler.com/maps/outdoor-v2/style.json?key=${MAPTILER_KEY}`
    : null;

const OSM_STYLE = {
    version: 8,
    sources: {
        osm: {
            type: 'raster',
            tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
            tileSize: 256,
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        }
    },
    layers: [{ id: 'osm-tiles', type: 'raster', source: 'osm' }]
};

async function resolveStyle() {
    if (!MAPTILER_STYLE_URL) return OSM_STYLE;
    try {
        const res = await fetch(MAPTILER_STYLE_URL, { method: 'HEAD' });
        return res.ok ? MAPTILER_STYLE_URL : OSM_STYLE;
    } catch (_) {
        return OSM_STYLE;
    }
}

export class MapController {

    constructor(mapElement, options = {}) {
        this._photos        = [];
        this._routes        = [];
        this._activeIndex   = -1;
        this._fixMarker     = null;
        this._mapReady      = false;
        this._clickConsumed = false;
        this._spinFrame          = null;
        this._isFlying           = false;
        this._spinOnNextMoveEnd  = false;
        this._initialCenter = [options.center?.[1] ?? 10, options.center?.[0] ?? 50];
        this._initialZoom   = options.zoom ?? 6;
        this._resizeHandler = () => this._map?.resize();

        // Foto-Pins (rundes Thumbnail statt Punkt, wie bei Polarsteps) - nur fuer
        // aktuell unclusterte Punkte. Key = Foto-Index, siehe _syncPhotoMarkers.
        this._token = options.token ?? null;
        this._photoMarkers = new Map();
        this._clusterMarkers = new Map();

        resolveStyle().then(style => this._initMap(mapElement, style));
    }

    get _isMobile() {
        return window.innerWidth <= 768;
    }

    _initMap(mapElement, style) {
        const usingMaptiler = style === MAPTILER_STYLE_URL;

        this._map = new maplibregl.Map({
            container: mapElement,
            style,
            center: this._initialCenter,
            zoom: this._initialZoom,
            pitch: usingMaptiler ? 60 : 0,
            bearing: 0,
            attributionControl: true,
            trackResize: false
        });

        window.addEventListener('resize', this._resizeHandler);
        this._map.addControl(new maplibregl.NavigationControl(), 'bottom-right');

        this._map.on('load', () => {
            this._map.resize();

            if (usingMaptiler) {
                this._setupTerrain();
                this._setupBuildings();
            }

            this._setupSources();
            this._setupLayers();
            this._setupEvents();
            this._mapReady = true;
            this._updateSources();

            if (this._activeIndex >= 0) {
                const photo = this._photos[this._activeIndex];
                if (photo?.lat && photo?.lon) {
                    this._map.jumpTo({
                        center: [photo.lon, photo.lat],
                        zoom: 15,
                        pitch: this._isMobile ? 30 : 50,
                        bearing: 0
                    });
                }
            }
        });

        this._map.on('error', () => {});

        // Standard-Muster fuer HTML-Marker auf geclusterten GeoJSON-Punkten: es gibt
        // keinen Event, der genau dann feuert, wenn sich die unclusterten Punkte
        // aendern (Zoom/Pan/Cluster-Auf-oder-Zuklappen), daher bei jedem Render-Tick
        // abgleichen (guard via isSourceLoaded haelt das im Leerlauf billig).
        this._map.on('render', () => {
            this._syncPhotoMarkers();
            this._syncClusterMarkers();
        });

        this._map.on('click', (e) => {
            if (!this._clickConsumed) {
                this._onMapClick?.(e.lngLat.lat, e.lngLat.lng);
            }
            this._clickConsumed = false;
        });

    }

    _setupTerrain() {
        const sources = this._map.getStyle().sources;
        const demId = Object.keys(sources).find(id => sources[id].type === 'raster-dem');
        if (!demId) return;

        const demSrc = sources[demId];
        this._map.addSource('terrain-dem', {
            type: 'raster-dem',
            url: demSrc.url,
            tileSize: demSrc.tileSize ?? 256
        });
        this._map.setTerrain({ source: 'terrain-dem', exaggeration: 1.5 });
    }

    _setupBuildings() {
        const buildingColor = [
            'interpolate', ['linear'],
            ['coalesce', ['get', 'render_height'], ['get', 'height'], 0],
            0,   '#2d3a4a',
            50,  '#3d5a7a',
            150, '#5b8fa8',
            300, '#89c4d9'
        ];

        // An die Karte gebundenes Licht statt ans Viewport, damit Gebäude beim
        // Kamera-Spin (_startSpin) je nach Ausrichtung zur "Sonne" unterschiedlich
        // beschattet wirken statt flach/künstlich auszusehen.
        this._map.setLight({
            anchor: 'map',
            color: '#fff6e8',
            intensity: 0.6,
            position: [1.15, 210, 40]
        });

        const styleLayers = this._map.getStyle().layers;
        const existingExtrusions = styleLayers.filter(l => l.type === 'fill-extrusion');

        if (existingExtrusions.length > 0) {
            existingExtrusions.forEach(l => {
                this._map.setLayoutProperty(l.id, 'visibility', 'visible');
                if ((l.minzoom ?? 0) > 13) this._map.setLayerZoomRange(l.id, 13, l.maxzoom ?? 24);
                this._map.setPaintProperty(l.id, 'fill-extrusion-color', buildingColor);
                this._map.setPaintProperty(l.id, 'fill-extrusion-opacity', 0.95);
                this._map.setPaintProperty(l.id, 'fill-extrusion-vertical-gradient', true);
            });
            return;
        }

        const sources = this._map.getStyle().sources;
        const vectorId = ['maptiler_planet', 'openmaptiles', 'outdoor']
            .find(id => sources[id]?.type === 'vector');
        if (!vectorId) return;

        try {
            this._map.addLayer({
                id: 'buildings-3d',
                type: 'fill-extrusion',
                source: vectorId,
                'source-layer': 'building',
                minzoom: 15,
                paint: {
                    'fill-extrusion-color': buildingColor,
                    'fill-extrusion-height': ['coalesce', ['get', 'render_height'], ['get', 'height'], 5],
                    'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], ['get', 'min_height'], 0],
                    'fill-extrusion-opacity': 0.95,
                    'fill-extrusion-vertical-gradient': true
                }
            });
        } catch (_) {}
    }

    _setupSources() {
        if (!this._map.getSource('photos')) {
            this._map.addSource('photos', {
                type: 'geojson',
                data: { type: 'FeatureCollection', features: [] },
                cluster: true,
                clusterMaxZoom: 13,
                clusterRadius: 50
            });
        }
        if (!this._map.getSource('route')) {
            this._map.addSource('route', {
                type: 'geojson',
                data: { type: 'FeatureCollection', features: [] }
            });
        }
    }

    _setupLayers() {
        if (!this._map.getLayer('route-line')) {
            this._map.addLayer({
                id: 'route-line',
                type: 'line',
                source: 'route',
                paint: {
                    'line-color': '#f97316',
                    'line-width': 4,
                    'line-opacity': 0.95
                }
            });
        }
        if (!this._map.getLayer('clusters')) {
            // Unsichtbar, wie 'unclustered-point' - dient nur als Quelle fuer
            // queryRenderedFeatures in _syncClusterMarkers. Die eigentliche Darstellung
            // ist ein HTML-Marker mit Foto + Zaehl-Badge (siehe dort).
            this._map.addLayer({
                id: 'clusters',
                type: 'circle',
                source: 'photos',
                filter: ['has', 'point_count'],
                paint: {
                    'circle-radius': ['step', ['get', 'point_count'], 15, 10, 20, 50, 25],
                    'circle-opacity': 0
                }
            });
        }
        if (!this._map.getLayer('unclustered-point')) {
            // Unsichtbar - dient nur noch als Quelle fuer queryRenderedFeatures in
            // _syncPhotoMarkers, die eigentliche Foto-Pin-Darstellung sind HTML-Marker
            // mit rundem Thumbnail (siehe dort). Ohne diese Ebene gaebe es keine
            // Moeglichkeit, "welche Punkte sind beim aktuellen Zoom nicht geclustert"
            // abzufragen.
            this._map.addLayer({
                id: 'unclustered-point',
                type: 'circle',
                source: 'photos',
                filter: ['!', ['has', 'point_count']],
                paint: {
                    'circle-radius': 6,
                    'circle-opacity': 0
                }
            });
        }
    }

    _setupEvents() {
        // Cluster-Klicks werden ueber den DOM-Marker selbst gehandhabt (siehe
        // _syncClusterMarkers), nicht mehr ueber die (jetzt unsichtbare) GL-Ebene.
    }

    async _expandCluster(clusterId, center) {
        try {
            const zoom = await this._map.getSource('photos').getClusterExpansionZoom(clusterId);
            this._map.easeTo({ center, zoom });
        } catch (_) {}
    }

    _buildPhotosGeoJSON() {
        return {
            type: 'FeatureCollection',
            features: this._photos.flatMap((p, i) => {
                if (p.lat == null || p.lon == null) return [];
                return [{
                    type: 'Feature',
                    geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
                    properties: { index: i, active: i === this._activeIndex }
                }];
            })
        };
    }

    _buildRouteGeoJSON() {
        const features = [];

        if (this._routes.length > 0) {
            for (const geometry of this._routes) {
                if (geometry) {
                    features.push({ type: 'Feature', geometry, properties: {} });
                }
            }
        } else {
            const coords = this._photos
                .filter(p => p.lat != null && p.lon != null)
                .map(p => [p.lon, p.lat]);
            if (coords.length > 1) {
                features.push({
                    type: 'Feature',
                    geometry: { type: 'LineString', coordinates: coords },
                    properties: {}
                });
            }
        }

        return { type: 'FeatureCollection', features };
    }

    _updateSources() {
        this._map.getSource('photos')?.setData(this._buildPhotosGeoJSON());
        this._map.getSource('route')?.setData(this._buildRouteGeoJSON());
    }

    /**
     * Haelt die HTML-Foto-Marker synchron zu den Punkten, die die unsichtbare
     * 'unclustered-point'-Ebene beim aktuellen Zoom/Ausschnitt tatsaechlich rendert.
     * Cluster-Punkte selbst werden von _syncClusterMarkers behandelt.
     */
    _syncPhotoMarkers() {
        if (!this._mapReady || !this._map.isSourceLoaded('photos')) return;

        const features = this._map.queryRenderedFeatures(undefined, { layers: ['unclustered-point'] });
        const visibleIndices = new Set(features.map(f => f.properties.index));

        for (const [index, marker] of this._photoMarkers) {
            if (!visibleIndices.has(index)) {
                marker.remove();
                this._photoMarkers.delete(index);
            }
        }

        for (const feature of features) {
            const index = feature.properties.index;
            if (this._photoMarkers.has(index)) continue;

            const photo = this._photos[index];
            if (!photo) continue;

            const el = document.createElement('div');
            el.className = 'photo-marker';
            if (index === this._activeIndex) el.classList.add('active');

            const img = document.createElement('img');
            img.src = `/api/thumb/${encodeFilenamePath(photo.filename)}?token=${this._token ?? ''}&size=blur`;
            img.loading = 'lazy';
            img.alt = '';
            // Faellt ein Thumbnail aus (z.B. geloeschtes Foto), soll die
            // Hintergrundfarbe des Pins durchscheinen statt eines kaputten Bild-Icons.
            img.addEventListener('error', () => { img.style.display = 'none'; });
            el.appendChild(img);

            el.addEventListener('click', () => {
                this._spinOnNextMoveEnd = true;
                this._onMarkerClick?.(index);
            });

            const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
                .setLngLat(feature.geometry.coordinates)
                .addTo(this._map);

            this._photoMarkers.set(index, marker);
        }
    }

    /**
     * Analog zu _syncPhotoMarkers, aber fuer Cluster-Punkte: zeigt ein Vorschaubild
     * eines der zusammengefassten Fotos plus ein Zaehl-Badge statt eines nackten
     * Nummern-Kreises. Das Vorschaubild kommt asynchron ueber getClusterLeaves,
     * der Pin erscheint aber sofort (mit Fallback-Hintergrund) und wird nachtraeglich
     * befuellt, damit Zoomen/Schwenken nicht auf jeden Cluster-Request warten muss.
     */
    _syncClusterMarkers() {
        if (!this._mapReady || !this._map.isSourceLoaded('photos')) return;

        const features = this._map.queryRenderedFeatures(undefined, { layers: ['clusters'] });
        const visibleIds = new Set(features.map(f => f.properties.cluster_id));

        for (const [clusterId, marker] of this._clusterMarkers) {
            if (!visibleIds.has(clusterId)) {
                marker.remove();
                this._clusterMarkers.delete(clusterId);
            }
        }

        for (const feature of features) {
            const clusterId = feature.properties.cluster_id;
            if (this._clusterMarkers.has(clusterId)) continue;

            const count = feature.properties.point_count_abbreviated ?? feature.properties.point_count;

            const el = document.createElement('div');
            el.className = 'photo-marker cluster-marker';

            const img = document.createElement('img');
            img.loading = 'lazy';
            img.alt = '';
            img.addEventListener('error', () => { img.style.display = 'none'; });
            el.appendChild(img);

            const badge = document.createElement('span');
            badge.className = 'cluster-badge';
            badge.textContent = String(count);
            el.appendChild(badge);

            const coordinates = feature.geometry.coordinates.slice();
            el.addEventListener('click', () => this._expandCluster(clusterId, coordinates));

            const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
                .setLngLat(coordinates)
                .addTo(this._map);

            this._clusterMarkers.set(clusterId, marker);

            this._map.getSource('photos').getClusterLeaves(clusterId, 1, 0).then(leaves => {
                if (!leaves?.length) return;
                // Zwischenzeitlich neu gezoomt/verschoben? Dann gehoert diese ID
                // inzwischen ggf. zu einem komplett anderen Cluster - nicht mehr
                // in den (ausgetauschten) Marker schreiben.
                if (this._clusterMarkers.get(clusterId) !== marker) return;

                const leafPhoto = this._photos[leaves[0].properties.index];
                if (leafPhoto) {
                    img.src = `/api/thumb/${encodeFilenamePath(leafPhoto.filename)}?token=${this._token ?? ''}&size=blur`;
                }
            }).catch(() => {});
        }
    }

    _startSpin() {
        const degreesPerFrame = 0.3;
        let rotated = 0;

        const cancel = () => this._cancelSpin();
        this._map.once('dragstart', cancel);
        this._map.once('zoomstart', cancel);

        const spin = () => {
            if (rotated >= 360) {
                this._map.setBearing(0);
                this._map.off('dragstart', cancel);
                this._map.off('zoomstart', cancel);
                this._spinFrame = null;
                return;
            }
            this._map.setBearing(rotated);
            rotated += degreesPerFrame;
            this._spinFrame = requestAnimationFrame(spin);
        };

        this._spinFrame = requestAnimationFrame(spin);
    }

    _cancelSpin() {
        if (this._spinFrame !== null) {
            cancelAnimationFrame(this._spinFrame);
            this._spinFrame = null;
        }
        this._isFlying = false;
    }

    set onMarkerClick(fn) { this._onMarkerClick = fn; }
    set onMapClick(fn)    { this._onMapClick    = fn; }

    renderPhotos(photos, routes) {
        this._photos = photos;
        if (routes !== undefined) this._routes = routes;
        if (this._mapReady) this._updateSources();
    }

    setActiveMarker(activeIndex, photo) {
        this._activeIndex = activeIndex;
        if (this._mapReady) this._updateSources();
        for (const [index, marker] of this._photoMarkers) {
            marker.getElement().classList.toggle('active', index === activeIndex);
        }
        if (!photo?.lat || !photo?.lon || !this._map) return;

        this._cancelSpin();
        this._isFlying = true;

        this._map.flyTo({
            center: [photo.lon, photo.lat],
            zoom: 15,
            pitch: this._isMobile ? 30 : 50,
            bearing: 0,
            curve: 2.5,
            speed: 0.6,
            essential: true
        });

        this._map.once('moveend', () => {
            if (!this._isFlying) return;
            this._isFlying = false;
            if (this._spinOnNextMoveEnd) {
                this._spinOnNextMoveEnd = false;
                this._startSpin();
            }
        });
    }

    setFixMarker(lat, lon) {
        if (!this._map) return;
        if (this._fixMarker) {
            this._fixMarker.setLngLat([lon, lat]);
        } else {
            this._fixMarker = new maplibregl.Marker({ draggable: true, color: '#ef4444' })
                .setLngLat([lon, lat])
                .addTo(this._map);
        }
        this._map.panTo([lon, lat]);
    }

    removeFixMarker() {
        if (this._fixMarker) {
            this._fixMarker.remove();
            this._fixMarker = null;
        }
    }

    getFixMarkerLatLng() {
        if (!this._fixMarker) return null;
        const ll = this._fixMarker.getLngLat();
        return { lat: ll.lat, lon: ll.lng };
    }

    hasFixMarker() {
        return this._fixMarker !== null;
    }

    getCenter() {
        if (!this._map) return { lat: 0, lon: 0 };
        const c = this._map.getCenter();
        return { lat: c.lat, lon: c.lng };
    }
}


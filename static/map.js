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

        const styleLayers = this._map.getStyle().layers;
        const existingExtrusions = styleLayers.filter(l => l.type === 'fill-extrusion');

        if (existingExtrusions.length > 0) {
            existingExtrusions.forEach(l => {
                this._map.setLayoutProperty(l.id, 'visibility', 'visible');
                if ((l.minzoom ?? 0) > 13) this._map.setLayerZoomRange(l.id, 13, l.maxzoom ?? 24);
                this._map.setPaintProperty(l.id, 'fill-extrusion-color', buildingColor);
                this._map.setPaintProperty(l.id, 'fill-extrusion-opacity', 0.95);
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
                    'fill-extrusion-opacity': 0.95
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
            this._map.addLayer({
                id: 'clusters',
                type: 'circle',
                source: 'photos',
                filter: ['has', 'point_count'],
                paint: {
                    'circle-color': '#f97316',
                    'circle-radius': ['step', ['get', 'point_count'], 15, 10, 20, 50, 25],
                    'circle-opacity': 0.85,
                    'circle-stroke-width': 2,
                    'circle-stroke-color': '#fff'
                }
            });
        }
        if (!this._map.getLayer('cluster-count')) {
            this._map.addLayer({
                id: 'cluster-count',
                type: 'symbol',
                source: 'photos',
                filter: ['has', 'point_count'],
                layout: {
                    'text-field': '{point_count_abbreviated}',
                    'text-size': 12,
                    'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold']
                },
                paint: { 'text-color': '#ffffff' }
            });
        }
        if (!this._map.getLayer('unclustered-point')) {
            this._map.addLayer({
                id: 'unclustered-point',
                type: 'circle',
                source: 'photos',
                filter: ['!', ['has', 'point_count']],
                paint: {
                    'circle-color': '#f97316',
                    'circle-radius': ['case', ['==', ['get', 'active'], true], 10, 6],
                    'circle-opacity': ['case', ['==', ['get', 'active'], true], 1, 0.6],
                    'circle-stroke-width': ['case', ['==', ['get', 'active'], true], 4, 1],
                    'circle-stroke-color': '#ffffff'
                }
            });
        }
    }

    _setupEvents() {
        this._map.on('click', 'unclustered-point', (e) => {
            this._clickConsumed = true;
            this._spinOnNextMoveEnd = true;
            this._onMarkerClick?.(e.features[0].properties.index);
        });

        this._map.on('click', 'clusters', async (e) => {
            this._clickConsumed = true;
            const clusterId = Number(e.features[0].properties.cluster_id);
            const center = e.features[0].geometry.coordinates.slice();
            try {
                const zoom = await this._map.getSource('photos').getClusterExpansionZoom(clusterId);
                this._map.easeTo({ center, zoom });
            } catch (_) {}
        });

        this._map.on('mouseenter', 'unclustered-point', () => { this._map.getCanvas().style.cursor = 'pointer'; });
        this._map.on('mouseleave', 'unclustered-point', () => { this._map.getCanvas().style.cursor = ''; });
        this._map.on('mouseenter', 'clusters',           () => { this._map.getCanvas().style.cursor = 'pointer'; });
        this._map.on('mouseleave', 'clusters',           () => { this._map.getCanvas().style.cursor = ''; });
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

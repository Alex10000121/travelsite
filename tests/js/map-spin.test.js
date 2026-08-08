import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MapController } from '../../static/map.js';

/** Minimaler MapLibre-Ersatz mit echter Listener-Verwaltung, damit once/off-Semantik
 *  im Test genauso greift wie in der Bibliothek. */
class FakeMap {
    constructor() {
        this._handlers = new Map();
        this.bearing = 0;
        this.flyToCalls = [];
    }

    _add(event, fn, once) {
        if (!this._handlers.has(event)) this._handlers.set(event, []);
        this._handlers.get(event).push({ fn, once });
    }

    // MapLibre erlaubt on(event, fn) genauso wie on(event, layerId, fn).
    on(event, a, b)   { this._add(event, b ?? a, false); }
    once(event, a, b) { this._add(event, b ?? a, true); }

    off(event, a, b) {
        const fn = b ?? a;
        const list = this._handlers.get(event);
        if (!list) return;
        const index = list.findIndex(h => h.fn === fn);
        if (index !== -1) list.splice(index, 1);
    }

    fire(event) {
        for (const handler of (this._handlers.get(event) || []).slice()) {
            if (handler.once) this.off(event, handler.fn);
            handler.fn();
        }
    }

    listenerCount(event) { return (this._handlers.get(event) || []).length; }

    addControl() {}
    resize() {}
    jumpTo() {}
    setBearing(value) { this.bearing = value; }
    flyTo(options) { this.flyToCalls.push(options); }
}

let pendingFrame = null;

function runFrames(limit = 3000) {
    let frames = 0;
    while (pendingFrame && frames < limit) {
        const frame = pendingFrame;
        pendingFrame = null;
        frame();
        frames++;
    }
    return frames;
}

async function makeController() {
    const element = document.createElement('div');
    document.body.appendChild(element);
    const controller = new MapController(element);
    // resolveStyle() ist async - _initMap laeuft erst nach dem Microtask-Durchlauf.
    await new Promise(resolve => setTimeout(resolve, 0));
    return controller;
}

const PHOTO_A = { lat: 48.1, lon: 11.5 };
const PHOTO_B = { lat: 52.5, lon: 13.4 };

beforeEach(() => {
    vi.stubGlobal('maplibregl', { Map: FakeMap, NavigationControl: class {}, Marker: class {} });
    pendingFrame = null;
    vi.stubGlobal('requestAnimationFrame', (cb) => { pendingFrame = cb; return 42; });
    vi.stubGlobal('cancelAnimationFrame', () => { pendingFrame = null; });
});

afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
});

describe('Kamera-Spin', () => {
    it('registriert Abbruch-Listener fuer Drag und Zoom', async () => {
        const controller = await makeController();
        const map = controller._map;

        controller._startSpin();

        expect(map.listenerCount('dragstart')).toBe(1);
        expect(map.listenerCount('zoomstart')).toBe(1);
    });

    it('entfernt die Abbruch-Listener beim Abbrechen', async () => {
        const controller = await makeController();
        const map = controller._map;

        controller._startSpin();
        controller._cancelSpin();

        expect(map.listenerCount('dragstart')).toBe(0);
        expect(map.listenerCount('zoomstart')).toBe(0);
        expect(controller._spinFrame).toBeNull();
    });

    it('entfernt die Abbruch-Listener nach einer vollen Umdrehung', async () => {
        const controller = await makeController();
        const map = controller._map;

        controller._startSpin();
        runFrames();

        expect(map.bearing).toBe(0);
        expect(map.listenerCount('dragstart')).toBe(0);
        expect(map.listenerCount('zoomstart')).toBe(0);
    });

    it('sammelt ueber mehrere abgebrochene Spins keine Listener an', async () => {
        const controller = await makeController();
        const map = controller._map;

        for (let i = 0; i < 5; i++) {
            controller._startSpin();
            controller._cancelSpin();
        }

        expect(map.listenerCount('dragstart')).toBe(0);
        expect(map.listenerCount('zoomstart')).toBe(0);
    });

    it('dreht auch den naechsten Marker, wenn der vorherige Spin noch laeuft', async () => {
        const controller = await makeController();
        const map = controller._map;

        controller._spinOnNextMoveEnd = true;
        controller.setActiveMarker(0, PHOTO_A);
        map.fire('moveend');
        expect(controller._spinFrame).not.toBeNull();

        controller._spinOnNextMoveEnd = true;
        controller.setActiveMarker(1, PHOTO_B);

        // flyTo loest in MapLibre ein zoomstart aus. Blieben die Abbruch-Listener des
        // ersten Spins registriert, wuerden sie hier _isFlying zuruecksetzen und der
        // Spin fuer den zweiten Marker fiele stillschweigend aus.
        map.fire('zoomstart');
        expect(controller._isFlying).toBe(true);

        map.fire('moveend');
        expect(controller._spinFrame).not.toBeNull();
        expect(controller._spinOnNextMoveEnd).toBe(false);
    });

    it('bricht den laufenden Spin bei echter Nutzerinteraktion ab', async () => {
        const controller = await makeController();
        const map = controller._map;

        controller._startSpin();
        map.fire('dragstart');

        expect(controller._spinFrame).toBeNull();
        expect(map.listenerCount('zoomstart')).toBe(0);
    });
});

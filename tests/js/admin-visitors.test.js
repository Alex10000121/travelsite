import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../static/api.js', () => ({
    fetchVisitorStats: vi.fn(),
}));

import {
    buildChartPoints,
    buildChartPaths,
    nearestPointIndex,
    AdminVisitorStats,
} from '../../static/admin-visitors.js';
import { fetchVisitorStats } from '../../static/api.js';

const DAILY = [
    { date: '2026-07-01', count: 2 },
    { date: '2026-07-02', count: 0 },
    { date: '2026-07-03', count: 10 },
];

describe('buildChartPoints', () => {
    const points = buildChartPoints(DAILY, 100, 50, 0);

    it('spreizt die Punkte gleichmäßig über die Breite', () => {
        expect(points).toHaveLength(3);
        expect(points[0].x).toBe(0);
        expect(points[1].x).toBe(50);
        expect(points[2].x).toBe(100);
    });

    it('setzt den höchsten Wert auf die oberste Position (kleinstes y)', () => {
        const maxPoint = points.find(p => p.count === 10);
        expect(maxPoint.y).toBe(0);
    });

    it('setzt einen Nullwert auf die Grundlinie', () => {
        const zeroPoint = points.find(p => p.count === 0);
        expect(zeroPoint.y).toBe(50);
    });

    it('gibt eine leere Liste für leere Daten zurück', () => {
        expect(buildChartPoints([], 100, 50)).toEqual([]);
    });

    it('platziert einen einzigen Punkt in der horizontalen Mitte', () => {
        const singlePoint = buildChartPoints([{ date: '2026-07-01', count: 5 }], 100, 50, 0);
        expect(singlePoint[0].x).toBe(50);
    });

    it('teilt nicht durch 0 wenn alle Zählwerte 0 sind', () => {
        const zeroPoints = buildChartPoints(
            [{ date: 'a', count: 0 }, { date: 'b', count: 0 }], 100, 50, 0
        );
        expect(zeroPoints.every(p => Number.isFinite(p.y))).toBe(true);
    });
});

describe('buildChartPaths', () => {
    const points = buildChartPoints(DAILY, 100, 50, 0);

    it('beginnt den Linienpfad mit M und den Rest mit L', () => {
        const { line } = buildChartPaths(points, 50);
        expect(line.startsWith('M')).toBe(true);
        expect(line.match(/L/g)).toHaveLength(2);
    });

    it('schließt den Flächenpfad an der Grundlinie unter erstem und letztem Punkt', () => {
        const { area } = buildChartPaths(points, 50);
        expect(area.endsWith('Z')).toBe(true);
        expect(area).toContain('L100.00,50');
        expect(area).toContain('L0.00,50');
    });

    it('gibt leere Pfade für leere Punktliste zurück', () => {
        expect(buildChartPaths([], 50)).toEqual({ line: '', area: '' });
    });
});

describe('nearestPointIndex', () => {
    const points = buildChartPoints(DAILY, 100, 50, 0);

    it('findet den exakt getroffenen Punkt', () => {
        expect(nearestPointIndex(points, 50)).toBe(1);
    });

    it('findet den nächstgelegenen Punkt bei einem Wert dazwischen', () => {
        expect(nearestPointIndex(points, 40)).toBe(1);
        expect(nearestPointIndex(points, 10)).toBe(0);
    });

    it('gibt -1 für eine leere Punktliste zurück', () => {
        expect(nearestPointIndex([], 10)).toBe(-1);
    });
});

function makeDom() {
    return {
        totalEl:        document.createElement('span'),
        activeEl:       document.createElement('span'),
        chartContainer: document.createElement('div'),
        yAxis:          document.createElement('div'),
        xAxis:          document.createElement('div'),
        tooltip:        document.createElement('div'),
    };
}

async function loadVisitorStats(response) {
    fetchVisitorStats.mockResolvedValue(response);
    const dom = makeDom();
    const stats = new AdminVisitorStats(dom);
    await stats.load();
    return { dom, stats };
}

describe('AdminVisitorStats', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('alert', vi.fn());
    });

    it('rendert Gesamt- und Live-Zahl in die Stat-Felder', async () => {
        const { dom } = await loadVisitorStats({ total: 42, active_now: 3, daily: DAILY });

        expect(dom.totalEl.textContent).toBe('42');
        expect(dom.activeEl.textContent).toBe('3');
    });

    it('hängt ein SVG mit Linie und Fläche in den Chart-Container', async () => {
        const { dom } = await loadVisitorStats({ total: 42, active_now: 3, daily: DAILY });

        expect(dom.chartContainer.querySelector('.visitor-chart-line')).not.toBeNull();
        expect(dom.chartContainer.querySelector('.visitor-chart-area')).not.toBeNull();
    });

    it('beschriftet die Y-Achse mit Maximum, Hälfte und 0', async () => {
        const { dom } = await loadVisitorStats({ total: 42, active_now: 3, daily: DAILY });

        const labels = [...dom.yAxis.children].map(el => el.textContent);
        expect(labels).toEqual(['10', '5', '0']);
    });

    it('beschriftet die X-Achse mit Datumsangaben aus den Tagesdaten', async () => {
        const { dom } = await loadVisitorStats({ total: 42, active_now: 3, daily: DAILY });

        const labels = [...dom.xAxis.children].map(el => el.textContent);
        expect(labels).toEqual(['01.07.', '02.07.', '03.07.']);
    });

    it('begrenzt die X-Achsen-Beschriftung auf maximal 5 Labels bei vielen Tagen', async () => {
        const daily = Array.from({ length: 30 }, (_, i) => ({
            date: `2026-07-${String(i + 1).padStart(2, '0')}`,
            count: i,
        }));
        const { dom } = await loadVisitorStats({ total: 1, active_now: 0, daily });

        expect(dom.xAxis.children).toHaveLength(5);
    });

    it('zeigt einen Alert, wenn das Laden fehlschlägt', async () => {
        fetchVisitorStats.mockRejectedValue(new Error('Netzwerkfehler'));
        const stats = new AdminVisitorStats(makeDom());
        await stats.load();

        expect(alert).toHaveBeenCalledWith('Netzwerkfehler');
    });

    it('lässt Chart-Container und Achsen leer, wenn keine Tagesdaten vorliegen', async () => {
        const { dom } = await loadVisitorStats({ total: 0, active_now: 0, daily: [] });

        expect(dom.chartContainer.querySelector('svg')).toBeNull();
        expect(dom.yAxis.children).toHaveLength(0);
        expect(dom.xAxis.children).toHaveLength(0);
    });
});

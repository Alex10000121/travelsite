// Besucher-Feature der /admin-Seite: Gesamt-/Live-Zahlen und ein
// Liniendiagramm der letzten 30 Tage (reines SVG, keine Chart-Bibliothek).

import { fetchVisitorStats } from './api.js';
import { tryOrAlert } from './dom-utils.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const CHART_WIDTH = 600;
const CHART_HEIGHT = 160;
const CHART_PADDING_TOP = 16;

/**
 * Wandelt die Tages-Zählwerte in SVG-Koordinaten um (reine Funktion, kein DOM).
 * @param {Array<{date: string, count: number}>} daily
 * @param {number} width
 * @param {number} height
 * @param {number} paddingTop
 * @returns {Array<{x: number, y: number, date: string, count: number}>}
 */
export function buildChartPoints(daily, width = CHART_WIDTH, height = CHART_HEIGHT, paddingTop = CHART_PADDING_TOP) {
    const n = daily.length;
    if (n === 0) return [];

    const maxCount = Math.max(1, ...daily.map(d => d.count));
    const usableHeight = height - paddingTop;

    return daily.map((d, i) => ({
        x: n > 1 ? (i / (n - 1)) * width : width / 2,
        y: paddingTop + usableHeight * (1 - d.count / maxCount),
        date: d.date,
        count: d.count,
    }));
}

/**
 * Baut die Linien- und Flächen-Pfade aus den Punkten (reine Funktion).
 * @param {Array<{x: number, y: number}>} points
 * @param {number} height
 * @returns {{line: string, area: string}}
 */
export function buildChartPaths(points, height = CHART_HEIGHT) {
    if (points.length === 0) return { line: '', area: '' };

    const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
    const first = points[0];
    const last = points[points.length - 1];
    const area = `${line} L${last.x.toFixed(2)},${height} L${first.x.toFixed(2)},${height} Z`;

    return { line, area };
}

/**
 * Findet den Punkt, dessen X-Koordinate dem Zeiger am nächsten liegt.
 * @param {Array<{x: number}>} points
 * @param {number} pointerX
 * @returns {number} Index in points, oder -1 wenn points leer ist
 */
export function nearestPointIndex(points, pointerX) {
    if (points.length === 0) return -1;

    let closest = 0;
    let closestDist = Math.abs(points[0].x - pointerX);
    for (let i = 1; i < points.length; i++) {
        const dist = Math.abs(points[i].x - pointerX);
        if (dist < closestDist) {
            closestDist = dist;
            closest = i;
        }
    }
    return closest;
}

/** Formatiert ein ISO-Datum ('YYYY-MM-DD') als 'DD.MM.'. */
function formatDayLabel(isoDate) {
    const [, month, day] = isoDate.split('-');
    return `${day}.${month}.`;
}

export class AdminVisitorStats {

    /**
     * @param {object} dom
     * @param {HTMLElement} dom.totalEl
     * @param {HTMLElement} dom.activeEl
     * @param {HTMLElement} dom.chartContainer - Element, in das das SVG eingehängt wird
     * @param {HTMLElement} [dom.yAxis] - Element für die Y-Achsen-Beschriftung (Besuche)
     * @param {HTMLElement} [dom.xAxis] - Element für die X-Achsen-Beschriftung (Datum)
     * @param {HTMLElement} dom.tooltip
     */
    constructor(dom) {
        this._dom = dom;
        this._points = [];
        this.load();
    }

    async load() {
        await tryOrAlert(async () => {
            const stats = await fetchVisitorStats();
            this._render(stats);
        });
    }

    _render(stats) {
        const { totalEl, activeEl } = this._dom;
        if (totalEl) totalEl.textContent = stats.total ?? 0;
        if (activeEl) activeEl.textContent = stats.active_now ?? 0;

        const daily = stats.daily || [];
        this._points = buildChartPoints(daily);
        this._renderChart();
        this._renderYAxis(daily);
        this._renderXAxis(daily);
    }

    _renderYAxis(daily) {
        const { yAxis } = this._dom;
        if (!yAxis) return;
        yAxis.innerHTML = '';
        if (daily.length === 0) return;

        const maxCount = Math.max(1, ...daily.map(d => d.count));
        [maxCount, Math.round(maxCount / 2), 0].forEach((value) => {
            const span = document.createElement('span');
            span.textContent = String(value);
            yAxis.appendChild(span);
        });
    }

    _renderXAxis(daily) {
        const { xAxis } = this._dom;
        if (!xAxis) return;
        xAxis.innerHTML = '';
        if (daily.length === 0) return;

        const labelCount = Math.min(5, daily.length);
        const step = (daily.length - 1) / (labelCount - 1 || 1);
        for (let i = 0; i < labelCount; i++) {
            const idx = Math.round(i * step);
            const span = document.createElement('span');
            span.textContent = formatDayLabel(daily[idx].date);
            xAxis.appendChild(span);
        }
    }

    _renderChart() {
        const { chartContainer } = this._dom;
        if (!chartContainer) return;

        chartContainer.innerHTML = '';
        if (this._points.length === 0) return;

        const { line, area } = buildChartPaths(this._points, CHART_HEIGHT);

        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('viewBox', `0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`);
        svg.setAttribute('class', 'visitor-chart-svg');
        svg.setAttribute('preserveAspectRatio', 'none');

        const baseline = document.createElementNS(SVG_NS, 'line');
        baseline.setAttribute('x1', '0');
        baseline.setAttribute('y1', String(CHART_HEIGHT - 0.5));
        baseline.setAttribute('x2', String(CHART_WIDTH));
        baseline.setAttribute('y2', String(CHART_HEIGHT - 0.5));
        baseline.setAttribute('class', 'visitor-chart-baseline');
        svg.appendChild(baseline);

        const areaEl = document.createElementNS(SVG_NS, 'path');
        areaEl.setAttribute('d', area);
        areaEl.setAttribute('class', 'visitor-chart-area');
        svg.appendChild(areaEl);

        const lineEl = document.createElementNS(SVG_NS, 'path');
        lineEl.setAttribute('d', line);
        lineEl.setAttribute('class', 'visitor-chart-line');
        svg.appendChild(lineEl);

        const last = this._points[this._points.length - 1];
        const endDot = document.createElementNS(SVG_NS, 'circle');
        endDot.setAttribute('cx', String(last.x));
        endDot.setAttribute('cy', String(last.y));
        endDot.setAttribute('r', '4');
        endDot.setAttribute('class', 'visitor-chart-enddot');
        svg.appendChild(endDot);

        const crosshair = document.createElementNS(SVG_NS, 'line');
        crosshair.setAttribute('y1', '0');
        crosshair.setAttribute('y2', String(CHART_HEIGHT));
        crosshair.setAttribute('class', 'visitor-chart-crosshair');
        crosshair.style.display = 'none';
        svg.appendChild(crosshair);

        const hoverDot = document.createElementNS(SVG_NS, 'circle');
        hoverDot.setAttribute('r', '4');
        hoverDot.setAttribute('class', 'visitor-chart-hoverdot');
        hoverDot.style.display = 'none';
        svg.appendChild(hoverDot);

        const hitArea = document.createElementNS(SVG_NS, 'rect');
        hitArea.setAttribute('x', '0');
        hitArea.setAttribute('y', '0');
        hitArea.setAttribute('width', String(CHART_WIDTH));
        hitArea.setAttribute('height', String(CHART_HEIGHT));
        hitArea.setAttribute('class', 'visitor-chart-hitarea');
        svg.appendChild(hitArea);

        hitArea.addEventListener('pointermove', (e) => this._onHover(e, svg, crosshair, hoverDot));
        hitArea.addEventListener('pointerleave', () => this._onHoverEnd(crosshair, hoverDot));

        chartContainer.appendChild(svg);
    }

    _onHover(e, svg, crosshair, hoverDot) {
        const rect = svg.getBoundingClientRect();
        const scaleX = CHART_WIDTH / rect.width;
        const pointerX = (e.clientX - rect.left) * scaleX;

        const index = nearestPointIndex(this._points, pointerX);
        if (index === -1) return;
        const point = this._points[index];

        crosshair.setAttribute('x1', String(point.x));
        crosshair.setAttribute('x2', String(point.x));
        crosshair.style.display = '';

        hoverDot.setAttribute('cx', String(point.x));
        hoverDot.setAttribute('cy', String(point.y));
        hoverDot.style.display = '';

        this._showTooltip(point, rect);
    }

    _onHoverEnd(crosshair, hoverDot) {
        crosshair.style.display = 'none';
        hoverDot.style.display = 'none';
        if (this._dom.tooltip) this._dom.tooltip.style.display = 'none';
    }

    _showTooltip(point, chartRect) {
        const { tooltip } = this._dom;
        if (!tooltip) return;

        tooltip.querySelector('.visitor-tooltip-date').textContent = formatDayLabel(point.date);
        tooltip.querySelector('.visitor-tooltip-count').textContent =
            `${point.count} ${point.count === 1 ? 'Besuch' : 'Besuche'}`;

        // Position relativ zum offsetParent (dem position:relative-Wrapper, an dem das
        // Tooltip-CSS "left" tatsaechlich ausrichtet) - nicht relativ zum Chart-Container,
        // der seit der Y-Achsen-Spalte nicht mehr an dessen linker Kante beginnt.
        const wrapRect = (tooltip.offsetParent || tooltip.parentElement).getBoundingClientRect();
        const scaleX = chartRect.width / CHART_WIDTH;
        const left = chartRect.left - wrapRect.left + point.x * scaleX;

        tooltip.style.display = 'block';
        tooltip.style.left = `${left}px`;
    }
}

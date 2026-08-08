// Trip-Reel-Feature der /admin-Seite: fasst alle Fotos/Videos eines Landes serverseitig
// per ffmpeg zu einem Video zusammen (siehe /api/admin/reels* in app.py). Reels sind reiner
// Download-Output - kein Player, keine Anzeige auf der Website. Serverseitig paginiert wie
// admin-routes.js/admin-log.js, zusaetzlich Polling fuer laufende Jobs.

import { fetchReelGroups, createReel, fetchAdminReels, fetchReelStatus, deleteReel, reelDownloadUrl } from './api.js';
import { tryOrAlert, updateLoadMoreVisibility, renderInto, createButton, createSpan } from './dom-utils.js';

const STATUS_LABELS = {
    pending: 'Wartet',
    running: 'Läuft',
    done: 'Fertig',
    error: 'Fehler',
};

const REEL_POLL_INTERVAL_MS = 3000;
const DEFAULT_REEL_DURATION_SECONDS = 30;

export class AdminReelManager {

    /**
     * @param {object} dom
     * @param {HTMLSelectElement} dom.groupSelect
     * @param {HTMLInputElement} dom.durationInput - Ziel-Dauer in Sekunden
     * @param {HTMLButtonElement} dom.createBtn
     * @param {HTMLElement} dom.list        - <ul> für die Reel-Liste
     * @param {HTMLElement} dom.loadMoreBtn
     */
    constructor(dom) {
        this._dom = dom;
        this._offset = 0;
        this._total = 0;
        this._pollers = new Map();

        dom.loadMoreBtn?.addEventListener('click', () => this.load({ reset: false }));
        dom.createBtn?.addEventListener('click', () => this._handleCreate());

        this._loadGroups();
        this.load();
    }

    async _loadGroups() {
        await tryOrAlert(async () => {
            const { groups } = await fetchReelGroups();
            this._renderGroups(groups);
        });
    }

    _renderGroups(groups) {
        const { groupSelect } = this._dom;
        if (!groupSelect) return;

        groupSelect.innerHTML = '';
        groupSelect.disabled = groups.length === 0;

        if (groups.length === 0) {
            const opt = document.createElement('option');
            opt.textContent = 'Keine Fotos/Videos vorhanden';
            groupSelect.appendChild(opt);
            return;
        }

        groups.forEach((g) => {
            const opt = document.createElement('option');
            opt.value = g.group_key;
            opt.textContent = this._describeGroup(g);
            groupSelect.appendChild(opt);
        });
    }

    // Videos landen nur ueber den Watchdog-Scanner im System (kein Upload dafuer) - bei
    // den meisten Nutzern ist die Videoanzahl also immer 0. "0 Videos" staendig
    // anzuzeigen wirkt wie ein kaputtes Feature statt wie ein optionaler Hinweis.
    _describeGroup(g) {
        return g.video_count > 0
            ? `${g.group_key} (${g.photo_count} Fotos, ${g.video_count} Videos)`
            : `${g.group_key} (${g.photo_count} Fotos)`;
    }

    async _handleCreate() {
        const { groupSelect, createBtn } = this._dom;
        const groupKey = groupSelect?.value;
        if (!groupKey) return;

        createBtn.disabled = true;
        await tryOrAlert(async () => {
            await createReel(groupKey, this._readDurationSeconds());
            await this.load({ reset: true });
        });
        createBtn.disabled = false;
    }

    _readDurationSeconds() {
        const raw = Number(this._dom.durationInput?.value);
        return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_REEL_DURATION_SECONDS;
    }

    async load({ reset = true } = {}) {
        await tryOrAlert(async () => {
            const page = await fetchAdminReels({ offset: reset ? 0 : this._offset });

            this._offset = page.offset + page.reels.length;
            this._total = page.total;

            this._render(page.reels, { append: !reset });
            updateLoadMoreVisibility(this._dom.loadMoreBtn, this._offset, this._total);

            page.reels
                .filter((r) => r.status === 'pending' || r.status === 'running')
                .forEach((r) => this._pollReel(r.id));
        });
    }

    _render(reels, opts) {
        renderInto(this._dom.list, reels, (reel) => this._buildItem(reel), opts);
    }

    _buildItem(reel) {
        const li = document.createElement('li');
        li.className = 'admin-log-item';
        li.dataset.reelId = String(reel.id);

        li.append(
            createSpan('admin-log-action', reel.group_key),
            this._buildStatusBadge(reel),
            createSpan('admin-log-detail', this._describeReel(reel)),
            this._buildActions(reel),
        );
        return li;
    }

    _buildStatusBadge(reel) {
        return createSpan(`admin-reel-status status-${reel.status}`, STATUS_LABELS[reel.status] || reel.status);
    }

    _describeReel(reel) {
        if (reel.status === 'error') return reel.error_message || 'Fehler bei der Erstellung';
        if (reel.status !== 'done') return 'Wird erstellt…';

        const parts = [`${reel.photo_count ?? 0} Fotos`, `${reel.video_count ?? 0} Videos`];
        if (reel.duration_seconds) parts.push(`${Math.round(reel.duration_seconds)}s`);
        return parts.join(' · ');
    }

    _buildActions(reel) {
        const actions = document.createElement('div');
        actions.className = 'admin-reel-actions';

        if (reel.status === 'done') {
            actions.appendChild(this._buildDownloadLink(reel));
        }

        const delBtn = createButton('admin-delete-btn', '🗑');
        delBtn.title = 'Löschen';
        delBtn.setAttribute('aria-label', 'Löschen');
        delBtn.addEventListener('click', () => this._handleDelete(reel));
        actions.appendChild(delBtn);

        return actions;
    }

    _buildDownloadLink(reel) {
        const link = document.createElement('a');
        link.className = 'admin-reel-download-btn';
        link.href = reelDownloadUrl(reel.id);
        link.download = reel.filename || '';
        link.textContent = '⬇';
        link.title = 'Herunterladen';
        link.setAttribute('aria-label', 'Herunterladen');
        return link;
    }

    async _handleDelete(reel) {
        await tryOrAlert(async () => {
            await deleteReel(reel.id);
            this._stopPolling(reel.id);
            await this.load({ reset: true });
        });
    }

    _pollReel(reelId) {
        if (this._pollers.has(reelId)) return;

        const tick = async () => {
            try {
                const reel = await fetchReelStatus(reelId);
                this._replaceItem(reel);
                if (reel.status === 'done' || reel.status === 'error') {
                    this._stopPolling(reelId);
                }
            } catch (err) {
                this._stopPolling(reelId);
            }
        };
        this._pollers.set(reelId, setInterval(tick, REEL_POLL_INTERVAL_MS));
    }

    _stopPolling(reelId) {
        const intervalId = this._pollers.get(reelId);
        if (intervalId === undefined) return;
        clearInterval(intervalId);
        this._pollers.delete(reelId);
    }

    _replaceItem(reel) {
        const existing = this._dom.list?.querySelector(`[data-reel-id="${reel.id}"]`);
        if (existing) existing.replaceWith(this._buildItem(reel));
    }
}

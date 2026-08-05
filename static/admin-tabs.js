// Tab-Umschaltung der /admin-Seite: gruppiert die Admin-Karten in Bereiche
// (Fotos, Routen, Statistik) und blendet jeweils nur den aktiven Bereich ein.

export class AdminTabs {

    constructor(dom) {
        this._dom = dom;
        dom.tabButtons.forEach(btn => {
            btn.addEventListener('click', () => this.activate(btn.dataset.tab));
        });
    }

    activate(tabId) {
        const { tabButtons, panels } = this._dom;

        tabButtons.forEach(btn => {
            const active = btn.dataset.tab === tabId;
            btn.classList.toggle('active', active);
            btn.setAttribute('aria-selected', String(active));
        });

        panels.forEach(panel => {
            panel.style.display = panel.dataset.tabPanel === tabId ? '' : 'none';
        });
    }
}

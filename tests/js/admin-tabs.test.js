import { describe, it, expect } from 'vitest';

import { AdminTabs } from '../../static/admin-tabs.js';

function makeDom(tabIds = ['photos', 'routes', 'stats']) {
    const tabButtons = tabIds.map((id, i) => {
        const btn = document.createElement('button');
        btn.dataset.tab = id;
        btn.setAttribute('aria-selected', String(i === 0));
        if (i === 0) btn.classList.add('active');
        return btn;
    });
    const panels = tabIds.map((id, i) => {
        const panel = document.createElement('div');
        panel.dataset.tabPanel = id;
        if (i !== 0) panel.style.display = 'none';
        return panel;
    });
    return { tabButtons, panels };
}

function setupTabs(tabIds) {
    const dom = makeDom(tabIds);
    const tabs = new AdminTabs(dom);
    return { dom, tabs };
}

describe('AdminTabs', () => {
    it('rührt den initialen Anzeigezustand beim reinen Instanziieren nicht an', () => {
        const { dom } = setupTabs();

        expect(dom.panels[0].style.display).toBe('');
        expect(dom.panels[1].style.display).toBe('none');
    });

    it('blendet beim Klick nur das Panel des angeklickten Tabs ein', () => {
        const { dom } = setupTabs();

        dom.tabButtons[1].click();

        expect(dom.panels[0].style.display).toBe('none');
        expect(dom.panels[1].style.display).toBe('');
        expect(dom.panels[2].style.display).toBe('none');
    });

    it('markiert nur den angeklickten Tab-Button als aktiv', () => {
        const { dom } = setupTabs();

        dom.tabButtons[2].click();

        expect(dom.tabButtons[0].classList.contains('active')).toBe(false);
        expect(dom.tabButtons[1].classList.contains('active')).toBe(false);
        expect(dom.tabButtons[2].classList.contains('active')).toBe(true);
    });

    it('setzt aria-selected passend zum aktiven Tab', () => {
        const { dom } = setupTabs();

        dom.tabButtons[1].click();

        expect(dom.tabButtons[0].getAttribute('aria-selected')).toBe('false');
        expect(dom.tabButtons[1].getAttribute('aria-selected')).toBe('true');
    });

    it('activate() lässt sich auch direkt aufrufen, ohne Klick', () => {
        const { dom, tabs } = setupTabs();

        tabs.activate('stats');

        expect(dom.panels[2].style.display).toBe('');
        expect(dom.tabButtons[2].classList.contains('active')).toBe(true);
    });
});

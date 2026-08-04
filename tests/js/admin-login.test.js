import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../static/api.js', () => ({
    adminLogin: vi.fn(),
}));

import { bindAdminLoginForm } from '../../static/admin-login.js';
import { adminLogin } from '../../static/api.js';

function makeDom() {
    const form = document.createElement('form');
    const btn = document.createElement('button');
    btn.type = 'submit';
    btn.innerText = 'Anmelden';
    form.appendChild(btn);

    const passwordInput = document.createElement('input');
    const errorEl = document.createElement('p');
    errorEl.style.display = 'none';

    return { form, errorEl, passwordInput };
}

function submit(form) {
    const event = new Event('submit', { bubbles: true, cancelable: true });
    form.dispatchEvent(event);
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('location', { reload: vi.fn() });
});

describe('bindAdminLoginForm', () => {
    it('lädt die Seite bei erfolgreichem Login neu', async () => {
        adminLogin.mockResolvedValue();
        const dom = makeDom();
        bindAdminLoginForm(dom);
        dom.passwordInput.value = 'geheim';

        submit(dom.form);
        await vi.waitFor(() => expect(location.reload).toHaveBeenCalled());

        expect(adminLogin).toHaveBeenCalledWith('geheim');
    });

    it('zeigt die Fehlermeldung bei falschem Passwort und leert das Feld', async () => {
        adminLogin.mockRejectedValue(new Error('Falsches Passwort.'));
        const dom = makeDom();
        bindAdminLoginForm(dom);
        dom.passwordInput.value = 'falsch';

        submit(dom.form);
        await vi.waitFor(() => expect(dom.errorEl.style.display).toBe('block'));

        expect(dom.errorEl.textContent).toBe('Falsches Passwort.');
        expect(dom.passwordInput.value).toBe('');
        expect(location.reload).not.toHaveBeenCalled();
    });

    it('reaktiviert den Button nach einem fehlgeschlagenen Login wieder', async () => {
        adminLogin.mockRejectedValue(new Error('Falsches Passwort.'));
        const dom = makeDom();
        bindAdminLoginForm(dom);
        const btn = dom.form.querySelector('button');

        submit(dom.form);
        await vi.waitFor(() => expect(btn.disabled).toBe(false));

        expect(btn.innerText).toBe('Anmelden');
    });

    it('tut nichts, wenn kein Formular übergeben wird', () => {
        expect(() => bindAdminLoginForm({ form: null, errorEl: null, passwordInput: null })).not.toThrow();
    });
});

// Login-Formular auf /admin, solange keine Admin-Session besteht.

import { adminLogin } from './api.js';

/**
 * @param {object} dom
 * @param {HTMLFormElement}     dom.form
 * @param {HTMLElement}         dom.errorEl
 * @param {HTMLInputElement}    dom.passwordInput
 */
export function bindAdminLoginForm(dom) {
    const { form, errorEl, passwordInput } = dom;
    if (!form) return;

    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        const btn = form.querySelector('button');
        const originalText = btn.innerText;
        btn.disabled = true;
        btn.innerText = 'Prüfe...';
        if (errorEl) errorEl.style.display = 'none';

        try {
            await adminLogin(passwordInput.value);
            window.location.reload();
        } catch (err) {
            if (errorEl) {
                errorEl.textContent = err.message;
                errorEl.style.display = 'block';
            }
            passwordInput.value = '';
            passwordInput.focus();
        } finally {
            btn.disabled = false;
            btn.innerText = originalText;
        }
    });
}

bindAdminLoginForm({
    form:          document.getElementById('admin-login-form'),
    errorEl:       document.getElementById('admin-login-error'),
    passwordInput: document.getElementById('admin-password-input'),
});

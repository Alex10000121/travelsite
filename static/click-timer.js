// Unterscheidet Einzel- von Doppelklick auf einem Element (z.B. Stats-Button:
// Einzelklick öffnet die Statistik, Doppelklick öffnet den Admin-Bereich).

/**
 * @param {object} opts
 * @param {function(): void} [opts.onSingleClick]
 * @param {function(): void} [opts.onDoubleClick]
 * @param {number} [opts.delay=300] - Max. Abstand zwischen zwei Klicks in ms
 * @returns {function(): void} Click-Handler zum Registrieren via addEventListener
 */
export function createClickDispatcher({ onSingleClick, onDoubleClick, delay = 300 }) {
    let timer = null;

    return function handleClick() {
        if (timer) {
            clearTimeout(timer);
            timer = null;
            onDoubleClick?.();
        } else {
            timer = setTimeout(() => {
                timer = null;
                onSingleClick?.();
            }, delay);
        }
    };
}

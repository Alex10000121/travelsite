import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createClickDispatcher } from '../../static/click-timer.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function createDispatcher(options = {}) {
    const onSingleClick = vi.fn();
    const onDoubleClick = vi.fn();
    const handleClick = createClickDispatcher({ onSingleClick, onDoubleClick, ...options });
    return { onSingleClick, onDoubleClick, handleClick };
}

describe('createClickDispatcher', () => {
    it('ruft onSingleClick nach Ablauf der Verzögerung auf, wenn nur einmal geklickt wird', () => {
        const { onSingleClick, onDoubleClick, handleClick } = createDispatcher({ delay: 300 });

        handleClick();
        expect(onSingleClick).not.toHaveBeenCalled();

        vi.advanceTimersByTime(300);
        expect(onSingleClick).toHaveBeenCalledTimes(1);
        expect(onDoubleClick).not.toHaveBeenCalled();
    });

    it('ruft bei zwei Klicks innerhalb der Verzögerung sofort onDoubleClick auf und unterdrückt onSingleClick', () => {
        const { onSingleClick, onDoubleClick, handleClick } = createDispatcher({ delay: 300 });

        handleClick();
        vi.advanceTimersByTime(100);
        handleClick();

        expect(onDoubleClick).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(300);
        expect(onSingleClick).not.toHaveBeenCalled();
    });

    it('behandelt einen zweiten Klick nach Ablauf der Verzögerung wieder als neuen Einzelklick', () => {
        const { onSingleClick, onDoubleClick, handleClick } = createDispatcher({ delay: 300 });

        handleClick();
        vi.advanceTimersByTime(300);
        handleClick();
        vi.advanceTimersByTime(300);

        expect(onSingleClick).toHaveBeenCalledTimes(2);
        expect(onDoubleClick).not.toHaveBeenCalled();
    });

    it('erlaubt nach einem Doppelklick wieder einen neuen Einzelklick', () => {
        const { onSingleClick, onDoubleClick, handleClick } = createDispatcher({ delay: 300 });

        handleClick();
        handleClick();
        handleClick();
        vi.advanceTimersByTime(300);

        expect(onDoubleClick).toHaveBeenCalledTimes(1);
        expect(onSingleClick).toHaveBeenCalledTimes(1);
    });

    it('nutzt 300ms als Standardverzögerung', () => {
        const { onSingleClick, handleClick } = createDispatcher();

        handleClick();
        vi.advanceTimersByTime(299);
        expect(onSingleClick).not.toHaveBeenCalled();

        vi.advanceTimersByTime(1);
        expect(onSingleClick).toHaveBeenCalledTimes(1);
    });
});

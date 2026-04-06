import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // happy-dom ist eine leichtgewichtige Browser-Simulation —
        // ausreichend für DOM-Bindungen (document.addEventListener) in den Konstruktoren.
        environment: 'happy-dom',
        include: ['tests/js/**/*.test.js'],
    },
});

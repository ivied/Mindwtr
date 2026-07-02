/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

const coverageReporters = process.env.CI
    ? ['text', 'lcovonly', 'json-summary']
    : ['text', 'lcov', 'html', 'json-summary'];

export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: [
            { find: '@', replacement: path.resolve(__dirname, './src') },
            {
                find: /^@mindwtr\/core$/,
                replacement: path.resolve(__dirname, '../../packages/core/src/index.ts'),
            },
            {
                find: /^@mindwtr\/core\/(.+)$/,
                replacement: path.resolve(__dirname, '../../packages/core/src/$1.ts'),
            },
        ],
    },
    test: {
        globals: true,
        environment: 'jsdom',
        setupFiles: './src/test/setup.ts',
        css: true,
        coverage: {
            provider: 'v8',
            reporter: coverageReporters,
        },
    },
});

import nodeConfig from '../../eslint.node.config.mjs';

export default [
  ...nodeConfig,
  {
    files: ['src/**/*.d.ts', 'src/**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
];

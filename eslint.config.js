//  @ts-check

import { tanstackConfig } from '@tanstack/eslint-config';

export default [
    ...tanstackConfig,
    {
        rules: {
            indent: ['error', 4, { SwitchCase: 1 }],
            '@typescript-eslint/array-type': 'off',
            '@typescript-eslint/no-unnecessary-condition': 'off',
            '@typescript-eslint/consistent-type-imports': 'off',
            semi: ['error', 'always'],
        },
    },
];

/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { expect, test } from './utils';

test('should load first config', async ({ activate }) => {
  const { vscode, testController, workspaceFolder } = await activate({});
  expect(testController).toHaveTestTree(`
  `);

  workspaceFolder.addFile('playwright.config.js', `module.exports = { testDir: 'tests' }`);
  workspaceFolder.addFile('tests/test.spec.ts', `
    import { test } from '@playwright/test';
    test('one', async () => {});
  `);

  const golden = `
    - tests
      - test.spec.ts
  `;
  while (testController.renderTestTree() !== golden) await new Promise(f => setTimeout(f, 200));

  expect(vscode).toHaveExecLog(`
    > playwright list-files -c playwright.config.js
  `);
});

test('should load second config', async ({ activate }) => {
  const { vscode, testController, workspaceFolder } = await activate({
    'playwright1.config.js': `module.exports = { testDir: 'tests1' }`,
    'tests1/test.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async () => {});
    `,
  });
  expect(testController).toHaveTestTree(`
    - tests1
      - test.spec.ts
  `);

  workspaceFolder.addFile('playwright2.config.js', `module.exports = { testDir: 'tests2' }`);
  workspaceFolder.addFile('tests2/test.spec.ts', `
    import { test } from '@playwright/test';
    test('one', async () => {});
  `);

  const golden = `
    - tests1
      - test.spec.ts
    - tests2
      - test.spec.ts
  `;
  while (testController.renderTestTree() !== golden) await new Promise(f => setTimeout(f, 200));

  expect(vscode).toHaveExecLog(`
    > playwright list-files -c playwright1.config.js
    > playwright list-files -c playwright1.config.js
    > playwright list-files -c playwright2.config.js
  `);
});

test('should remove model for config', async ({ activate }) => {
  const { vscode, testController, workspaceFolder } = await activate({
    'playwright1.config.js': `module.exports = { testDir: 'tests1' }`,
    'playwright2.config.js': `module.exports = { testDir: 'tests2' }`,
    'tests1/test.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async () => {});
    `,
    'tests2/test.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async () => {});
    `,
  });
  expect(testController).toHaveTestTree(`
    - tests1
      - test.spec.ts
    - tests2
      - test.spec.ts
  `);

  workspaceFolder.removeFile('playwright1.config.js');

  const golden = `
    - tests2
      - test.spec.ts
  `;
  while (testController.renderTestTree() !== golden) await new Promise(f => setTimeout(f, 200));

  expect(vscode).toHaveExecLog(`
    > playwright list-files -c playwright1.config.js
    > playwright list-files -c playwright2.config.js
    > playwright list-files -c playwright2.config.js
  `);
});

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
import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  await page.goto('https://bot.badgaming.de/#/play/files');
 
  // Click [placeholder="theSinusBot"]
  await page.click('[placeholder="theSinusBot"]');
 
  // Fill [placeholder="theSinusBot"]
  await page.fill('[placeholder="theSinusBot"]', 'admin');
 
  // Fill [placeholder="Password"]
  await page.fill('[placeholder="Password"]', 'satL8kEWNnP7G2omqF6783sjB4366Am');
 
  // Press Enter
  await page.press('[placeholder="Password"]', 'Enter');
 
  // Click text=Settings
  await page.click('text=Settings')
 
  // Click text=Instance Settings
  await page.click('text=Instance Settings')
 
  // Click :nth-match(:text("Instances"), 2)
  await page.click(':nth-match(:text("Instances"), 2)')
 
  // Click text=User Accounts
  await page.click('text=User Accounts')
 
  // Click text=Bot Log
  await page.click('text=Bot Log')
 
  // Click text=Instance Log
  await page.click('text=Instance Log')
 
  // Click text=Scripts
  await page.click('text=Scripts')
 
  // Click text=Addons
  await page.click('text=Addons')
 
  // Click text=Info
  await page.click('text=Info')
 
  // Click text=Commands
  await page.click('text=Commands');
 
  // Click text=Formats & Codecs
  await page.click('text=Formats & Codecs');
 
  // Click text=Changelog
  await page.click('text=Changelog');
 
  // Click text=About...
  await page.click('text=About...');

  await page.click('text=Playwright?!?');
});
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from 'vitest';
import { resolveCssImports } from '../../../tests/helpers/css-cascade-fixture';
import { scrollBrowserFixture } from './scroll-browser-fixture';

// #4518 fix round: the production start chip (with its open picker), the ACP
// session mode sheet and the Agent's default picker under a managed approval
// ceiling, rendered with the app's cascade at phone and desktop widths in
// both themes. The PNGs are the visual evidence; the assertions pin what a
// person sees selected and what they can choose.
const shared = `
import React, {useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {DialogHistoryHostBoundary} from './src-ui/src/components/DialogHistoryHost';
import {AccountPreferencesContext} from './src-ui/src/contexts/AccountPreferencesContext';
import {ManagedPolicyContext} from './src-ui/src/contexts/ManagedPolicyContext';
const account = {status:'account', saving:false, waitingForConnection:false, error:false, conflict:false, save(){}, retry(){}};
const queries = new QueryClient({defaultOptions:{queries:{staleTime:Infinity, retry:false, refetchOnMount:false, refetchOnWindowFocus:false}}});
function mount(policy, node) {
  createRoot(document.getElementById('root')).render(
    <QueryClientProvider client={queries}><DialogHistoryHostBoundary><AccountPreferencesContext.Provider value={account}>
      <ManagedPolicyContext.Provider value={policy}>{node}</ManagedPolicyContext.Provider>
    </AccountPreferencesContext.Provider></DialogHistoryHostBoundary></QueryClientProvider>);
}
`;
const ASK = `{organization:'Example Corp', supportUrl:'https://help.example.com/station', lockedSettings:[], limits:{maxApprovalMode:'ask'}}`;
const AUTO = `{organization:'Example Corp', supportUrl:'https://help.example.com/station', lockedSettings:[], limits:{maxApprovalMode:'auto'}}`;

const startChip = `${shared}
import {StartApprovalSummary} from './src-ui/src/components/chat-start/StartApprovalSummary';
const agent = {slug:'builder', name:'Builder', execution:{agentConnectionId:'codex', approvalMode:'auto'}};
queries.setQueryData(['agents'], {agents:[agent], catalogState:'stable'});
queries.setQueryData(['config'], {});
mount(${ASK}, <div style={{position:'fixed',left:16,bottom:16}}><StartApprovalSummary agent={agent} onPick={()=>{}} /></div>);
`;

const acpSheet = `${shared}
import {AcpSessionModeChip} from './src-ui/src/components/badges/AcpSessionModeChip';
mount(${AUTO}, <div style={{position:'fixed',left:16,bottom:16}}><AcpSessionModeChip
  modes={[{id:'default',name:'Default',description:'Asks before edits and commands'},{id:'acceptEdits',name:'Accept Edits'},{id:'bypassPermissions',name:'Bypass Permissions',description:'Accepts all permissions'}]}
  currentModeId="default" onChange={()=>{}} /></div>);
`;

const agentDefault = `${shared}
import {AgentEditorApprovalDefault} from './src-ui/src/views/agent-editor/AgentEditorApprovalDefault';
queries.setQueryData(['acp-connections'], []);
function Host() {
  const [form, setForm] = useState({execution:{agentConnectionId:'claude'}});
  return <div style={{padding:16,maxWidth:640}}><AgentEditorApprovalDefault form={form} setForm={setForm} locked={false} /></div>;
}
mount(${AUTO}, <Host/>);
`;

async function addCascade(page: Page) {
  await page.addStyleTag({
    content:
      resolveCssImports(resolve(import.meta.dirname, '../index.css')) +
      resolveCssImports(
        resolve(import.meta.dirname, '../components/chat/chat.css'),
      ) +
      resolveCssImports(
        resolve(import.meta.dirname, '../components/editor-controls.css'),
      ),
  });
}

async function eachViewport(
  page: Page,
  name: string,
  check: (label: string) => Promise<void>,
) {
  const out = resolve('.kontourai/approval-ceiling-pickers');
  mkdirSync(out, { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(
      (value) => document.documentElement.setAttribute('data-theme', value),
      theme,
    );
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await check(`${width}px ${theme}`);
      await page.evaluate(() =>
        Promise.all(document.getAnimations().map((a) => a.finished)),
      );
      await page.screenshot({ path: `${out}/${name}-${width}-${theme}.png` });
    }
  }
}

test('the start chip and its picker show an inherited Auto lowered to an Ask ceiling', async () => {
  const { browser, page, errors } = await scrollBrowserFixture(startChip);
  try {
    await addCascade(page);
    const chip = page.getByRole('button', { name: /^Permissions: / });
    await chip.waitFor();
    expect(await chip.textContent()).toContain('Ask');
    await chip.click();
    const sheet = page.getByRole('dialog', { name: 'Approval mode' });
    await sheet.waitFor();
    await eachViewport(page, 'start-chip', async (label) => {
      const radios = await sheet.evaluate((root) =>
        Object.fromEntries(
          [...root.querySelectorAll('input[type="radio"]')].map((input) => [
            (input as HTMLInputElement).value,
            {
              checked: (input as HTMLInputElement).checked,
              disabled: (input as HTMLInputElement).disabled,
            },
          ]),
        ),
      );
      expect(radios.ask, label).toEqual({ checked: true, disabled: false });
      expect(radios.auto, label).toEqual({ checked: false, disabled: true });
      expect(
        await sheet
          .getByRole('link', { name: 'Get help' })
          .getAttribute('href'),
        label,
      ).toBe('https://help.example.com/station');
    });
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

test('the ACP session mode sheet disables a known full-access mode under an Auto ceiling', async () => {
  const { browser, page, errors } = await scrollBrowserFixture(acpSheet);
  try {
    await addCascade(page);
    await page.getByRole('button', { name: /^Session mode: / }).click();
    const group = page.getByRole('radiogroup', { name: 'Session mode' });
    await group.waitFor();
    await eachViewport(page, 'acp-sheet', async (label) => {
      expect(
        await group
          .getByRole('radio', { name: /Bypass Permissions/ })
          .isDisabled(),
        label,
      ).toBe(true);
      expect(
        await group.getByRole('radio', { name: /Accept Edits/ }).isDisabled(),
        label,
      ).toBe(false);
    });
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

test("the Agent's default picker marks Full access Managed under an Auto ceiling", async () => {
  const { browser, page, errors } = await scrollBrowserFixture(agentDefault);
  try {
    await addCascade(page);
    const select = page.locator('#ae-approval-default');
    await select.waitFor();
    await eachViewport(page, 'agent-default', async (label) => {
      const never = select.locator('option[value="never"]');
      expect(await never.isDisabled(), label).toBe(true);
      expect(await never.textContent(), label).toMatch(/\(Managed\)$/);
    });
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

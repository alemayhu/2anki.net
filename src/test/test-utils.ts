// This file is temporarily to reduce duplication between jest and ava.
// When jest migration is complete it can be deleted most likely

import path from 'path';
import fs from 'fs';

import { DeckParser } from '../lib/parser/DeckParser';
import CardOption from '../lib/parser/Settings';
import Workspace from '../lib/parser/WorkSpace';

function mockPayload(name: string, contents: string) {
  return [{ name, contents }];
}

function loadFixture(fileName: string) {
  const filePath = path.join(__dirname, 'fixtures', fileName);
  const html = fs.readFileSync(filePath).toString();
  return mockPayload(fileName, html);
}

function configureParser(fileName: string, opts: CardOption) {
  const info = loadFixture(fileName);
  return new DeckParser({
    name: fileName,
    settings: opts,
    files: info,
    noLimits: true,
    workspace: new Workspace(true, 'fs'),
  });
}

export async function getDeck(fileName: string, opts: CardOption) {
  const p = configureParser(fileName, opts);
  await p.build(new Workspace(true, 'fs'));
  return p.payload[0];
}
export const pageId = '3ce6b147ac8a425f836b51cc21825b85';

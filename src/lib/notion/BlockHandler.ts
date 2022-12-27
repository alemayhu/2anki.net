import path from 'path';
import fs from 'fs';

import {
  AudioBlockObjectResponse,
  BlockObjectResponse,
  ColumnBlockObjectResponse,
  FileBlockObjectResponse,
  GetBlockResponse,
  ImageBlockObjectResponse,
  ListBlockChildrenResponse,
} from '@notionhq/client/build/src/api-endpoints';
import axios from 'axios';
import NotionAPIWrapper from './NotionAPIWrapper';
import Note from '../parser/Note';
import Settings from '../parser/Settings';
import ParserRules from '../parser/ParserRules';
import Deck from '../parser/Deck';
import CustomExporter from '../parser/CustomExporter';
import { S3FileName, SuffixFrom } from '../misc/file';
import RenderNotionLink from './RenderNotionLink';
import TagRegistry from '../parser/TagRegistry';
import sanitizeTags from '../anki/sanitizeTags';
import BlockColumn from './blocks/lists/BlockColumn';
import getClozeDeletionCard from './helpers/getClozeDeletionCard';
import getInputCard from './helpers/getInputCard';
import getColumn from './helpers/getColumn';
import isColumnList from './helpers/isColumnList';
import isTesting from './helpers/isTesting';
import perserveNewlinesIfApplicable from './helpers/preserveNewlinesIfApplicable';
import getDeckName from '../anki/getDeckname';
import getUniqueFileName from '../misc/getUniqueFileName';
import getSubDeckName from './helpers/getSubDeckName';
import { captureException } from '@sentry/node';
import { renderBack } from './helpers/renderBack';
import { getImageUrl } from './helpers/getImageUrl';
import { getAudioUrl } from './helpers/getAudioUrl';
import { getFileUrl } from './helpers/getFileUrl';
import { isFullBlock, isFullPage } from '@notionhq/client';
import { blockToStaticMarkup } from './helpers/blockToStaticMarkup';

interface Finder {
  parentType: string;
  topLevelId: string;
  rules: ParserRules;
  decks: Deck[];
  parentName: string;
}

class BlockHandler {
  api: NotionAPIWrapper;

  exporter;

  skip: string[];

  firstPageTitle?: string;

  useAll: boolean = false;

  settings: Settings;

  constructor(
    exporter: CustomExporter,
    api: NotionAPIWrapper,
    settings: Settings
  ) {
    this.exporter = exporter;
    this.api = api;
    this.skip = [];
    this.settings = settings;
  }

  async embedImage(c: BlockObjectResponse): Promise<string> {
    const url = getImageUrl(c as ImageBlockObjectResponse);
    if (this.settings.isTextOnlyBack || isTesting() || !url) {
      return '';
    }

    const suffix = SuffixFrom(S3FileName(url));
    const newName = getUniqueFileName(url) + (suffix || '');
    const imageRequest = await axios.get(url, {
      responseType: 'arraybuffer',
    });
    const contents = imageRequest.data;
    this.exporter.addMedia(newName, contents);
    return `<img src='${newName}' />`;
  }

  async embedAudioFile(c: AudioBlockObjectResponse): Promise<string> {
    const url = getAudioUrl(c);
    if (this.settings.isTextOnlyBack || isTesting() || !url) {
      return '';
    }
    const newName = getUniqueFileName(url);

    const audioRequest = await axios.get(url, { responseType: 'arraybuffer' });
    const contents = audioRequest.data;
    this.exporter.addMedia(newName, contents);
    return `[sound:${newName}]`;
  }

  async embedFile(block: FileBlockObjectResponse): Promise<string> {
    const url = getFileUrl(block);
    if (this.settings.isTextOnlyBack || isTesting() || !url) {
      return '';
    }
    const newName = getUniqueFileName(url);
    const fileRequest = await axios.get(url, { responseType: 'arraybuffer' });
    const contents = fileRequest.data;
    this.exporter.addMedia(newName, contents);
    return `<embed src='${newName}' />`;
  }

  /**
   * Retrieve the back side of a toggle
   * @param block
   * @param handleChildren
   * @returns
   */
  async getBackSide(
    block: GetBlockResponse,
    handleChildren?: boolean
  ): Promise<string | null> {
    let response2: ListBlockChildrenResponse | null;
    try {
      response2 = await this.api.getBlocks(block.id, this.useAll);
      const requestChildren = response2.results;
      return await renderBack(this, requestChildren, response2, handleChildren);
    } catch (e: unknown) {
      captureException(e);
      return null;
    }
  }

  __notionLink(
    id: string,
    notionBaseLink: string | undefined
  ): string | undefined {
    return notionBaseLink
      ? `${notionBaseLink}#${id.replace(/-/g, '')}`
      : undefined;
  }

  private async getFlashcards(
    rules: ParserRules,
    flashcardBlocks: GetBlockResponse[],
    tags: string[],
    notionBaseLink: string | undefined
  ): Promise<Note[]> {
    let cards = [];
    let counter = 0;

    for (const block of flashcardBlocks) {
      // Assume it's a basic card then check for children
      const name = await blockToStaticMarkup(
        this,
        block as BlockObjectResponse
      );
      let back: null | string = '';
      if (isColumnList(block) && rules.useColums()) {
        const secondColumn = await getColumn(block.id, this, 1);
        if (secondColumn) {
          back = await BlockColumn(
            secondColumn as ColumnBlockObjectResponse,
            this
          );
        }
      } else {
        back = await this.getBackSide(block);
      }
      if (!name) {
        console.debug('name is not valid for front, skipping', name, back);
        continue;
      }
      const ankiNote = new Note(name, back || '');
      ankiNote.media = this.exporter.media;
      let isBasicType = true;
      // Look for cloze deletion cards
      if (this.settings.isCloze) {
        const clozeCard = await getClozeDeletionCard(rules, block);
        if (clozeCard) {
          isBasicType = false;
          ankiNote.copyValues(clozeCard);
        }
      }
      // Look for input cards
      if (this.settings.useInput) {
        const inputCard = await getInputCard(rules, block);
        if (inputCard) {
          isBasicType = false;
          ankiNote.copyValues(inputCard);
        }
      }

      ankiNote.back = back!;
      ankiNote.notionLink = this.__notionLink(block.id, notionBaseLink);
      if (this.settings.addNotionLink) {
        ankiNote.back += RenderNotionLink(ankiNote.notionLink!, this);
      }
      ankiNote.notionId = this.settings.useNotionId ? block.id : undefined;
      ankiNote.media = this.exporter.media;
      this.exporter.media = [];

      const tr = TagRegistry.getInstance();
      ankiNote.tags =
        rules.TAGS === 'heading' ? tr.headings : tr.strikethroughs;
      ankiNote.number = counter++;

      ankiNote.name = perserveNewlinesIfApplicable(
        ankiNote.name,
        this.settings
      );
      ankiNote.back = perserveNewlinesIfApplicable(
        ankiNote.back,
        this.settings
      );

      cards.push(ankiNote);
      if (
        !this.settings.isCherry &&
        (this.settings.basicReversed || ankiNote.hasRefreshIcon()) &&
        isBasicType
      ) {
        cards.push(ankiNote.reversed(ankiNote));
      }
      tr.clear();
    }

    if (this.settings.isCherry) {
      cards = cards.filter((c) => c.hasCherry());
    }
    if (this.settings.isAvocado) {
      cards = cards.filter((c) => !c.hasAvocado());
    }

    if (this.settings.useTags && tags.length > 0) {
      cards.forEach((c) => {
        c.tags ||= [];
        c.tags = tags.concat(sanitizeTags(c.tags));
      });
    }
    return cards; // .filter((c) => !c.isValid());
  }

  async findFlashcards(locator: Finder): Promise<Deck[]> {
    const { parentType, topLevelId, rules, decks } = locator;
    if (parentType === 'page') {
      return this.findFlashcardsFromPage(locator);
    } else if (parentType === 'database') {
      const dbResult = await this.api.queryDatabase(topLevelId);
      const database = await this.api.getDatabase(topLevelId);
      const dbName = this.api.getDatabaseTitle(database, this.settings);
      let dbDecks = [];
      for (const entry of dbResult.results) {
        dbDecks = await this.findFlashcardsFromPage({
          parentType: 'database',
          topLevelId: entry.id,
          rules,
          decks,
          parentName: dbName,
        });
        return dbDecks;
      }
    } else {
      console.log('xxx: to be implemented:');
      console.log(
        `
      // in the case user selects something other than db and page
      // search in both database and page
       `
      );
    }
    return decks;
  }

  async findFlashcardsFromPage(locator: Finder): Promise<Deck[]> {
    const { topLevelId, rules, parentName, parentType } = locator;
    let { decks } = locator;

    const tags = await this.api.getTopLevelTags(topLevelId, rules);
    const response = await this.api.getBlocks(topLevelId, rules.UNLIMITED);
    const blocks = response.results;
    const flashCardTypes = rules.flaschardTypeNames();

    const page = await this.api.getPage(topLevelId);
    const title = await this.api.getPageTitle(page, this.settings);
    if (!this.firstPageTitle) {
      this.firstPageTitle = title;
    }
    if (rules.permitsDeckAsPage() && parentType === 'page' && page) {
      // Locate the card blocks to be used from the parser rules
      const cBlocks = blocks.filter((b: GetBlockResponse) => {
        if (!isFullBlock(b)) {
          return false;
        }
        return flashCardTypes.includes(b.type);
      });
      this.settings.parentBlockId = page.id;

      let notionBaseLink =
        this.settings.addNotionLink && this.settings.parentBlockId
          ? isFullPage(page)
            ? page?.url
            : undefined
          : undefined;
      const cards = await this.getFlashcards(
        rules,
        cBlocks,
        tags,
        notionBaseLink
      );
      const NOTION_STYLE = fs.readFileSync(
        path.join(__dirname, '../../templates/notion.css'),
        'utf8'
      );
      const deck = new Deck(
        getDeckName(parentName, title),
        cards,
        undefined,
        NOTION_STYLE,
        Deck.GenerateId(),
        this.settings
      );

      decks.push(deck);
    }

    if (this.settings.isAll) {
      const subDecks = blocks.filter((b) => {
        if (!isFullBlock(b)) {
          return;
        }
        return rules.SUB_DECKS.includes(b.type);
      });

      for (const sd of subDecks) {
        if (isFullBlock(sd)) {
          const subDeckType = sd.type;
          console.log('sd.type', subDeckType);
          const res = await this.api.getBlocks(sd.id, rules.UNLIMITED);
          const cBlocks = res.results.filter((b: GetBlockResponse) =>
            flashCardTypes.includes((b as BlockObjectResponse).type)
          );

          this.settings.parentBlockId = sd.id;
          const cards = await this.getFlashcards(
            rules,
            cBlocks,
            tags,
            undefined
          );
          const NOTION_STYLE = fs.readFileSync(
            path.join(__dirname, '../../templates/notion.css'),
            'utf8'
          );
          let subDeckName = getSubDeckName(sd);

          decks.push(
            new Deck(
              getDeckName(
                this.settings.deckName || this.firstPageTitle,
                subDeckName
              ),
              cards,
              undefined,
              NOTION_STYLE,
              Deck.GenerateId(),
              this.settings
            )
          );
          continue;
        }
        const subPage = await this.api.getPage(sd.id);
        if (subPage && isFullBlock(sd)) {
          decks = await this.findFlashcardsFromPage({
            parentType: sd.type,
            topLevelId: sd.id,
            rules,
            decks,
            parentName: parentName,
          });
        }
      }
    }
    console.log('have ', decks.length, ' decks so far');
    return decks;
  }
}

export default BlockHandler;

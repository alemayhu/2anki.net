import express from 'express';
import ConversionJob from '../ConversionJob';

import StorageHandler from '../../StorageHandler';
import { notifyUserIfNecessary } from './notifyUserIfNecessary';
import { Knex } from 'knex';
import NotionAPIWrapper from '../../../../services/NotionService/NotionAPIWrapper';

interface ConversionRequest {
  title: string | null;
  api: NotionAPIWrapper;
  id: string;
  owner: string;
  req: express.Request | null;
  res: express.Response | null;
}

export default async function performConversion(
  database: Knex,
  { title, api, id, owner, req, res }: ConversionRequest
) {
  let waitingResponse = true;
  try {
    console.log(`Performing conversion for ${id}`);

    const storage = new StorageHandler();
    const job = new ConversionJob(database);

    await job.load(id, owner, title);
    if (!job.canStart()) {
      console.log(`job ${id} was not started. Job is already active.`);
      return res ? res.redirect('/uploads') : null;
    }

    const jobs = await database('jobs').where({ owner }).returning(['*']);
    if (!res?.locals.patreon && jobs.length > 1) {
      await job.cancelled();
      return res ? res.redirect('/uploads') : null;
    }

    console.log(`job ${id} is not active, starting`);
    await job.start();

    // Note user is getting a response but the job is still running
    if (res) {
      waitingResponse = false;
      res.status(200).send();
    }

    const { ws, exporter, settings, bl, rules } = await job.createWorkSpace(
      api
    );
    const decks = await job.createFlashcards(bl, req, id, rules, settings);
    if (!decks) {
      await job.failed();
      return;
    }

    const { size, key, apkg } = await job.buildingDeck(
      bl,
      exporter,
      decks,
      ws,
      settings,
      storage,
      id,
      owner
    );
    await notifyUserIfNecessary({
      owner,
      rules,
      db: database,
      size,
      key,
      id,
      apkg,
    });
    await job.completed();
  } catch (error) {
    if (waitingResponse) {
      res?.status(400).send('conversion failed.');
    }
    console.error(error);
  }
}

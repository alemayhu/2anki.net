import { Knex } from 'knex';
import StorageHandler from '../../StorageHandler';
import Uploads from '../../../../data_layer/public/Uploads';

const MAX_KEYS = 100_000;

export const deleteDanglingUploads = async (
  db: Knex,
  storage: StorageHandler
) => {
  const query = await db.raw(`
    SELECT up.key FROM users u JOIN uploads up ON u.id = up.owner WHERE u.patreon = true;
    `);
  const subScriberUploads: Uploads[] | [] = query.rows || [];
  const storedFiles = await storage.getContents(MAX_KEYS);
  const nonPatreonFiles =
    storedFiles?.filter(
      (f) => f.Key && !subScriberUploads.find((up) => up.key === f.Key)
    ) ?? [];

  for (const file of nonPatreonFiles) {
    if (file.Key) {
      storage.delete(file.Key);
    }
  }
};

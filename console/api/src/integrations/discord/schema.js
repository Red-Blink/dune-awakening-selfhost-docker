import { migrateDiscordAdapterSchema } from "../../duneDb.js";

const migrationPromises = new WeakMap();

export function initializeDiscordAdapterSchema(db) {
  if (!migrationPromises.has(db)) {
    const migrationPromise = migrateDiscordAdapterSchema(db).catch((error) => {
      migrationPromises.delete(db);
      throw error;
    });
    migrationPromises.set(db, migrationPromise);
  }
  return migrationPromises.get(db);
}

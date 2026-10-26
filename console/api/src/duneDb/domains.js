/**
 * Domain-grouped facade over `duneDb.js` (E-01).
 *
 * Organizes the database access layer into cohesive domain namespaces
 * (`database`, `players`, `bases`, `vehicles`, `landsraad`, `liveMap`, `addons`)
 * while preserving the flat exports on `duneDb.js` for backward compatibility
 * with existing route handlers and static source-inspection tests.
 */
import * as duneDb from "../duneDb.js";

export const databaseDomain = Object.freeze({
  dbStatus: duneDb.dbStatus,
  changeDunePassword: duneDb.changeDunePassword,
  listSchemas: duneDb.listSchemas,
  listRoutines: duneDb.listRoutines,
  routineDefinition: duneDb.routineDefinition,
  listTables: duneDb.listTables,
  tableColumns: duneDb.tableColumns,
  tableCount: duneDb.tableCount,
  tablePreview: duneDb.tablePreview,
  updateTableRow: duneDb.updateTableRow
});

export const playersDomain = Object.freeze({
  listPlayers: duneDb.listPlayers,
  listAllPlayers: duneDb.listAllPlayers,
  countOnlinePlayers: duneDb.countOnlinePlayers,
  countOnlinePlayersForTarget: duneDb.countOnlinePlayersForTarget,
  playerOverview: duneDb.playerOverview,
  playerInventory: duneDb.playerInventory,
  deleteInventoryItem: duneDb.deleteInventoryItem,
  updateInventoryItem: duneDb.updateInventoryItem,
  playerProgression: duneDb.playerProgression,
  playerFactions: duneDb.playerFactions,
  playerJourney: duneDb.playerJourney,
  trackPlayerPlaytime: duneDb.trackPlayerPlaytime
});

export const basesDomain = Object.freeze({
  listBases: duneDb.listBases,
  setBasePermissions: duneDb.setBasePermissions,
  transferBaseToSystemCustodian: duneDb.transferBaseToSystemCustodian,
  deleteBaseCompletely: duneDb.deleteBaseCompletely,
  exportBaseAsBlueprint: duneDb.exportBaseAsBlueprint,
  listQueuedGeneratorRefills: duneDb.listQueuedGeneratorRefills,
  queueGeneratorRefill: duneDb.queueGeneratorRefill,
  cancelQueuedGeneratorRefill: duneDb.cancelQueuedGeneratorRefill,
  flushGeneratorRefills: duneDb.flushGeneratorRefills,
  listQueuedWaterRefills: duneDb.listQueuedWaterRefills,
  queueWaterRefill: duneDb.queueWaterRefill,
  cancelQueuedWaterRefill: duneDb.cancelQueuedWaterRefill,
  listQueuedBaseDeletes: duneDb.listQueuedBaseDeletes,
  queueBaseDelete: duneDb.queueBaseDelete,
  cancelQueuedBaseDelete: duneDb.cancelQueuedBaseDelete,
  hasQueuedBaseChildAccess: duneDb.hasQueuedBaseChildAccess,
  listQueuedBaseChildAccess: duneDb.listQueuedBaseChildAccess,
  queueBaseChildAccess: duneDb.queueBaseChildAccess
});

export const vehiclesDomain = Object.freeze({
  listQueuedVehicleDeletes: duneDb.listQueuedVehicleDeletes,
  queueVehicleDelete: duneDb.queueVehicleDelete,
  cancelQueuedVehicleDelete: duneDb.cancelQueuedVehicleDelete
});

export const liveMapDomain = Object.freeze({
  liveMapConfigPayload: duneDb.liveMapConfigPayload,
  liveMapMarkers: duneDb.liveMapMarkers,
  liveMapPartitions: duneDb.liveMapPartitions,
  liveMapPartitionRuntimeState: duneDb.liveMapPartitionRuntimeState,
  teleportPlayer: duneDb.teleportPlayer,
  teleportOfflinePlayerToCoords: duneDb.teleportOfflinePlayerToCoords
});

export const addonsDomain = Object.freeze({
  addonLeadershipPlayers: duneDb.addonLeadershipPlayers,
  addonPlayerProgression: duneDb.addonPlayerProgression
});

export const duneDbDomains = Object.freeze({
  database: databaseDomain,
  players: playersDomain,
  bases: basesDomain,
  vehicles: vehiclesDomain,
  liveMap: liveMapDomain,
  addons: addonsDomain
});

import { useEffect, useRef, useState } from "react";
import { Brain, ChevronDown, ChevronUp, Hammer, Map as MapIcon, Microscope, ScrollText, ShieldCheck, Star, UserRound } from "lucide-react";
import { adminApi } from "../../api/admin";
import { playersApi } from "../../api/players";
import type { Task } from "../../api/setup";
import { compareTableValues, DataTable, useResizableColumns, useSortableRows, useSortState } from "../../components/common/DataTable";
import { InlineActionResult } from "../../components/common/InlineActionResult";
import { AugmentDropdown } from "../../components/common/AugmentDropdown";
import { ItemCatalogSelector, ItemGradeSelect, PackageItemPreview, catalogItemId, catalogItemMinimumGrade, catalogItemName, grantItemDurability, itemGrade, normalizeItemGrade, type CatalogItem } from "../../components/common/ItemCatalog";
import { firstDefined, formatCell } from "../../lib/display";
import { augmentLimitForItem, filterAugmentsForItem, formatAugmentOptions } from "../../lib/augmentEligibility";
import { PlayerCategoryIconRail } from "./PlayerCategoryIconRail";
import { PlayerDetailTab } from "./PlayerDetailTab";
import { PlayerSummary } from "./PlayerSummary";
import { SpecializationTab } from "./SpecializationTab";
import { adminTaskFailureDetail, friendlyCraftingSource, friendlyInlineError, friendlyVehicleName, friendlyVehicleTemplateName, parseSkillModuleRows, parseVehicleCatalog, playerAdmin_bulkItemFailure, playerAdmin_friendlyFailure, playerAdmin_taskFailureMessage, titleCaseWords, vehicleSpawnDistanceLabel, vehicleSpawnOffsetUnits } from "./playerAdminUtils";
import { BlueprintsPanel } from "../blueprints/BlueprintsPanel";

type CraftingRecipeRow = { recipeId: string; displayName: string; category: string; source: string; qualityLevel: number; unlocked: boolean };
type ResearchItemRow = { itemKey: string; displayName: string; category: string; productGroup: string; type: string; unlockedState: string; unlocked: boolean; isNew: boolean };
type SkillModuleCatalogRow = { skillModule: string; category: string; id: string; maxLevel: number };
type SkillCard = { name: string; type: string; rank: string };
type StarterSkillPreset = { label: string; modules: { id: string; level: number }[] };
type JourneyRow = { id: string; name: string; rawName: string; category: string; depth: number; parentId: string; dependency?: string; status: string; complete: boolean; revealed?: boolean; pendingReward?: boolean; tags?: number; state?: number | null };

type ConfirmAction = (message: string, options?: { title?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean; details?: { label: string; value: string; tone?: "accent" | "success" | "danger" }[] }) => Promise<boolean>;

function playerAdmin_itemUsesDatabaseGrant(item: { itemId?: string; id?: string; category?: string; source?: string; quality?: unknown; grade?: unknown; durability?: unknown; augments?: string[] }) {
  const id = String(item.itemId || item.id || "").trim();
  const category = String(item.category || "").toLowerCase();
  const source = String(item.source || "").toLowerCase();
  return itemGrade(item) > 0 ||
    Boolean(item.augments?.length) ||
    category === "schematics" ||
    source === "schematics" ||
    category.includes("augment") ||
    source.includes("augment") ||
    /^schematic(pattern|_)/i.test(id) ||
    /_schematic$/i.test(id) ||
    /schematic$/i.test(id);
}

function playerAdmin_augmentLimit(itemName: string, itemId = "", category = "", source = "") {
  return augmentLimitForItem({ name: itemName, itemId, category, source });
}

function playerAdmin_augmentGrade(value: unknown) {
  const grade = normalizeItemGrade(value);
  return Math.max(1, Math.min(5, grade || 1));
}

function playerAdmin_effectiveGrade(value: unknown, item?: { itemId?: string; id?: string; source?: string; category?: string }) {
  return Math.max(catalogItemMinimumGrade(item), normalizeItemGrade(value));
}

export function CharacterAdminUI({ detail, fallback, dbPlayerId, actionPlayerId, playerName, onError, onRefresh, onClose, confirmAction, waitForTask, formatMutationResult }: { detail: Record<string, unknown> | null; fallback: Record<string, unknown>; dbPlayerId: string; actionPlayerId: string; playerName: string; onError: (text: string) => void; onRefresh: () => void; onClose: () => void; confirmAction: ConfirmAction; waitForTask: (task: Task) => Promise<Task>; formatMutationResult: (result: unknown) => string }) {
  const playerAdmin_tabs = [
    { label: "Character", icon: UserRound },
    { label: "Crafting", icon: Hammer },
    { label: "Research", icon: Microscope },
    { label: "Skills", icon: Brain },
    { label: "Specialization", icon: Star },
    { label: "Journey", icon: MapIcon },
    { label: "Blueprints", icon: ScrollText },
    { label: "Admin", icon: ShieldCheck }
  ];
  const [playerAdmin_activeTab, playerAdmin_setActiveTab] = useState("Character");
  const [playerAdmin_openToggles, playerAdmin_setOpenToggles] = useState<Record<string, boolean>>({ quick_rewards: true });
  const [playerAdmin_inventoryData, playerAdmin_setInventoryData] = useState<Record<string, unknown> | null>(null);
  const [playerAdmin_inventoryFilter, playerAdmin_setInventoryFilter] = useState("");
  const [playerAdmin_craftingCategory, playerAdmin_setCraftingCategory] = useState("Essentials");
  const [playerAdmin_craftingFilter, playerAdmin_setCraftingFilter] = useState("");
  const [playerAdmin_researchCategory, playerAdmin_setResearchCategory] = useState("");
  const [playerAdmin_productGroup, playerAdmin_setProductGroup] = useState("");
  const [playerAdmin_researchFilter, playerAdmin_setResearchFilter] = useState("");
  const [playerAdmin_skillSchool, playerAdmin_setSkillSchool] = useState("Trooper");
  const [playerAdmin_xpAmount, playerAdmin_setXpAmount] = useState("1000");
  const [playerAdmin_currencyType, playerAdmin_setCurrencyType] = useState("Solari Credit");
  const [playerAdmin_currencyAmount, playerAdmin_setCurrencyAmount] = useState("100");
  const [playerAdmin_intelAmount, playerAdmin_setIntelAmount] = useState("100");
  const [playerAdmin_factionName, playerAdmin_setFactionName] = useState("Atreides");
  const [playerAdmin_factionAmount, playerAdmin_setFactionAmount] = useState("100");
  const [playerAdmin_selectedItem, playerAdmin_setSelectedItem] = useState<CatalogItem | null>(null);
  const [playerAdmin_itemName, playerAdmin_setItemName] = useState("");
  const [playerAdmin_itemId, playerAdmin_setItemId] = useState("");
  const [playerAdmin_quantity, playerAdmin_setQuantity] = useState("1");
  const [playerAdmin_grade, playerAdmin_setGrade] = useState("0");
  const [playerAdmin_augmentGradeValue, playerAdmin_setAugmentGradeValue] = useState("1");
  const [playerAdmin_multiList, playerAdmin_setMultiList] = useState<{ itemName?: string; itemId?: string; image?: string; category?: string; source?: string; quantity: number; durability?: number; quality?: number; grade?: number; augments?: string[]; augmentQuality?: number }[]>([]);
  const [playerAdmin_itemEditIndex, playerAdmin_setItemEditIndex] = useState<number | null>(null);
  const [playerAdmin_itemEditDraft, playerAdmin_setItemEditDraft] = useState({ quantity: "1", grade: "0", augmentGrade: "1" });
  const [playerAdmin_selectedAugments, playerAdmin_setSelectedAugments] = useState<string[]>([]);
  const [playerAdmin_augmentCatalog, playerAdmin_setAugmentCatalog] = useState<{ id: string; name: string }[]>([]);
  const [playerAdmin_filteredAugments, playerAdmin_setFilteredAugments] = useState<{ id: string; name: string }[]>([]);
  const [playerAdmin_actionResult, playerAdmin_setActionResult] = useState<{ key: string; tone: "success" | "danger" | "neutral"; text: string; pending?: boolean } | null>(null);
  const [playerAdmin_busyActionKey, playerAdmin_setBusyActionKey] = useState("");
  const [playerAdmin_characterLog, playerAdmin_setCharacterLog] = useState<Record<string, string>[]>([]);
  const [playerAdmin_adminLog, playerAdmin_setAdminLog] = useState<Record<string, string>[]>([]);
  const [playerAdmin_craftingRows, playerAdmin_setCraftingRows] = useState<CraftingRecipeRow[]>([]);
  const [playerAdmin_craftingLoading, playerAdmin_setCraftingLoading] = useState(false);
  const [playerAdmin_craftingError, playerAdmin_setCraftingError] = useState("");
  const [playerAdmin_researchRows, playerAdmin_setResearchRows] = useState<ResearchItemRow[]>([]);
  const [playerAdmin_researchLoading, playerAdmin_setResearchLoading] = useState(false);
  const [playerAdmin_researchError, playerAdmin_setResearchError] = useState("");
  const [playerAdmin_skillPointsAmount, playerAdmin_setSkillPointsAmount] = useState("10");
  const [playerAdmin_skillCatalog, playerAdmin_setSkillCatalog] = useState<SkillModuleCatalogRow[]>([]);
  const [playerAdmin_skillCatalogLoading, playerAdmin_setSkillCatalogLoading] = useState(false);
  const [playerAdmin_skillCatalogError, playerAdmin_setSkillCatalogError] = useState("");
  const [playerAdmin_skillBaseline, playerAdmin_setSkillBaseline] = useState<Record<string, number>>({});
  const [playerAdmin_skillChanges, playerAdmin_setSkillChanges] = useState<Record<string, number>>({});
  const [playerAdmin_journeyRows, playerAdmin_setJourneyRows] = useState<Record<string, JourneyRow[]>>({ story: [], contract: [], codex: [], tutorial: [] });
  const [playerAdmin_journeyLoading, playerAdmin_setJourneyLoading] = useState(false);
  const [playerAdmin_journeyError, playerAdmin_setJourneyError] = useState("");
  const [playerAdmin_journeyFilter, playerAdmin_setJourneyFilter] = useState("");
  const [playerAdmin_expandedJourney, playerAdmin_setExpandedJourney] = useState<Record<string, boolean>>({});
  const [playerAdmin_coords, playerAdmin_setCoords] = useState({ x: "", y: "", z: "", yaw: "0" });
  const [playerAdmin_vehicleId, playerAdmin_setVehicleId] = useState("");
  const [playerAdmin_vehicleTemplate, playerAdmin_setVehicleTemplate] = useState("");
  const [playerAdmin_vehicleCatalog, playerAdmin_setVehicleCatalog] = useState<Record<string, string[]>>({});
  const [playerAdmin_vehicleDecayThreshold, playerAdmin_setVehicleDecayThreshold] = useState("50");
  const playerAdmin_resultTimer = useRef<number | null>(null);
  useEffect(() => {
    playerAdmin_setFilteredAugments(filterAugmentsForItem({
      itemId: playerAdmin_itemId,
      name: playerAdmin_itemName,
      category: playerAdmin_selectedItem?.category,
      source: playerAdmin_selectedItem?.source
    }, playerAdmin_augmentCatalog));
  }, [playerAdmin_itemName, playerAdmin_itemId, playerAdmin_selectedItem?.category, playerAdmin_selectedItem?.source, playerAdmin_augmentCatalog]);
  const playerAdmin_factionIds: Record<string, number> = { Atreides: 1, Harkonnen: 2, Smuggler: 4 };
  const playerAdmin_craftingCategories = ["Essentials", "Water Discipline", "Combat", "Construction", "Exploration", "Vehicles"];
  const playerAdmin_isOnline = String(firstDefined(detail?.online_status, fallback.online_status) || "").toLowerCase() === "online";
  const playerAdmin_canRunLiveAction = Boolean(actionPlayerId) && playerAdmin_isOnline;
  const playerAdmin_allowedSelectedAugments = playerAdmin_selectedAugments.filter((augmentId) => playerAdmin_filteredAugments.some((augment) => augment.id === augmentId));
  const playerAdmin_selectedGrantItems = playerAdmin_multiList.length ? playerAdmin_multiList : playerAdmin_selectedItem ? [{
    itemName: playerAdmin_itemName,
    itemId: playerAdmin_itemId,
    image: playerAdmin_selectedItem.image,
    category: playerAdmin_selectedItem.category,
    source: playerAdmin_selectedItem.source,
    quantity: Number(playerAdmin_quantity) || 1,
    quality: playerAdmin_effectiveGrade(playerAdmin_grade, playerAdmin_selectedItem),
    augments: playerAdmin_allowedSelectedAugments.length > 0 ? [...playerAdmin_allowedSelectedAugments] : undefined,
    augmentQuality: playerAdmin_allowedSelectedAugments.length > 0 ? playerAdmin_augmentGrade(playerAdmin_augmentGradeValue) : undefined
  }] : [];
  const playerAdmin_hasGrantItems = playerAdmin_selectedGrantItems.length > 0;
  const playerAdmin_allGrantItemsUseDb = playerAdmin_hasGrantItems && playerAdmin_selectedGrantItems.every(playerAdmin_itemUsesDatabaseGrant);
  const playerAdmin_canGiveSelectedItems = playerAdmin_hasGrantItems && (
    playerAdmin_canRunLiveAction ||
    (Boolean(dbPlayerId) && playerAdmin_allGrantItemsUseDb) ||
    (Boolean(dbPlayerId) && !playerAdmin_isOnline)
  );
  const playerAdmin_displayAugments = formatAugmentOptions(playerAdmin_filteredAugments, playerAdmin_augmentGradeValue);
  const playerAdmin_skillChangeCount = Object.keys(playerAdmin_skillChanges).length;
  const playerAdmin_toggle = (playerAdmin_key: string) => playerAdmin_setOpenToggles((playerAdmin_current) => ({ ...playerAdmin_current, [playerAdmin_key]: !playerAdmin_current[playerAdmin_key] }));
  const playerAdmin_toggleJourney = (key: string) => playerAdmin_setExpandedJourney((current) => ({ ...current, [key]: !current[key] }));
  function playerAdmin_showResult(key: string, text: string, tone: "success" | "danger" | "neutral" = "success", pending = false) {
    playerAdmin_setActionResult({ key, text, tone, pending });
    if (playerAdmin_resultTimer.current) window.clearTimeout(playerAdmin_resultTimer.current);
    playerAdmin_resultTimer.current = null;
    if (!pending) playerAdmin_resultTimer.current = window.setTimeout(() => playerAdmin_setActionResult(null), 8000);
  }
  function playerAdmin_addLog(actionType: string, target: string, amount: string, notes: string) {
    const row = { "Date / Time": new Date().toLocaleString(), Admin: "Console", "Action Type": actionType, Target: target, Amount: amount, Notes: notes };
    playerAdmin_setCharacterLog((current) => [row, ...current].slice(0, 25));
    if (/kick|wipe|reset progression|teleport|spawn vehicle|load position/i.test(actionType)) playerAdmin_setAdminLog((current) => [row, ...current].slice(0, 25));
  }
  function playerAdmin_actionResultOrNote(key: string, text: string) {
    return playerAdmin_actionResult?.key === key ? <InlineActionResult result={playerAdmin_actionResult} resultKey={key} /> : <span className="inline-action-result-wrap"><span className="inline-action-result note">{text}</span></span>;
  }
  useEffect(() => {
    adminApi.itemCatalog("", 10000).then((result) => {
      const augs = (result.rows || []).filter((item) =>
        (item.category || "").toLowerCase().includes("augment") ||
        (item.source || "").toLowerCase() === "augments"
      ).map((item) => ({ id: item.itemId || item.id, name: item.name }));
      playerAdmin_setAugmentCatalog(augs);
    }).catch(() => playerAdmin_setAugmentCatalog([]));
  }, []);
  async function playerAdmin_runTask(action: () => Promise<{ task: Task }>) {
    const response = await action();
    const final = await waitForTask(response.task);
    if (final.status === "succeeded") {
      onRefresh();
      return { ok: true };
    }
    else throw new Error(adminTaskFailureDetail(final) || playerAdmin_taskFailureMessage(final));
  }
  async function playerAdmin_runAction(key: string, pendingText: string, action: () => Promise<unknown>, successText: string, log: { actionType: string; target: string; amount: string }, successTone: "success" | "danger" = "success", failureText?: string | ((error: unknown) => string)) {
    onError("");
    playerAdmin_showResult(key, pendingText, "neutral", true);
    try {
      const response = await action();
      const responseText = formatMutationResult(response);
      playerAdmin_showResult(key, responseText && responseText !== "Action completed." ? responseText : successText, successTone);
      playerAdmin_addLog(log.actionType, log.target, log.amount, "Succeeded");
    } catch (error) {
      const message = typeof failureText === "function" ? failureText(error) : failureText || playerAdmin_friendlyFailure(error, log.actionType, playerName);
      playerAdmin_showResult(key, message, "danger");
      playerAdmin_addLog(log.actionType, log.target, log.amount, `Failed: ${message}`);
    }
  }
  function playerAdmin_chooseItem(item: CatalogItem | null) {
    playerAdmin_setSelectedItem(item);
    playerAdmin_setItemName(item?.name || "");
    playerAdmin_setItemId(item?.itemId || item?.id || "");
    playerAdmin_setSelectedAugments([]);
    playerAdmin_setAugmentGradeValue("1");
  }
  function playerAdmin_addSelectedItem() {
    if (!playerAdmin_selectedItem) return;
    const allowedAugments = playerAdmin_selectedAugments.filter((augmentId) => playerAdmin_filteredAugments.some((augment) => augment.id === augmentId));
    playerAdmin_setMultiList((current) => [...current, {
      itemName: playerAdmin_itemName,
      itemId: playerAdmin_itemId,
      image: playerAdmin_selectedItem.image,
      category: playerAdmin_selectedItem.category,
      source: playerAdmin_selectedItem.source,
      quantity: Number(playerAdmin_quantity) || 1,
      quality: playerAdmin_effectiveGrade(playerAdmin_grade, playerAdmin_selectedItem),
      augments: allowedAugments.length > 0 ? [...allowedAugments] : undefined,
      augmentQuality: allowedAugments.length > 0 ? playerAdmin_augmentGrade(playerAdmin_augmentGradeValue) : undefined
    }]);
    playerAdmin_setSelectedAugments([]);
  }
  function playerAdmin_editQueuedItem(index: number) {
    const item = playerAdmin_multiList[index];
    if (!item) return;
    playerAdmin_setItemEditIndex(index);
    playerAdmin_setItemEditDraft({ quantity: String(item.quantity ?? 1), grade: String(itemGrade(item)), augmentGrade: String(item.augmentQuality ?? 1) });
  }
  function playerAdmin_saveQueuedItem(index: number) {
    playerAdmin_setMultiList((current) => current.map((item, itemIndex) => {
      if (itemIndex !== index) return item;
      const augmentQuality = item.augments?.length ? playerAdmin_augmentGrade(playerAdmin_itemEditDraft.augmentGrade) : undefined;
      return { ...item, quantity: Number(playerAdmin_itemEditDraft.quantity) || 1, quality: playerAdmin_effectiveGrade(playerAdmin_itemEditDraft.grade, item), augmentQuality, durability: undefined };
    }));
    playerAdmin_setItemEditIndex(null);
  }
  async function playerAdmin_giveMultipleItems() {
    const items = playerAdmin_selectedGrantItems;
    if (!items.length) {
      playerAdmin_showResult("giveMultiple", "Select at least one item before granting.", "danger");
      return;
    }
    const allItemsUseDb = items.every(playerAdmin_itemUsesDatabaseGrant);
    if (!playerAdmin_canRunLiveAction && !allItemsUseDb) {
      playerAdmin_showResult("giveMultiple", "Normal Grade 0 item grants require the player to be online. Use Grade 1-5, schematics, or augments for offline database grants.", "danger");
      return;
    }
    const hasOfflineOnlyPreAugmentedItem = items.some((item) => item.augments?.length);
    if (playerAdmin_isOnline && hasOfflineOnlyPreAugmentedItem) {
      playerAdmin_showResult("giveMultiple", "Pre-augmented item grants require the player to be offline. Grade 0 items with no augments can be granted while the player is online. Item Grades 1-5 or Augment Grades 1-5 require the player to be offline.", "danger");
      return;
    }
    const grantTargetId = allItemsUseDb && dbPlayerId ? dbPlayerId : actionPlayerId;
    if (!grantTargetId) {
      playerAdmin_showResult("giveMultiple", "This player is missing the required grant target ID.", "danger");
      return;
    }
    const isSingleSelectedItemGrant = !playerAdmin_multiList.length && items.length === 1;
    const actionLabel = isSingleSelectedItemGrant ? "Give Item" : "Give Multiple Items";
    const hasAugmentedGrant = items.some((item) => item.augments?.length);
    const successText = `${items.length} item entr${items.length === 1 ? "y was" : "ies were"} granted to ${playerName}.${hasAugmentedGrant && playerAdmin_isOnline ? " Augments were saved; relog may be required before the slots appear in-game." : ""}`;
    await playerAdmin_runAction(
      "giveMultiple",
      `Granting ${items.length} item entr${items.length === 1 ? "y" : "ies"} to ${playerName}`,
      async () => {
        const result = await playersApi.giveItems(grantTargetId, items.map((item) => ({ itemName: item.itemName, itemId: item.itemId, quantity: item.quantity, quality: itemGrade(item), durability: grantItemDurability(), augments: item.augments || [], augmentQuality: item.augments?.length ? playerAdmin_augmentGrade(item.augmentQuality) : undefined })));
        if (!result.ok) throw new Error(playerAdmin_bulkItemFailure(result.results));
        await playerAdmin_loadInventoryRows();
      },
      successText,
      { actionType: actionLabel, target: playerName, amount: String(items.length) },
      "success",
      (error) => playerAdmin_friendlyFailure(error, "Give Items", playerName)
    );
  }
  function normalizeSkillSchool(value: string) {
    return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  }
  function normalizeSkillName(value: string) {
    return String(value || "").toLowerCase().replace(/^ability:\s*/, "").replace(/[^a-z0-9]/g, "");
  }
  async function playerAdmin_loadCraftingRecipes() {
    if (!dbPlayerId) {
      playerAdmin_setCraftingRows([]);
      return;
    }
    playerAdmin_setCraftingLoading(true);
    playerAdmin_setCraftingError("");
    try {
      const response = await playersApi.craftingRecipes(dbPlayerId);
      playerAdmin_setCraftingRows((response.rows || []).map((row) => ({
        recipeId: String(row.recipeId || ""),
        displayName: String(row.displayName || row.recipeId || ""),
        category: String(row.category || "Essentials"),
        source: String(row.source || "Unknown"),
        qualityLevel: Number(row.qualityLevel || 0),
        unlocked: Boolean(row.unlocked)
      })).filter((row) => row.recipeId));
    } catch (error) {
      playerAdmin_setCraftingRows([]);
      playerAdmin_setCraftingError(friendlyInlineError(error));
    } finally {
      playerAdmin_setCraftingLoading(false);
    }
  }
  async function playerAdmin_unlockCraftingRecipe(row: CraftingRecipeRow) {
    const key = `crafting:${row.recipeId}`;
    onError("");
    playerAdmin_setBusyActionKey(key);
    try {
      const response = await playersApi.unlockCraftingRecipe(dbPlayerId, { recipeId: row.recipeId, confirmation: "UNLOCK CRAFTING RECIPE" });
      const alreadyUnlocked = Boolean(response.result?.alreadyUnlocked);
      playerAdmin_addLog("Unlock Crafting Recipe", row.recipeId, "1", alreadyUnlocked ? "Already Unlocked" : "Succeeded");
      await playerAdmin_loadCraftingRecipes();
      playerAdmin_showResult(key, alreadyUnlocked ? "Already unlocked." : "Unlocked. Player will see it on next login.", "success");
    } catch (error) {
      const message = friendlyInlineError(error);
      playerAdmin_showResult(key, message, "danger");
      playerAdmin_addLog("Unlock Crafting Recipe", row.recipeId, "1", `Failed: ${message}`);
    } finally {
      playerAdmin_setBusyActionKey("");
    }
  }
  async function playerAdmin_loadResearchItems() {
    if (!dbPlayerId) {
      playerAdmin_setResearchRows([]);
      return;
    }
    playerAdmin_setResearchLoading(true);
    playerAdmin_setResearchError("");
    try {
      const response = await playersApi.researchItems(dbPlayerId);
      playerAdmin_setResearchRows((response.rows || []).map((row) => ({
        itemKey: String(row.itemKey || ""),
        displayName: String(row.displayName || row.itemKey || ""),
        category: String(row.category || "Essentials"),
        productGroup: String(row.productGroup || "Salvage Products"),
        type: String(row.type || "Research"),
        unlockedState: String(row.unlockedState || "Unknown"),
        unlocked: Boolean(row.unlocked),
        isNew: Boolean(row.isNew)
      })).filter((row) => row.itemKey));
    } catch (error) {
      playerAdmin_setResearchRows([]);
      playerAdmin_setResearchError(friendlyInlineError(error));
    } finally {
      playerAdmin_setResearchLoading(false);
    }
  }
  async function playerAdmin_unlockResearchItem(row: ResearchItemRow) {
    const key = `research:${row.itemKey}`;
    onError("");
    playerAdmin_setBusyActionKey(key);
    try {
      const response = await playersApi.unlockResearchItem(dbPlayerId, { itemKey: row.itemKey, confirmation: "UNLOCK RESEARCH ITEM" });
      const alreadyUnlocked = Boolean(response.result?.alreadyUnlocked);
      playerAdmin_addLog("Unlock Research", row.itemKey, "1", alreadyUnlocked ? "Already Unlocked" : "Succeeded");
      await playerAdmin_loadResearchItems();
      await playerAdmin_loadCraftingRecipes();
      playerAdmin_showResult(key, alreadyUnlocked ? "Already researched." : "Researched. Player will see it on next login.", "success");
    } catch (error) {
      const message = friendlyInlineError(error);
      playerAdmin_showResult(key, message, "danger");
      playerAdmin_addLog("Unlock Research", row.itemKey, "1", `Failed: ${message}`);
    } finally {
      playerAdmin_setBusyActionKey("");
    }
  }
  async function playerAdmin_loadSkillCatalog() {
    playerAdmin_setSkillCatalogLoading(true);
    playerAdmin_setSkillCatalogError("");
    try {
      const response = await adminApi.skillModules();
      playerAdmin_setSkillCatalog(parseSkillModuleRows(response.stdout || "").map((row) => ({
        skillModule: String(row.skillModule || ""),
        category: String(row.category || ""),
        id: String(row.id || ""),
        maxLevel: Math.max(1, Number(row.maxLevel || 1))
      })).filter((row) => row.skillModule && row.id));
    } catch (error) {
      playerAdmin_setSkillCatalog([]);
      playerAdmin_setSkillCatalogError(friendlyInlineError(error));
    } finally {
      playerAdmin_setSkillCatalogLoading(false);
    }
  }
  async function playerAdmin_reloadSkills() {
    await playerAdmin_loadSkillCatalog();
  }
  function playerAdmin_skillKey(school: string, name: string) {
    return `${normalizeSkillSchool(school)}:${normalizeSkillName(name)}`;
  }
  function playerAdmin_findSkillModule(school: string, card: SkillCard) {
    const schoolKey = normalizeSkillSchool(school);
    const nameKey = normalizeSkillName(card.name);
    return playerAdmin_skillCatalog.find((row) => normalizeSkillSchool(row.category) === schoolKey && normalizeSkillName(row.skillModule) === nameKey);
  }
  function playerAdmin_skillMaxRank(school: string, card: SkillCard) {
    const module = playerAdmin_findSkillModule(school, card);
    return Math.max(1, Number(module?.maxLevel || card.rank || 1));
  }
  function playerAdmin_skillBaselineRank(school: string, card: SkillCard) {
    const module = playerAdmin_findSkillModule(school, card);
    const key = module?.id || playerAdmin_skillKey(school, card.name);
    return Math.max(0, Math.min(playerAdmin_skillMaxRank(school, card), playerAdmin_skillBaseline[key] ?? 0));
  }
  function playerAdmin_skillValue(school: string, card: SkillCard) {
    const module = playerAdmin_findSkillModule(school, card);
    const key = module?.id || playerAdmin_skillKey(school, card.name);
    return playerAdmin_skillChanges[key] ?? playerAdmin_skillBaselineRank(school, card);
  }
  function playerAdmin_setSkillValue(school: string, card: SkillCard, rank: number) {
    const module = playerAdmin_findSkillModule(school, card);
    const key = module?.id || playerAdmin_skillKey(school, card.name);
    const maxRank = playerAdmin_skillMaxRank(school, card);
    const nextRank = Math.max(0, Math.min(maxRank, rank));
    const baseline = playerAdmin_skillBaselineRank(school, card);
    playerAdmin_setSkillChanges((current) => {
      const next = { ...current };
      if (nextRank === baseline) delete next[key];
      else next[key] = nextRank;
      return next;
    });
  }
  async function playerAdmin_saveSkillChanges() {
    const entries = Object.entries(playerAdmin_skillChanges);
    if (!entries.length) return;
    onError("");
    playerAdmin_showResult("skillSave", `Saving ${entries.length} skill change${entries.length === 1 ? "" : "s"} for ${playerName}`, "neutral", true);
    try {
      for (const [moduleId, level] of entries) {
        await playerAdmin_runTask(() => playersApi.setSkillModule(actionPlayerId, { module: moduleId, level }));
      }
      playerAdmin_setSkillBaseline((current) => ({ ...current, ...Object.fromEntries(entries) }));
      playerAdmin_setSkillChanges({});
      playerAdmin_showResult("skillSave", `${entries.length} skill change${entries.length === 1 ? "" : "s"} saved for ${playerName}.`, "success");
      playerAdmin_addLog("Set Skill Modules", playerName, String(entries.length), "Succeeded");
    } catch (error) {
      const message = friendlyInlineError(error);
      playerAdmin_showResult("skillSave", message, "danger");
      playerAdmin_addLog("Set Skill Modules", playerName, String(entries.length), `Failed: ${message}`);
    }
  }
  function playerAdmin_discardSkillChanges() {
    playerAdmin_setSkillChanges({});
    playerAdmin_showResult("skillSave", "Skill changes were discarded.", "neutral");
  }
  function playerAdmin_mapJourneyRows(rows: unknown) {
    const raw = rows && typeof rows === "object" ? rows as Record<string, unknown> : {};
    const mapRows = (items: unknown): JourneyRow[] => Array.isArray(items) ? items.map((item) => {
      const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
      return {
        id: String(row.id || ""),
        name: String(row.name || row.id || ""),
        rawName: String(row.rawName || row.id || ""),
        category: String(row.category || ""),
        depth: Math.max(0, Number(row.depth || 0)),
        parentId: String(row.parentId || ""),
        dependency: String(row.dependency || row.parentId || ""),
        status: String(row.status || "Incomplete"),
        complete: Boolean(row.complete),
        revealed: Boolean(row.revealed),
        pendingReward: Boolean(row.pendingReward),
        tags: Number(row.tags || 0),
        state: row.state === null || row.state === undefined ? null : Number(row.state)
      };
    }).filter((row) => row.id) : [];
    return { story: mapRows(raw.story), contract: mapRows(raw.contract), codex: mapRows(raw.codex), tutorial: mapRows(raw.tutorial) };
  }
  async function playerAdmin_loadJourneyRows() {
    if (!dbPlayerId) {
      playerAdmin_setJourneyRows({ story: [], contract: [], codex: [], tutorial: [] });
      return;
    }
    playerAdmin_setJourneyLoading(true);
    playerAdmin_setJourneyError("");
    try {
      const response = await playersApi.journey(dbPlayerId);
      playerAdmin_setJourneyRows(playerAdmin_mapJourneyRows(response.rows));
    } catch (error) {
      playerAdmin_setJourneyRows({ story: [], contract: [], codex: [], tutorial: [] });
      playerAdmin_setJourneyError(friendlyInlineError(error));
    } finally {
      playerAdmin_setJourneyLoading(false);
    }
  }
  async function playerAdmin_loadInventoryRows() {
    if (!dbPlayerId) {
      playerAdmin_setInventoryData(null);
      return;
    }
    try {
      const response = await playersApi.inventory(dbPlayerId);
      playerAdmin_setInventoryData(response);
    } catch (error) {
      playerAdmin_setInventoryData(null);
      onError(error instanceof Error ? error.message : String(error));
    }
  }
  async function playerAdmin_completeJourney(row: JourneyRow) {
    const key = `journey:${row.category}:${row.id}`;
    onError("");
    playerAdmin_showResult(key, `Completing ${row.name} for ${playerName}`, "neutral", true);
    try {
      const response = row.category === "Tutorial"
        ? await playersApi.completeTutorial(dbPlayerId, { tutorialId: row.id, confirmation: "COMPLETE TUTORIAL" })
        : await playersApi.completeJourneyNode(dbPlayerId, { nodeId: row.id, confirmation: "COMPLETE JOURNEY NODE" });
      const changed = Number(response.result?.updatedRows || response.result?.deletedRows || 1);
      playerAdmin_showResult(key, `${row.name} was completed for ${playerName}.`, "success");
      playerAdmin_addLog(`Complete ${row.category}`, row.rawName || row.id, String(changed), "Succeeded");
      await playerAdmin_loadJourneyRows();
    } catch (error) {
      const message = friendlyInlineError(error);
      playerAdmin_showResult(key, message, "danger");
      playerAdmin_addLog(`Complete ${row.category}`, row.rawName || row.id, "1", `Failed: ${message}`);
    }
  }
  async function playerAdmin_resetJourney(row: JourneyRow) {
    const key = `journey:${row.category}:${row.id}`;
    onError("");
    playerAdmin_showResult(key, `Resetting ${row.name} for ${playerName}`, "neutral", true);
    try {
      const response = row.category === "Tutorial"
        ? await playersApi.resetTutorial(dbPlayerId, { tutorialId: row.id, confirmation: "RESET TUTORIAL" })
        : await playersApi.resetJourneyNode(dbPlayerId, { nodeId: row.id, confirmation: "RESET JOURNEY NODE" });
      const changed = Number(response.result?.updatedRows || response.result?.deletedRows || 0);
      playerAdmin_showResult(key, `${row.name} was reset for ${playerName}.`, "neutral");
      playerAdmin_addLog(`Reset ${row.category}`, row.rawName || row.id, String(changed), "Succeeded");
      await playerAdmin_loadJourneyRows();
    } catch (error) {
      const message = friendlyInlineError(error);
      playerAdmin_showResult(key, message, "danger");
      playerAdmin_addLog(`Reset ${row.category}`, row.rawName || row.id, "1", `Failed: ${message}`);
    }
  }
  async function playerAdmin_useCurrentPosition() {
    const data = await playersApi.position(dbPlayerId);
    const position = (data.position || data) as Record<string, unknown>;
    const x = firstDefined(position.x, position.X, position.location_x, position.pos_x);
    const y = firstDefined(position.y, position.Y, position.location_y, position.pos_y);
    const z = firstDefined(position.z, position.Z, position.location_z, position.pos_z);
    const yaw = firstDefined(position.yaw, position.Yaw, position.rotation_yaw, position.rot_yaw, 0);
    if (x === undefined || y === undefined || z === undefined) throw new Error("Current position is not available from the detected player position schema.");
    playerAdmin_setCoords({ x: String(x), y: String(y), z: String(z), yaw: String(yaw ?? 0) });
  }
  async function playerAdmin_loadVehicles() {
    try {
      const response = await adminApi.structuredVehicles();
      const parsed = Object.fromEntries((response.vehicles || []).map((vehicle) => [vehicle.id || vehicle.name, vehicle.templates || []]).filter(([id]) => id));
      playerAdmin_setVehicleCatalog(parsed);
      const firstVehicle = Object.keys(parsed).sort((a, b) => friendlyVehicleName(a).localeCompare(friendlyVehicleName(b)))[0] || "";
      if (firstVehicle && !playerAdmin_vehicleId) {
        playerAdmin_setVehicleId(firstVehicle);
        playerAdmin_setVehicleTemplate([...(parsed[firstVehicle] || [])].sort((a, b) => friendlyVehicleTemplateName(a).localeCompare(friendlyVehicleTemplateName(b)))[0] || "");
      }
    } catch {
      try {
        const response = await adminApi.vehicles("");
        const parsed = parseVehicleCatalog(response.stdout || "");
        playerAdmin_setVehicleCatalog(parsed);
        const firstVehicle = Object.keys(parsed).sort((a, b) => friendlyVehicleName(a).localeCompare(friendlyVehicleName(b)))[0] || "";
        if (firstVehicle && !playerAdmin_vehicleId) {
          playerAdmin_setVehicleId(firstVehicle);
          playerAdmin_setVehicleTemplate([...(parsed[firstVehicle] || [])].sort((a, b) => friendlyVehicleTemplateName(a).localeCompare(friendlyVehicleTemplateName(b)))[0] || "");
        }
      } catch {
        playerAdmin_setVehicleCatalog({});
      }
    }
  }
  useEffect(() => {
    if (playerAdmin_activeTab === "Crafting") void playerAdmin_loadCraftingRecipes();
  }, [playerAdmin_activeTab, dbPlayerId]);
  useEffect(() => {
    if (playerAdmin_activeTab === "Research") void playerAdmin_loadResearchItems();
  }, [playerAdmin_activeTab, dbPlayerId]);
  useEffect(() => {
    if (playerAdmin_activeTab === "Skills") void playerAdmin_loadSkillCatalog();
  }, [playerAdmin_activeTab, dbPlayerId]);
  useEffect(() => {
    if (playerAdmin_activeTab !== "Skills" || !dbPlayerId) return;
    const refreshVisibleSkills = () => {
      if (document.visibilityState === "visible" && playerAdmin_skillChangeCount === 0) {
        void playerAdmin_loadSkillCatalog();
      }
    };
    const refreshFocusedSkills = () => {
      if (playerAdmin_skillChangeCount === 0) {
        void playerAdmin_loadSkillCatalog();
      }
    };
    document.addEventListener("visibilitychange", refreshVisibleSkills);
    window.addEventListener("focus", refreshFocusedSkills);
    return () => {
      document.removeEventListener("visibilitychange", refreshVisibleSkills);
      window.removeEventListener("focus", refreshFocusedSkills);
    };
  }, [playerAdmin_activeTab, dbPlayerId, playerAdmin_skillChangeCount]);
  useEffect(() => {
    if (playerAdmin_activeTab === "Skills" && playerAdmin_skillSchool) playerAdmin_openSkillTreeToggles(playerAdmin_skillSchool);
  }, [playerAdmin_activeTab, playerAdmin_skillSchool]);
  useEffect(() => {
    if (playerAdmin_activeTab === "Journey") void playerAdmin_loadJourneyRows();
  }, [playerAdmin_activeTab, dbPlayerId]);
  useEffect(() => {
    if (playerAdmin_activeTab === "Character") void playerAdmin_loadInventoryRows();
  }, [playerAdmin_activeTab, dbPlayerId]);
  useEffect(() => {
    if (playerAdmin_activeTab === "Admin" && !Object.keys(playerAdmin_vehicleCatalog).length) void playerAdmin_loadVehicles();
  }, [playerAdmin_activeTab, Object.keys(playerAdmin_vehicleCatalog).length]);
  useEffect(() => {
    playerAdmin_setSkillBaseline({});
    playerAdmin_setSkillChanges({});
  }, [actionPlayerId]);
  useEffect(() => () => { if (playerAdmin_resultTimer.current) window.clearTimeout(playerAdmin_resultTimer.current); }, []);
  const playerAdmin_table = (playerAdmin_columns: string[], playerAdmin_rows: Record<string, string>[]) => (
    <div className="playerAdmin_tableWrap">
      <table className="playerAdmin_table">
        <thead><tr>{playerAdmin_columns.map((playerAdmin_column) => <th key={playerAdmin_column}>{playerAdmin_column}</th>)}</tr></thead>
        <tbody>{playerAdmin_rows.map((playerAdmin_row, playerAdmin_index) => <tr key={playerAdmin_index}>{playerAdmin_columns.map((playerAdmin_column) => <td key={playerAdmin_column}>{playerAdmin_row[playerAdmin_column] || "-"}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
  const playerAdmin_toggleBox = (playerAdmin_key: string, playerAdmin_title: string, playerAdmin_children: React.ReactNode) => (
    <div className={`playerAdmin_toggle ${playerAdmin_openToggles[playerAdmin_key] ? "open" : ""}`}>
      <button className="playerAdmin_toggleHeader" onClick={() => playerAdmin_toggle(playerAdmin_key)}>{playerAdmin_openToggles[playerAdmin_key] ? <ChevronUp size={18} /> : <ChevronDown size={18} />}<span>{playerAdmin_title}</span></button>
      {playerAdmin_openToggles[playerAdmin_key] && <div className="playerAdmin_toggleBody">{playerAdmin_children}</div>}
    </div>
  );
  const playerAdmin_skillCards = (playerAdmin_school: string, playerAdmin_items: SkillCard[]) => (
    <div className="playerAdmin_cardGrid">{playerAdmin_items.map((playerAdmin_item) => {
      const module = playerAdmin_findSkillModule(playerAdmin_school, playerAdmin_item);
      const key = module?.id || playerAdmin_skillKey(playerAdmin_school, playerAdmin_item.name);
      const maxRank = playerAdmin_skillMaxRank(playerAdmin_school, playerAdmin_item);
      const value = playerAdmin_skillValue(playerAdmin_school, playerAdmin_item);
      const dirty = key in playerAdmin_skillChanges;
      return <article className={`playerAdmin_card playerAdmin_skillCard ${dirty ? "dirty" : ""}`} key={`${playerAdmin_school}-${playerAdmin_item.name}-${playerAdmin_item.type}`}>
        <div className="playerAdmin_skillCardHeader"><strong>{playerAdmin_item.name}</strong><span>{value}/{maxRank}</span></div>
        <span>Type: {playerAdmin_item.type}</span>
        <div className="playerAdmin_rankBars" aria-label={`${playerAdmin_item.name} rank`}>
          {Array.from({ length: maxRank }, (_, index) => {
            const rank = index + 1;
            const active = rank <= value;
            return <button key={rank} type="button" className={active ? "active" : ""} disabled={!module || playerAdmin_actionResult?.pending} title={module ? `Set ${playerAdmin_item.name} to ${value === rank ? 0 : rank}` : "Skill module ID was not found"} onClick={() => playerAdmin_setSkillValue(playerAdmin_school, playerAdmin_item, value === rank ? 0 : rank)} aria-label={`Set ${playerAdmin_item.name} rank ${value === rank ? 0 : rank}`} />;
          })}
        </div>
        <code>{module?.id || "Module ID not found"}</code>
      </article>;
    })}</div>
  );
  const playerAdmin_actionRow = (playerAdmin_key: string, playerAdmin_label: React.ReactNode, playerAdmin_input: React.ReactNode, playerAdmin_buttonLabel: string, playerAdmin_onClick: () => void, playerAdmin_disabled = false, playerAdmin_note = "") => (
    <div className="playerAdmin_actionGroup">
      <div className="playerAdmin_actionRow">
        <span className="playerAdmin_actionLabel">{playerAdmin_label}{playerAdmin_note && <em>{playerAdmin_note}</em>}</span>
        <span className="playerAdmin_fieldGroup">{playerAdmin_input}</span>
        <button disabled={playerAdmin_disabled || playerAdmin_actionResult?.pending} onClick={playerAdmin_onClick}>{playerAdmin_buttonLabel}</button>
        <InlineActionResult result={playerAdmin_actionResult} resultKey={playerAdmin_key} />
      </div>
    </div>
  );
  const playerAdmin_craftingCategoryFilteredRows = playerAdmin_craftingRows.filter((row) => !playerAdmin_craftingCategory || row.category === playerAdmin_craftingCategory);
  const playerAdmin_craftingFilterTerms = playerAdmin_craftingFilter.toLowerCase().split(/\s+/).map((term) => term.trim()).filter(Boolean);
  const playerAdmin_filteredCraftingRows = playerAdmin_craftingFilterTerms.length
    ? playerAdmin_craftingCategoryFilteredRows.filter((row) =>
        playerAdmin_craftingFilterTerms.every((term) => [row.displayName, row.recipeId, row.source, row.category].join(" ").toLowerCase().includes(term)))
    : playerAdmin_craftingCategoryFilteredRows;
  const playerAdmin_researchCategoryFilteredRows = playerAdmin_researchRows.filter((row) =>
    (!playerAdmin_researchCategory || row.category === playerAdmin_researchCategory) &&
    (!playerAdmin_productGroup || row.productGroup === playerAdmin_productGroup)
  );
  const playerAdmin_researchFilterTerms = playerAdmin_researchFilter.toLowerCase().split(/\s+/).map((term) => term.trim()).filter(Boolean);
  const playerAdmin_filteredResearchRows = playerAdmin_researchFilterTerms.length
    ? playerAdmin_researchCategoryFilteredRows.filter((row) =>
        playerAdmin_researchFilterTerms.every((term) => [row.displayName, row.itemKey, row.type, row.productGroup].join(" ").toLowerCase().includes(term)))
    : playerAdmin_researchCategoryFilteredRows;
  const playerAdmin_craftingCategoryCount = (category: string) => playerAdmin_craftingRows.filter((row) => !category || row.category === category).length;
  const playerAdmin_researchCategoryCount = (category: string) => playerAdmin_researchRows.filter((row) => !category || row.category === category).length;
  const playerAdmin_journeyEntryCount = playerAdmin_journeyRows.story.length + playerAdmin_journeyRows.contract.length + playerAdmin_journeyRows.codex.length + playerAdmin_journeyRows.tutorial.length;
  const playerAdmin_journeyFilterTerms = playerAdmin_journeyFilter.toLowerCase().split(/\s+/).map((term) => term.trim()).filter(Boolean);
  const playerAdmin_filterJourneyRows = (rows: JourneyRow[]) => {
    if (!playerAdmin_journeyFilterTerms.length) return rows;
    const byKey = new Map<string, JourneyRow>();
    const childrenByParent = new Map<string, JourneyRow[]>();
    for (const row of rows) {
      for (const key of [row.id, row.rawName].filter(Boolean)) byKey.set(key, row);
    }
    for (const row of rows) {
      const parentKey = row.parentId || row.dependency || "";
      if (!parentKey || !byKey.has(parentKey)) continue;
      childrenByParent.set(parentKey, [...(childrenByParent.get(parentKey) || []), row]);
    }
    const keep = new Set<string>();
    const addRow = (row: JourneyRow) => {
      keep.add(row.id);
      let parentKey = row.parentId || row.dependency || "";
      while (parentKey && byKey.has(parentKey)) {
        const parent = byKey.get(parentKey);
        if (!parent || keep.has(parent.id)) break;
        keep.add(parent.id);
        parentKey = parent.parentId || parent.dependency || "";
      }
    };
    const addDescendants = (row: JourneyRow) => {
      const rowKey = row.id || row.rawName;
      for (const child of childrenByParent.get(rowKey) || []) {
        if (keep.has(child.id)) continue;
        keep.add(child.id);
        addDescendants(child);
      }
    };
    for (const row of rows) {
      const haystack = [row.name, row.rawName, row.id, row.category, row.status, row.dependency || "", row.pendingReward ? "pending reward" : ""].join(" ").toLowerCase();
      if (!playerAdmin_journeyFilterTerms.every((term) => haystack.includes(term))) continue;
      addRow(row);
      addDescendants(row);
    }
    return rows.filter((row) => keep.has(row.id));
  };
  const playerAdmin_filteredJourneyRows = {
    story: playerAdmin_filterJourneyRows(playerAdmin_journeyRows.story),
    contract: playerAdmin_filterJourneyRows(playerAdmin_journeyRows.contract),
    codex: playerAdmin_filterJourneyRows(playerAdmin_journeyRows.codex),
    tutorial: playerAdmin_filterJourneyRows(playerAdmin_journeyRows.tutorial)
  };
  const playerAdmin_filteredJourneyEntryCount = playerAdmin_filteredJourneyRows.story.length + playerAdmin_filteredJourneyRows.contract.length + playerAdmin_filteredJourneyRows.codex.length + playerAdmin_filteredJourneyRows.tutorial.length;
  const playerAdmin_inventoryAllRows = Array.isArray(playerAdmin_inventoryData?.rows) ? playerAdmin_inventoryData.rows as Record<string, unknown>[] : [];
  const playerAdmin_inventoryFilterTerms = playerAdmin_inventoryFilter.toLowerCase().split(/\s+/).map((term) => term.trim()).filter(Boolean);
  const playerAdmin_filteredInventoryRows = playerAdmin_inventoryFilterTerms.length
    ? playerAdmin_inventoryAllRows.filter((row) => {
        const haystack = [row.template_id, row.id, row.inventory_id, row.position_index].map((value) => String(value ?? "")).join(" ").toLowerCase();
        return playerAdmin_inventoryFilterTerms.every((term) => haystack.includes(term));
      })
    : playerAdmin_inventoryAllRows;
  const playerAdmin_vehicleIds = Object.keys(playerAdmin_vehicleCatalog).sort((a, b) => friendlyVehicleName(a).localeCompare(friendlyVehicleName(b)));
  const playerAdmin_selectedTemplates = [...(playerAdmin_vehicleCatalog[playerAdmin_vehicleId] || [])].sort((a, b) => friendlyVehicleTemplateName(a).localeCompare(friendlyVehicleTemplateName(b)));
  const playerAdmin_starterSkillPresets: Record<string, StarterSkillPreset> = {
    Trooper: {
      label: "Trooper starter skills",
      modules: [
        { id: "Skills.Key.Trooper1", level: 1 },
        { id: "Skills.Ability.CablePull", level: 1 }
      ]
    },
    Mentat: {
      label: "Mentat starter skills",
      modules: [
        { id: "Skills.Key.Mentat1", level: 1 },
        { id: "Skills.Ability.TurretSeeker", level: 1 }
      ]
    },
    Planetologist: {
      label: "Planetologist starter skills",
      modules: [
        { id: "Skills.Key.Planetologist1", level: 1 },
        { id: "Skills.Ability.SuspensorPad", level: 1 }
      ]
    },
    "Bene Gesserit": {
      label: "Bene Gesserit starter skills",
      modules: [
        { id: "Skills.Key.BeneGesserit1", level: 1 },
        { id: "Skills.Ability.VoiceCompel", level: 1 }
      ]
    },
    Swordmaster: {
      label: "Swordmaster starter skills",
      modules: [
        { id: "Skills.Key.Swordmaster1", level: 1 },
        { id: "Skills.Ability.KneeCharge", level: 1 }
      ]
    }
  };
  const playerAdmin_starterSkillPreset = playerAdmin_starterSkillPresets[playerAdmin_skillSchool];
  async function playerAdmin_restoreStarterSkills() {
    if (!playerAdmin_starterSkillPreset) {
      playerAdmin_showResult("starterSkills", `No verified starter preset is available for ${playerAdmin_skillSchool}.`, "danger");
      return;
    }
    if (!(await confirmAction(`Restore the ${playerAdmin_skillSchool} starter unlocks for ${playerName}. This will set the starter phase and starter ability to Rank 1.`, {
      title: "Restore Starter Skills",
      confirmLabel: "Restore",
      details: [{
        label: "Modules",
        value: playerAdmin_starterSkillPreset.modules.map((module) => `${module.id} -> Rank ${module.level}`).join(", "),
        tone: "accent"
      }]
    }))) return;
    onError("");
    playerAdmin_showResult("starterSkills", `Restoring ${playerAdmin_starterSkillPreset.label} for ${playerName}`, "neutral", true);
    try {
      for (const module of playerAdmin_starterSkillPreset.modules) {
        await playerAdmin_runTask(() => playersApi.setSkillModule(actionPlayerId, { module: module.id, level: module.level }));
      }
      playerAdmin_showResult("starterSkills", `${playerAdmin_starterSkillPreset.label} restored for ${playerName}.`, "success");
      playerAdmin_addLog("Restore Starter Skills", playerAdmin_skillSchool, String(playerAdmin_starterSkillPreset.modules.length), "Succeeded");
      await playerAdmin_loadSkillCatalog();
    } catch (error) {
      const message = friendlyInlineError(error);
      playerAdmin_showResult("starterSkills", message, "danger");
      playerAdmin_addLog("Restore Starter Skills", playerAdmin_skillSchool, String(playerAdmin_starterSkillPreset.modules.length), `Failed: ${message}`);
    }
  }
  const playerAdmin_craftingDisplayRows = playerAdmin_filteredCraftingRows.map((row) => ({ ...row, recipeName: row.displayName }));
  const playerAdmin_craftingSort = useSortableRows(playerAdmin_craftingDisplayRows);
  const playerAdmin_craftingTable = (
    <DataTable
      rows={playerAdmin_craftingSort.sortedRows}
      columns={["recipeName", "recipeId", "source", "qualityLevel"]}
      emptyMessage={playerAdmin_craftingLoading ? "Loading recipes..." : "No crafting recipes found for this category."}
      sortColumn={playerAdmin_craftingSort.sortColumn}
      sortDirection={playerAdmin_craftingSort.sortDirection}
      onSort={playerAdmin_craftingSort.onSort}
      resizableColumns
      tableClassName="playerAdmin_schematicTable"
      rowKey={(row) => String(row.recipeId)}
      renderCell={(row, col) =>
        col === "recipeId" ? <code>{String(row.recipeId)}</code> :
        col === "source" ? friendlyCraftingSource(String(row.source)) :
        formatCell(row[col])
      }
      secondaryAction={(row) => <InlineActionResult result={playerAdmin_actionResult} resultKey={`crafting:${row.recipeId}`} />}
      secondaryActionLabel="Result"
      action={(row) => <button className="playerAdmin_stateActionButton" disabled={!dbPlayerId || Boolean(row.unlocked) || Boolean(playerAdmin_busyActionKey)} onClick={() => playerAdmin_unlockCraftingRecipe(row as unknown as CraftingRecipeRow)}>{playerAdmin_busyActionKey === `crafting:${row.recipeId}` ? "Unlocking..." : row.unlocked ? "Unlocked" : "Unlock"}</button>}
    />
  );
  const playerAdmin_researchDisplayRows = playerAdmin_filteredResearchRows.map((row) => ({ ...row, researchName: row.displayName }));
  const playerAdmin_researchSort = useSortableRows(playerAdmin_researchDisplayRows);
  const playerAdmin_researchTable = (
    <DataTable
      rows={playerAdmin_researchSort.sortedRows}
      columns={["researchName", "itemKey", "type", "productGroup"]}
      emptyMessage={playerAdmin_researchLoading ? "Loading research..." : "No research entries found for this filter."}
      sortColumn={playerAdmin_researchSort.sortColumn}
      sortDirection={playerAdmin_researchSort.sortDirection}
      onSort={playerAdmin_researchSort.onSort}
      resizableColumns
      tableClassName="playerAdmin_schematicTable"
      rowKey={(row) => String(row.itemKey)}
      renderCell={(row, col) => col === "itemKey" ? <code>{String(row.itemKey)}</code> : formatCell(row[col])}
      secondaryAction={(row) => <InlineActionResult result={playerAdmin_actionResult} resultKey={`research:${row.itemKey}`} />}
      secondaryActionLabel="Result"
      action={(row) => <button className="playerAdmin_stateActionButton" disabled={!dbPlayerId || Boolean(row.unlocked) || Boolean(playerAdmin_busyActionKey)} onClick={() => playerAdmin_unlockResearchItem(row as unknown as ResearchItemRow)}>{playerAdmin_busyActionKey === `research:${row.itemKey}` ? "Researching..." : row.unlocked ? "Researched" : "Research"}</button>}
    />
  );
  const playerAdmin_journeySortStory = useSortState();
  const playerAdmin_journeySortContract = useSortState();
  const playerAdmin_journeySortCodex = useSortState();
  const playerAdmin_journeySortTutorial = useSortState();
  const playerAdmin_journeyResizeStory = useResizableColumns();
  const playerAdmin_journeyResizeContract = useResizableColumns();
  const playerAdmin_journeyResizeCodex = useResizableColumns();
  const playerAdmin_journeyResizeTutorial = useResizableColumns();
  const playerAdmin_journeyColumnValue: Record<string, (row: JourneyRow) => unknown> = {
    name: (row) => row.name,
    category: (row) => row.category,
    id: (row) => row.rawName || row.id,
    dependency: (row) => row.dependency || "",
    status: (row) => row.status,
    tags: (row) => row.tags || 0
  };
  const playerAdmin_journeyColumns: { key: string; label: string }[] = [
    { key: "name", label: "Name" },
    { key: "category", label: "Type" },
    { key: "id", label: "ID" },
    { key: "dependency", label: "Depends On" },
    { key: "status", label: "Status" },
    { key: "tags", label: "Tags" }
  ];
  const playerAdmin_journeyTable = (rows: JourneyRow[], emptyText: string, sort: ReturnType<typeof useSortState>, resize: ReturnType<typeof useResizableColumns>) => {
    const sortGroup = (group: JourneyRow[]) => sort.sortColumn ? [...group].sort((a, b) => compareTableValues(playerAdmin_journeyColumnValue[sort.sortColumn!](a), playerAdmin_journeyColumnValue[sort.sortColumn!](b), sort.sortDirection!)) : group;
    const childrenByParent = new Map<string, JourneyRow[]>();
    const rowKeys = new Set(rows.flatMap((row) => [row.id, row.rawName]).filter(Boolean));
    for (const row of rows) {
      const parentKey = row.parentId || row.dependency || "";
      if (!parentKey || !rowKeys.has(parentKey)) continue;
      childrenByParent.set(parentKey, [...(childrenByParent.get(parentKey) || []), row]);
    }
    const pushVisible = (row: JourneyRow, output: JourneyRow[]) => {
      output.push(row);
      const rowKey = row.id || row.rawName;
      if (!playerAdmin_journeyFilterTerms.length && !playerAdmin_expandedJourney[`${row.category}:${rowKey}`]) return;
      for (const child of sortGroup(childrenByParent.get(rowKey) || [])) pushVisible(child, output);
    };
    const childIds = new Set(Array.from(childrenByParent.values()).flat().flatMap((row) => [row.id, row.rawName]).filter(Boolean));
    const visibleRows: JourneyRow[] = [];
    for (const row of sortGroup(rows.filter((row) => !childIds.has(row.id) && !childIds.has(row.rawName)))) {
      pushVisible(row, visibleRows);
    }
    return (
    <div className="playerAdmin_tableWrap">
      <table className="playerAdmin_table playerAdmin_compactTable playerAdmin_fullResultTable playerAdmin_journeyTable">
        <thead><tr>{playerAdmin_journeyColumns.map((col) => <th key={col.key} className="sortable" style={resize.columnStyle(col.key)} onClick={() => sort.onSort(col.key)}>{col.label}{sort.sortColumn === col.key && <span className="sort-indicator">{sort.sortDirection === "desc" ? " ↓" : " ↑"}</span>}{resize.resizeHandle(col.key)}</th>)}<th>Result</th><th>Action</th></tr></thead>
        <tbody>
          {visibleRows.map((row) => {
            const key = `journey:${row.category}:${row.id}`;
            const rowKey = row.id || row.rawName;
            const hasChildren = Boolean(childrenByParent.get(rowKey)?.length);
            const expanded = playerAdmin_journeyFilterTerms.length ? hasChildren : Boolean(playerAdmin_expandedJourney[`${row.category}:${rowKey}`]);
            return <tr key={`${row.category}-${row.id}`}>
              <td className="playerAdmin_journeyName" style={{ ...resize.columnStyle("name"), paddingLeft: `${10 + row.depth * 18}px` }}>{hasChildren ? <button className="playerAdmin_expanderButton" type="button" onClick={() => playerAdmin_toggleJourney(`${row.category}:${rowKey}`)}>{expanded ? "-" : "+"}</button> : <span className="playerAdmin_expanderSpacer" />}<span title={row.name}>{row.name}</span></td>
              <td style={resize.columnStyle("category")}>{row.category}</td>
              <td className="playerAdmin_shortCode" style={resize.columnStyle("id")}><code title={row.rawName || row.id} style={resize.columnStyle("id") ? { maxWidth: "100%" } : undefined}>{row.rawName || row.id}</code></td>
              <td className="playerAdmin_shortCode" style={resize.columnStyle("dependency")}>{row.dependency ? <code title={row.dependency} style={resize.columnStyle("dependency") ? { maxWidth: "100%" } : undefined}>{row.dependency}</code> : "Unknown"}</td>
              <td style={resize.columnStyle("status")}>{row.status}{row.pendingReward ? " / Pending Reward" : ""}</td>
              <td style={resize.columnStyle("tags")}>{row.category === "Tutorial" ? "-" : row.tags || 0}</td>
              <td className="playerAdmin_resultCell"><InlineActionResult result={playerAdmin_actionResult} resultKey={key} /></td>
              <td className="playerAdmin_actionCell">
                <button disabled={!dbPlayerId || row.complete || playerAdmin_actionResult?.pending} onClick={() => playerAdmin_completeJourney(row)}>{row.complete ? "Complete" : "Complete"}</button>
                <button disabled={!dbPlayerId || playerAdmin_actionResult?.pending} onClick={() => playerAdmin_resetJourney(row)}>Reset</button>
              </td>
            </tr>;
          })}
          {!visibleRows.length && <tr><td colSpan={8}>{playerAdmin_journeyLoading ? "Loading journey data..." : emptyText}</td></tr>}
        </tbody>
      </table>
    </div>
    );
  };
  const playerAdmin_researchGroups: Record<string, string[]> = {
    "Water Discipline": ["Salvage Products", "Copper Products", "Iron Products", "Steel Products", "Aluminum Products", "Duraluminum Products", "Plastanium Products"],
    Combat: ["Salvage Products", "Copper Products", "Iron Products", "Steel Products", "Aluminum Products", "Duraluminum Products", "Plastanium Products"],
    Construction: ["Salvage Products", "Copper Products", "Iron Products", "Steel Products", "Aluminum Products", "Duraluminum Products", "Plastanium Products"],
    Exploration: ["Salvage Products", "Copper Products", "Iron Products", "Steel Products", "Aluminum Products", "Duraluminum Products", "Plastanium Products"],
    Vehicles: ["Copper Products", "Iron Products", "Steel Products", "Aluminum Products", "Duraluminum Products", "Plastanium Products"],
    Augmentations: ["Garment Augmentations", "Melee Weapon Augmentations", "Ranged Weapon Augmentations", "Generic Augmentations"],
    Uniques: ["Copper Products", "Iron Products", "Steel Products", "Aluminum Products", "Duraluminum Products", "Plastanium Products"]
  };
  const playerAdmin_skillTrees: Record<string, { tree: string; cards: { name: string; type: string; rank: string }[] }[]> = {
    Trooper: [
      { tree: "Gunnery", cards: [{ name: "Energy Capsule", type: "Ability", rank: "1" }, { name: "Heavy Weapon Damage", type: "Passive", rank: "3" }, { name: "Gunsmith", type: "Passive", rank: "3" }, { name: "Heavy Weapon Agility", type: "Technique", rank: "3" }, { name: "Scattergun Damage", type: "Passive", rank: "3" }, { name: "Field Maintenance", type: "Passive", rank: "3" }, { name: "Disruptor Damage", type: "Passive", rank: "3" }, { name: "Center of Mass", type: "Technique", rank: "3" }, { name: "Ranged Damage", type: "Passive", rank: "3" }] },
      { tree: "Suspensor Training", cards: [{ name: "Suspensor Blast", type: "Ability", rank: "1" }, { name: "Death from Above", type: "Technique", rank: "3" }, { name: "Collapse Grenade", type: "Ability", rank: "1" }, { name: "Suspensor Efficiency", type: "Passive", rank: "3" }, { name: "Suspensor Dash", type: "Technique", rank: "1" }, { name: "Gravity Field", type: "Ability", rank: "1" }, { name: "Anti-gravity Field", type: "Ability", rank: "1" }] },
      { tree: "Tactical Tech", cards: [{ name: "Reflexive Reload", type: "Passive", rank: "1" }, { name: "Assault Seeker", type: "Ability", rank: "3" }, { name: "Attractor Field", type: "Ability", rank: "1" }, { name: "Explosive Grenade", type: "Ability", rank: "3" }, { name: "Battle Hardened", type: "Technique", rank: "3" }, { name: "Shigawire Claw", type: "Ability", rank: "3" }] }
    ],
    Mentat: [
      { tree: "Mental Calculus", cards: [{ name: "Shield Overcharge", type: "Passive", rank: "1" }, { name: "Exploit Weakness", type: "Technique", rank: "1" }, { name: "Rifle Damage", type: "Passive", rank: "3" }, { name: "Tailoring", type: "Passive", rank: "3" }, { name: "Marksman", type: "Technique", rank: "3" }, { name: "Pistol Damage", type: "Passive", rank: "3" }, { name: "Garment Keeper", type: "Passive", rank: "3" }, { name: "Ranged Damage", type: "Passive", rank: "3" }, { name: "The Sentinel", type: "Ability", rank: "3" }] },
      { tree: "Assassination", cards: [{ name: "Hunter-Seeker", type: "Ability", rank: "1" }, { name: "Poison Tooth", type: "Technique", rank: "3" }, { name: "Stunner", type: "Ability", rank: "1" }, { name: "Assassin's Shot", type: "Passive", rank: "3" }, { name: "Poison Mine", type: "Ability", rank: "3" }, { name: "Headshot Damage", type: "Passive", rank: "3" }, { name: "Poison Capsule", type: "Ability", rank: "3" }] },
      { tree: "Tactician", cards: [{ name: "Source of Power", type: "Ability", rank: "1" }, { name: "Anti-gravity Mine", type: "Ability", rank: "1" }, { name: "Iron Will", type: "Technique", rank: "1" }, { name: "Gravity Mine", type: "Ability", rank: "1" }, { name: "Solido Decoy", type: "Ability", rank: "1" }, { name: "Shield Wall", type: "Ability", rank: "3" }] }
    ],
    Planetologist: [
      { tree: "Scientist", cards: [{ name: "Conservation of Energy", type: "Technique", rank: "3" }, { name: "Compaction", type: "Passive", rank: "3" }, { name: "Overcharge", type: "Passive", rank: "3" }, { name: "Deep Analysis", type: "Passive", rank: "3" }, { name: "Dew Gathering", type: "Passive", rank: "3" }, { name: "Rerouting", type: "Passive", rank: "3" }, { name: "Cutteray Mining", type: "Passive", rank: "3" }] },
      { tree: "Explorer", cards: [{ name: "Spice Surveyor", type: "Passive", rank: "1" }, { name: "Scanner Mastery", type: "Passive", rank: "3" }, { name: "Stillsuit Seals", type: "Passive", rank: "3" }, { name: "Cartographer", type: "Passive", rank: "1" }, { name: "Mountaineer", type: "Passive", rank: "3" }, { name: "Suspensor Pad", type: "Ability", rank: "1" }] },
      { tree: "Mechanic", cards: [{ name: "Heat Management", type: "Passive", rank: "1" }, { name: "Fuel Efficient Pilot", type: "Passive", rank: "3" }, { name: "Sandcrawler Yield", type: "Passive", rank: "3" }, { name: "Vehicle Scanning", type: "Passive", rank: "3" }, { name: "Fuel Efficient Driver", type: "Passive", rank: "3" }, { name: "Vehicle Mining", type: "Passive", rank: "3" }, { name: "Vehicle Repair", type: "Passive", rank: "3" }] }
    ],
    "Bene Gesserit": [
      { tree: "Weirding Way", cards: [{ name: "Bindu Dodge", type: "Passive", rank: "1" }, { name: "Prana-Bindu Strikes", type: "Ability", rank: "1" }, { name: "Weirding Step", type: "Ability", rank: "1" }, { name: "Short Blade Damage", type: "Passive", rank: "3" }, { name: "Manipulate Instability", type: "Technique", rank: "3" }, { name: "Blade Damage", type: "Passive", rank: "3" }, { name: "Bindu Sprint", type: "Ability", rank: "3" }] },
      { tree: "The Voice", cards: [{ name: "Screech", type: "Passive", rank: "1" }, { name: "Rapid Register", type: "Technique", rank: "1" }, { name: "Stop", type: "Ability", rank: "1" }, { name: "Ignore", type: "Ability", rank: "1" }, { name: "Voice Training", type: "Passive", rank: "3" }, { name: "Compel", type: "Ability", rank: "1" }] },
      { tree: "Body Control", cards: [{ name: "Litany Against Fear", type: "Ability", rank: "3" }, { name: "Prana-Bindu Stability", type: "Technique", rank: "3" }, { name: "Metabolize Poison", type: "Technique", rank: "1" }, { name: "Vitality", type: "Passive", rank: "3" }, { name: "Self-Healing", type: "Passive", rank: "3" }, { name: "Poison Tolerance", type: "Passive", rank: "3" }, { name: "Trauma Recovery", type: "Technique", rank: "3" }, { name: "Sun Tolerance", type: "Passive", rank: "3" }, { name: "Recovery", type: "Passive", rank: "3" }] }
    ],
    Swordmaster: [
      { tree: "The Blade", cards: [{ name: "Precise Parry", type: "Passive", rank: "3" }, { name: "Eye of the Storm", type: "Ability", rank: "3" }, { name: "Foil", type: "Ability", rank: "1" }, { name: "Long Blade Damage", type: "Passive", rank: "3" }, { name: "Dance of Blades", type: "Technique", rank: "3" }, { name: "Retaliate", type: "Ability", rank: "1" }, { name: "Blade Damage", type: "Passive", rank: "3" }] },
      { tree: "The Will", cards: [{ name: "Thrive on Danger", type: "Technique", rank: "1" }, { name: "Solid Stance", type: "Passive", rank: "3" }, { name: "Confidence", type: "Passive", rank: "3" }, { name: "Bleed Tolerance", type: "Passive", rank: "3" }, { name: "Reckless Lunge", type: "Technique", rank: "3" }, { name: "Deflection", type: "Ability", rank: "1" }] },
      { tree: "The Way", cards: [{ name: "Prescient Strike", type: "Passive", rank: "1" }, { name: "General Conditioning", type: "Passive", rank: "3" }, { name: "Desert Conditioning", type: "Passive", rank: "3" }, { name: "Crippling Strike", type: "Ability", rank: "1" }, { name: "Disciplined Breathing", type: "Technique", rank: "3" }, { name: "Inspiration", type: "Ability", rank: "3" }, { name: "Field Medicine", type: "Passive", rank: "3" }, { name: "Optimized Hydration", type: "Passive", rank: "3" }, { name: "Knee Charge", type: "Ability", rank: "3" }] }
    ]
  };

  function playerAdmin_openSkillTreeToggles(school: string) {
    const trees = playerAdmin_skillTrees[school] || [];
    if (!trees.length) return;
    playerAdmin_setOpenToggles((current) => {
      const next = { ...current };
      for (const tree of trees) next[`skill_${school}_${tree.tree}`] = true;
      return next;
    });
  }

  return (
    <section className="playerAdmin_container" aria-label="Player admin layout">
      <div className="playerAdmin_header"><p className="playerAdmin_experimentalNotice">Some features in this section are experimental. Please report anything that isn't working correctly or appears out of place.</p><button onClick={onClose}>Close</button></div>
      <PlayerSummary detail={detail} fallback={fallback} dbPlayerId={dbPlayerId} actionPlayerId={actionPlayerId} />
      <div className="playerAdmin_tabs" role="tablist" aria-label="Player admin tabs">{playerAdmin_tabs.map((playerAdmin_tab) => {
        const TabIcon = playerAdmin_tab.icon;
        return <button key={playerAdmin_tab.label} className={playerAdmin_activeTab === playerAdmin_tab.label ? "active" : ""} onClick={() => playerAdmin_setActiveTab(playerAdmin_tab.label)}><TabIcon size={17} aria-hidden="true" /><span>{playerAdmin_tab.label}</span></button>;
      })}</div>
      {playerAdmin_activeTab === "Character" && <div className="playerAdmin_content">
        {playerAdmin_toggleBox("quick_rewards", "Quick Rewards", <div className="playerAdmin_section playerAdmin_quickRewardsSection">
          <div className="playerAdmin_quickButtonRow">
              <button disabled={!playerAdmin_canRunLiveAction || playerAdmin_actionResult?.pending} onClick={() => playerAdmin_runAction("water", `Giving water to ${playerName}`, () => playerAdmin_runTask(() => playersApi.giveItemId(actionPlayerId, { itemId: "WaterPack_Consumable", quantity: 10, durability: 1 })), `${playerName} received water.`, { actionType: "Give Water", target: playerName, amount: "10" })}>Give Water</button>
              <button disabled={!playerAdmin_canRunLiveAction || playerAdmin_actionResult?.pending} onClick={() => playerAdmin_runAction("refill", `Refilling ${playerName}'s container`, () => playerAdmin_runTask(() => playersApi.refillWater(actionPlayerId)), `${playerName}'s container was filled successfully.`, { actionType: "Refill Container", target: playerName, amount: "1" })}>Refill Container</button>
              <div className="playerAdmin_quickButtonResult">
                {playerAdmin_actionResult?.key === "refill"
                  ? <InlineActionResult result={playerAdmin_actionResult} resultKey="refill" />
                  : playerAdmin_actionResultOrNote("water", "The player must be online.")}
              </div>
          </div>
          {playerAdmin_actionRow("xp", "Give XP", <input type="number" min="1" value={playerAdmin_xpAmount} onChange={(event) => playerAdmin_setXpAmount(event.target.value)} />, "Give", () => playerAdmin_runAction("xp", `Giving ${Number(playerAdmin_xpAmount) || 0} XP to ${playerName}`, () => playerAdmin_runTask(() => playersApi.addXp(actionPlayerId, Number(playerAdmin_xpAmount) || 0)), `${playerName} received ${Number(playerAdmin_xpAmount) || 0} XP.`, { actionType: "Give XP", target: playerName, amount: String(Number(playerAdmin_xpAmount) || 0) }), !playerAdmin_canRunLiveAction, "The player must be online.")}
          {playerAdmin_actionRow("currency", "Give Currency", <><select value={playerAdmin_currencyType} onChange={(event) => playerAdmin_setCurrencyType(event.target.value)}><option>Solari Credit</option><option>Scrip</option></select><input type="number" min="1" value={playerAdmin_currencyAmount} onChange={(event) => playerAdmin_setCurrencyAmount(event.target.value)} /></>, "Give", () => playerAdmin_runAction("currency", `Giving ${Number(playerAdmin_currencyAmount) || 0} ${playerAdmin_currencyType} to ${playerName}`, () => playersApi.addCurrency(dbPlayerId, { currencyId: playerAdmin_currencyType === "Scrip" ? 1 : 0, amount: Number(playerAdmin_currencyAmount) || 0, confirmation: "ADD CURRENCY" }), `${playerName}'s ${playerAdmin_currencyType} was updated. Relog required.`, { actionType: `Give ${playerAdmin_currencyType}`, target: playerName, amount: String(Number(playerAdmin_currencyAmount) || 0) }), !dbPlayerId, "A relog is required to see the change.")}
          {playerAdmin_actionRow("intel", "Give Intel", <input type="number" min="1" value={playerAdmin_intelAmount} onChange={(event) => playerAdmin_setIntelAmount(event.target.value)} />, "Give", () => playerAdmin_runAction("intel", `Giving ${Number(playerAdmin_intelAmount) || 0} Intel to ${playerName}`, () => playersApi.addIntel(dbPlayerId, { amount: Number(playerAdmin_intelAmount) || 0, confirmation: "ADD INTEL" }), `${playerName}'s Intel was updated and will load on next join.`, { actionType: "Give Intel", target: playerName, amount: String(Number(playerAdmin_intelAmount) || 0) }), !dbPlayerId || playerAdmin_isOnline, playerAdmin_isOnline ? "The player must be offline." : "The player must be offline for this database edit.")}
          {playerAdmin_actionRow("faction", "Give Faction Reputation", <><select value={playerAdmin_factionName} onChange={(event) => playerAdmin_setFactionName(event.target.value)}><option>Atreides</option><option>Harkonnen</option><option>Smuggler</option></select><input type="number" min="1" max="12474" value={playerAdmin_factionAmount} onChange={(event) => playerAdmin_setFactionAmount(event.target.value)} /></>, "Give", () => playerAdmin_runAction("faction", `Giving ${Number(playerAdmin_factionAmount) || 0} ${playerAdmin_factionName} reputation to ${playerName}`, () => playersApi.addFactionReputation(dbPlayerId, { factionId: playerAdmin_factionIds[playerAdmin_factionName] || 1, amount: Number(playerAdmin_factionAmount) || 0, confirmation: "ADD FACTION REPUTATION" }), `${playerName}'s faction reputation was updated. Relog required.`, { actionType: "Give Faction Reputation", target: playerAdmin_factionName, amount: String(Number(playerAdmin_factionAmount) || 0) }), !dbPlayerId, "A relog is required to see the change.")}
        </div>)}
         <div className={`playerAdmin_toggle ${playerAdmin_openToggles.give_items ? "open" : ""}`}><button className="playerAdmin_toggleHeader" onClick={() => playerAdmin_toggle("give_items")}>{playerAdmin_openToggles.give_items ? <ChevronUp size={18} /> : <ChevronDown size={18} />}<span>Give Items</span></button>{playerAdmin_openToggles.give_items && <div className="playerAdmin_toggleBody"><div className="playerAdmin_section"><ItemCatalogSelector selected={playerAdmin_selectedItem} onSelect={playerAdmin_chooseItem} /><div className="playerAdmin_itemActionStack"><div className="playerAdmin_itemInputLine"><span className="playerAdmin_actionLabel playerAdmin_itemSelectedLabel">Selected Item</span><label className="playerAdmin_itemNumberField">Quantity<input className="package-item-quantity-input" type="number" min="1" value={playerAdmin_quantity} onChange={(event) => playerAdmin_setQuantity(event.target.value)} /></label><label className="playerAdmin_itemNumberField">Grade<ItemGradeSelect value={playerAdmin_grade} minGrade={catalogItemMinimumGrade(playerAdmin_selectedItem)} onChange={playerAdmin_setGrade} /></label>{playerAdmin_filteredAugments.length > 0 && <><div className="playerAdmin_itemNumberField"><span>Augments</span><AugmentDropdown options={playerAdmin_displayAugments} value={playerAdmin_selectedAugments} maxSelected={playerAdmin_augmentLimit(playerAdmin_itemName, playerAdmin_itemId, playerAdmin_selectedItem?.category, playerAdmin_selectedItem?.source)} onChange={(selected) => playerAdmin_setSelectedAugments(selected.slice(0, playerAdmin_augmentLimit(playerAdmin_itemName, playerAdmin_itemId, playerAdmin_selectedItem?.category, playerAdmin_selectedItem?.source)))} /></div><label className="playerAdmin_itemNumberField">Aug. Grade<ItemGradeSelect value={playerAdmin_augmentGradeValue} minGrade={1} disabled={playerAdmin_selectedAugments.length === 0} emptyWhenDisabled onChange={playerAdmin_setAugmentGradeValue} /></label></>}<div className="playerAdmin_actionRow playerAdmin_itemActionRow"><button disabled={!playerAdmin_canGiveSelectedItems || playerAdmin_actionResult?.pending} onClick={() => void playerAdmin_giveMultipleItems()}>{playerAdmin_multiList.length ? "Give Package" : "Give Item"}</button><button disabled={!playerAdmin_selectedItem} onClick={playerAdmin_addSelectedItem}>Add Item</button><InlineActionResult result={playerAdmin_actionResult} resultKey="giveMultiple" /></div></div><p className="action-help-note">Grade 0 items with no augments can be granted while the player is online. Item Grades 1-5 or Augment Grades 1-5 require the player to be offline.</p></div>
          {playerAdmin_multiList.length ? <div className="table-wrap package-items-table playerAdmin_itemsTable"><table><thead><tr><th>Preview</th><th>Item Name</th><th>Item ID</th><th>Quantity</th><th>Grade</th><th>Augments</th><th>Aug. Grade</th><th>Actions</th></tr></thead><tbody>{playerAdmin_multiList.map((item, index) => {
            const editing = playerAdmin_itemEditIndex === index;
            return <tr key={`${item.itemName || item.itemId}-${index}`}><td><PackageItemPreview item={item} /></td><td>{catalogItemName(item)}</td><td>{catalogItemId(item)}</td><td>{editing ? <input className="package-item-quantity-input" type="number" min="1" value={playerAdmin_itemEditDraft.quantity} onChange={(event) => playerAdmin_setItemEditDraft({ ...playerAdmin_itemEditDraft, quantity: event.target.value })} /> : item.quantity}</td><td>{editing ? <ItemGradeSelect value={playerAdmin_itemEditDraft.grade} minGrade={catalogItemMinimumGrade(item)} onChange={(grade) => playerAdmin_setItemEditDraft({ ...playerAdmin_itemEditDraft, grade })} /> : itemGrade(item)}</td><td style={{ fontSize: "11px" }}><span className="package-augment-summary">{(item.augments && item.augments.length > 0) ? item.augments.map((augId) => { const found = playerAdmin_augmentCatalog.find((a) => a.id === augId); return found ? found.name : augId; }).join(", ") : "—"}</span></td><td>{item.augments?.length ? (editing ? <ItemGradeSelect value={playerAdmin_itemEditDraft.augmentGrade} minGrade={1} onChange={(augmentGrade) => playerAdmin_setItemEditDraft({ ...playerAdmin_itemEditDraft, augmentGrade })} /> : (item.augmentQuality ?? 1)) : "—"}</td><td className="package-actions-cell"><div className="service-actions">{editing ? <><button onClick={() => playerAdmin_saveQueuedItem(index)}>Save</button><button onClick={() => playerAdmin_setItemEditIndex(null)}>Cancel</button></> : <button onClick={() => playerAdmin_editQueuedItem(index)}>Edit</button>}<button className="danger" onClick={() => playerAdmin_setMultiList(playerAdmin_multiList.filter((_, itemIndex) => itemIndex !== index))}>Remove</button></div></td></tr>;
          })}</tbody></table></div> : null}
        </div></div>}</div>
        {playerAdmin_toggleBox("character_inventory", `Inventory (${playerAdmin_filteredInventoryRows.length}${playerAdmin_inventoryFilterTerms.length ? `/${playerAdmin_inventoryAllRows.length}` : ""})`, <><div className="playerAdmin_boxHeaderLine playerAdmin_filterHeaderLine"><p>A relog is required to see the change.</p><div className="playerAdmin_filterToolsRow"><input className="playerAdmin_filterTextInput" value={playerAdmin_inventoryFilter} onChange={(event) => playerAdmin_setInventoryFilter(event.target.value)} placeholder="Filter by item ID or template" aria-label="Filter Inventory" />{playerAdmin_inventoryFilter && <button type="button" onClick={() => playerAdmin_setInventoryFilter("")}>Clear</button>}</div></div><PlayerDetailTab playerId={dbPlayerId} data={playerAdmin_inventoryData} rows={playerAdmin_filteredInventoryRows} emptyMessage={playerAdmin_inventoryFilterTerms.length ? "No inventory items match this filter." : "No inventory items were found."} onReload={playerAdmin_loadInventoryRows} onError={onError} confirmAction={confirmAction} formatMutationResult={formatMutationResult} playerIsOnline={playerAdmin_isOnline} onActionLog={(actionType, target, amount, notes) => playerAdmin_addLog(actionType, target, amount, notes)} /></>)}
        {playerAdmin_toggleBox("character_log", "Character Action Log", <div className="playerAdmin_logSection">{playerAdmin_characterLog.length > 0 && <div className="action-row admin-history-actions"><button onClick={() => playerAdmin_setCharacterLog([])}>Clear</button></div>}{playerAdmin_characterLog.length ? playerAdmin_table(["Date / Time", "Admin", "Action Type", "Target", "Amount", "Notes"], playerAdmin_characterLog) : <p>No character actions have been recorded in this layout yet.</p>}</div>)}
      </div>}
      {playerAdmin_activeTab === "Crafting" && (
        <div className="playerAdmin_content">
          <section className="playerAdmin_box">
            <h4>Crafting Schematics</h4>
            <div className="playerAdmin_boxHeaderLine playerAdmin_filterHeaderLine">
              <p>Recipe unlocks require the player to be offline. The Grade shown is the recipe grade found in the game database.</p>
            </div>
            <div className="playerAdmin_filterRow playerAdmin_filterActionLine">
              <div className="playerAdmin_filterToolsRow">
                <input className="playerAdmin_filterTextInput" value={playerAdmin_craftingFilter} onChange={(event) => playerAdmin_setCraftingFilter(event.target.value)} placeholder="Filter by name, recipe ID, source, or category" aria-label="Filter Crafting Schematics" />
                {playerAdmin_craftingFilter && <button type="button" onClick={() => playerAdmin_setCraftingFilter("")}>Clear</button>}
                <span className="playerAdmin_note">{playerAdmin_craftingFilterTerms.length ? `${playerAdmin_filteredCraftingRows.length} of ${playerAdmin_craftingCategoryFilteredRows.length}` : playerAdmin_craftingCategoryFilteredRows.length} Schematic{(playerAdmin_craftingFilterTerms.length ? playerAdmin_filteredCraftingRows.length : playerAdmin_craftingCategoryFilteredRows.length) === 1 ? "" : "s"} Detected</span>
              </div>
              <div className="playerAdmin_filterActionsRight">
                <button disabled={!dbPlayerId || playerAdmin_craftingLoading} onClick={() => playerAdmin_loadCraftingRecipes()}>{playerAdmin_craftingLoading ? "Loading..." : "Reload"}</button>
              </div>
            </div>
            <PlayerCategoryIconRail
              options={playerAdmin_craftingCategories}
              value={playerAdmin_craftingCategory}
              onChange={playerAdmin_setCraftingCategory}
              includeAll={false}
            />
            {playerAdmin_craftingError ? <p className="playerAdmin_note danger">{playerAdmin_craftingError}</p> : playerAdmin_craftingTable}
          </section>
        </div>
      )}
      {playerAdmin_activeTab === "Research" && (
        <div className="playerAdmin_content">
          <section className="playerAdmin_box">
            <h4>Research Schematics</h4>
            <div className="playerAdmin_boxHeaderLine playerAdmin_filterHeaderLine">
              <p>Research unlocks require the player to be offline. Unlocking research may also materialize its linked crafting recipe when the game database exposes one.</p>
            </div>
            <div className="playerAdmin_filterRow playerAdmin_filterActionLine">
              <div className="playerAdmin_filterToolsRow">
                <input className="playerAdmin_filterTextInput" value={playerAdmin_researchFilter} onChange={(event) => playerAdmin_setResearchFilter(event.target.value)} placeholder="Filter by name, item key, type, or product group" aria-label="Filter Research Schematics" />
                {playerAdmin_researchFilter && <button type="button" onClick={() => playerAdmin_setResearchFilter("")}>Clear</button>}
                <span className="playerAdmin_note">{playerAdmin_researchFilterTerms.length ? `${playerAdmin_filteredResearchRows.length} of ${playerAdmin_researchCategoryFilteredRows.length}` : playerAdmin_researchCategoryFilteredRows.length} Research Entr{(playerAdmin_researchFilterTerms.length ? playerAdmin_filteredResearchRows.length : playerAdmin_researchCategoryFilteredRows.length) === 1 ? "y" : "ies"} Detected</span>
              </div>
              <div className="playerAdmin_filterActionsRight">
                {playerAdmin_researchCategory && <select value={playerAdmin_productGroup} onChange={(playerAdmin_event) => playerAdmin_setProductGroup(playerAdmin_event.target.value)}><option value="">All Product Groups</option>{playerAdmin_researchGroups[playerAdmin_researchCategory].map((playerAdmin_option) => <option key={playerAdmin_option}>{playerAdmin_option}</option>)}</select>}
                <button disabled={!dbPlayerId || playerAdmin_researchLoading} onClick={() => playerAdmin_loadResearchItems()}>{playerAdmin_researchLoading ? "Loading..." : "Reload"}</button>
              </div>
            </div>
            <PlayerCategoryIconRail
              options={Object.keys(playerAdmin_researchGroups)}
              value={playerAdmin_researchCategory}
              onChange={(nextCategory) => {
                playerAdmin_setResearchCategory(nextCategory);
                playerAdmin_setProductGroup("");
              }}
              allLabel="All Categories"
            />
            {playerAdmin_researchError ? <p className="playerAdmin_note danger">{playerAdmin_researchError}</p> : playerAdmin_researchTable}
          </section>
        </div>
      )}
      {playerAdmin_activeTab === "Skills" && (
        <div className="playerAdmin_content">
          <section className="playerAdmin_box">
            <h4>Skill Point Controls</h4>
            {playerAdmin_actionRow("skillPoints", "Set Skill Points", <input className="playerAdmin_skillPointsInput" type="number" min="0" value={playerAdmin_skillPointsAmount} onChange={(event) => playerAdmin_setSkillPointsAmount(event.target.value)} />, "Set", () => playerAdmin_runAction("skillPoints", `Setting ${playerName}'s skill points to ${Number(playerAdmin_skillPointsAmount) || 0}`, () => playerAdmin_runTask(() => playersApi.setSkillPoints(actionPlayerId, Number(playerAdmin_skillPointsAmount) || 0)), `${playerName}'s skill points were updated.`, { actionType: "Set Skill Points", target: playerName, amount: String(Number(playerAdmin_skillPointsAmount) || 0) }), !playerAdmin_canRunLiveAction, "The player must be online.")}
          </section>
          <section className="playerAdmin_box">
            <h4>Skill Browser</h4>
            <div className="playerAdmin_boxHeaderLine">
              <p>Use Restore Starter Skills after a progression reset leaves the starting tree locked.</p>
              <div className="playerAdmin_filterRow playerAdmin_filterRowRight">
                <span className="playerAdmin_note">{playerAdmin_skillChangeCount} Unsaved Change{playerAdmin_skillChangeCount === 1 ? "" : "s"}</span>
                <button disabled={!playerAdmin_canRunLiveAction || !playerAdmin_starterSkillPreset || playerAdmin_actionResult?.pending} onClick={() => playerAdmin_restoreStarterSkills()}>Restore Starter Skills</button>
                <button disabled={playerAdmin_skillCatalogLoading} onClick={() => playerAdmin_reloadSkills()}>{playerAdmin_skillCatalogLoading ? "Loading..." : "Reload"}</button>
                <InlineActionResult result={playerAdmin_actionResult} resultKey="starterSkills" />
              </div>
            </div>
            <PlayerCategoryIconRail
              options={Object.keys(playerAdmin_skillTrees)}
              value={playerAdmin_skillSchool}
              onChange={(school) => {
                playerAdmin_setSkillSchool(school);
                playerAdmin_openSkillTreeToggles(school);
              }}
              emptyLabel="Select Skill School"
              includeAll={false}
            />
            {playerAdmin_skillCatalogError && <p className="playerAdmin_note danger">{playerAdmin_skillCatalogError}</p>}
            {playerAdmin_skillSchool && <div className="playerAdmin_section"><h5>{playerAdmin_skillSchool}</h5>{playerAdmin_skillTrees[playerAdmin_skillSchool].map((playerAdmin_tree) => playerAdmin_toggleBox(`skill_${playerAdmin_skillSchool}_${playerAdmin_tree.tree}`, playerAdmin_tree.tree, playerAdmin_tree.cards.length ? playerAdmin_skillCards(playerAdmin_skillSchool, playerAdmin_tree.cards) : <p>Leave empty for now.</p>))}{playerAdmin_skillChangeCount > 0 && <div className="playerAdmin_saveBar"><button disabled={!playerAdmin_canRunLiveAction || playerAdmin_actionResult?.pending} onClick={() => playerAdmin_saveSkillChanges()}>Save</button><button disabled={playerAdmin_actionResult?.pending} onClick={() => playerAdmin_discardSkillChanges()}>Discard</button><InlineActionResult result={playerAdmin_actionResult} resultKey="skillSave" /></div>}</div>}
          </section>
        </div>
      )}
      {playerAdmin_activeTab === "Specialization" && (
        <div className="playerAdmin_content">
          <SpecializationTab
            dbPlayerId={dbPlayerId}
            actionPlayerId={actionPlayerId}
            playerName={playerName}
            isOnline={playerAdmin_isOnline}
            onError={onError}
            confirmAction={confirmAction}
            onSkillBaselineChange={(baseline) => {
              playerAdmin_setSkillBaseline(baseline);
              playerAdmin_setSkillChanges({});
            }}
            waitForTask={waitForTask}
            formatMutationResult={formatMutationResult}
          />
        </div>
      )}
      {playerAdmin_activeTab === "Journey" && <div className="playerAdmin_content"><section className="playerAdmin_box"><h4>Journey Browser</h4><div className="playerAdmin_boxHeaderLine playerAdmin_filterHeaderLine"><p>A relog is required to see the change.</p><div className="playerAdmin_filterToolsRow"><input className="playerAdmin_filterTextInput" value={playerAdmin_journeyFilter} onChange={(event) => playerAdmin_setJourneyFilter(event.target.value)} placeholder="Filter by name, ID, status, or dependency" aria-label="Filter Journey Browser" />{playerAdmin_journeyFilter && <button type="button" onClick={() => playerAdmin_setJourneyFilter("")}>Clear</button>}<span className="playerAdmin_note">{playerAdmin_journeyFilterTerms.length ? `${playerAdmin_filteredJourneyEntryCount} of ${playerAdmin_journeyEntryCount}` : playerAdmin_journeyEntryCount} Journey Entr{(playerAdmin_journeyFilterTerms.length ? playerAdmin_filteredJourneyEntryCount : playerAdmin_journeyEntryCount) === 1 ? "y" : "ies"} Detected</span></div></div>{playerAdmin_journeyError && <p className="playerAdmin_note danger">{playerAdmin_journeyError}</p>}{playerAdmin_toggleBox("journey_story", `Story (${playerAdmin_filteredJourneyRows.story.length}${playerAdmin_journeyFilterTerms.length ? `/${playerAdmin_journeyRows.story.length}` : ""})`, playerAdmin_journeyTable(playerAdmin_filteredJourneyRows.story, playerAdmin_journeyFilterTerms.length ? "No story entries match this filter." : "No story entries were found.", playerAdmin_journeySortStory, playerAdmin_journeyResizeStory))}{playerAdmin_toggleBox("journey_contract", `Contracts (${playerAdmin_filteredJourneyRows.contract.length}${playerAdmin_journeyFilterTerms.length ? `/${playerAdmin_journeyRows.contract.length}` : ""})`, playerAdmin_journeyTable(playerAdmin_filteredJourneyRows.contract, playerAdmin_journeyFilterTerms.length ? "No contract entries match this filter." : "No contract entries were found.", playerAdmin_journeySortContract, playerAdmin_journeyResizeContract))}{playerAdmin_toggleBox("journey_codex", `Codex (${playerAdmin_filteredJourneyRows.codex.length}${playerAdmin_journeyFilterTerms.length ? `/${playerAdmin_journeyRows.codex.length}` : ""})`, playerAdmin_journeyTable(playerAdmin_filteredJourneyRows.codex, playerAdmin_journeyFilterTerms.length ? "No codex entries match this filter." : "No codex entries were found.", playerAdmin_journeySortCodex, playerAdmin_journeyResizeCodex))}{playerAdmin_toggleBox("journey_tutorial", `Tutorial (${playerAdmin_filteredJourneyRows.tutorial.length}${playerAdmin_journeyFilterTerms.length ? `/${playerAdmin_journeyRows.tutorial.length}` : ""})`, playerAdmin_journeyTable(playerAdmin_filteredJourneyRows.tutorial, playerAdmin_journeyFilterTerms.length ? "No tutorial entries match this filter." : "No tutorial entries were found.", playerAdmin_journeySortTutorial, playerAdmin_journeyResizeTutorial))}</section></div>}
      {playerAdmin_activeTab === "Blueprints" && <div className="playerAdmin_content"><section className="playerAdmin_box"><h4>Blueprints</h4><BlueprintsPanel dbPlayerId={dbPlayerId} playerName={playerName} onError={onError} confirmAction={confirmAction} /></section></div>}
      {playerAdmin_activeTab === "Admin" && <div className="playerAdmin_content"><section className="playerAdmin_box"><h4>Player Admin Actions</h4><p>Use this area for player maintenance and high-impact admin actions. Some actions require the player to be online, while database repairs require the player to be offline.</p><div className="playerAdmin_section playerAdmin_repairSection"><h5>Repair</h5><div className="playerAdmin_repairRow"><span className="playerAdmin_repairLabel"><span>Repair Gear</span><em>{playerAdmin_isOnline ? "The player must be offline." : "Equipped and carried gear durability. Relog required."}</em></span><button disabled={!dbPlayerId || playerAdmin_isOnline || playerAdmin_actionResult?.pending} onClick={async () => {
        if (!(await confirmAction(`Repair gear for ${playerName}? The player must be offline and should relog after this.`))) return;
        void playerAdmin_runAction("repairGear", `Repairing ${playerName}'s gear`, async () => {
          const response = await playersApi.repairGear(dbPlayerId, "REPAIR GEAR");
          const result = response.result || {};
          const repaired = Number(result.repaired || 0);
          const scanned = Number(result.scanned || 0);
          return {
            message: repaired > 0
              ? `Repaired ${repaired} of ${scanned} gear item${scanned === 1 ? "" : "s"}. Relog required.`
              : `No gear needed repair (${scanned} item${scanned === 1 ? "" : "s"} scanned).`
          };
        }, `${playerName}'s gear was repaired. Relog required.`, { actionType: "Repair Gear", target: playerName, amount: "1" });
      }}>Repair Gear</button><InlineActionResult result={playerAdmin_actionResult} resultKey="repairGear" /></div><div className="playerAdmin_repairRow"><span className="playerAdmin_repairLabel"><span>Repair Vehicle Red Bar</span><label className="playerAdmin_vehicleDecayField"><span>Threshold</span><input value={playerAdmin_vehicleDecayThreshold} onChange={(event) => playerAdmin_setVehicleDecayThreshold(event.target.value)} inputMode="numeric" aria-label="Vehicle red-bar repair threshold percent" /><span>%</span></label><em>{playerAdmin_isOnline ? "The player must be offline." : "Owned vehicle modules below the threshold. Relog required."}</em></span><button disabled={!dbPlayerId || playerAdmin_isOnline || playerAdmin_actionResult?.pending} onClick={async () => {
        const threshold = Number(playerAdmin_vehicleDecayThreshold);
        if (!Number.isFinite(threshold) || threshold < 1 || threshold > 100) {
          playerAdmin_showResult("repairVehicleDecay", "Use a threshold from 1 to 100.", "danger");
          return;
        }
        if (!(await confirmAction(`Repair vehicle red-bar decay below ${threshold}% for ${playerName}? The player must be offline and should relog after this.`, {
          title: "Repair Vehicle Decay",
          confirmLabel: "Repair Vehicles",
          details: [{ label: "Threshold", value: `${threshold}%`, tone: "accent" }]
        }))) return;
        void playerAdmin_runAction("repairVehicleDecay", `Repairing ${playerName}'s vehicle decay`, async () => {
          const response = await playersApi.repairVehicleDecay(dbPlayerId, { thresholdPercent: threshold, confirmation: "REPAIR VEHICLE DECAY" });
          const result = response.result || {};
          const repaired = Number(result.repaired || 0);
          const scanned = Number(result.scanned || 0);
          const vehicles = Number(result.vehicles || 0);
          const repairedVehicles = Number(result.repairedVehicles || 0);
          return {
            message: repaired > 0
              ? `Repaired ${repaired} vehicle module${repaired === 1 ? "" : "s"} across ${repairedVehicles} vehicle${repairedVehicles === 1 ? "" : "s"}. Relog required.`
              : `No vehicle modules were below ${threshold}% red-bar threshold (${scanned} module${scanned === 1 ? "" : "s"} across ${vehicles} vehicle${vehicles === 1 ? "" : "s"} scanned).`
          };
        }, `${playerName}'s vehicle decay was repaired. Relog required.`, { actionType: "Repair Vehicle Decay", target: playerName, amount: `${threshold}%` });
      }}>Repair Vehicles</button><InlineActionResult result={playerAdmin_actionResult} resultKey="repairVehicleDecay" /></div></div><div className="playerAdmin_section playerAdmin_dangerSection"><h5>Danger Zone</h5><div className="playerAdmin_buttonRow"><button className="danger" disabled={!actionPlayerId || playerAdmin_actionResult?.pending} onClick={async () => {
        if (!(await confirmAction(`Repair ${playerName}'s login queue? Use this only when the player is stuck on connection errors and is not actually in-game.`, {
          title: "Repair Login Queue",
          confirmLabel: "Repair Queue",
          danger: true,
          details: [
            { label: "Player", value: playerName, tone: "accent" },
            { label: "Queue", value: `${actionPlayerId}_queue`, tone: "danger" }
          ]
        }))) return;
        void playerAdmin_runAction("repairLoginQueue", `Repairing ${playerName}'s login queue`, () => playerAdmin_runTask(() => playersApi.repairLoginQueue(actionPlayerId, "REPAIR LOGIN QUEUE")), `${playerName}'s login queue was repaired. Ask the player to connect again.`, { actionType: "Repair Login Queue", target: playerName, amount: "1" });
      }}>Repair Login Queue</button><button className="danger" disabled={!playerAdmin_canRunLiveAction || playerAdmin_actionResult?.pending} onClick={async () => {
        if (!(await confirmAction(`Kick ${playerName} from the server?`))) return;
        void playerAdmin_runAction("adminKick", `Kicking ${playerName}`, () => playerAdmin_runTask(() => playersApi.kick(actionPlayerId)), `${playerName} was kicked from the server.`, { actionType: "Kick Player", target: playerName, amount: "1" }, "danger");
      }}>Kick Player</button><button className="danger" disabled={!playerAdmin_canRunLiveAction || playerAdmin_actionResult?.pending} onClick={async () => {
        if (!(await confirmAction(`Wipe ${playerName}'s inventory?`))) return;
        void playerAdmin_runAction("adminWipe", `Wiping ${playerName}'s inventory`, () => playerAdmin_runTask(() => playersApi.cleanInventory(actionPlayerId, "CLEAN INVENTORY")), `${playerName}'s inventory was wiped.`, { actionType: "Wipe Inventory", target: playerName, amount: "1" }, "danger");
      }}>Wipe Inventory</button><button className="danger" disabled={!playerAdmin_canRunLiveAction || playerAdmin_actionResult?.pending} onClick={async () => {
        if (!(await confirmAction(`Reset ${playerName}'s progression?`))) return;
        void playerAdmin_runAction("adminReset", `Resetting ${playerName}'s progression`, () => playerAdmin_runTask(() => playersApi.resetProgression(actionPlayerId, "RESET PROGRESSION")), `${playerName}'s progression was reset.`, { actionType: "Reset Progression", target: playerName, amount: "1" }, "danger");
      }}>Reset Progression</button><InlineActionResult result={playerAdmin_actionResult} resultKey="repairLoginQueue" /><InlineActionResult result={playerAdmin_actionResult} resultKey="adminKick" /><InlineActionResult result={playerAdmin_actionResult} resultKey="adminWipe" /><InlineActionResult result={playerAdmin_actionResult} resultKey="adminReset" /></div></div></section><section className="playerAdmin_box"><h4>Movement / Vehicles</h4><p>The player must be online.</p><div className="playerAdmin_actionRow playerAdmin_coordinatesRow"><span>Coordinates</span><input value={playerAdmin_coords.x} onChange={(event) => playerAdmin_setCoords({ ...playerAdmin_coords, x: event.target.value })} placeholder="X" /><input value={playerAdmin_coords.y} onChange={(event) => playerAdmin_setCoords({ ...playerAdmin_coords, y: event.target.value })} placeholder="Y" /><input value={playerAdmin_coords.z} onChange={(event) => playerAdmin_setCoords({ ...playerAdmin_coords, z: event.target.value })} placeholder="Z" /><input value={playerAdmin_coords.yaw} onChange={(event) => playerAdmin_setCoords({ ...playerAdmin_coords, yaw: event.target.value })} placeholder="Yaw" /><button disabled={!dbPlayerId || playerAdmin_actionResult?.pending} onClick={() => void playerAdmin_runAction("adminPosition", `Loading ${playerName}'s position`, playerAdmin_useCurrentPosition, "Position loaded. Edit X/Y/Z before teleporting if needed.", { actionType: "Load Position", target: playerName, amount: "1" })}>Use Current Position</button><button disabled={!playerAdmin_canRunLiveAction || playerAdmin_actionResult?.pending} onClick={async () => {
        if (!(await confirmAction(`Teleport ${playerName} to X=${playerAdmin_coords.x} Y=${playerAdmin_coords.y} Z=${playerAdmin_coords.z}?`))) return;
        void playerAdmin_runAction("adminTeleport", `Teleporting ${playerName}`, () => playerAdmin_runTask(() => playersApi.teleport(actionPlayerId, { x: Number(playerAdmin_coords.x), y: Number(playerAdmin_coords.y), z: Number(playerAdmin_coords.z), yaw: Number(playerAdmin_coords.yaw) })), `${playerName} was teleported.`, { actionType: "Teleport", target: playerName, amount: "1" });
      }}>Teleport</button><InlineActionResult result={playerAdmin_actionResult} resultKey="adminPosition" /><InlineActionResult result={playerAdmin_actionResult} resultKey="adminTeleport" /></div><div className="playerAdmin_actionRow playerAdmin_spawnVehicleRow"><span>Spawn Vehicle</span><select value={playerAdmin_vehicleId} onChange={(event) => { const nextVehicle = event.target.value; playerAdmin_setVehicleId(nextVehicle); playerAdmin_setVehicleTemplate([...(playerAdmin_vehicleCatalog[nextVehicle] || [])].sort((a, b) => friendlyVehicleTemplateName(a).localeCompare(friendlyVehicleTemplateName(b)))[0] || ""); }}>{playerAdmin_vehicleIds.length === 0 && <option value="">Manual Vehicle ID</option>}{playerAdmin_vehicleIds.map((id) => <option key={id} value={id}>{friendlyVehicleName(id)}</option>)}</select><select value={playerAdmin_vehicleTemplate} onChange={(event) => playerAdmin_setVehicleTemplate(event.target.value)}>{playerAdmin_selectedTemplates.length === 0 && <option value="">Manual Template</option>}{playerAdmin_selectedTemplates.map((template) => <option key={template} value={template}>{friendlyVehicleTemplateName(template)}</option>)}</select><button disabled={!playerAdmin_canRunLiveAction || playerAdmin_actionResult?.pending} onClick={async () => {
        const knownTemplates = Object.values(playerAdmin_vehicleCatalog).flat();
        if (knownTemplates.includes(playerAdmin_vehicleId) && !playerAdmin_vehicleCatalog[playerAdmin_vehicleId]) {
          playerAdmin_showResult("adminVehicle", `${playerAdmin_vehicleId} is a vehicle template, not a vehicle ID.`, "danger");
          return;
        }
        const vehicleLabel = friendlyVehicleName(playerAdmin_vehicleId);
        const templateLabel = friendlyVehicleTemplateName(playerAdmin_vehicleTemplate);
        const spawnOffset = vehicleSpawnOffsetUnits(playerAdmin_vehicleId);
        const spawnDistance = vehicleSpawnDistanceLabel(spawnOffset);
        if (!(await confirmAction(`Spawn ${vehicleLabel} / ${templateLabel} ${spawnDistance} in front of ${playerName}?`))) return;
        void playerAdmin_runAction("adminVehicle", `Spawning ${vehicleLabel} for ${playerName}`, () => playerAdmin_runTask(() => playersApi.spawnVehicle(actionPlayerId, { vehicleId: playerAdmin_vehicleId, template: playerAdmin_vehicleTemplate, offset: spawnOffset })), `${vehicleLabel} (${templateLabel}) was spawned ${spawnDistance} in front of ${playerName}.`, { actionType: "Spawn Vehicle", target: playerName, amount: vehicleLabel });
      }}>Spawn</button><InlineActionResult result={playerAdmin_actionResult} resultKey="adminVehicle" /></div><details className="technical-details"><summary>Advanced manual override</summary><div className="actions-grid"><label>Manual Vehicle ID<input value={playerAdmin_vehicleId} onChange={(event) => playerAdmin_setVehicleId(event.target.value)} placeholder="Sandbike" /></label><label>Manual Template<input value={playerAdmin_vehicleTemplate} onChange={(event) => playerAdmin_setVehicleTemplate(event.target.value)} placeholder="T1_ExtraSeat" /></label></div></details></section>{playerAdmin_toggleBox("admin_log", "Admin Action Log", <div className="playerAdmin_logSection">{playerAdmin_adminLog.length > 0 && <div className="action-row admin-history-actions"><button onClick={() => playerAdmin_setAdminLog([])}>Clear</button></div>}{playerAdmin_adminLog.length ? playerAdmin_table(["Date / Time", "Admin", "Action Type", "Target", "Amount", "Notes"], playerAdmin_adminLog) : <p>No admin actions have been recorded in this layout yet.</p>}</div>)}</div>}
    </section>
  );
}

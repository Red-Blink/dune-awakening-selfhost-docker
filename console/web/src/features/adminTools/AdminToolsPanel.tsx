import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { adminApi } from "../../api/admin";
import { liveMapApi } from "../../api/liveMap";
import { playersApi } from "../../api/players";
import { serverApi } from "../../api/server";
import { setupApi, type Task } from "../../api/setup";
import { DataTable } from "../../components/common/DataTable";
import { KeyValueGrid, TechnicalDetails } from "../../components/common/DisplayPrimitives";
import { InlineActionResult } from "../../components/common/InlineActionResult";
import { adminTaskFailureDetail, friendlyInlineError, titleCaseWords } from "../players/playerAdminUtils";
import { formatUiSentence, stripAnsi, titleCase } from "../../lib/display";
import type { CharacterTransferSettings, IncomingCharacterTransferPolicy, MessageOfTheDaySettings, PlayerAnnouncementSettings } from "../../api/admin";

type HomeTaskResult = { status: "running" | "succeeded" | "failed" | "stopped"; title: string; message?: string; details?: string };
type ConfirmAction = (message: string, options?: { title?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean }) => Promise<boolean>;
type InlineResult = { key: string; tone: "success" | "danger" | "neutral"; text: string; pending?: boolean };
type MapChatOption = { key: string; label: string; chatRegion: string; dimension: number; status: string; players: number };
type TransferResult = { status: "idle" | "running" | "succeeded" | "failed"; title: string; details?: string };

type AdminToolsPanelProps = {
  onError: (text: string) => void;
  confirmAction: ConfirmAction;
};

const DEFAULT_PLAYER_JOIN_MESSAGE = "{playerName} has entered {mapName}, their trail fresh upon the sands.";
const DEFAULT_PLAYER_LEAVE_MESSAGE = "{playerName} has vanished from {mapName}, their tracks swallowed by the dunes.";

export function AdminToolsPanel({ onError, confirmAction }: AdminToolsPanelProps) {
  const [players, setPlayers] = useState<Record<string, unknown>[]>([]);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [restartSchedule, setRestartSchedule] = useState<{ stdout?: string; stderr?: string; exitCode?: number } | null>(null);
  const [scheduleLoading, setScheduleLoading] = useState(true);
  const [restartEnabled, setRestartEnabled] = useState(false);
  const [restartTime, setRestartTime] = useState("05:00");
  const [restartNotifyMinutes, setRestartNotifyMinutes] = useState("15");
  const [scheduleResult, setScheduleResult] = useState<HomeTaskResult | null>(null);
  const [ipChangeRestart, setIpChangeRestart] = useState<{ stdout?: string; stderr?: string; exitCode?: number } | null>(null);
  const [ipChangeLoading, setIpChangeLoading] = useState(true);
  const [ipChangeEnabled, setIpChangeEnabled] = useState(false);
  const [ipChangeIntervalMinutes, setIpChangeIntervalMinutes] = useState("5");
  const [ipChangeNotifyMinutes, setIpChangeNotifyMinutes] = useState("1");
  const [ipChangeResult, setIpChangeResult] = useState<HomeTaskResult | null>(null);
  const [shutdownProtection, setShutdownProtection] = useState<{ stdout?: string; stderr?: string; exitCode?: number } | null>(null);
  const [shutdownProtectionLoading, setShutdownProtectionLoading] = useState(true);
  const [shutdownProtectionEnabled, setShutdownProtectionEnabled] = useState(false);
  const [shutdownProtectionResult, setShutdownProtectionResult] = useState<HomeTaskResult | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferLoading, setTransferLoading] = useState(true);
  const [transferSettings, setTransferSettings] = useState<CharacterTransferSettings | null>(null);
  const [transferOriginal, setTransferOriginal] = useState<CharacterTransferSettings | null>(null);
  const [transferDefaults, setTransferDefaults] = useState<CharacterTransferSettings | null>(null);
  const [transferPolicies, setTransferPolicies] = useState<IncomingCharacterTransferPolicy[]>([]);
  const [transferResult, setTransferResult] = useState<TransferResult | null>(null);
  const [liveToolsOpen, setLiveToolsOpen] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [broadcastTitle, setBroadcastTitle] = useState("");
  const [broadcastBody, setBroadcastBody] = useState("");
  const [broadcastDuration, setBroadcastDuration] = useState("30");
  const [messageOfTheDay, setMessageOfTheDay] = useState<MessageOfTheDaySettings>({ enabled: false, title: "", message: "" });
  const [messageOfTheDayOriginal, setMessageOfTheDayOriginal] = useState<MessageOfTheDaySettings>({ enabled: false, title: "", message: "" });
  const [playerAnnouncements, setPlayerAnnouncements] = useState<PlayerAnnouncementSettings>({ joinEnabled: false, joinMessage: DEFAULT_PLAYER_JOIN_MESSAGE, leaveEnabled: false, leaveMessage: DEFAULT_PLAYER_LEAVE_MESSAGE });
  const [playerAnnouncementsOriginal, setPlayerAnnouncementsOriginal] = useState<PlayerAnnouncementSettings>({ joinEnabled: false, joinMessage: DEFAULT_PLAYER_JOIN_MESSAGE, leaveEnabled: false, leaveMessage: DEFAULT_PLAYER_LEAVE_MESSAGE });
  const [mapChatOptions, setMapChatOptions] = useState<MapChatOption[]>(defaultMapChatOptions());
  const [mapChatTarget, setMapChatTarget] = useState(defaultMapChatOptions()[0]?.key || "HaggaBasin|0");
  const [mapChatBody, setMapChatBody] = useState("");
  const [history, setHistory] = useState("");
  const [actionResult, setActionResult] = useState<InlineResult | null>(null);
  const resultTimer = useRef<number | null>(null);
  const scheduleSaving = scheduleResult?.status === "running";
  const restartScheduleValues = parseKeyValueText(restartSchedule?.stdout || "");
  const scheduleTimerValue = restartScheduleValues.systemd_timer || "";
  const scheduleTimerLabel = scheduleTimerValue ? formatTimerStatus(scheduleTimerValue) : "Not Installed";
  const scheduleTimerActive = /^active$/i.test(scheduleTimerValue);
  const scheduleActive = restartEnabled && scheduleTimerActive;
  const scheduleLoaded = Boolean(restartSchedule);
  const scheduleDisplayActive = scheduleSaving ? restartEnabled : scheduleActive;
  const scheduleStatusLabel = !scheduleLoaded && !scheduleSaving ? "Checking" : scheduleDisplayActive ? "Enabled" : "Disabled";
  const scheduleDisplayTimerLabel = !scheduleLoaded && !scheduleSaving ? "Checking" : scheduleSaving ? restartEnabled ? "Activating" : "Deactivating" : restartEnabled ? scheduleTimerLabel : "Inactive";
  const ipChangeValues = parseKeyValueText(ipChangeRestart?.stdout || "");
  const ipChangeTimerValue = ipChangeValues.systemd_timer || "";
  const ipChangeTimerLabel = ipChangeTimerValue ? formatTimerStatus(ipChangeTimerValue) : "Not Installed";
  const ipChangeTimerActive = /^active$/i.test(ipChangeTimerValue);
  const ipChangeSaving = ipChangeResult?.status === "running";
  const ipChangeLoaded = Boolean(ipChangeRestart);
  const ipChangeDisplayActive = ipChangeSaving ? ipChangeEnabled : ipChangeEnabled && ipChangeTimerActive;
  const ipChangeStatusLabel = !ipChangeLoaded && !ipChangeSaving ? "Checking" : ipChangeDisplayActive ? "Enabled" : "Disabled";
  const ipChangeDisplayTimerLabel = !ipChangeLoaded && !ipChangeSaving ? "Checking" : ipChangeSaving ? ipChangeEnabled ? "Activating" : "Deactivating" : ipChangeEnabled ? ipChangeTimerLabel : "Inactive";
  const shutdownProtectionValues = parseKeyValueText(shutdownProtection?.stdout || "");
  const shutdownProtectionServiceValue = shutdownProtectionValues.systemd_service || "";
  const shutdownProtectionEnabledValue = shutdownProtectionValues.systemd_enabled || "";
  const shutdownProtectionSaving = shutdownProtectionResult?.status === "running";
  const shutdownProtectionLoaded = Boolean(shutdownProtection);
  const shutdownProtectionServiceActive = /^active$/i.test(shutdownProtectionServiceValue);
  const shutdownProtectionSystemdEnabled = /^enabled$/i.test(shutdownProtectionEnabledValue);
  const shutdownProtectionDisplayActive = shutdownProtectionSaving ? shutdownProtectionEnabled : shutdownProtectionEnabled && shutdownProtectionServiceActive && shutdownProtectionSystemdEnabled;
  const shutdownProtectionStatusLabel = !shutdownProtectionLoaded && !shutdownProtectionSaving ? "Checking" : shutdownProtectionDisplayActive ? "Enabled" : "Disabled";
  const shutdownProtectionServiceLabel = !shutdownProtectionLoaded && !shutdownProtectionSaving ? "Checking" : shutdownProtectionSaving ? shutdownProtectionEnabled ? "Activating" : "Deactivating" : shutdownProtectionServiceValue ? formatTimerStatus(shutdownProtectionServiceValue) : "Not Installed";
  const shutdownProtectionInstalled = Boolean(shutdownProtectionServiceValue && !/^not installed$/i.test(shutdownProtectionServiceValue));
  const transferDirty = Boolean(transferSettings && transferOriginal && !sameTransferSettings(transferSettings, transferOriginal));
  const transferSaving = transferResult?.status === "running";
  const messageOfTheDayDirty = !sameMessageOfTheDay(messageOfTheDay, messageOfTheDayOriginal);
  const playerAnnouncementsDirty = !samePlayerAnnouncements(playerAnnouncements, playerAnnouncementsOriginal);

  async function run(action: () => Promise<unknown>) {
    onError("");
    try { await action(); } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
  }

  function showActionResult(key: string, text: string, tone: InlineResult["tone"] = "success", pending = false) {
    setActionResult({ key, text, tone, pending });
    if (resultTimer.current) window.clearTimeout(resultTimer.current);
    resultTimer.current = null;
    if (!pending) resultTimer.current = window.setTimeout(() => setActionResult(null), 5000);
  }

  async function runAdminAction(key: string, pendingText: string, action: () => Promise<unknown>, successText: string, successTone: "success" | "danger" = "success", failureText?: string | ((error: unknown) => string)) {
    showActionResult(key, pendingText, "neutral", true);
    try {
      await action();
      showActionResult(key, successText, successTone);
    } catch (error) {
      showActionResult(key, typeof failureText === "function" ? failureText(error) : failureText || friendlyInlineError(error), "danger");
    }
  }

  async function loadHistory(open = false) {
    setHistory((await adminApi.history()).stdout || "");
    if (open) setHistoryOpen(true);
  }

  async function clearHistory() {
    if (!(await confirmAction("Clear command history?"))) return;
    await adminApi.clearHistory("admin-tools");
    setHistory("");
    setHistoryOpen(false);
  }

  async function runInlineTask(taskFactory: () => Promise<{ task: Task }>) {
    const response = await taskFactory();
    const final = await waitForTaskSilently(response.task);
    if (final.status !== "succeeded") {
      await loadHistory(true).catch(() => undefined);
      throw new Error(adminTaskFailureDetail(final) || final.errorMessage || final.progressMessage || "Admin action failed.");
    }
    await loadHistory(true);
    return final;
  }

  async function loadRestartSchedule() {
    setScheduleLoading(true);
    try {
      const result = await serverApi.restartSchedule();
      setRestartSchedule(result);
      const values = parseKeyValueText(result.stdout || "");
      const timerActive = /^active$/i.test(values.systemd_timer || "");
      setRestartEnabled(/^true$/i.test(values.scheduled_restart_enabled || "") && timerActive);
      if (values.restart_time && values.restart_time !== "unset") setRestartTime(toHourMinuteTime(values.restart_time));
      const notifyMatch = String(values.notify_players_before || "").match(/\d+/);
      if (notifyMatch) setRestartNotifyMinutes(notifyMatch[0]);
    } finally {
      setScheduleLoading(false);
    }
  }

  async function saveSchedule(nextEnabled = restartEnabled) {
    const sanitizedTime = toHourMinuteTime(restartTime);
    const notifyMinutes = Number(restartNotifyMinutes);
    if (nextEnabled && !isValidHourMinuteTime(sanitizedTime)) {
      setScheduleResult({ status: "failed", title: "Schedule Save Failed", message: "Restart time must be a valid 24-hour time, for example 05:00 or 23:30." });
      return;
    }
    if (nextEnabled && (!Number.isInteger(notifyMinutes) || notifyMinutes < 1 || notifyMinutes > 1440)) {
      setScheduleResult({ status: "failed", title: "Schedule Save Failed", message: "Notification time must be between 1 and 1440 minutes." });
      return;
    }
    setRestartTime(sanitizedTime);
    setRestartNotifyMinutes(String(Number.isInteger(notifyMinutes) ? notifyMinutes : 15));
    setScheduleResult({ status: "running", title: "Saving Schedule" });
    const requestedEnabled = nextEnabled;
    setRestartEnabled(requestedEnabled);
    onError("");
    try {
      const final = await waitForTaskSilently((await serverApi.saveRestartSchedule({ enabled: requestedEnabled, time: sanitizedTime, notifyMinutes })).task);
      const details = taskTechnicalDetails(final);
      const nextSchedule = await serverApi.restartSchedule();
      setRestartSchedule(nextSchedule);
      const nextValues = parseKeyValueText(nextSchedule.stdout || "");
      const timerActive = /^active$/i.test(nextValues.systemd_timer || "");
      const timerInactive = /^inactive$/i.test(nextValues.systemd_timer || "");
      if (requestedEnabled && !timerActive) setRestartEnabled(false);
      if (!requestedEnabled && timerInactive) setRestartEnabled(false);
      const notifyMatch = String(nextValues.notify_players_before || "").match(/\d+/);
      if (notifyMatch) setRestartNotifyMinutes(notifyMatch[0]);
      setScheduleResult(final.status === "succeeded" && (!requestedEnabled ? timerInactive : timerActive)
        ? { status: "succeeded", title: "Schedule Saved Successfully", details }
        : { status: "failed", title: requestedEnabled ? "Timer Install Failed" : "Schedule Save Failed", details: details || nextSchedule.stdout || nextSchedule.stderr || "" });
    } catch (error) {
      setRestartEnabled(!requestedEnabled);
      setScheduleResult({ status: "failed", title: "Schedule Save Failed", details: error instanceof Error ? error.message : String(error) });
    }
  }

  async function loadIpChangeRestart(options: { showLoading?: boolean; syncControls?: boolean } = {}) {
    const showLoading = options.showLoading ?? true;
    const syncControls = options.syncControls ?? true;
    if (showLoading) setIpChangeLoading(true);
    try {
      const result = await serverApi.ipChangeRestart();
      setIpChangeRestart(result);
      const values = parseKeyValueText(result.stdout || "");
      const timerActive = /^active$/i.test(values.systemd_timer || "");
      setIpChangeEnabled(/^true$/i.test(values.public_ip_change_restart_enabled || "") && timerActive);
      if (syncControls) {
        const intervalMatch = String(values.check_interval || "").match(/\d+/);
        if (intervalMatch) setIpChangeIntervalMinutes(intervalMatch[0]);
        const notifyMatch = String(values.in_game_notice || "").match(/\d+/);
        if (notifyMatch) setIpChangeNotifyMinutes(notifyMatch[0]);
      }
    } finally {
      if (showLoading) setIpChangeLoading(false);
    }
  }

  async function saveIpChangeRestart(nextEnabled = ipChangeEnabled) {
    const intervalMinutes = Number(ipChangeIntervalMinutes);
    const notifyMinutes = Number(ipChangeNotifyMinutes);
    if (nextEnabled && (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1440)) {
      setIpChangeResult({ status: "failed", title: "IP Monitor Save Failed", message: "Check interval must be between 1 and 1440 minutes." });
      return;
    }
    if (nextEnabled && (!Number.isInteger(notifyMinutes) || notifyMinutes < 0 || notifyMinutes > 60)) {
      setIpChangeResult({ status: "failed", title: "IP Monitor Save Failed", message: "In-game notice must be between 0 and 60 minutes." });
      return;
    }
    setIpChangeIntervalMinutes(String(Number.isInteger(intervalMinutes) ? intervalMinutes : 5));
    setIpChangeNotifyMinutes(String(Number.isInteger(notifyMinutes) ? notifyMinutes : 1));
    setIpChangeResult({ status: "running", title: "Saving IP Monitor" });
    const requestedEnabled = nextEnabled;
    setIpChangeEnabled(requestedEnabled);
    onError("");
    try {
      const final = await waitForTaskSilently((await serverApi.saveIpChangeRestart({ enabled: requestedEnabled, intervalMinutes, notifyMinutes })).task);
      const details = taskTechnicalDetails(final);
      const nextStatus = await serverApi.ipChangeRestart();
      setIpChangeRestart(nextStatus);
      const nextValues = parseKeyValueText(nextStatus.stdout || "");
      const timerActive = /^active$/i.test(nextValues.systemd_timer || "");
      const timerInactive = /^inactive$|^not installed$/i.test(nextValues.systemd_timer || "");
      if (requestedEnabled && !timerActive) setIpChangeEnabled(false);
      if (!requestedEnabled && timerInactive) setIpChangeEnabled(false);
      const intervalMatch = String(nextValues.check_interval || "").match(/\d+/);
      if (intervalMatch) setIpChangeIntervalMinutes(intervalMatch[0]);
      const notifyMatch = String(nextValues.in_game_notice || "").match(/\d+/);
      if (notifyMatch) setIpChangeNotifyMinutes(notifyMatch[0]);
      setIpChangeResult(final.status === "succeeded" && (!requestedEnabled ? timerInactive : timerActive)
        ? { status: "succeeded", title: "IP Monitor Saved Successfully", details }
        : { status: "failed", title: requestedEnabled ? "IP Monitor Timer Failed" : "IP Monitor Save Failed", details: details || nextStatus.stdout || nextStatus.stderr || "" });
    } catch (error) {
      setIpChangeEnabled(!requestedEnabled);
      setIpChangeResult({ status: "failed", title: "IP Monitor Save Failed", details: error instanceof Error ? error.message : String(error) });
    }
  }

  async function checkIpChangeNow() {
    setIpChangeResult({ status: "running", title: "Checking Public IP" });
    onError("");
    try {
      const final = await waitForTaskSilently((await serverApi.checkIpChangeRestartNow()).task);
      const nextStatus = await serverApi.ipChangeRestart();
      setIpChangeRestart(nextStatus);
      setIpChangeResult(final.status === "succeeded"
        ? { status: "succeeded", title: "Public IP Check Complete", details: taskTechnicalDetails(final) }
        : { status: "failed", title: "Public IP Check Failed", details: taskTechnicalDetails(final) || final.errorMessage || "" });
    } catch (error) {
      setIpChangeResult({ status: "failed", title: "Public IP Check Failed", details: error instanceof Error ? error.message : String(error) });
    }
  }

  async function loadShutdownProtection() {
    setShutdownProtectionLoading(true);
    try {
      const result = await serverApi.shutdownProtection();
      setShutdownProtection(result);
      const values = parseKeyValueText(result.stdout || "");
      const active = /^active$/i.test(values.systemd_service || "");
      const enabled = /^enabled$/i.test(values.systemd_enabled || "");
      setShutdownProtectionEnabled(/^true$/i.test(values.shutdown_protection_enabled || "") && active && enabled);
    } finally {
      setShutdownProtectionLoading(false);
    }
  }

  async function saveShutdownProtection(nextEnabled = shutdownProtectionEnabled) {
    setShutdownProtectionResult({ status: "running", title: "Saving Shutdown Protection" });
    const requestedEnabled = nextEnabled;
    setShutdownProtectionEnabled(requestedEnabled);
    onError("");
    try {
      const final = await waitForTaskSilently((await serverApi.saveShutdownProtection({ enabled: requestedEnabled })).task);
      const details = taskTechnicalDetails(final);
      const nextStatus = await serverApi.shutdownProtection();
      setShutdownProtection(nextStatus);
      const nextValues = parseKeyValueText(nextStatus.stdout || "");
      const active = /^active$/i.test(nextValues.systemd_service || "");
      const enabled = /^enabled$/i.test(nextValues.systemd_enabled || "");
      const inactive = /^inactive$|^not installed$/i.test(nextValues.systemd_service || "");
      if (requestedEnabled && (!active || !enabled)) setShutdownProtectionEnabled(false);
      if (!requestedEnabled && inactive) setShutdownProtectionEnabled(false);
      setShutdownProtectionResult(final.status === "succeeded" && (!requestedEnabled ? inactive || !enabled : active && enabled)
        ? { status: "succeeded", title: "Shutdown Protection Saved", details }
        : { status: "failed", title: requestedEnabled ? "Shutdown Protection Install Failed" : "Shutdown Protection Save Failed", details: details || nextStatus.stdout || nextStatus.stderr || "" });
    } catch (error) {
      setShutdownProtectionEnabled(!requestedEnabled);
      setShutdownProtectionResult({ status: "failed", title: "Shutdown Protection Save Failed", details: error instanceof Error ? error.message : String(error) });
    }
  }

  async function removeShutdownProtection() {
    if (!(await confirmAction("Remove the Linux shutdown protection systemd service from this host?", { title: "Remove Shutdown Protection", confirmLabel: "Remove", danger: true }))) return;
    setShutdownProtectionResult({ status: "running", title: "Removing Shutdown Protection" });
    onError("");
    try {
      const final = await waitForTaskSilently((await serverApi.removeShutdownProtection()).task);
      const details = taskTechnicalDetails(final);
      const nextStatus = await serverApi.shutdownProtection();
      setShutdownProtection(nextStatus);
      setShutdownProtectionEnabled(false);
      setShutdownProtectionResult(final.status === "succeeded"
        ? { status: "succeeded", title: "Shutdown Protection Removed", details }
        : { status: "failed", title: "Shutdown Protection Remove Failed", details: details || nextStatus.stdout || nextStatus.stderr || "" });
    } catch (error) {
      setShutdownProtectionResult({ status: "failed", title: "Shutdown Protection Remove Failed", details: error instanceof Error ? error.message : String(error) });
    }
  }

  async function loadTransferSettings() {
    setTransferLoading(true);
    try {
      const result = await adminApi.characterTransferSettings();
      setTransferSettings(result.settings);
      setTransferOriginal(result.settings);
      setTransferDefaults(result.defaults);
      setTransferPolicies(result.policies);
    } finally {
      setTransferLoading(false);
    }
  }

  async function loadMessageOfTheDay() {
    const result = await adminApi.messageOfTheDay();
    setMessageOfTheDay(result.settings);
    setMessageOfTheDayOriginal(result.settings);
  }

  async function loadPlayerAnnouncements() {
    const result = await adminApi.playerAnnouncements();
    setPlayerAnnouncements(result.settings);
    setPlayerAnnouncementsOriginal(result.settings);
  }

  function updateTransferSetting<K extends keyof CharacterTransferSettings>(key: K, value: CharacterTransferSettings[K]) {
    setTransferSettings((current) => current ? { ...current, [key]: value } : current);
  }

  async function saveTransferSettings() {
    if (!transferSettings) return;
    setTransferResult({ status: "running", title: "Saving Character Transfer Settings" });
    onError("");
    try {
      const response = await adminApi.saveCharacterTransferSettings(transferSettings);
      const final = await waitForTaskSilently(response.task);
      const details = taskTechnicalDetails(final);
      if (final.status !== "succeeded") {
        setTransferResult({ status: "failed", title: "Character Transfer Save Failed", details: details || final.errorMessage || "" });
        return;
      }
      await loadTransferSettings();
      setTransferResult({ status: "succeeded", title: "Character Transfer Settings Saved", details });
    } catch (error) {
      setTransferResult({ status: "failed", title: "Character Transfer Save Failed", details: error instanceof Error ? error.message : String(error) });
    }
  }

  async function restoreTransferDefaults() {
    if (!(await confirmAction("Restore official character transfer defaults and restart the Battlegroup Director?", { title: "Restore Character Transfer Defaults", confirmLabel: "Restore Defaults" }))) return;
    setTransferResult({ status: "running", title: "Restoring Character Transfer Defaults" });
    onError("");
    try {
      const response = await adminApi.restoreCharacterTransferSettings();
      setTransferSettings(response.settings);
      const final = await waitForTaskSilently(response.task);
      const details = taskTechnicalDetails(final);
      if (final.status !== "succeeded") {
        setTransferResult({ status: "failed", title: "Character Transfer Restore Failed", details: details || final.errorMessage || "" });
        return;
      }
      await loadTransferSettings();
      setTransferResult({ status: "succeeded", title: "Character Transfer Defaults Restored", details });
    } catch (error) {
      setTransferResult({ status: "failed", title: "Character Transfer Restore Failed", details: error instanceof Error ? error.message : String(error) });
    }
  }

  useEffect(() => {
    playersApi.list().then((result) => setPlayers(result.rows || [])).catch(() => undefined);
    loadMapChatOptions().catch(() => undefined);
    loadMessageOfTheDay().catch(() => undefined);
    loadPlayerAnnouncements().catch(() => undefined);
    loadHistory().catch(() => undefined);
    loadRestartSchedule().catch((error) => onError(error instanceof Error ? error.message : String(error)));
    loadIpChangeRestart().catch((error) => onError(error instanceof Error ? error.message : String(error)));
    loadShutdownProtection().catch((error) => onError(error instanceof Error ? error.message : String(error)));
    loadTransferSettings().catch((error) => onError(error instanceof Error ? error.message : String(error)));
    return () => {
      if (resultTimer.current) window.clearTimeout(resultTimer.current);
    };
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.hidden || ipChangeResult?.status === "running") return;
      loadIpChangeRestart({ showLoading: false, syncControls: false }).catch(() => undefined);
    }, 30000);
    return () => window.clearInterval(id);
  }, [ipChangeResult?.status]);

  useEffect(() => {
    if (!scheduleResult || scheduleResult.status === "running") return;
    const id = window.setTimeout(() => setScheduleResult(null), 10400);
    return () => window.clearTimeout(id);
  }, [scheduleResult?.status, scheduleResult?.title]);

  useEffect(() => {
    if (!ipChangeResult || ipChangeResult.status === "running") return;
    const id = window.setTimeout(() => setIpChangeResult(null), 10400);
    return () => window.clearTimeout(id);
  }, [ipChangeResult?.status, ipChangeResult?.title]);

  useEffect(() => {
    if (!shutdownProtectionResult || shutdownProtectionResult.status === "running") return;
    const id = window.setTimeout(() => setShutdownProtectionResult(null), 10400);
    return () => window.clearTimeout(id);
  }, [shutdownProtectionResult?.status, shutdownProtectionResult?.title]);

  useEffect(() => {
    if (!transferResult || transferResult.status === "running") return;
    const id = window.setTimeout(() => setTransferResult(null), 10400);
    return () => window.clearTimeout(id);
  }, [transferResult?.status, transferResult?.title]);

  async function hydrateOnlinePlayers() {
    const response = await playersApi.online();
    const targets = (response.rows || []).map((player) => String(player.action_player_id || player.funcom_id || player.fls_id || "")).filter(Boolean);
    if (!targets.length) {
      showActionResult("global", "No players are currently online.", "neutral");
      return;
    }
    if (!(await confirmAction(`Hydrate all ${targets.length} online player${targets.length === 1 ? "" : "s"}?`))) return;
    await runAdminAction("global", `Hydrating ${targets.length} online player${targets.length === 1 ? "" : "s"}`, async () => {
      const results = await Promise.allSettled(targets.map((target) => playersApi.giveItems(target, [{ itemId: "WaterPack_Consumable", quantity: 10, durability: 1 }], { historyScope: "admin-tools", historyFriendly: "Hydrate All" })));
      const failed = results.filter((result) => result.status === "rejected" || (result.status === "fulfilled" && result.value.ok === false)).length;
      await loadHistory(true);
      if (failed) throw new Error(`Hydration completed with ${failed} failed player${failed === 1 ? "" : "s"}.`);
    }, `Hydrated ${targets.length} online player${targets.length === 1 ? "" : "s"} successfully.`);
  }

  async function kickAllPlayers() {
    const response = await playersApi.online();
    const onlineCount = (response.rows || []).filter((player) => String(player.action_player_id || player.funcom_id || player.fls_id || "")).length;
    if (!onlineCount) {
      showActionResult("global", "No players are currently online.", "neutral");
      return;
    }
    if (!(await confirmAction(`Kick ${onlineCount} online player${onlineCount === 1 ? "" : "s"}?`))) return;
    await runAdminAction("global", `Kicking ${onlineCount} online player${onlineCount === 1 ? "" : "s"}`, () => runInlineTask(() => adminApi.kickAllOnline("KICK ALL ONLINE PLAYERS")), "All online players were kicked.", "danger");
  }

  async function sendBroadcast() {
    await runAdminAction("broadcast", "Sending broadcast message", async () => {
      await adminApi.broadcast(broadcastTitle, broadcastBody, Number(broadcastDuration || 30));
      await loadHistory(true);
    }, "Broadcast message was sent successfully.");
  }

  async function saveMessageOfTheDay() {
    await runAdminAction("message-of-the-day", "Saving Message of the Day", async () => {
      const result = await adminApi.saveMessageOfTheDay(messageOfTheDay);
      setMessageOfTheDay(result.settings);
      setMessageOfTheDayOriginal(result.settings);
      await loadHistory(true);
    }, "Message of the Day was saved successfully.");
  }

  async function toggleMessageOfTheDay(nextEnabled: boolean) {
    const previous = messageOfTheDay;
    const next = { ...messageOfTheDay, enabled: nextEnabled };
    setMessageOfTheDay(next);
    await runAdminAction("message-of-the-day", nextEnabled ? "Enabling Message of the Day" : "Disabling Message of the Day", async () => {
      const result = await adminApi.saveMessageOfTheDay(next);
      setMessageOfTheDay(result.settings);
      setMessageOfTheDayOriginal(result.settings);
      await loadHistory(true);
    }, nextEnabled ? "Message of the Day enabled." : "Message of the Day disabled.", "success", (error) => {
      setMessageOfTheDay(previous);
      return friendlyInlineError(error);
    });
  }

  async function restoreMessageOfTheDay() {
    if (!(await confirmAction("Restore the Message of the Day defaults?", { title: "Restore Message of the Day", confirmLabel: "Restore Defaults" }))) return;
    await runAdminAction("message-of-the-day", "Restoring Message of the Day", async () => {
      const result = await adminApi.restoreMessageOfTheDay();
      setMessageOfTheDay(result.settings);
      setMessageOfTheDayOriginal(result.settings);
      await loadHistory(true);
    }, "Message of the Day defaults were restored.");
  }

  async function savePlayerAnnouncements() {
    await runAdminAction("player-announcements", "Saving player announcements", async () => {
      const result = await adminApi.savePlayerAnnouncements(playerAnnouncements);
      setPlayerAnnouncements(result.settings);
      setPlayerAnnouncementsOriginal(result.settings);
      await loadHistory(true);
    }, "Player announcements were saved successfully.");
  }

  async function restorePlayerAnnouncements() {
    if (!(await confirmAction("Restore the join and leave announcement defaults?", { title: "Restore Player Announcements", confirmLabel: "Restore Defaults" }))) return;
    await runAdminAction("player-announcements", "Restoring player announcements", async () => {
      const result = await adminApi.restorePlayerAnnouncements();
      setPlayerAnnouncements(result.settings);
      setPlayerAnnouncementsOriginal(result.settings);
      await loadHistory(true);
    }, "Player announcement defaults were restored.");
  }

  async function sendMapChat() {
    const target = mapChatOptions.find((option) => option.key === mapChatTarget) || mapChatOptions[0] || defaultMapChatOptions()[0];
    await runAdminAction("map-chat", "Sending map chat message", async () => {
      await adminApi.mapChat(target.chatRegion, target.dimension, mapChatBody);
      await loadHistory(true);
    }, "Map chat message was sent successfully.");
  }

  async function loadMapChatOptions() {
    const result = await liveMapApi.services();
    const options = buildMapChatOptions(result.rows || []);
    if (!options.length) return;
    setMapChatOptions(options);
    setMapChatTarget((current) => options.some((option) => option.key === current) ? current : options[0].key);
  }

  const historyRows = parseHistoryRows(history, players, "admin-tools");
  const transferBooleanRow = (key: keyof CharacterTransferSettings, label: string) => {
    const value = Boolean(transferSettings?.[key]);
    return <label className="character-transfer-row character-transfer-boolean-row">
      <span>{label}</span>
      <strong>{value ? "True" : "False"}</strong>
      <input type="checkbox" disabled={transferSaving} checked={value} onChange={(event) => updateTransferSetting(key, event.target.checked as CharacterTransferSettings[typeof key])} />
    </label>;
  };

  return <section className="panel admin-tools-panel">
    <h2>Admin Tools</h2>
    <div className={`playerAdmin_toggle ${liveToolsOpen ? "open" : ""}`}>
      <button className="playerAdmin_toggleHeader" aria-label={liveToolsOpen ? "Collapse Global Live Tools" : "Expand Global Live Tools"} onClick={() => setLiveToolsOpen(!liveToolsOpen)}>{liveToolsOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}<span>Global Live Tools</span></button>
      {liveToolsOpen && <div className="playerAdmin_toggleBody"><div className="global-live-tools">
        <div className="action-line admin-global-actions">
          <button className="danger" onClick={() => run(kickAllPlayers)}>Kick All</button>
          <button className="success" onClick={() => run(hydrateOnlinePlayers)}>Hydrate All</button>
          <InlineActionResult result={actionResult} resultKey="global" />
        </div>
        <div className="section-divider" />
        <div className="action-line broadcast-line motd-line">
          <div className="panel-title schedule-panel-title motd-panel-title">
            <h4>Message of the Day</h4>
            <label className={`switch-checkbox ${messageOfTheDay.enabled ? "enabled" : "disabled"}`}><input type="checkbox" checked={messageOfTheDay.enabled} onChange={(event) => run(() => toggleMessageOfTheDay(event.target.checked))} /><span className="switch-label">Login Message</span><strong className="switch-state">{messageOfTheDay.enabled ? "ON" : "OFF"}</strong></label>
          </div>
          {messageOfTheDayDirty && <p className="dirty-note">Unsaved changes: Message of the Day</p>}
          <p className="muted">Shown as a private in-game message once per player login session.</p>
          <label className="broadcast-message">Message<textarea rows={3} value={messageOfTheDay.message} onChange={(event) => setMessageOfTheDay((current) => ({ ...current, message: event.target.value }))} placeholder="Message shown when a player logs in" /></label>
          <div className="broadcast-controls-row">
            <button disabled={!messageOfTheDayDirty} onClick={() => run(saveMessageOfTheDay)}>Save MOTD</button>
            <button onClick={() => run(restoreMessageOfTheDay)}>Restore Defaults</button>
            <InlineActionResult result={actionResult} resultKey="message-of-the-day" />
          </div>
        </div>
        <div className="section-divider" />
        <div className="action-line broadcast-line">
          <h4 className="live-tool-section-title">Send Server Broadcast</h4>
          <label className="broadcast-title">Broadcast Title<input value={broadcastTitle} onChange={(event) => setBroadcastTitle(event.target.value)} placeholder="Title shown in-game" /></label>
          <label className="broadcast-message">Broadcast Body<textarea rows={3} value={broadcastBody} onChange={(event) => setBroadcastBody(event.target.value)} placeholder="Message shown to online players" /></label>
          <div className="broadcast-controls-row">
            <label className="inline-field">Duration Seconds<input type="number" min="1" max="3600" value={broadcastDuration} onChange={(event) => setBroadcastDuration(event.target.value)} /></label>
            <button onClick={() => run(sendBroadcast)}>Send Broadcast</button>
            <InlineActionResult result={actionResult} resultKey="broadcast" />
          </div>
        </div>
        <div className="section-divider" />
        <div className="action-line broadcast-line map-chat-line">
          <h4 className="live-tool-section-title">Send Map Message</h4>
          <label className="broadcast-title">Choose Map<select value={mapChatTarget} onChange={(event) => setMapChatTarget(event.target.value)}>
            {mapChatOptions.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
          </select></label>
          <label className="broadcast-message">Message<textarea rows={3} value={mapChatBody} onChange={(event) => setMapChatBody(event.target.value)} placeholder="Message shown in this map chat" /></label>
          <div className="broadcast-controls-row">
            <button onClick={() => run(sendMapChat)}>Send Message</button>
            <InlineActionResult result={actionResult} resultKey="map-chat" />
          </div>
        </div>
        <div className="section-divider" />
        <div className="action-line broadcast-line player-announcements-line">
          <div className="panel-title schedule-panel-title">
            <h4>Player Arrival & Departure Messages</h4>
          </div>
          {playerAnnouncementsDirty && <p className="dirty-note">Unsaved changes: Player announcements</p>}
          <label className="checkbox-line">
            <input type="checkbox" checked={playerAnnouncements.joinEnabled} onChange={(event) => setPlayerAnnouncements((current) => ({ ...current, joinEnabled: event.target.checked }))} />
            <span>Enable Join Announcements</span>
          </label>
          <label className="broadcast-message">Join Message<textarea rows={2} value={playerAnnouncements.joinMessage} onChange={(event) => setPlayerAnnouncements((current) => ({ ...current, joinMessage: event.target.value }))} placeholder={DEFAULT_PLAYER_JOIN_MESSAGE} /></label>
          <label className="checkbox-line">
            <input type="checkbox" checked={playerAnnouncements.leaveEnabled} onChange={(event) => setPlayerAnnouncements((current) => ({ ...current, leaveEnabled: event.target.checked }))} />
            <span>Enable Leave Announcements</span>
          </label>
          <label className="broadcast-message">Leave Message<textarea rows={2} value={playerAnnouncements.leaveMessage} onChange={(event) => setPlayerAnnouncements((current) => ({ ...current, leaveMessage: event.target.value }))} placeholder={DEFAULT_PLAYER_LEAVE_MESSAGE} /></label>
          <div className="broadcast-controls-row">
            <button disabled={!playerAnnouncementsDirty} onClick={() => run(savePlayerAnnouncements)}>Save</button>
            <button onClick={() => run(restorePlayerAnnouncements)}>Restore Defaults</button>
            <InlineActionResult result={actionResult} resultKey="player-announcements" />
          </div>
        </div>
      </div></div>}
    </div>
    <div className={`playerAdmin_toggle ${scheduleOpen ? "open" : ""}`}>
      <button className="playerAdmin_toggleHeader" aria-label={scheduleOpen ? "Collapse Schedule Server Restart" : "Expand Schedule Server Restart"} onClick={() => setScheduleOpen(!scheduleOpen)}>{scheduleOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}<span>Schedule Server Restart</span></button>
      {scheduleOpen && <div className="playerAdmin_toggleBody">
        <div className="panel-title schedule-panel-title">
          <h4>Daily Restart</h4>
          <label className={`switch-checkbox ${restartEnabled ? "enabled" : "disabled"}`}><input type="checkbox" disabled={scheduleLoading || scheduleSaving} checked={restartEnabled} onChange={(event) => run(() => saveSchedule(event.target.checked))} /><span className="switch-label">Service Status</span><strong className="switch-state">{restartEnabled ? "ON" : "OFF"}</strong></label>
        </div>
        <KeyValueGrid items={[["Current Status", scheduleStatusLabel], ["Restart Time (Local Server Time)", toHourMinuteTime(restartScheduleValues.restart_time || restartTime)], ["In-Game Notice Before", `${restartNotifyMinutes} minutes`], ["Timer", scheduleDisplayTimerLabel]]} />
        {commandStatusSummary(restartSchedule).reason && <p className="danger-note">{commandStatusSummary(restartSchedule).reason}</p>}
        <div className="action-line schedule-action-line">
          <label className="compact-select">Daily Restart Time<input type="time" step="60" pattern="[0-2][0-9]:[0-5][0-9]" disabled={scheduleSaving} value={restartTime} onChange={(event) => setRestartTime(sanitizeTimeInput(event.target.value))} placeholder="05:00" /></label>
          <label className="compact-select schedule-notify-field">In-Game Notice Before (Min)<input type="number" min="1" max="1440" step="1" disabled={scheduleSaving} value={restartNotifyMinutes} onChange={(event) => setRestartNotifyMinutes(event.target.value)} /></label>
          <button disabled={scheduleSaving || scheduleLoading} onClick={() => saveSchedule()}>Save Schedule</button>
          {scheduleResult && <span className={`inline-task-result result-${scheduleResult.status === "succeeded" ? "ok" : scheduleResult.status === "failed" ? "fail" : "running"}`}>
            <strong className={scheduleResult.status === "running" ? "loading-dots" : ""}>{formatResultTitle(scheduleResult.title, scheduleResult.status === "running")}</strong>
          </span>}
        </div>
        <div className="section-divider" />
        <div className="panel-title schedule-panel-title">
          <h4>Restart On Public IP Change</h4>
          <label className={`switch-checkbox ${ipChangeEnabled ? "enabled" : "disabled"}`}><input type="checkbox" disabled={ipChangeLoading || ipChangeSaving} checked={ipChangeEnabled} onChange={(event) => run(() => saveIpChangeRestart(event.target.checked))} /><span className="switch-label">IP Monitor</span><strong className="switch-state">{ipChangeEnabled ? "ON" : "OFF"}</strong></label>
        </div>
        <KeyValueGrid items={[["Current Status", ipChangeStatusLabel], ["Check Interval", `${ipChangeIntervalMinutes} minutes`], ["In-Game Notice", `${ipChangeNotifyMinutes} minutes`], ["Last Public IP", ipChangeValues.last_known_public_ip || "Unavailable"], ["Last Check", ipChangeValues.last_check || "Unavailable"], ["Last Restart", ipChangeValues.last_restart || "Unavailable"], ["Timer", ipChangeDisplayTimerLabel]]} />
        {commandStatusSummary(ipChangeRestart).reason && <p className="danger-note">{commandStatusSummary(ipChangeRestart).reason}</p>}
        <p className="muted">For public servers on dynamic IPs. When the public IP changes, the console updates SERVER_IP and restarts the console so the new address is advertised.</p>
        <div className="action-line schedule-action-line">
          <label className="compact-select schedule-notify-field">Check Every (Min)<input type="number" min="1" max="1440" step="1" disabled={ipChangeSaving} value={ipChangeIntervalMinutes} onChange={(event) => setIpChangeIntervalMinutes(event.target.value)} /></label>
          <label className="compact-select schedule-notify-field">In-Game Notice (Min)<input type="number" min="0" max="60" step="1" disabled={ipChangeSaving} value={ipChangeNotifyMinutes} onChange={(event) => setIpChangeNotifyMinutes(event.target.value)} /></label>
          <button disabled={ipChangeSaving || ipChangeLoading} onClick={() => saveIpChangeRestart()}>Save IP Monitor</button>
          <button disabled={ipChangeSaving || ipChangeLoading} onClick={() => checkIpChangeNow()}>Check Now</button>
          {ipChangeResult && <span className={`inline-task-result result-${ipChangeResult.status === "succeeded" ? "ok" : ipChangeResult.status === "failed" ? "fail" : "running"}`}>
            <strong className={ipChangeResult.status === "running" ? "loading-dots" : ""}>{formatResultTitle(ipChangeResult.title, ipChangeResult.status === "running")}</strong>
          </span>}
        </div>
        <div className="section-divider" />
        <div className="panel-title schedule-panel-title">
          <h4>Host Shutdown Protection</h4>
          <label className={`switch-checkbox ${shutdownProtectionEnabled ? "enabled" : "disabled"}`}><input type="checkbox" disabled={shutdownProtectionLoading || shutdownProtectionSaving} checked={shutdownProtectionEnabled} onChange={(event) => run(() => saveShutdownProtection(event.target.checked))} /><span className="switch-label">Clean Stop</span><strong className="switch-state">{shutdownProtectionEnabled ? "ON" : "OFF"}</strong></label>
        </div>
        <KeyValueGrid items={[["Current Status", shutdownProtectionStatusLabel], ["Systemd Service", shutdownProtectionServiceLabel], ["Systemd Enabled", shutdownProtectionEnabledValue ? formatTimerStatus(shutdownProtectionEnabledValue) : "Not Installed"], ["Timeout", shutdownProtectionValues.timeout || "240 seconds"]]} />
        {commandStatusSummary(shutdownProtection).reason && <p className="danger-note">{commandStatusSummary(shutdownProtection).reason}</p>}
        <p className="muted">Optional Linux host integration. When the host shuts down or reboots, systemd runs the console clean-stop flow before Docker terminates containers. This is not required for Unraid, WSL, or custom environments that manage shutdown another way.</p>
        <div className="action-line schedule-action-line">
          {shutdownProtectionInstalled && <button className="danger" disabled={shutdownProtectionSaving || shutdownProtectionLoading} onClick={() => removeShutdownProtection()}>Remove Service</button>}
          {shutdownProtectionResult && <span className={`inline-task-result result-${shutdownProtectionResult.status === "succeeded" ? "ok" : shutdownProtectionResult.status === "failed" ? "fail" : "running"}`}>
            <strong className={shutdownProtectionResult.status === "running" ? "loading-dots" : ""}>{formatResultTitle(shutdownProtectionResult.title, shutdownProtectionResult.status === "running")}</strong>
          </span>}
        </div>
        {shutdownProtectionResult?.status === "failed" && shutdownProtectionValues.manual_install_command && <p className="danger-note">If automatic install is not available in this environment, run this on the Linux host: <code>{shutdownProtectionValues.manual_install_command}</code></p>}
      </div>}
    </div>
    <div className={`playerAdmin_toggle ${transferOpen ? "open" : ""}`}>
      <button className="playerAdmin_toggleHeader" aria-label={transferOpen ? "Collapse Character Transfer Settings" : "Expand Character Transfer Settings"} onClick={() => setTransferOpen(!transferOpen)}>{transferOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}<span>Character Transfer Settings</span></button>
      {transferOpen && <div className="playerAdmin_toggleBody">
        {transferDirty && <p className="dirty-note">Unsaved changes: Character Transfer Settings</p>}
        <p className="muted">Battlegroup Director transfer policy. Saving restarts only the Director service so the battlegroup-wide transfer rules are reloaded.</p>
        {transferSettings && <div className="character-transfer-grid">
          {transferBooleanRow("ShouldDeleteOriginCharactersDuringTransfers", "Delete origin character after transfer")}
          <label className="character-transfer-row"><span>Incoming character transfer policy</span><select disabled={transferSaving} value={transferSettings.IncomingCharacterTransfers} onChange={(event) => updateTransferSetting("IncomingCharacterTransfers", Number(event.target.value))}>{transferPolicies.map((policy) => <option key={policy.value} value={policy.value}>{policy.label}</option>)}</select><span className="character-transfer-spacer" /></label>
          {transferBooleanRow("AcceptOutgoingCharacterTransfers", "Accept outgoing character transfers")}
          <label className="character-transfer-row"><span>Export timeout, seconds</span><input type="number" min="1" step="1" disabled={transferSaving} value={transferSettings.ExportCharacterTimeout} onChange={(event) => updateTransferSetting("ExportCharacterTimeout", Number(event.target.value))} /><span className="character-transfer-spacer" /></label>
          <label className="character-transfer-row"><span>Import timeout, seconds</span><input type="number" min="1" step="1" disabled={transferSaving} value={transferSettings.ImportCharacterTimeout} onChange={(event) => updateTransferSetting("ImportCharacterTimeout", Number(event.target.value))} /><span className="character-transfer-spacer" /></label>
          {transferBooleanRow("FreeToTransferCharactersFrom", "Free transfers from this server")}
          {transferBooleanRow("FreeToTransferCharactersTo", "Free transfers to this server")}
          <label className="character-transfer-row"><span>Validate-before-import timeout, seconds</span><input type="number" min="1" step="1" disabled={transferSaving} value={transferSettings.ValidateBeforeImportCharacterTimeout} onChange={(event) => updateTransferSetting("ValidateBeforeImportCharacterTimeout", Number(event.target.value))} /><span className="character-transfer-spacer" /></label>
          {transferBooleanRow("ForceIsWorldClosed", "Force world closed")}
          {transferBooleanRow("ForceIsWorldClosingSoon", "Force world closing soon")}
        </div>}
        <div className="action-line schedule-action-line">
          <button disabled={transferLoading || transferSaving || !transferDirty} onClick={() => saveTransferSettings()}>Save</button>
          <button disabled={transferLoading || transferSaving || !transferDefaults} onClick={() => restoreTransferDefaults()}>Restore Defaults</button>
          {transferResult && <span className={`inline-task-result result-${transferResult.status === "succeeded" ? "ok" : transferResult.status === "failed" ? "fail" : "running"}`}>
            <strong className={transferResult.status === "running" ? "loading-dots" : ""}>{formatResultTitle(transferResult.title, transferResult.status === "running")}</strong>
          </span>}
        </div>
      </div>}
    </div>
    <div className={`playerAdmin_toggle admin-history-toggle-panel ${historyOpen ? "open" : ""}`}>
      <button className="playerAdmin_toggleHeader" aria-label={historyOpen ? "Collapse Command History" : "Expand Command History"} onClick={() => setHistoryOpen(!historyOpen)}>{historyOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}<span>Command History</span></button>
      {historyOpen && <div className="playerAdmin_toggleBody"><div className="admin-history-content">
        {historyRows.length > 0 && <div className="action-row admin-history-actions"><button onClick={() => run(clearHistory)}>Clear</button></div>}
        {historyRows.length ? <div className="admin-history-table"><DataTable rows={historyRows} columns={["time", "action", "target", "status", "summary"]} tableClassName="admin-history-grid" /></div> : <div className="admin-history-empty">Command history will appear here after an admin action runs.</div>}
        {history && <TechnicalDetails title="Advanced history output" text={history} />}
      </div></div>}
    </div>
  </section>;
}

function formatResultTitle(value: unknown, pending = false) {
  return formatUiSentence(value, pending);
}

function parseKeyValueText(text: string) {
  const out: Record<string, string> = {};
  for (const rawLine of stripAnsi(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = line.match(/^([^:=]{2,80}):\s*(.*)$/);
    if (!match) continue;
    out[match[1].trim().toLowerCase().replace(/\s+/g, "_")] = match[2].trim();
  }
  return out;
}

function commandStatusSummary(result: { stdout?: string; stderr?: string; exitCode?: number } | null) {
  if (!result) return { status: "Loading", reason: "" };
  if (Number(result.exitCode || 0) === 0) return { status: "Checked", reason: "" };
  return { status: "Check Failed", reason: result.stderr || result.stdout || "Command failed" };
}

function formatTimerStatus(value: string) {
  const text = String(value || "").trim();
  if (/^not installed$/i.test(text)) return "Not Installed";
  return titleCase(text);
}

function toHourMinuteTime(value: unknown) {
  const text = String(value || "").trim();
  if (!text || /^unset$/i.test(text)) return "Unset";
  const match = text.match(/^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/);
  return match ? `${match[1]}:${match[2]}` : text;
}

function sanitizeTimeInput(value: string) {
  return value.replace(/[^\d:]/g, "").slice(0, 5);
}

function isValidHourMinuteTime(value: string) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function taskTechnicalDetails(task: Task) {
  return task.logLines.map((line) => line.line).filter(Boolean).join("\n") || task.errorMessage || "";
}

async function waitForTaskSilently(task: Task) {
  let current = task;
  for (let i = 0; i < 180 && !isTerminalTask(current.status); i += 1) {
    await new Promise((resolvePromise) => window.setTimeout(resolvePromise, 1000));
    current = (await setupApi.task(current.id)).task;
  }
  return current;
}

function isTerminalTask(status: string) {
  return ["succeeded", "failed", "cancelled"].includes(status);
}

function sameTransferSettings(a: CharacterTransferSettings, b: CharacterTransferSettings) {
  return Object.keys(a).every((key) => a[key as keyof CharacterTransferSettings] === b[key as keyof CharacterTransferSettings]);
}

function sameMessageOfTheDay(a: MessageOfTheDaySettings, b: MessageOfTheDaySettings) {
  return a.enabled === b.enabled && a.message === b.message;
}

function samePlayerAnnouncements(a: PlayerAnnouncementSettings, b: PlayerAnnouncementSettings) {
  return a.joinEnabled === b.joinEnabled
    && a.joinMessage === b.joinMessage
    && a.leaveEnabled === b.leaveEnabled
    && a.leaveMessage === b.leaveMessage;
}

function buildMapChatOptions(rows: Record<string, unknown>[]) {
  const candidates = rows.map((row) => {
    const map = String(row.map || "").trim();
    if (!map) return null;
    const dimension = Number(row.dimension_index || 0);
    const alive = Boolean(row.alive);
    const ready = Boolean(row.ready);
    const players = Number(row.connected_players || 0);
    const chatRegion = chatRegionForMap(map);
    const status = ready ? "Ready" : alive ? "Warming" : "Offline";
    const destinationName = mapChatDestinationName(row, map);
    return {
      key: `${chatRegion}|${dimension}`,
      label: `${destinationName} (${status}, ${players} online)`,
      chatRegion,
      dimension,
      status,
      players,
      alive,
      ready
    };
  }).filter((option): option is MapChatOption & { alive: boolean; ready: boolean } => Boolean(option));

  const running = candidates.filter((option) => option.alive || option.ready);
  const source = running.length ? running : candidates;
  const seen = new Set<string>();
  return source.sort((a, b) => Number(b.ready) - Number(a.ready) || Number(b.alive) - Number(a.alive) || a.chatRegion.localeCompare(b.chatRegion) || a.dimension - b.dimension).filter((option) => {
    if (seen.has(option.key)) return false;
    seen.add(option.key);
    return true;
  }).map(({ alive, ready, ...option }) => option);
}

function defaultMapChatOptions(): MapChatOption[] {
  return [
    { key: "HaggaBasin|0", label: "Survival Sietch (Default, 0 online)", chatRegion: "HaggaBasin", dimension: 0, status: "Default", players: 0 },
    { key: "Overland|0", label: "Overland (Default, 0 online)", chatRegion: "Overland", dimension: 0, status: "Default", players: 0 },
    { key: "DeepDesert|0", label: "Deep Desert (Default, 0 online)", chatRegion: "DeepDesert", dimension: 0, status: "Default", players: 0 }
  ];
}

function mapChatDestinationName(row: Record<string, unknown>, map: string) {
  const name = String(row.name || "").trim();
  return name || friendlyMapChatName(map);
}

function chatRegionForMap(map: string) {
  const value = String(map || "").trim();
  const aliases: Record<string, string> = {
    Survival_1: "HaggaBasin",
    Overmap: "Overland",
    DeepDesert_1: "DeepDesert",
    SH_Arrakeen: "Arrakeen",
    SH_HarkoVillage: "HarkoVillage"
  };
  if (aliases[value]) return aliases[value];
  return value.replace(/^SH_/, "").replace(/^CB_Story_/, "").replace(/^CB_Dungeon_/, "").replace(/^DLC_Story_/, "");
}

function friendlyMapChatName(map: string) {
  return chatRegionForMap(map).replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ");
}

function parseHistoryRows(text: string, players: Record<string, unknown>[] = [], scope: "all" | "admin-tools" = "all") {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).filter((line) => !/^time\s+/i.test(line) && !/^no admin command history found\.?$/i.test(line)).map((line) => {
    const parts = line.split(/\t/);
    if (parts.length >= 6) {
      if (!adminHistoryLineMatchesScope(parts[1], parts[2], scope)) return null;
      return { time: formatAdminHistoryTime(parts[0]), action: friendlyAdminHistoryAction(parts[1]), target: friendlyAdminHistoryTarget(parts[2], players), status: friendlyAdminHistoryValue(parts[5]), summary: friendlyAdminHistorySummary(parts[3], parts[4], parts.slice(6).join(" "), parts[1]) };
    }
    const loose = line.split(/\s{2,}/).filter(Boolean);
    if (!adminHistoryLineMatchesScope(loose[1] || "", loose[2] || "", scope)) return null;
    return { time: formatAdminHistoryTime(loose[0] || ""), action: friendlyAdminHistoryAction(loose[1] || ""), target: friendlyAdminHistoryTarget(loose[2] || "", players), status: friendlyAdminHistoryValue(loose[5] || ""), summary: friendlyAdminHistorySummary(loose[3] || "", loose[4] || "", loose.slice(6).join(" "), loose[1] || "") };
  }).filter((row): row is { time: string; action: string; target: string; status: string; summary: string } => Boolean(row && (row.action || row.summary))).reverse();
}

function adminHistoryLineMatchesScope(command: string, target: string, scope: "all" | "admin-tools") {
  if (scope === "all") return true;
  const rawCommand = String(command || "").trim();
  const rawTarget = String(target || "").trim();
  if (/^web-(broadcast|shutdown-broadcast|map-chat|hydrate-all)$/i.test(rawCommand)) return true;
  if (/^KickPlayer$/i.test(rawCommand) && /^(all|\*)$/i.test(rawTarget)) return true;
  return false;
}

function formatAdminHistoryTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function friendlyAdminHistoryValue(value: string) {
  const text = String(value || "-").replace(/^web[-_]/i, "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  if (!text || text === "-") return "-";
  return titleCaseWords(text);
}

function friendlyAdminHistoryAction(value: string) {
  const raw = String(value || "").trim();
  const labels: Record<string, string> = { "web-hydrate-all": "Hydrate All", AddItemToInventory: "Grant Item", AwardXP: "Award XP", UpdateAllWaterFillables: "Refill Container", KickPlayer: "Kick Player", GrantTemplate: "Grant Template", SkillsSetUnspentSkillPoints: "Set Skill Points", SkillsSetModuleLevel: "Set Skill Module", CleanPlayerInventory: "Clean Inventory", ResetProgression: "Reset Progression", TeleportTo: "Teleport Player", SpawnVehicleAt: "Spawn Vehicle", SpecializationXP: "Specialization XP" };
  labels["web-map-chat"] = "Map Chat";
  if (labels[raw]) return labels[raw];
  const cleaned = raw.replace(/^web[-_]/i, "").replace(/[-_]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/\bXP\b/i, "XP").replace(/\s+/g, " ").trim();
  return cleaned ? titleCaseWords(cleaned).replace(/\bXp\b/g, "XP") : "-";
}

function friendlyAdminHistoryTarget(value: string, players: Record<string, unknown>[]) {
  const text = String(value || "-").trim();
  if (!text || text === "-") return "-";
  if (/^(all|\*)$/i.test(text)) return "All";
  const row = players.find((player) => adminHistoryTargetCandidates(player).some((candidate) => matchesAdminHistoryTarget(candidate, text)));
  return row ? String(row.character_name || text) : friendlyAdminHistoryValue(text);
}

function adminHistoryTargetCandidates(player: Record<string, unknown>) {
  return [player.action_player_id, player.funcom_id, player.fls_id, player.account_id, player.actor_id, player.player_pawn_id, player.id].map((candidate) => String(candidate || "").trim()).filter(Boolean);
}

function matchesAdminHistoryTarget(candidate: string, target: string) {
  const normalizedCandidate = candidate.toLowerCase();
  const normalizedTarget = target.toLowerCase();
  if (normalizedCandidate === normalizedTarget) return true;
  const masked = normalizedTarget.match(/^(.{4,})\.\.\.(.{4,})$/);
  if (!masked) return false;
  return normalizedCandidate.startsWith(masked[1]) && normalizedCandidate.endsWith(masked[2]);
}

function friendlyAdminHistorySummary(friendly: string, path: string, payload: string, command = "") {
  const label = String(friendly || "").replace(/\bpublish test\b/gi, "").replace(/\s+/g, " ").trim();
  const parsed = parseJsonMaybe(payload) as { messagePreview?: unknown } | null;
  const message = parsed?.messagePreview;
  const messageText = typeof message === "string" && message.trim() ? `: "${message.trim().slice(0, 80)}${message.trim().length > 80 ? "..." : ""}"` : "";
  if (/^web-map-chat$/i.test(String(command || ""))) return `Map chat${messageText}`;
  if (/broadcast/i.test(label) || /^web-(broadcast|shutdown-broadcast)$/i.test(String(command || ""))) return `Broadcast${messageText}`;
  if (/hydrate/i.test(label) || /^web-hydrate-all$/i.test(String(command || ""))) return "Hydrated online players";
  if (/kick/i.test(label)) return "Kick command";
  if (/grant/i.test(label)) return label || "Grant command";
  if (label) return label;
  if (/rmq/i.test(path)) return "RabbitMQ command";
  return "Admin command";
}

function parseJsonMaybe(text: string) {
  if (!text.trim().startsWith("{") && !text.trim().startsWith("[")) return null;
  try { return JSON.parse(text); } catch { return null; }
}

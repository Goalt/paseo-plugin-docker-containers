import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Linking, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import {
  containerLogs,
  containerStats,
  inspectContainer,
  listContainers,
  listImages,
  listNetworks,
  listVolumes,
  removeContainer,
  startContainer,
  stopContainer,
  type ContainerDetail,
  type ContainerInfo,
  type ContainerStats,
  type ImageInfo,
  type NetworkInfo,
  type VolumeInfo,
} from "../shared/contract";

const REFRESH_MS = 5000;

// ВАЖНО: в этом файле нельзя использовать async/await — компилятор демона 0.6.1
// не понижает синтаксис для клиентского бандла, и Hermes на iOS/Android его не съест.
// Только промис-цепочки.

type Tab = "containers" | "volumes" | "images" | "networks";

const TABS: { key: Tab; label: string }[] = [
  { key: "containers", label: "Containers" },
  { key: "volumes", label: "Volumes" },
  { key: "images", label: "Images" },
  { key: "networks", label: "Networks" },
];

interface SectionState<T> {
  items: T[] | null;
  error: string | null;
  updatedAt: string | null;
}

interface DetailState {
  loading: boolean;
  error: string | null;
  detail: ContainerDetail | null;
  logs: string | null;
}

const EMPTY_DETAIL: DetailState = { loading: false, error: null, detail: null, logs: null };

function now(): string {
  return new Date().toLocaleTimeString();
}

// Tailscale-IP хоста, на котором крутится демон, — ссылки на порты ведут туда.
const TAILSCALE_IP = "100.107.34.3";

interface PortEntry {
  label: string;
  url: string | null;
}

function portUrl(hostIp: string, hostPort: string): string | null {
  if (!hostPort) return null;
  // привязка только к loopback — снаружи по Tailscale недоступна
  if (hostIp === "127.0.0.1") return null;
  return `http://${TAILSCALE_IP}:${hostPort}`;
}

function parseCardPorts(ports: string): PortEntry[] {
  if (!ports) return [];
  const seen = new Set<string>();
  const out: PortEntry[] = [];
  for (const part of ports.split(",")) {
    const raw = part.trim();
    if (!raw) continue;
    const label = raw.replace("0.0.0.0:", "").replace("[::]:", "").replace(":::", "");
    if (!label || seen.has(label)) continue;
    seen.add(label);
    const arrow = raw.indexOf("->");
    if (arrow === -1) {
      out.push({ label, url: null });
      continue;
    }
    const left = raw.slice(0, arrow);
    const portMatch = left.match(/(\d+)$/);
    const ipMatch = left.match(/^(\d{1,3}(?:\.\d{1,3}){3}):/);
    out.push({
      label,
      url: portUrl(ipMatch ? ipMatch[1] : "", portMatch ? portMatch[1] : ""),
    });
  }
  return out;
}

// Строка из detail.ports: "8080/tcp → :8080, 1.2.3.4:9000" или "6379/tcp (not published)"
function parseDetailPortLine(line: string): { prefix: string; bindings: PortEntry[] } {
  const idx = line.indexOf(" → ");
  if (idx === -1) return { prefix: line, bindings: [] };
  const bindings = line
    .slice(idx + 3)
    .split(",")
    .map((piece) => piece.trim())
    .filter(Boolean)
    .map((binding) => {
      const m = binding.match(/^(?:(\d{1,3}(?:\.\d{1,3}){3}))?:(\d+)$/);
      if (!m) return { label: binding, url: null };
      return { label: binding, url: portUrl(m[1] ?? "", m[2]) };
    });
  return { prefix: line.slice(0, idx), bindings };
}

function openUrl(url: string) {
  Linking.openURL(url).catch(() => {
    // на некоторых клиентах открытие может быть запрещено — молча игнорируем
  });
}

function formatIso(value: string): string {
  if (!value || value.startsWith("0001")) return "";
  return value.replace("T", " ").slice(0, 19);
}

function stateColor(
  state: string,
  colors: PluginSurfaceProps["theme"]["colors"],
): string {
  if (state === "running") return colors.accent;
  if (state === "exited" || state === "dead") return colors.statusDanger;
  return colors.foregroundMuted;
}

// Живой фильтр списка контейнеров: подстрока в имени или в имени образа.
// Пустой (в т.ч. пробельный) запрос пропускает всё.
function matchesQuery(item: ContainerInfo, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return (
    item.name.toLowerCase().includes(needle) ||
    item.image.toLowerCase().includes(needle)
  );
}

const NO_COMPOSE_KEY = "__none__";

interface ContainerGroup {
  key: string;
  title: string;
  items: ContainerInfo[];
}

// Группировка по label com.docker.compose.project. Порядок внутри группы —
// как отдал docker ps (Map хранит порядок вставки); проекты по алфавиту,
// контейнеры без compose — всегда последней группой.
function groupByCompose(items: ContainerInfo[]): ContainerGroup[] {
  const byProject = new Map<string, ContainerInfo[]>();
  for (const item of items) {
    const project = item.composeProject ?? "";
    const bucket = byProject.get(project);
    if (bucket) bucket.push(item);
    else byProject.set(project, [item]);
  }
  const named: string[] = [];
  for (const project of byProject.keys()) {
    if (project !== "") named.push(project);
  }
  named.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const groups: ContainerGroup[] = named.map((project) => ({
    key: project,
    title: project,
    items: byProject.get(project) ?? [],
  }));
  const loose = byProject.get("");
  if (loose && loose.length > 0) {
    groups.push({ key: NO_COMPOSE_KEY, title: "Без compose", items: loose });
  }
  return groups;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

type ContainerAction = "stop" | "start" | "remove";

// Какие действия допускает состояние контейнера; у removing и прочих — никаких.
// Delete — только у остановленных: принудительного удаления запущенных нет.
function allowedActions(state: string): ContainerAction[] {
  if (state === "running" || state === "restarting" || state === "paused") return ["stop"];
  if (state === "exited" || state === "created") return ["start", "remove"];
  if (state === "dead") return ["remove"];
  return [];
}

const ACTION_LABELS: Record<ContainerAction, { idle: string; confirm: string; busy: string }> = {
  stop: { idle: "Stop", confirm: "Confirm stop?", busy: "Stopping…" },
  start: { idle: "Start", confirm: "Confirm start?", busy: "Starting…" },
  remove: { idle: "Delete", confirm: "Confirm delete?", busy: "Deleting…" },
};

// Армированное «Confirm …?» сбрасывается, если второй тап так и не случился.
const CONFIRM_RESET_MS = 3000;

function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

export function DockerContainers({ theme, layout }: PluginSurfaceProps) {
  const fetchPs = useRpc(listContainers);
  const fetchStats = useRpc(containerStats);
  const fetchInspect = useRpc(inspectContainer);
  const fetchLogs = useRpc(containerLogs);
  const fetchVolumes = useRpc(listVolumes);
  const fetchImages = useRpc(listImages);
  const fetchNetworks = useRpc(listNetworks);
  const callStop = useRpc(stopContainer);
  const callStart = useRpc(startContainer);
  const callRemove = useRpc(removeContainer);

  const [tab, setTab] = useState<Tab>("containers");
  const [containers, setContainers] = useState<ContainerInfo[] | null>(null);
  const [statsById, setStatsById] = useState<Record<string, ContainerStats>>({});
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const [volumes, setVolumes] = useState<SectionState<VolumeInfo>>({
    items: null,
    error: null,
    updatedAt: null,
  });
  const [images, setImages] = useState<SectionState<ImageInfo>>({
    items: null,
    error: null,
    updatedAt: null,
  });
  const [networks, setNetworks] = useState<SectionState<NetworkInfo>>({
    items: null,
    error: null,
    updatedAt: null,
  });

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detailById, setDetailById] = useState<Record<string, DetailState>>({});
  const [envShownFor, setEnvShownFor] = useState<Record<string, boolean>>({});
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  // Confirm и busy действий — по id в топ-левел стейте: карточки пересоздаются
  // на каждом автообновлении, а эти состояния должны это переживать.
  const [armedById, setArmedById] = useState<Record<string, { action: ContainerAction }>>({});
  const [actionBusyById, setActionBusyById] = useState<Record<string, ContainerAction>>({});
  const [actionErrorById, setActionErrorById] = useState<Record<string, string>>({});

  const aliveRef = useRef(true);
  // null — запросов нет; иначе значение `all` запроса в полёте. Переключение
  // Running↔All при активном запросе не глушится, а устаревший ответ отбрасывается.
  const busyRef = useRef<boolean | null>(null);
  const wantedAllRef = useRef(false);
  const sectionBusyRef = useRef<Record<string, boolean>>({});
  const armTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  // Синхронная копия busy: повторный тап может прийти раньше перерисовки.
  const actionBusyRef = useRef<Record<string, ContainerAction>>({});
  // Действие просило refresh, пока такой же запрос docker ps уже был в полёте.
  const pendingRefreshRef = useRef(false);
  // Коллбеки действий завершаются через секунды — раскрытую карточку читаем на тот момент.
  const expandedIdRef = useRef<string | null>(null);
  expandedIdRef.current = expandedId;

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      for (const timer of Object.values(armTimersRef.current)) clearTimeout(timer);
      armTimersRef.current = {};
    };
  }, []);

  const refresh = useCallback(
    (all: boolean) => {
      wantedAllRef.current = all;
      if (busyRef.current === all) return;
      busyRef.current = all;
      fetchPs({ all })
        .then((result) => {
          if (!aliveRef.current || wantedAllRef.current !== all) return;
          if (!result.ok) {
            setError(result.error ?? "docker ps failed");
            return;
          }
          setError(null);
          setContainers(result.containers);
          setUpdatedAt(now());
        })
        .catch((cause) => {
          if (aliveRef.current) setError(messageOf(cause));
        })
        .then(() => {
          if (busyRef.current === all) busyRef.current = null;
          // этот ответ мог быть снят до завершения действия — повторяем в актуальном режиме
          if (pendingRefreshRef.current && busyRef.current === null && aliveRef.current) {
            pendingRefreshRef.current = false;
            refresh(wantedAllRef.current);
          }
        });
      fetchStats({})
        .then((result) => {
          if (!aliveRef.current || !result.ok) return;
          const next: Record<string, ContainerStats> = {};
          for (const row of result.stats) next[row.id] = row;
          setStatsById(next);
        })
        .catch(() => {
          // stats — вспомогательные данные; их сбой не должен ронять список
        });
    },
    [fetchPs, fetchStats],
  );

  const refreshSection = useCallback(
    (which: Exclude<Tab, "containers">) => {
      if (sectionBusyRef.current[which]) return;
      sectionBusyRef.current[which] = true;
      const done = () => {
        sectionBusyRef.current[which] = false;
      };
      if (which === "volumes") {
        fetchVolumes({})
          .then((result) => {
            if (!aliveRef.current) return;
            setVolumes(
              result.ok
                ? { items: result.volumes, error: null, updatedAt: now() }
                : { items: null, error: result.error ?? "docker volume ls failed", updatedAt: null },
            );
          })
          .catch((cause) => {
            if (aliveRef.current) {
              setVolumes({ items: null, error: messageOf(cause), updatedAt: null });
            }
          })
          .then(done);
      } else if (which === "images") {
        fetchImages({})
          .then((result) => {
            if (!aliveRef.current) return;
            setImages(
              result.ok
                ? { items: result.images, error: null, updatedAt: now() }
                : { items: null, error: result.error ?? "docker images failed", updatedAt: null },
            );
          })
          .catch((cause) => {
            if (aliveRef.current) {
              setImages({ items: null, error: messageOf(cause), updatedAt: null });
            }
          })
          .then(done);
      } else {
        fetchNetworks({})
          .then((result) => {
            if (!aliveRef.current) return;
            setNetworks(
              result.ok
                ? { items: result.networks, error: null, updatedAt: now() }
                : { items: null, error: result.error ?? "docker network ls failed", updatedAt: null },
            );
          })
          .catch((cause) => {
            if (aliveRef.current) {
              setNetworks({ items: null, error: messageOf(cause), updatedAt: null });
            }
          })
          .then(done);
      }
    },
    [fetchVolumes, fetchImages, fetchNetworks],
  );

  useEffect(() => {
    if (tab !== "containers") {
      refreshSection(tab);
      return;
    }
    refresh(showAll);
    const timer = setInterval(() => refresh(showAll), REFRESH_MS);
    return () => clearInterval(timer);
  }, [tab, showAll, refresh, refreshSection]);

  // silent — перечитать детали, не пряча текущие (после stop/start в раскрытой карточке).
  const loadDetail = useCallback(
    (id: string, silent = false) => {
      if (!silent) {
        setDetailById((prev) => ({
          ...prev,
          [id]: { loading: true, error: null, detail: null, logs: null },
        }));
      }
      fetchInspect({ id })
        .then((result) => {
          if (!aliveRef.current) return;
          setDetailById((prev) => {
            const entry = prev[id] ?? EMPTY_DETAIL;
            if (!result.ok) {
              return {
                ...prev,
                [id]: { ...entry, loading: false, error: result.error ?? "docker inspect failed" },
              };
            }
            return { ...prev, [id]: { ...entry, loading: false, error: null, detail: result.detail } };
          });
        })
        .catch((cause) => {
          if (!aliveRef.current) return;
          setDetailById((prev) => ({
            ...prev,
            [id]: { ...(prev[id] ?? EMPTY_DETAIL), loading: false, error: messageOf(cause) },
          }));
        });
      fetchLogs({ id })
        .then((result) => {
          if (!aliveRef.current) return;
          setDetailById((prev) => {
            const entry = prev[id];
            if (!entry) return prev;
            return {
              ...prev,
              [id]: { ...entry, logs: result.ok ? result.logs : result.error ?? "docker logs failed" },
            };
          });
        })
        .catch(() => {
          // хвост логов — вспомогательный; его сбой не должен ломать детали
        });
    },
    [fetchInspect, fetchLogs],
  );

  const toggleExpand = useCallback(
    (id: string) => {
      if (expandedId === id) {
        setExpandedId(null);
        return;
      }
      setExpandedId(id);
      loadDetail(id);
    },
    [expandedId, loadDetail],
  );

  // Refresh после действия: обычный refresh() молча выходит, если тик автообновления
  // уже в полёте, — тогда чейнимся после него. Режим берём из wantedAllRef, а не из
  // замыкания: за время stop сегмент Running/All могли переключить.
  const forceRefresh = useCallback(() => {
    const all = wantedAllRef.current;
    if (busyRef.current === all) {
      pendingRefreshRef.current = true;
      return;
    }
    refresh(all);
  }, [refresh]);

  const toggleCollapse = useCallback((key: string) => {
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const disarmAction = useCallback((id: string) => {
    const timer = armTimersRef.current[id];
    if (timer !== undefined) {
      clearTimeout(timer);
      delete armTimersRef.current[id];
    }
    setArmedById((prev) => omitKey(prev, id));
  }, []);

  const armAction = useCallback((id: string, action: ContainerAction) => {
    const previous = armTimersRef.current[id];
    if (previous !== undefined) clearTimeout(previous);
    setArmedById((prev) => ({ ...prev, [id]: { action } }));
    armTimersRef.current[id] = setTimeout(() => {
      delete armTimersRef.current[id];
      if (aliveRef.current) setArmedById((prev) => omitKey(prev, id));
    }, CONFIRM_RESET_MS);
  }, []);

  const runAction = useCallback(
    (id: string, action: ContainerAction) => {
      actionBusyRef.current[id] = action;
      setActionBusyById((prev) => ({ ...prev, [id]: action }));
      setActionErrorById((prev) => omitKey(prev, id));
      const request =
        action === "stop" ? callStop({ id }) : action === "start" ? callStart({ id }) : callRemove({ id });
      const command = action === "remove" ? "rm" : action;
      request
        .then((result) => (result.ok ? null : (result.error ?? `docker ${command} failed`)))
        // transport-reject (демон недоступен, таймаут RPC) — тоже инлайн-ошибка
        .catch((cause) => messageOf(cause))
        .then((failure) => {
          delete actionBusyRef.current[id];
          if (!aliveRef.current) return;
          setActionBusyById((prev) => omitKey(prev, id));
          if (failure !== null) {
            setActionErrorById((prev) => ({ ...prev, [id]: failure }));
          }
          const expanded = expandedIdRef.current === id;
          if (failure === null && action === "stop" && !wantedAllRef.current && expanded) {
            // в Running остановленный контейнер исчезнет из списка — не держим его раскрытым
            setExpandedId(null);
            setDetailById((prev) => omitKey(prev, id));
          } else if (expanded) {
            loadDetail(id, true);
          }
          // и при успехе, и при ошибке: после таймаута контейнер мог всё-таки смениться
          forceRefresh();
        });
    },
    [callStop, callStart, callRemove, loadDetail, forceRefresh],
  );

  // Первый тап армирует, второй выполняет — но только если армировано именно это
  // действие и текущий state контейнера его всё ещё допускает.
  const pressAction = (item: ContainerInfo, action: ContainerAction) => {
    if (actionBusyRef.current[item.id] !== undefined) return;
    if (!allowedActions(item.state).includes(action)) return;
    if (armedById[item.id]?.action !== action) {
      armAction(item.id, action);
      return;
    }
    disarmAction(item.id);
    runAction(item.id, action);
  };

  const mono = layout.platform === "ios" ? "Menlo" : "monospace";
  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        padding: layout.compact ? 12 : 20,
        gap: layout.compact ? 10 : 14,
        backgroundColor: theme.colors.surface0,
      },
      headerRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        flexWrap: "wrap" as const,
        gap: 8,
      },
      title: {
        color: theme.colors.foreground,
        fontSize: layout.compact ? 18 : 22,
        fontWeight: "700" as const,
      },
      subtitle: { color: theme.colors.foregroundMuted, fontSize: 12 },
      controls: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      segment: {
        flexDirection: "row" as const,
        borderWidth: 1,
        borderColor: theme.colors.foregroundMuted,
        borderRadius: 8,
        overflow: "hidden" as const,
      },
      segmentButton: { paddingVertical: 6, paddingHorizontal: 12 },
      segmentActive: { backgroundColor: theme.colors.accent },
      segmentTextActive: { color: theme.colors.accentForeground, fontSize: 13 },
      segmentTextIdle: { color: theme.colors.foregroundMuted, fontSize: 13 },
      refreshButton: {
        paddingVertical: 6,
        paddingHorizontal: 12,
        borderRadius: 8,
        backgroundColor: theme.colors.accent,
      },
      refreshText: { color: theme.colors.accentForeground, fontSize: 13 },
      errorText: { color: theme.colors.statusDanger, fontSize: 13 },
      list: { gap: layout.compact ? 8 : 10 },
      card: {
        borderWidth: 1,
        borderColor: theme.colors.foregroundMuted,
        borderRadius: 10,
        padding: layout.compact ? 10 : 12,
        gap: 4,
      },
      cardHeader: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
      },
      name: {
        color: theme.colors.foreground,
        fontSize: 15,
        fontWeight: "600" as const,
        flexShrink: 1,
      },
      badgeText: { fontSize: 12, fontWeight: "600" as const },
      chevron: { color: theme.colors.foregroundMuted, fontSize: 12, marginLeft: "auto" as const },
      dot: { width: 8, height: 8, borderRadius: 4 },
      image: { color: theme.colors.foregroundMuted, fontSize: 12 },
      metaRow: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        gap: 12,
      },
      meta: { color: theme.colors.foregroundMuted, fontSize: 12 },
      statText: { color: theme.colors.foreground, fontSize: 12 },
      monoText: {
        color: theme.colors.foregroundMuted,
        fontSize: 11,
        fontFamily: mono,
      },
      portsRow: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        alignItems: "center" as const,
        gap: 8,
      },
      portLink: {
        color: theme.colors.accent,
        fontSize: 11,
        fontFamily: mono,
        textDecorationLine: "underline" as const,
      },
      placeholder: { color: theme.colors.foregroundMuted, fontSize: 14 },
      group: { gap: layout.compact ? 8 : 10 },
      groupHeader: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingVertical: 6,
        paddingHorizontal: 10,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.foregroundMuted,
      },
      groupChevron: { color: theme.colors.foregroundMuted, fontSize: 12 },
      groupTitle: {
        color: theme.colors.foreground,
        fontSize: 13,
        fontWeight: "600" as const,
        flexShrink: 1,
      },
      groupCount: {
        color: theme.colors.foregroundMuted,
        fontSize: 12,
        marginLeft: "auto" as const,
      },
      searchInput: {
        borderWidth: 1,
        borderColor: theme.colors.foregroundMuted,
        borderRadius: 8,
        paddingVertical: layout.compact ? 6 : 8,
        paddingHorizontal: 12,
        color: theme.colors.foreground,
        fontSize: 14,
      },
      detail: {
        marginTop: 6,
        paddingTop: 8,
        borderTopWidth: 1,
        borderTopColor: theme.colors.foregroundMuted,
        gap: 6,
      },
      detailRow: { flexDirection: "row" as const, gap: 8 },
      detailLabel: {
        color: theme.colors.foregroundMuted,
        fontSize: 12,
        width: 110,
        flexShrink: 0,
      },
      detailValue: { color: theme.colors.foreground, fontSize: 12, flexShrink: 1 },
      sectionLabel: {
        color: theme.colors.foreground,
        fontSize: 12,
        fontWeight: "600" as const,
        marginTop: 2,
      },
      envButton: {
        alignSelf: "flex-start" as const,
        paddingVertical: 4,
        paddingHorizontal: 10,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.foregroundMuted,
      },
      envButtonText: { color: theme.colors.foregroundMuted, fontSize: 12 },
      actionRow: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8, marginTop: 2 },
      actionButton: {
        paddingVertical: layout.compact ? 4 : 6,
        paddingHorizontal: layout.compact ? 10 : 14,
        borderRadius: 6,
        borderWidth: 1,
      },
      actionText: { fontSize: layout.compact ? 12 : 13, fontWeight: "600" as const },
      actionDanger: { borderColor: theme.colors.statusDanger },
      actionDangerText: { color: theme.colors.statusDanger },
      actionDangerArmed: {
        borderColor: theme.colors.statusDanger,
        backgroundColor: theme.colors.statusDanger,
      },
      actionStart: { borderColor: theme.colors.accent },
      actionStartText: { color: theme.colors.accent },
      actionStartArmed: { borderColor: theme.colors.accent, backgroundColor: theme.colors.accent },
      actionArmedText: { color: theme.colors.accentForeground },
      actionBusy: { borderColor: theme.colors.foregroundMuted },
      actionBusyText: { color: theme.colors.foregroundMuted },
      logsBox: {
        borderWidth: 1,
        borderColor: theme.colors.foregroundMuted,
        borderRadius: 6,
        padding: 8,
      },
    }),
    [theme, layout.compact, mono],
  );

  const filteredContainers = useMemo(
    () => (containers ?? []).filter((item) => matchesQuery(item, query)),
    [containers, query],
  );
  const filtering = query.trim().length > 0;
  const groups = useMemo(() => groupByCompose(filteredContainers), [filteredContainers]);

  const runningCount =
    containers === null
      ? 0
      : containers.filter((item) => item.state === "running").length;

  const subtitle = (() => {
    if (tab === "containers") {
      if (containers === null) return "Loading…";
      return (
        `${runningCount} running${showAll ? ` / ${containers.length} total` : ""}` +
        (filtering ? ` · ${filteredContainers.length} shown` : "") +
        (updatedAt ? ` · updated ${updatedAt}` : "")
      );
    }
    const section = tab === "volumes" ? volumes : tab === "images" ? images : networks;
    if (section.items === null) return section.error ? "failed" : "Loading…";
    return `${section.items.length} ${tab}` + (section.updatedAt ? ` · updated ${section.updatedAt}` : "");
  })();

  const renderActions = (item: ContainerInfo) => {
    const busyAction = actionBusyById[item.id];
    const busy = busyAction !== undefined;
    // Пока запрос в полёте, state может смениться автообновлением — показываем
    // инертную busy-кнопку того действия, что выполняется.
    const actions = busy ? [busyAction] : allowedActions(item.state);
    if (actions.length === 0) return null;
    const armed = armedById[item.id];
    return (
      <View style={styles.actionRow}>
        {actions.map((action) => {
          const confirming = !busy && armed?.action === action;
          const labels = ACTION_LABELS[action];
          const label = busy ? labels.busy : confirming ? labels.confirm : labels.idle;
          // Stop и Delete — разрушительные (statusDanger), Start — accent
          const danger = action !== "start";
          return (
            <Pressable
              key={action}
              accessibilityRole="button"
              accessibilityLabel={`${label} ${item.name}`}
              accessibilityState={{ disabled: busy, busy }}
              onPress={(event) => {
                // не `disabled`: тап по отключённой вложенной кнопке ушёл бы карточке и свернул её
                event.stopPropagation();
                pressAction(item, action);
              }}
              style={[
                styles.actionButton,
                busy
                  ? styles.actionBusy
                  : confirming
                    ? danger
                      ? styles.actionDangerArmed
                      : styles.actionStartArmed
                    : danger
                      ? styles.actionDanger
                      : styles.actionStart,
              ]}
            >
              <Text
                style={[
                  styles.actionText,
                  busy
                    ? styles.actionBusyText
                    : confirming
                      ? styles.actionArmedText
                      : danger
                        ? styles.actionDangerText
                        : styles.actionStartText,
                ]}
              >
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    );
  };

  const renderDetail = (item: ContainerInfo) => {
    const entry = detailById[item.id];
    if (!entry) return null;
    const detail = entry.detail;
    const rows: [string, string][] = detail
      ? ([
          ["Command", detail.command],
          ["Created", formatIso(detail.created)],
          ["Started", formatIso(detail.started)],
          // FinishedAt хранит время прошлой остановки даже у запущенного контейнера
          ["Finished", item.state === "running" ? "" : formatIso(detail.finished)],
          [
            "Exit code",
            item.state !== "running" && formatIso(detail.finished) ? String(detail.exitCode) : "",
          ],
          ["Restart", detail.restartPolicy],
          ["Health", detail.health],
          ["PID", detail.pid > 0 ? String(detail.pid) : ""],
        ].filter((row) => row[1] !== "") as [string, string][])
      : [];
    return (
      <View style={styles.detail}>
        {entry.loading ? <Text style={styles.meta}>Loading details…</Text> : null}
        {entry.error ? <Text style={styles.errorText}>{entry.error}</Text> : null}
        {detail ? (
          <>
            {rows.map(([label, value]) => (
              <View key={label} style={styles.detailRow}>
                <Text style={styles.detailLabel}>{label}</Text>
                <Text style={styles.detailValue}>{value}</Text>
              </View>
            ))}
            {detail.networks.length > 0 ? (
              <>
                <Text style={styles.sectionLabel}>Networks</Text>
                {detail.networks.map((net) => (
                  <Text key={net.name} style={styles.monoText}>
                    {net.name}
                    {net.ip ? `  ${net.ip}` : ""}
                  </Text>
                ))}
              </>
            ) : null}
            {detail.ports.length > 0 ? (
              <>
                <Text style={styles.sectionLabel}>Ports</Text>
                {detail.ports.map((line) => {
                  const parsed = parseDetailPortLine(line);
                  return (
                    <View key={line} style={styles.portsRow}>
                      <Text style={styles.monoText}>
                        {parsed.prefix}
                        {parsed.bindings.length > 0 ? " →" : ""}
                      </Text>
                      {parsed.bindings.map((binding) => {
                        const url = binding.url;
                        return url ? (
                          <Pressable
                            key={binding.label}
                            accessibilityRole="link"
                            accessibilityLabel={`Open ${url}`}
                            onPress={(event) => {
                              event.stopPropagation();
                              openUrl(url);
                            }}
                          >
                            <Text style={styles.portLink}>{binding.label}</Text>
                          </Pressable>
                        ) : (
                          <Text key={binding.label} style={styles.monoText}>
                            {binding.label}
                          </Text>
                        );
                      })}
                    </View>
                  );
                })}
              </>
            ) : null}
            {detail.mounts.length > 0 ? (
              <>
                <Text style={styles.sectionLabel}>Mounts</Text>
                {detail.mounts.map((mount) => (
                  <Text key={mount.destination} style={styles.monoText}>
                    {`${mount.rw ? "rw" : "ro"} ${mount.type}  ${mount.source} → ${mount.destination}`}
                  </Text>
                ))}
              </>
            ) : null}
            {detail.env.length > 0 ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={
                  envShownFor[item.id] ? "Hide environment variables" : "Show environment variables"
                }
                onPress={() =>
                  setEnvShownFor((prev) => ({ ...prev, [item.id]: !prev[item.id] }))
                }
                style={styles.envButton}
              >
                <Text style={styles.envButtonText}>
                  {envShownFor[item.id] ? "Hide env" : `Show env (${detail.env.length})`}
                </Text>
              </Pressable>
            ) : null}
            {envShownFor[item.id]
              ? detail.env.map((line) => (
                  <Text key={line} style={styles.monoText}>
                    {line}
                  </Text>
                ))
              : null}
            {renderActions(item)}
            {actionErrorById[item.id] ? (
              <Text style={styles.errorText}>{actionErrorById[item.id]}</Text>
            ) : null}
            <Text style={styles.sectionLabel}>Logs (tail 30)</Text>
            <View style={styles.logsBox}>
              <Text style={styles.monoText}>
                {entry.logs === null ? "Loading logs…" : entry.logs || "(no output)"}
              </Text>
            </View>
          </>
        ) : null}
      </View>
    );
  };

  const renderCard = (item: ContainerInfo) => {
    const color = stateColor(item.state, theme.colors);
    const stats = statsById[item.id];
    const ports = parseCardPorts(item.ports);
    const expanded = expandedId === item.id;
    return (
      <Pressable
        key={item.id}
        accessibilityRole="button"
        accessibilityLabel={`${expanded ? "Collapse" : "Expand"} details for ${item.name}`}
        onPress={() => toggleExpand(item.id)}
        style={styles.card}
      >
        <View style={styles.cardHeader}>
          <View style={[styles.dot, { backgroundColor: color }]} />
          <Text style={styles.name} numberOfLines={1}>
            {item.name}
          </Text>
          <Text style={[styles.badgeText, { color }]}>{item.state}</Text>
          <Text style={styles.chevron}>{expanded ? "▾" : "▸"}</Text>
        </View>
        <Text style={styles.image} numberOfLines={1}>
          {item.image}
        </Text>
        <View style={styles.metaRow}>
          <Text style={styles.meta}>{item.status}</Text>
          {stats ? (
            <Text style={styles.statText}>
              CPU {stats.cpu} · MEM {stats.mem} ({stats.memPerc})
            </Text>
          ) : null}
        </View>
        {ports.length > 0 ? (
          <View style={styles.portsRow}>
            {ports.map((entry) => {
              const url = entry.url;
              return url ? (
                <Pressable
                  key={entry.label}
                  accessibilityRole="link"
                  accessibilityLabel={`Open ${url}`}
                  onPress={(event) => {
                    event.stopPropagation();
                    openUrl(url);
                  }}
                >
                  <Text style={styles.portLink}>{entry.label}</Text>
                </Pressable>
              ) : (
                <Text key={entry.label} style={styles.monoText}>
                  {entry.label}
                </Text>
              );
            })}
          </View>
        ) : null}
        <Text style={styles.monoText}>
          {item.id}
          {item.networks ? `  ·  ${item.networks}` : ""}
        </Text>
        {expanded ? renderDetail(item) : null}
      </Pressable>
    );
  };

  const renderContainers = () => (
    <>
      {containers !== null && containers.length === 0 ? (
        <Text style={styles.placeholder}>
          {showAll ? "No containers" : "No running containers"}
        </Text>
      ) : null}
      {containers !== null && containers.length > 0 && groups.length === 0 ? (
        <Text style={styles.placeholder}>Nothing matches “{query.trim()}”</Text>
      ) : null}
      {groups.map((group) => {
        const hidden = collapsed[group.key] === true;
        return (
          <View key={group.key} style={styles.group}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${hidden ? "Expand" : "Collapse"} compose group ${group.title}, ${group.items.length} containers`}
              onPress={() => toggleCollapse(group.key)}
              style={styles.groupHeader}
            >
              <Text style={styles.groupChevron}>{hidden ? "▸" : "▾"}</Text>
              <Text style={styles.groupTitle} numberOfLines={1}>
                {group.title}
              </Text>
              <Text style={styles.groupCount}>{group.items.length}</Text>
            </Pressable>
            {hidden ? null : group.items.map((item) => renderCard(item))}
          </View>
        );
      })}
    </>
  );

  const renderVolumes = () => (
    <>
      {volumes.items !== null && volumes.items.length === 0 ? (
        <Text style={styles.placeholder}>No volumes</Text>
      ) : null}
      {(volumes.items ?? []).map((volume) => (
        <View key={volume.name} style={styles.card}>
          <Text style={styles.name} numberOfLines={1}>
            {volume.name}
          </Text>
          <Text style={styles.meta}>
            {volume.driver}
            {volume.usedBy.length > 0 ? ` · used by: ${volume.usedBy.join(", ")}` : " · unused"}
          </Text>
          <Text style={styles.monoText} numberOfLines={1}>
            {volume.mountpoint}
          </Text>
        </View>
      ))}
    </>
  );

  const renderImages = () => (
    <>
      {images.items !== null && images.items.length === 0 ? (
        <Text style={styles.placeholder}>No images</Text>
      ) : null}
      {(images.items ?? []).map((image) => (
        <View key={`${image.id}-${image.repository}-${image.tag}`} style={styles.card}>
          <Text style={styles.name} numberOfLines={1}>
            {image.repository}:{image.tag}
          </Text>
          <Text style={styles.meta}>
            {image.size} · created {image.createdSince}
            {image.containers && image.containers !== "N/A"
              ? ` · containers: ${image.containers}`
              : ""}
          </Text>
          <Text style={styles.monoText}>{image.id}</Text>
        </View>
      ))}
    </>
  );

  const renderNetworks = () => (
    <>
      {networks.items !== null && networks.items.length === 0 ? (
        <Text style={styles.placeholder}>No networks</Text>
      ) : null}
      {(networks.items ?? []).map((network) => (
        <View key={network.id} style={styles.card}>
          <Text style={styles.name} numberOfLines={1}>
            {network.name}
          </Text>
          <Text style={styles.meta}>
            {network.driver} · {network.scope}
            {network.internal ? " · internal" : ""}
            {network.containers.length > 0
              ? ` · containers: ${network.containers.join(", ")}`
              : ""}
          </Text>
          <Text style={styles.monoText}>{network.id}</Text>
        </View>
      ))}
    </>
  );

  const sectionError =
    tab === "containers"
      ? error
      : (tab === "volumes" ? volumes : tab === "images" ? images : networks).error;

  return (
    <View style={styles.screen}>
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.title}>Docker</Text>
          <Text style={styles.subtitle}>{subtitle}</Text>
        </View>
        <View style={styles.controls}>
          {tab === "containers" ? (
            <View style={styles.segment}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Show running containers"
                onPress={() => setShowAll(false)}
                style={[styles.segmentButton, showAll ? null : styles.segmentActive]}
              >
                <Text style={showAll ? styles.segmentTextIdle : styles.segmentTextActive}>
                  Running
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Show all containers"
                onPress={() => setShowAll(true)}
                style={[styles.segmentButton, showAll ? styles.segmentActive : null]}
              >
                <Text style={showAll ? styles.segmentTextActive : styles.segmentTextIdle}>
                  All
                </Text>
              </Pressable>
            </View>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Refresh"
            onPress={() => (tab === "containers" ? refresh(showAll) : refreshSection(tab))}
            style={styles.refreshButton}
          >
            <Text style={styles.refreshText}>Refresh</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.segment}>
        {TABS.map(({ key, label }) => (
          <Pressable
            key={key}
            accessibilityRole="button"
            accessibilityLabel={`Show ${label}`}
            onPress={() => setTab(key)}
            style={[styles.segmentButton, tab === key ? styles.segmentActive : null]}
          >
            <Text style={tab === key ? styles.segmentTextActive : styles.segmentTextIdle}>
              {label}
            </Text>
          </Pressable>
        ))}
      </View>

      {tab === "containers" ? (
        <TextInput
          accessibilityLabel="Search containers"
          value={query}
          onChangeText={setQuery}
          placeholder="Search by name or image"
          placeholderTextColor={theme.colors.foregroundMuted}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.searchInput}
        />
      ) : null}

      {sectionError ? <Text style={styles.errorText}>{sectionError}</Text> : null}

      <ScrollView contentContainerStyle={styles.list}>
        {tab === "containers" ? renderContainers() : null}
        {tab === "volumes" ? renderVolumes() : null}
        {tab === "images" ? renderImages() : null}
        {tab === "networks" ? renderNetworks() : null}
      </ScrollView>
    </View>
  );
}

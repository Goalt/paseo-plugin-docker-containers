import type { PluginSurfaceProps } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import {
  containerLogs,
  containerStats,
  inspectContainer,
  listContainers,
  listImages,
  listNetworks,
  listVolumes,
  type ContainerDetail,
  type ContainerInfo,
  type ContainerStats,
  type ImageInfo,
  type NetworkInfo,
  type VolumeInfo,
} from "./contract";

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

function formatPorts(ports: string): string {
  if (!ports) return "";
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of ports.split(",")) {
    const cleaned = part
      .trim()
      .replace("0.0.0.0:", "")
      .replace("[::]:", "")
      .replace(":::", "");
    if (cleaned && !seen.has(cleaned)) {
      seen.add(cleaned);
      out.push(cleaned);
    }
  }
  return out.join("  ");
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

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function DockerContainers({ theme, layout }: PluginSurfaceProps) {
  const fetchPs = useRpc(listContainers);
  const fetchStats = useRpc(containerStats);
  const fetchInspect = useRpc(inspectContainer);
  const fetchLogs = useRpc(containerLogs);
  const fetchVolumes = useRpc(listVolumes);
  const fetchImages = useRpc(listImages);
  const fetchNetworks = useRpc(listNetworks);

  const [tab, setTab] = useState<Tab>("containers");
  const [containers, setContainers] = useState<ContainerInfo[] | null>(null);
  const [statsById, setStatsById] = useState<Record<string, ContainerStats>>({});
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);

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

  const aliveRef = useRef(true);
  // null — запросов нет; иначе значение `all` запроса в полёте. Переключение
  // Running↔All при активном запросе не глушится, а устаревший ответ отбрасывается.
  const busyRef = useRef<boolean | null>(null);
  const wantedAllRef = useRef(false);
  const sectionBusyRef = useRef<Record<string, boolean>>({});

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
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

  const loadDetail = useCallback(
    (id: string) => {
      setDetailById((prev) => ({
        ...prev,
        [id]: { loading: true, error: null, detail: null, logs: null },
      }));
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
            return { ...prev, [id]: { ...entry, loading: false, detail: result.detail } };
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
      placeholder: { color: theme.colors.foregroundMuted, fontSize: 14 },
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
      logsBox: {
        borderWidth: 1,
        borderColor: theme.colors.foregroundMuted,
        borderRadius: 6,
        padding: 8,
      },
    }),
    [theme, layout.compact, mono],
  );

  const runningCount =
    containers === null
      ? 0
      : containers.filter((item) => item.state === "running").length;

  const subtitle = (() => {
    if (tab === "containers") {
      if (containers === null) return "Loading…";
      return (
        `${runningCount} running${showAll ? ` / ${containers.length} total` : ""}` +
        (updatedAt ? ` · updated ${updatedAt}` : "")
      );
    }
    const section = tab === "volumes" ? volumes : tab === "images" ? images : networks;
    if (section.items === null) return section.error ? "failed" : "Loading…";
    return `${section.items.length} ${tab}` + (section.updatedAt ? ` · updated ${section.updatedAt}` : "");
  })();

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
                {detail.ports.map((line) => (
                  <Text key={line} style={styles.monoText}>
                    {line}
                  </Text>
                ))}
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

  const renderContainers = () => (
    <>
      {containers !== null && containers.length === 0 ? (
        <Text style={styles.placeholder}>
          {showAll ? "No containers" : "No running containers"}
        </Text>
      ) : null}
      {(containers ?? []).map((item) => {
        const color = stateColor(item.state, theme.colors);
        const stats = statsById[item.id];
        const ports = formatPorts(item.ports);
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
            {ports ? (
              <Text style={styles.monoText} numberOfLines={2}>
                {ports}
              </Text>
            ) : null}
            <Text style={styles.monoText}>
              {item.id}
              {item.networks ? `  ·  ${item.networks}` : ""}
            </Text>
            {expanded ? renderDetail(item) : null}
          </Pressable>
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

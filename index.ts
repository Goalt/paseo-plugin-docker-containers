import type { PluginContext } from "@getpaseo/plugin";
import { exec } from "node:child_process";
import { DockerContainers } from "./containers.client";
import {
  containerLogs,
  containerStats,
  inspectContainer,
  listContainers,
  listImages,
  listNetworks,
  listVolumes,
} from "./contract";

// Серверные хелперы. В клиентский бандл не попадают: единственные ссылки на них —
// внутри вызовов plugin.handle, которые компилятор 0.6.1 вырезает из client-таргета.
function run(command: string): Promise<{ error: string | null; stdout: string }> {
  return new Promise((resolve) => {
    exec(command, { timeout: 20000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        resolve({ error: (stderr || error.message || "command failed").trim(), stdout: "" });
        return;
      }
      resolve({ error: null, stdout });
    });
  });
}

function jsonLines(stdout: string): Record<string, string>[] {
  const rows: Record<string, string>[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed) as Record<string, string>);
    } catch {
      // docker может вклинить warning-строку в stdout — пропускаем не-JSON
    }
  }
  return rows;
}

interface PsUsage {
  name: string;
  mounts: string[];
  networks: string[];
}

// Сводка «какой контейнер что использует» для вкладок Volumes/Networks.
function psUsage(): Promise<PsUsage[]> {
  return run("docker ps -a --format '{{.Names}}|{{.Mounts}}|{{.Networks}}'").then(
    ({ error, stdout }) => {
      if (error !== null) return [];
      const rows: PsUsage[] = [];
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        const [name, mounts, networks] = line.split("|");
        rows.push({
          name: name ?? "",
          mounts: (mounts ?? "").split(",").filter(Boolean),
          networks: (networks ?? "").split(",").filter(Boolean),
        });
      }
      return rows;
    },
  );
}

// В `docker ps` длинные имена томов обрезаются с «…» — сверяем и по префиксу.
function mountMatches(token: string, volumeName: string): boolean {
  if (token === volumeName) return true;
  if (token.endsWith("…")) return volumeName.startsWith(token.slice(0, -1));
  return false;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === "string" && value) return [value];
  return [];
}

function formatPortBindings(ports: unknown): string[] {
  if (ports === null || typeof ports !== "object") return [];
  const lines: string[] = [];
  for (const [containerPort, bindings] of Object.entries(ports as Record<string, unknown>)) {
    if (!Array.isArray(bindings) || bindings.length === 0) {
      lines.push(`${containerPort} (not published)`);
      continue;
    }
    const seen = new Set<string>();
    for (const binding of bindings as { HostIp?: string; HostPort?: string }[]) {
      const ip = binding.HostIp ?? "";
      const port = binding.HostPort ?? "";
      const label = ip === "0.0.0.0" || ip === "::" || ip === "" ? `:${port}` : `${ip}:${port}`;
      seen.add(label);
    }
    lines.push(`${containerPort} → ${[...seen].join(", ")}`);
  }
  return lines;
}

export default function contribute(plugin: PluginContext) {
  plugin.handle(listContainers, ({ all }) => {
    const command = `docker ps${all ? " -a" : ""} --format '{{json .}}'`;
    return run(command).then(({ error, stdout }) => {
      if (error !== null) return { ok: false, error, containers: [] };
      const containers = jsonLines(stdout).map((row) => ({
        id: row.ID ?? "",
        name: row.Names ?? "",
        image: row.Image ?? "",
        state: row.State ?? "",
        status: row.Status ?? "",
        ports: row.Ports ?? "",
        networks: row.Networks ?? "",
        createdAt: row.CreatedAt ?? "",
      }));
      return { ok: true, error: null, containers };
    });
  });

  plugin.handle(containerStats, () => {
    return run("docker stats --no-stream --format '{{json .}}'").then(({ error, stdout }) => {
      if (error !== null) return { ok: false, error, stats: [] };
      const stats = jsonLines(stdout).map((row) => ({
        id: row.ID ?? "",
        name: row.Name ?? "",
        cpu: row.CPUPerc ?? "",
        mem: row.MemUsage ?? "",
        memPerc: row.MemPerc ?? "",
      }));
      return { ok: true, error: null, stats };
    });
  });

  plugin.handle(inspectContainer, ({ id }) => {
    return run(`docker inspect --format '{{json .}}' ${id}`).then(({ error, stdout }) => {
      if (error !== null) return { ok: false, error, detail: null };
      let doc: Record<string, any>;
      try {
        doc = JSON.parse(stdout) as Record<string, any>;
      } catch {
        return { ok: false, error: "could not parse docker inspect output", detail: null };
      }
      const state = (doc.State ?? {}) as Record<string, any>;
      const config = (doc.Config ?? {}) as Record<string, any>;
      const hostConfig = (doc.HostConfig ?? {}) as Record<string, any>;
      const netSettings = (doc.NetworkSettings ?? {}) as Record<string, any>;
      const policy = (hostConfig.RestartPolicy ?? {}) as Record<string, any>;
      const retries = Number(policy.MaximumRetryCount ?? 0);
      const command = [...asStringArray(config.Entrypoint), ...asStringArray(config.Cmd)].join(" ");
      const mounts = (Array.isArray(doc.Mounts) ? doc.Mounts : []).map(
        (mount: Record<string, any>) => ({
          type: String(mount.Type ?? ""),
          source: String(mount.Source ?? mount.Name ?? ""),
          destination: String(mount.Destination ?? ""),
          rw: mount.RW !== false,
        }),
      );
      const networks = Object.entries(
        (netSettings.Networks ?? {}) as Record<string, Record<string, any>>,
      ).map(([name, net]) => ({ name, ip: String(net.IPAddress ?? "") }));
      return {
        ok: true,
        error: null,
        detail: {
          id: String(doc.Id ?? ""),
          name: String(doc.Name ?? "").replace(/^\//, ""),
          image: String(config.Image ?? ""),
          command,
          created: String(doc.Created ?? ""),
          started: String(state.StartedAt ?? ""),
          finished: String(state.FinishedAt ?? ""),
          exitCode: Number(state.ExitCode ?? 0),
          restartPolicy:
            String(policy.Name ?? "no") + (retries > 0 ? ` (max ${retries})` : ""),
          health: String((state.Health ?? {}).Status ?? ""),
          pid: Number(state.Pid ?? 0),
          mounts,
          networks,
          ports: formatPortBindings(netSettings.Ports),
          env: asStringArray(config.Env),
        },
      };
    });
  });

  plugin.handle(containerLogs, ({ id }) => {
    return run(`docker logs --tail 30 ${id} 2>&1`).then(({ error, stdout }) => {
      if (error !== null) return { ok: false, error, logs: "" };
      return { ok: true, error: null, logs: stdout.slice(-8000).trimEnd() };
    });
  });

  plugin.handle(listVolumes, () => {
    return Promise.all([run("docker volume ls --format '{{json .}}'"), psUsage()]).then(
      ([{ error, stdout }, usage]) => {
        if (error !== null) return { ok: false, error, volumes: [] };
        const volumes = jsonLines(stdout).map((row) => {
          const name = row.Name ?? "";
          const usedBy = usage
            .filter((entry) => entry.mounts.some((token) => mountMatches(token, name)))
            .map((entry) => entry.name);
          return {
            name,
            driver: row.Driver ?? "",
            mountpoint: row.Mountpoint ?? "",
            usedBy,
          };
        });
        return { ok: true, error: null, volumes };
      },
    );
  });

  plugin.handle(listImages, () => {
    return run("docker images --format '{{json .}}'").then(({ error, stdout }) => {
      if (error !== null) return { ok: false, error, images: [] };
      const images = jsonLines(stdout).map((row) => ({
        id: row.ID ?? "",
        repository: row.Repository ?? "",
        tag: row.Tag ?? "",
        size: row.Size ?? "",
        createdSince: row.CreatedSince ?? "",
        containers: row.Containers ?? "",
      }));
      return { ok: true, error: null, images };
    });
  });

  plugin.handle(listNetworks, () => {
    return Promise.all([run("docker network ls --format '{{json .}}'"), psUsage()]).then(
      ([{ error, stdout }, usage]) => {
        if (error !== null) return { ok: false, error, networks: [] };
        const networks = jsonLines(stdout).map((row) => {
          const name = row.Name ?? "";
          const containers = usage
            .filter((entry) => entry.networks.includes(name))
            .map((entry) => entry.name);
          return {
            id: row.ID ?? "",
            name,
            driver: row.Driver ?? "",
            scope: row.Scope ?? "",
            internal: row.Internal === "true",
            containers,
          };
        });
        return { ok: true, error: null, networks };
      },
    );
  });

  plugin.addSurface("main", DockerContainers);
  plugin.addSidebarItem({
    id: "main",
    title: "Docker",
    icon: "Container",
    surface: "main",
  });
  plugin.addWorkspacePanel({
    id: "containers",
    title: "Docker",
    icon: "Container",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: DockerContainers,
  });
  plugin.addCommandCenterItem({
    id: "open-docker-containers",
    title: "Open Docker panel",
    icon: "Container",
    keywords: ["docker", "containers", "ps", "stats", "volumes", "images", "networks"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("containers");
    },
  });
  return () => {};
}

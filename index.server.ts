import type { PluginServerContext } from "@getpaseo/plugin/server";
import { exec } from "node:child_process";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import {
  containerLogs,
  containerStats,
  inspectContainer,
  listContainers,
  listImages,
  listNetworks,
  listVolumes,
  removeContainer,
  removeVolume,
  startContainer,
  stopContainer,
} from "./shared/contract";

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
// --no-trunc обязателен: без него docker режет имена томов в Mounts до 14 символов
// + «…», и префикс-сверка засчитывала использование ВСЕМ томам с тем же началом
// имени — у свободного соседа пропадала кнопка Delete.
function psUsage(): Promise<PsUsage[]> {
  return run("docker ps -a --no-trunc --format '{{.Names}}|{{.Mounts}}|{{.Networks}}'").then(
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

// С --no-trunc имена приходят целиком; ветка «…» — страховка на случай обрезанного
// вывода (тогда сверка по префиксу может ложно пометить соседний том занятым).
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

// Labels из `docker ps` — это "k=v,k=v". Ключ сверяется ТОЧНО по срезу до первого
// "=": рядом живут сиблинги com.docker.compose.project.config_files и
// .project.working_dir, и матч по префиксу вернул бы их значение.
// Значение может содержать "=", поэтому режем только по первому вхождению.
function labelValue(labels: string, key: string): string {
  if (!labels) return "";
  for (const part of labels.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== key) continue;
    return part.slice(eq + 1);
  }
  return "";
}

// Демон Paseo сам живёт в контейнере этого хоста: stop/rm его контейнера убил бы
// демона вместе с этим процессом — RPC не ответил бы никогда, панель зависла бы в busy.
interface SelfContainer {
  id: string;
  name: string;
}

// Кандидаты в id собственного контейнера. Внутри docker hostname = первые 12 символов
// id (если не переопределён через --hostname). Fallback — полный id из /proc/self/cgroup
// (cgroup v1) или /proc/self/mountinfo: на cgroup v2 в cgroup лишь "0::/", а id виден
// в путях /var/lib/docker/containers/<id>/…
function selfContainerCandidates(): string[] {
  const candidates: string[] = [];
  const host = hostname();
  if (/^[0-9a-f]{12}$/.test(host)) candidates.push(host);
  for (const file of ["/proc/self/cgroup", "/proc/self/mountinfo"]) {
    try {
      const match = readFileSync(file, "utf8").match(/(?:docker[-/]|\/containers\/)([0-9a-f]{64})/);
      if (match) candidates.push(match[1]);
    } catch {
      // не Linux или нет procfs — значит, и не контейнер docker
    }
  }
  return candidates;
}

// null — процесс не в контейнере (guard неактивен); undefined — docker не ответил,
// спросим снова при следующем мутирующем вызове.
function resolveSelfContainer(): Promise<SelfContainer | null | undefined> {
  const candidates = selfContainerCandidates();
  const attempt = (index: number, dockerFailed: boolean): Promise<SelfContainer | null | undefined> => {
    if (index >= candidates.length) return Promise.resolve(dockerFailed ? undefined : null);
    const candidate = candidates[index];
    return run(
      `docker container inspect --format '{{.Id}}|{{.Name}}|{{.Config.Hostname}}' -- ${candidate}`,
    ).then(({ error, stdout }) => {
      if (error !== null) {
        return attempt(index + 1, dockerFailed || !/no such container/i.test(error));
      }
      const [id = "", name = "", configHostname = ""] = stdout.trim().split("|");
      // 12-символьный hostname мог совпасть с чужим id случайно — засчитываем его,
      // только если у найденного контейнера тот же hostname
      const confirmed =
        id.startsWith(candidate) && (candidate.length === 64 || configHostname === hostname());
      if (!confirmed) return attempt(index + 1, dockerFailed);
      return { id, name: name.replace(/^\//, "") };
    });
  };
  return attempt(0, false);
}

// docker принимает имя, полный id и любой однозначный префикс id. Префикс сверяем
// консервативно (без учёта регистра): хекс-имя другого контейнера, совпавшее с
// префиксом нашего id, тоже будет заблокировано — UI всегда шлёт 12-символьный id.
function isSelfTarget(target: string, self: SelfContainer): boolean {
  if (self.name && target === self.name) return true;
  const lower = target.toLowerCase();
  return self.id.startsWith(lower) || lower.startsWith(self.id);
}

export default function contribute(server: PluginServerContext) {
  // Собственный контейнер определяем один раз при старте; если docker тогда не
  // ответил — переспрашиваем при каждом мутирующем вызове, пока не ответит.
  let selfPromise = resolveSelfContainer();
  const selfContainer = (): Promise<SelfContainer | null> =>
    selfPromise.then((self) => {
      if (self !== undefined) return self;
      selfPromise = resolveSelfContainer();
      return selfPromise.then((retry) => {
        if (retry !== undefined) return retry;
        // docker недоступен — сверяем хотя бы по id-кандидату, имя неизвестно
        const candidates = selfContainerCandidates();
        return candidates.length > 0 ? { id: candidates[candidates.length - 1], name: "" } : null;
      });
    });

  // Текст ошибки, если цель — контейнер самого демона; иначе null. Команду тогда не выполняем.
  const refuseSelf = (id: string, verb: string): Promise<string | null> =>
    selfContainer().then((self) =>
      self !== null && isSelfTarget(id, self)
        ? `Refusing to ${verb} ${self.name || self.id.slice(0, 12)}: this container runs the Paseo daemon (and this panel)`
        : null,
    );

  server.handle(listContainers, ({ all }) => {
    const command = `docker ps${all ? " -a" : ""} --format '{{json .}}'`;
    return run(command).then(({ error, stdout }) => {
      if (error !== null) return { ok: false, error, containers: [] };
      const containers = jsonLines(stdout).map((row) => {
        const labels = row.Labels ?? "";
        return {
          id: row.ID ?? "",
          name: row.Names ?? "",
          image: row.Image ?? "",
          state: row.State ?? "",
          status: row.Status ?? "",
          ports: row.Ports ?? "",
          networks: row.Networks ?? "",
          createdAt: row.CreatedAt ?? "",
          composeProject: labelValue(labels, "com.docker.compose.project"),
          composeService: labelValue(labels, "com.docker.compose.service"),
        };
      });
      return { ok: true, error: null, containers };
    });
  });

  server.handle(containerStats, () => {
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

  server.handle(inspectContainer, ({ id }) => {
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

  server.handle(containerLogs, ({ id }) => {
    return run(`docker logs --tail 30 ${id} 2>&1`).then(({ error, stdout }) => {
      if (error !== null) return { ok: false, error, logs: "" };
      return { ok: true, error: null, logs: stdout.slice(-8000).trimEnd() };
    });
  });

  // `--` перед id: даже если схема когда-нибудь ослабнет, id не станет флагом.
  // Повторный stop остановленного / start запущенного — exit 0, т.е. ok:true.
  server.handle(stopContainer, ({ id }) => {
    return refuseSelf(id, "stop").then((refusal) => {
      if (refusal !== null) return { ok: false, error: refusal };
      return run(`docker stop -t 5 -- ${id}`).then(({ error }) =>
        error !== null ? { ok: false, error } : { ok: true, error: null },
      );
    });
  });

  server.handle(startContainer, ({ id }) => {
    return run(`docker start -- ${id}`).then(({ error }) =>
      error !== null ? { ok: false, error } : { ok: true, error: null },
    );
  });

  // Без -f: запущенный контейнер docker откажется удалять («You cannot remove a running
  // container»). Без -v: анонимные тома не пропадают молча — их видно на вкладке Volumes.
  server.handle(removeContainer, ({ id }) => {
    return refuseSelf(id, "remove").then((refusal) => {
      if (refusal !== null) return { ok: false, error: refusal };
      return run(`docker rm -- ${id}`).then(({ error }) =>
        error !== null ? { ok: false, error } : { ok: true, error: null },
      );
    });
  });

  // Без -f. Гейт «unused» в UI строится эвристикой mountMatches и может ошибаться —
  // последняя линия защиты сам docker: занятый том («volume is in use») он не удалит.
  // Текст ошибки отдаём как есть.
  server.handle(removeVolume, ({ name }) => {
    return run(`docker volume rm -- ${name}`).then(({ error }) =>
      error !== null ? { ok: false, error } : { ok: true, error: null },
    );
  });

  server.handle(listVolumes, () => {
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

  server.handle(listImages, () => {
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

  server.handle(listNetworks, () => {
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

  return () => {};
}

import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const ContainerSchema = z.object({
  id: z.string(),
  name: z.string(),
  image: z.string(),
  state: z.string(),
  status: z.string(),
  ports: z.string(),
  networks: z.string(),
  createdAt: z.string(),
  // Пустая строка = контейнер запущен не через docker compose.
  composeProject: z.string(),
  composeService: z.string(),
});

export type ContainerInfo = z.infer<typeof ContainerSchema>;

export const StatsSchema = z.object({
  id: z.string(),
  name: z.string(),
  cpu: z.string(),
  mem: z.string(),
  memPerc: z.string(),
});

export type ContainerStats = z.infer<typeof StatsSchema>;

// id приходит из клиента и подставляется в shell-команду — формат жёстко зажат.
// Первый символ — только буква/цифра: иначе "--help" прошёл бы как id, а
// `docker stop --help` завершается с exit 0 и дал бы ложный ok:true.
const ContainerIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);

export const DetailSchema = z.object({
  id: z.string(),
  name: z.string(),
  image: z.string(),
  command: z.string(),
  created: z.string(),
  started: z.string(),
  finished: z.string(),
  exitCode: z.number(),
  restartPolicy: z.string(),
  health: z.string(),
  pid: z.number(),
  mounts: z.array(
    z.object({
      type: z.string(),
      source: z.string(),
      destination: z.string(),
      rw: z.boolean(),
    }),
  ),
  networks: z.array(z.object({ name: z.string(), ip: z.string() })),
  ports: z.array(z.string()),
  env: z.array(z.string()),
});

export type ContainerDetail = z.infer<typeof DetailSchema>;

export const VolumeSchema = z.object({
  name: z.string(),
  driver: z.string(),
  mountpoint: z.string(),
  usedBy: z.array(z.string()),
});

export type VolumeInfo = z.infer<typeof VolumeSchema>;

export const ImageSchema = z.object({
  id: z.string(),
  repository: z.string(),
  tag: z.string(),
  size: z.string(),
  createdSince: z.string(),
  containers: z.string(),
});

export type ImageInfo = z.infer<typeof ImageSchema>;

export const NetworkSchema = z.object({
  id: z.string(),
  name: z.string(),
  driver: z.string(),
  scope: z.string(),
  internal: z.boolean(),
  containers: z.array(z.string()),
});

export type NetworkInfo = z.infer<typeof NetworkSchema>;

export const listContainers = defineRpc({
  name: "docker.ps",
  input: z.object({ all: z.boolean() }),
  output: z.object({
    ok: z.boolean(),
    error: z.string().nullable(),
    containers: z.array(ContainerSchema),
  }),
});

export const containerStats = defineRpc({
  name: "docker.stats",
  input: z.object({}),
  output: z.object({
    ok: z.boolean(),
    error: z.string().nullable(),
    stats: z.array(StatsSchema),
  }),
});

export const inspectContainer = defineRpc({
  name: "docker.inspect",
  input: z.object({ id: ContainerIdSchema }),
  output: z.object({
    ok: z.boolean(),
    error: z.string().nullable(),
    detail: DetailSchema.nullable(),
  }),
});

export const containerLogs = defineRpc({
  name: "docker.logs",
  input: z.object({ id: ContainerIdSchema }),
  output: z.object({
    ok: z.boolean(),
    error: z.string().nullable(),
    logs: z.string(),
  }),
});

// Мутирующие RPC. error: null при успехе — форма как у read-only RPC выше.
export const stopContainer = defineRpc({
  name: "docker.stop",
  input: z.object({ id: ContainerIdSchema }),
  output: z.object({
    ok: z.boolean(),
    error: z.string().nullable(),
  }),
});

export const startContainer = defineRpc({
  name: "docker.start",
  input: z.object({ id: ContainerIdSchema }),
  output: z.object({
    ok: z.boolean(),
    error: z.string().nullable(),
  }),
});

export const listVolumes = defineRpc({
  name: "docker.volumes",
  input: z.object({}),
  output: z.object({
    ok: z.boolean(),
    error: z.string().nullable(),
    volumes: z.array(VolumeSchema),
  }),
});

export const listImages = defineRpc({
  name: "docker.images",
  input: z.object({}),
  output: z.object({
    ok: z.boolean(),
    error: z.string().nullable(),
    images: z.array(ImageSchema),
  }),
});

export const listNetworks = defineRpc({
  name: "docker.networks",
  input: z.object({}),
  output: z.object({
    ok: z.boolean(),
    error: z.string().nullable(),
    networks: z.array(NetworkSchema),
  }),
});

# docker-containers — плагин Paseo

Панель Docker на машине демона. Четыре вкладки:

- **Containers** — имя, образ, состояние, статус, CPU/MEM (из `docker stats`),
  порты (с дедупликацией IPv4/IPv6), ID и сети. Автообновление каждые 5 секунд,
  переключатель Running/All, кнопка Refresh. **Тап по карточке** разворачивает
  детали (`docker inspect` + `docker logs --tail 30`): command, created/started,
  finished/exit code (только для незапущенных), restart policy, health, PID,
  сети с IP, полные порты, маунты, env (за кнопкой «Show env» — там секреты),
  хвост логов.
- **Volumes** — имя, драйвер, mountpoint, «used by: …» (считается по
  `docker ps -a`; обрезанные «…»-имена матчатся по префиксу). Размеров нет:
  `docker system df -v` на этом хосте уходит в таймаут.
- **Images** — repo:tag, размер, возраст, число контейнеров, ID.
- **Networks** — имя, драйвер, scope, internal, подключённые контейнеры, ID.

## Где появляется
- пункт **Docker** в сайдбаре (surface `main`);
- вкладка в воркспейсе и эксплорере (workspace panel `containers`);
- **Open Docker panel** в Command Center (Ctrl+K, контекст воркспейса).

## Архитектура (важно: демон Paseo 0.6.1)
- `contract.ts` — RPC-контракты (`docker.ps|stats|inspect|logs|volumes|images|networks`), zod-схемы.
  Имена RPC — только lowercase/точки/дефисы, id контейнера зажат regex'ом (уходит в shell).
- `index.ts` — вход. Компилируется дважды: в server-бандле остаются
  `plugin.handle(...)` (там `node:child_process` → docker CLI c `--format '{{json .}}'`),
  в client-бандле эти вызовы вырезаются компилятором, а `node:*`-импорты стабятся в `{}`.
- `containers.client.tsx` — UI (react-native primitives). **Без async/await** —
  компилятор 0.6.1 не понижает синтаксис, Hermes на iOS/Android не загрузит бандл.
  Только промис-цепочки.
- Палитра 0.6.1: только `surface0`, `foreground`, `foregroundMuted`, `accent`,
  `accentForeground`, `statusDanger`. Бейджи: running → accent, exited/dead → statusDanger.

## Управление
```bash
npm run typecheck
paseo plugin reload docker-containers
paseo plugin logs docker-containers
```

import type { PluginClientContext } from "@getpaseo/plugin/client";
import { DockerContainers } from "./client/containers";

export default function contribute(client: PluginClientContext) {
  client.addSurface("main", DockerContainers);
  client.addSidebarItem({
    id: "main",
    title: "Docker",
    icon: "Container",
    surface: "main",
  });
  client.addWorkspacePanel({
    id: "containers",
    title: "Docker",
    icon: "Container",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: DockerContainers,
  });
  client.addCommandCenterItem({
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

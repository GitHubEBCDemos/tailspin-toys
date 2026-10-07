import { execFile } from "node:child_process";
import { promisify } from "node:util";

export function repositoryFromRemote(remote) {
  const normalized = remote.trim().replace(/^git@github\.com:/i, "https://github.com/");
  let url;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error("The canvas requires a GitHub origin remote.");
  }
  const match = url.pathname.match(/^\/([a-zA-Z0-9-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?\/?$/);
  if (!["https:", "ssh:"].includes(url.protocol) || url.hostname.toLowerCase() !== "github.com" || url.port || !match) {
    throw new Error("The canvas requires a github.com origin remote.");
  }
  return `${match[1]}/${match[2]}`;
}

export async function workspaceRepository(directory) {
  const { stdout } = await promisify(execFile)("git", ["-C", directory, "remote", "get-url", "origin"]);
  return repositoryFromRemote(stdout);
}

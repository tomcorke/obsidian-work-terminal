import type { StateResolver } from "../../core/interfaces";
import { FolderStateResolver } from "../../core/resolvers/FolderStateResolver";
import { FrontmatterStateResolver } from "../../core/resolvers/FrontmatterStateResolver";
import { CompositeStateResolver } from "../../core/resolvers/CompositeStateResolver";
import { STATE_FOLDER_MAP } from "./types";

/** State resolution strategy identifier. */
export type StateStrategy = "folder" | "frontmatter" | "composite";

const VALID_TASK_STATES = ["priority", "todo", "active", "done", "abandoned"];

/**
 * Create the default state resolver for the task-agent adapter.
 * Uses a composite that checks frontmatter first, then falls back to folder.
 * This preserves backward compatibility: existing folder-based tasks still
 * work, while tasks with a `state` frontmatter field use that value.
 *
 * The folder resolver handles file moves on state transition. The frontmatter
 * resolver handles the `state:` field update (which TaskMover also does
 * directly for now - the resolver is used for state *resolution*, the mover
 * handles the full transition including tags, timestamps, and activity log).
 */
export function createDefaultStateResolver(basePath: string): StateResolver {
  return createStateResolver("folder", basePath);
}

/**
 * Create a state resolver for the given strategy.
 */
export function createStateResolver(strategy: StateStrategy, basePath: string): StateResolver {
  switch (strategy) {
    case "folder":
      return new FolderStateResolver(STATE_FOLDER_MAP, basePath);

    case "frontmatter":
      return new FrontmatterStateResolver("state", VALID_TASK_STATES);

    case "composite":
      return new CompositeStateResolver([
        new FrontmatterStateResolver("state", VALID_TASK_STATES),
        new FolderStateResolver(STATE_FOLDER_MAP, basePath),
      ]);

    default:
      return new FolderStateResolver(STATE_FOLDER_MAP, basePath);
  }
}

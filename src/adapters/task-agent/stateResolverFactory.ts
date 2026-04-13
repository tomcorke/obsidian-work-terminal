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
 * Defaults to folder-based resolution for backward compatibility: state is
 * derived from folder location and transitions move files between folders.
 *
 * Use the `stateStrategy` setting to switch to frontmatter or composite mode.
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

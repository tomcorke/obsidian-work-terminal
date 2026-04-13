import type { StateResolver } from "../../core/interfaces";
import { FolderStateResolver } from "../../core/resolvers/FolderStateResolver";
import { FrontmatterStateResolver } from "../../core/resolvers/FrontmatterStateResolver";
import { CompositeStateResolver } from "../../core/resolvers/CompositeStateResolver";
import { STATE_FOLDER_MAP } from "./types";

/** State resolution strategy identifier. */
export type StateStrategy = "folder" | "frontmatter" | "composite";

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
 *
 * For frontmatter and composite modes, the FrontmatterStateResolver accepts
 * any string value (open state set). This means users can write arbitrary
 * states like `state: amazing` and they will be passed through as-is,
 * creating dynamic columns in the kanban board.
 */
export function createStateResolver(strategy: StateStrategy, basePath: string): StateResolver {
  switch (strategy) {
    case "folder":
      return new FolderStateResolver(STATE_FOLDER_MAP, basePath);

    case "frontmatter":
      // No valid-state restriction: any frontmatter value is a valid state
      return new FrontmatterStateResolver("state");

    case "composite":
      // No valid-state restriction on frontmatter: any value is accepted.
      // Folder resolver still provides fallback for files without frontmatter state.
      return new CompositeStateResolver([
        new FrontmatterStateResolver("state"),
        new FolderStateResolver(STATE_FOLDER_MAP, basePath),
      ]);

    default:
      return new FolderStateResolver(STATE_FOLDER_MAP, basePath);
  }
}

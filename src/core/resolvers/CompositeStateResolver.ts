import type { App, TFile } from "obsidian";
import type { StateResolver } from "../interfaces";

/**
 * Chains multiple state resolvers. For resolution, tries each resolver
 * in order and returns the first non-null result. For applying state,
 * runs all resolvers (so both frontmatter and folder can be updated).
 */
export class CompositeStateResolver implements StateResolver {
  private resolvers: StateResolver[];

  constructor(resolvers: StateResolver[]) {
    this.resolvers = resolvers;
  }

  resolveState(filePath: string, frontmatter: Record<string, unknown> | undefined): string | null {
    for (const resolver of this.resolvers) {
      const state = resolver.resolveState(filePath, frontmatter);
      if (state !== null) return state;
    }
    return null;
  }

  async applyState(
    app: App,
    file: TFile,
    newState: string,
    oldState: string,
    basePath: string,
  ): Promise<boolean> {
    let anySucceeded = false;
    for (const resolver of this.resolvers) {
      try {
        const result = await resolver.applyState(app, file, newState, oldState, basePath);
        if (result) anySucceeded = true;
      } catch (err) {
        console.error("[work-terminal] CompositeStateResolver: resolver failed", err);
      }
    }
    return anySucceeded;
  }

  getFolderForState(state: string): string | null {
    for (const resolver of this.resolvers) {
      if (resolver.getFolderForState) {
        const folder = resolver.getFolderForState(state);
        if (folder !== null) return folder;
      }
    }
    return null;
  }

  getValidStates(): string[] {
    const states = new Set<string>();
    for (const resolver of this.resolvers) {
      if (resolver.getValidStates) {
        for (const s of resolver.getValidStates()) {
          states.add(s);
        }
      }
    }
    return [...states];
  }
}

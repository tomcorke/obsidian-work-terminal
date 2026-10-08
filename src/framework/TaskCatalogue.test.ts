import { describe, expect, it } from "vitest";
import type {
  AdapterBundle,
  WorkItem,
  WorkItemParser,
  WorkItemRelationships,
} from "../core/interfaces";
import { TaskAgentAdapter } from "../adapters/task-agent";
import { TaskCatalogue } from "./TaskCatalogue";

function item(
  id: string,
  state: string,
  parentIds: string[] = [],
  childIds: string[] = [],
): WorkItem {
  return {
    id,
    path: `Tasks/${id}.md`,
    title: `Task ${id}`,
    state,
    metadata: { parentIds, childIds },
  };
}

function catalogue(items: WorkItem[], columns = [{ id: "active", label: "Active" }]) {
  const parser = { loadAll: async () => items } as WorkItemParser;
  const adapter = {
    config: { columns },
    getWorkItemRelationships(workItem: WorkItem): WorkItemRelationships {
      return {
        parentIds: workItem.metadata.parentIds as string[],
        childIds: workItem.metadata.childIds as string[],
      };
    },
  } as unknown as AdapterBundle;
  return new TaskCatalogue(parser, adapter);
}

describe("TaskCatalogue", () => {
  it("exposes deterministic categories and bounded task summaries", async () => {
    const tasks = [item("b", "custom"), item("a", "active"), item("c", "active")];
    const subject = catalogue(tasks);

    await expect(subject.listCategories()).resolves.toEqual([
      { id: "active", label: "Active" },
      { id: "custom", label: "Custom" },
    ]);
    const firstPage = await subject.listTasks({ categoryId: "active", limit: 1 });
    expect(firstPage).toEqual({
      tasks: [
        {
          id: "a",
          title: "Task a",
          state: "active",
          categoryId: "active",
          reference: "Tasks/a.md",
          directParentIds: [],
          directChildIds: [],
        },
      ],
      truncated: true,
      nextCursor: expect.any(String),
    });
    await expect(
      subject.listTasks({ categoryId: "active", limit: 1, cursor: firstPage.nextCursor }),
    ).resolves.toEqual({
      tasks: [
        {
          id: "c",
          title: "Task c",
          state: "active",
          categoryId: "active",
          reference: "Tasks/c.md",
          directParentIds: [],
          directChildIds: [],
        },
      ],
      truncated: false,
    });
  });

  it("returns direct relationships without exposing adapter metadata", async () => {
    const subject = catalogue([
      item("parent", "active", [], ["explicit", "missing", "explicit"]),
      item("child", "active", ["parent"]),
      item("explicit", "active"),
    ]);

    await expect(subject.getTask("parent")).resolves.toMatchObject({
      id: "parent",
      directParentIds: [],
      directChildIds: ["child", "explicit", "missing"],
    });
    await expect(subject.getTask("explicit")).resolves.toMatchObject({
      directParentIds: ["parent"],
      directChildIds: [],
    });
    await expect(subject.getTask("unknown")).resolves.toBeNull();
  });

  it("traverses parents and sub-tasks breadth-first with depth and direct relationship data", async () => {
    const subject = catalogue([
      item("root", "active", [], ["b", "a"]),
      item("a", "active", [], ["shared"]),
      item("b", "active", [], ["shared"]),
      item("shared", "active", [], ["leaf"]),
      item("leaf", "active"),
    ]);

    const subtasks = await subject.getSubtasks("root");
    expect(subtasks?.tasks.map(({ id, depth, direct }) => ({ id, depth, direct }))).toEqual([
      { id: "a", depth: 1, direct: true },
      { id: "b", depth: 1, direct: true },
      { id: "shared", depth: 2, direct: false },
      { id: "leaf", depth: 3, direct: false },
    ]);
    expect(subtasks).toMatchObject({
      missingIds: [],
      cycles: [],
      truncated: false,
      truncation: { depthLimitReached: false, resultLimitReached: false },
    });

    const parents = await subject.getParentTasks("leaf");
    expect(parents?.tasks.map(({ id, depth, direct }) => ({ id, depth, direct }))).toEqual([
      { id: "shared", depth: 1, direct: true },
      { id: "a", depth: 2, direct: false },
      { id: "b", depth: 2, direct: false },
      { id: "root", depth: 3, direct: false },
    ]);
  });

  it("reports missing links and cycles without repeating tasks", async () => {
    const subject = catalogue([
      item("root", "active", [], ["a", "b", "missing"]),
      item("a", "active", [], ["c"]),
      item("b", "active", [], ["a"]),
      item("c", "active", [], ["b"]),
    ]);

    await expect(subject.getSubtasks("root")).resolves.toMatchObject({
      tasks: [{ id: "a" }, { id: "b" }, { id: "c" }],
      missingIds: ["missing"],
      cycles: [{ fromId: "b", toId: "a" }],
      truncated: false,
    });
  });

  it("uses task-agent relationship semantics instead of parsing task files", async () => {
    const parent = item("parent", "active");
    const child = {
      ...item("child", "active"),
      metadata: { parent: { id: "parent", path: parent.path } },
    };
    const parser = { loadAll: async () => [child, parent] } as WorkItemParser;
    const subject = new TaskCatalogue(parser, new TaskAgentAdapter());

    await expect(subject.getSubtasks("parent")).resolves.toMatchObject({
      tasks: [{ id: "child", depth: 1, direct: true }],
    });
  });

  it("bounds hierarchy depth and result count with explicit truncation metadata", async () => {
    const subject = catalogue([
      item("root", "active", [], ["a", "b", "c"]),
      item("a", "active", [], ["deep"]),
      item("b", "active"),
      item("c", "active"),
      item("deep", "active"),
    ]);

    await expect(subject.getSubtasks("root", { maxDepth: 1 })).resolves.toMatchObject({
      tasks: [
        { id: "a", depth: 1 },
        { id: "b", depth: 1 },
        { id: "c", depth: 1 },
      ],
      truncated: true,
      truncation: { depthLimitReached: true, resultLimitReached: false },
    });
    await expect(subject.getSubtasks("root", { maxResults: 2 })).resolves.toMatchObject({
      tasks: [{ id: "a" }, { id: "b" }],
      truncated: true,
      truncation: { depthLimitReached: false, resultLimitReached: true },
    });
  });
});

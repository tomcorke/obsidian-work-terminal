import { describe, it, expect, vi } from "vitest";
import { TaskParser } from "./TaskParser";
import type { App, TFile, CachedMetadata } from "obsidian";

function mockApp(
  files: Array<{ path: string; name: string; basename: string; extension: string }>,
  caches: Record<string, CachedMetadata | null>,
): App {
  return {
    metadataCache: {
      getFileCache: (file: TFile) => caches[file.path] ?? null,
    },
    vault: {
      getAbstractFileByPath: (path: string) => {
        if (path.endsWith("/")) return null;
        // For folder checks, return truthy for known folders
        const knownFolders = [
          "2 - Areas/Tasks/priority",
          "2 - Areas/Tasks/todo",
          "2 - Areas/Tasks/active",
          "2 - Areas/Tasks/archive",
        ];
        if (knownFolders.includes(path)) return { path };
        return files.find((f) => f.path === path) || null;
      },
      getMarkdownFiles: () =>
        files.map((f) => ({
          path: f.path,
          name: f.name,
          basename: f.basename,
          extension: f.extension,
        })),
      read: vi.fn(),
      modify: vi.fn(),
    },
  } as unknown as App;
}

function makeFile(path: string): {
  path: string;
  name: string;
  basename: string;
  extension: string;
} {
  const name = path.split("/").pop() || "";
  const basename = name.replace(/\.md$/, "");
  return { path, name, basename, extension: "md" };
}

function makeFrontmatter(overrides: Record<string, any> = {}) {
  return {
    frontmatter: {
      id: "test-uuid",
      state: "active",
      title: "Test Task",
      tags: ["task", "task/active"],
      source: { type: "prompt", id: "p1", url: "", captured: "2026-03-27" },
      priority: {
        score: 50,
        deadline: "",
        impact: "medium",
        "has-blocker": false,
        "blocker-context": "",
      },
      "agent-actionable": false,
      goal: ["improve-perf"],
      created: "2026-03-27T00:00:00Z",
      updated: "2026-03-27T12:00:00Z",
      ...overrides,
    },
  } as unknown as CachedMetadata;
}

describe("TaskParser", () => {
  const defaultSettings = {
    "adapter.taskBasePath": "2 - Areas/Tasks",
    "adapter.jiraBaseUrl": "https://example.atlassian.net/browse",
  };

  describe("parse", () => {
    it("extracts all fields from valid frontmatter", () => {
      const file = makeFile("2 - Areas/Tasks/active/task.md");
      const app = mockApp([file], {
        [file.path]: makeFrontmatter(),
      });
      const parser = new TaskParser(app, "", defaultSettings);
      const item = parser.parse(file as unknown as TFile);

      expect(item).not.toBeNull();
      expect(item!.id).toBe("test-uuid");
      expect(item!.title).toBe("Test Task");
      expect(item!.state).toBe("active");
      expect(item!.path).toBe(file.path);
      expect((item!.metadata as any).source.type).toBe("prompt");
      expect((item!.metadata as any).priority.score).toBe(50);
      expect((item!.metadata as any).goal).toEqual(["improve-perf"]);
    });

    it("returns null for missing frontmatter", () => {
      const file = makeFile("2 - Areas/Tasks/active/task.md");
      const app = mockApp([file], { [file.path]: null });
      const parser = new TaskParser(app, "", defaultSettings);
      const item = parser.parse(file as unknown as TFile);
      expect(item).not.toBeNull();
      expect(item!.id).toBe(file.path);
      expect(item!.title).toBe("task");
      expect(item!.state).toBe("active");
    });

    it("falls back to path-derived defaults for empty frontmatter", () => {
      const file = makeFile("2 - Areas/Tasks/active/task.md");
      const app = mockApp([file], {
        [file.path]: { frontmatter: undefined } as unknown as CachedMetadata,
      });
      const parser = new TaskParser(app, "", defaultSettings);
      const item = parser.parse(file as unknown as TFile);
      expect(item).not.toBeNull();
      expect(item!.state).toBe("active");
      expect((item!.metadata as any).priority.score).toBe(0);
    });

    it("uses registered transient task metadata while metadata cache is still empty", () => {
      const file = makeFile("2 - Areas/Tasks/active/task.md");
      const app = mockApp([file], { [file.path]: null });
      const parser = new TaskParser(app, "", defaultSettings);
      parser.registerTransientTask({
        id: "child-id",
        path: file.path,
        filename: file.name,
        state: "active",
        title: "Sub-task from: Parent",
        tags: ["task", "task/active", "sub-task"],
        source: { type: "prompt", id: "", url: "", captured: "" },
        priority: {
          score: 0,
          deadline: "",
          impact: "medium",
          "has-blocker": false,
          "blocker-context": "",
        },
        agentActionable: false,
        goal: [],
        parent: {
          id: "parent-id",
          title: "Parent",
          path: "2 - Areas/Tasks/active/parent.md",
          link: "[[parent|Parent]]",
        },
        isSubTask: true,
        created: "2026-05-01T11:00:00Z",
        updated: "2026-05-01T11:00:00Z",
        lastActive: "",
      });

      const item = parser.parse(file as unknown as TFile);

      expect(item).not.toBeNull();
      expect(item!.id).toBe("child-id");
      expect(item!.title).toBe("Sub-task from: Parent");
      expect((item!.metadata as any).isSubTask).toBe(true);
      expect((item!.metadata as any).parent).toEqual({
        id: "parent-id",
        title: "Parent",
        path: "2 - Areas/Tasks/active/parent.md",
        link: "[[parent|Parent]]",
      });
    });

    it("falls back to the folder state when frontmatter state is invalid", () => {
      const file = makeFile("2 - Areas/Tasks/active/task.md");
      const app = mockApp([file], {
        [file.path]: makeFrontmatter({ state: "invalid" }),
      });
      const parser = new TaskParser(app, "", defaultSettings);
      const item = parser.parse(file as unknown as TFile);
      expect(item).not.toBeNull();
      expect(item!.state).toBe("active");
    });

    it("falls back to the folder state when taskBasePath has a trailing slash", () => {
      const file = makeFile("2 - Areas/Tasks/active/task.md");
      const app = mockApp([file], {
        [file.path]: makeFrontmatter({ state: "invalid" }),
      });
      const parser = new TaskParser(app, "", {
        "adapter.taskBasePath": "2 - Areas/Tasks/",
      });
      const item = parser.parse(file as unknown as TFile);
      expect(item).not.toBeNull();
      expect(item!.state).toBe("active");
    });

    it("uses file basename when title is missing", () => {
      const file = makeFile("2 - Areas/Tasks/active/my-task.md");
      const app = mockApp([file], {
        [file.path]: makeFrontmatter({ title: undefined }),
      });
      const parser = new TaskParser(app, "", defaultSettings);
      const item = parser.parse(file as unknown as TFile);
      expect(item!.title).toBe("my-task");
    });

    it("parses parent frontmatter and marks sub-tasks", () => {
      const parent = makeFile("2 - Areas/Tasks/active/parent.md");
      const child = makeFile("2 - Areas/Tasks/active/child.md");
      const app = mockApp([parent, child], {
        [parent.path]: makeFrontmatter({ id: "parent-uuid", title: "Resolved Parent" }),
        [child.path]: makeFrontmatter({
          id: "child-uuid",
          title: "Child Task",
          "sub-task": true,
          parent: {
            id: "parent-uuid",
            title: "Stored Parent",
            path: "old/path.md",
            link: "[[parent|Stored Parent]]",
          },
        }),
      });
      const parser = new TaskParser(app, "", defaultSettings);
      const item = parser.parse(child as unknown as TFile);

      expect((item!.metadata as any).isSubTask).toBe(true);
      expect((item!.metadata as any).parent).toEqual({
        id: "parent-uuid",
        title: "Stored Parent",
        path: parent.path,
        link: "[[parent|Stored Parent]]",
      });
    });

    it("uses file.path as the ID when frontmatter id is missing", () => {
      const file = makeFile("2 - Areas/Tasks/active/task-without-id.md");
      const app = mockApp([file], {
        [file.path]: makeFrontmatter({ id: undefined }),
      });
      const parser = new TaskParser(app, "", defaultSettings);
      const item = parser.parse(file as unknown as TFile);

      expect(item).not.toBeNull();
      expect(item!.id).toBe(file.path);
      expect(item!.path).toBe(file.path);
      expect(item!.state).toBe("active");
    });

    it("defaults source.type to 'other' when missing", () => {
      const file = makeFile("2 - Areas/Tasks/active/task.md");
      const app = mockApp([file], {
        [file.path]: makeFrontmatter({ source: undefined }),
      });
      const parser = new TaskParser(app, "", defaultSettings);
      const item = parser.parse(file as unknown as TFile);
      expect((item!.metadata as any).source.type).toBe("other");
    });

    it("detects Jira source from a discrete jira frontmatter field", () => {
      const file = makeFile("2 - Areas/Tasks/active/task.md");
      const app = mockApp([file], {
        [file.path]: makeFrontmatter({
          source: undefined,
          jira: "PROJ-1234",
        }),
      });
      const parser = new TaskParser(app, "", defaultSettings);
      const item = parser.parse(file as unknown as TFile);

      expect((item!.metadata as any).source).toMatchObject({
        type: "jira",
        id: "PROJ-1234",
        url: "https://example.atlassian.net/browse/PROJ-1234",
        captured: "PROJ-1234",
      });
    });

    it("detects Jira source from a full Jira URL in a discrete jira frontmatter field", () => {
      const file = makeFile("2 - Areas/Tasks/active/task.md");
      const jiraUrl = "https://example.atlassian.net/browse/PROJ-1234";
      const app = mockApp([file], {
        [file.path]: makeFrontmatter({
          source: undefined,
          jira: jiraUrl,
        }),
      });
      const parser = new TaskParser(app, "", defaultSettings);
      const item = parser.parse(file as unknown as TFile);

      expect((item!.metadata as any).source).toMatchObject({
        type: "jira",
        id: "PROJ-1234",
        url: jiraUrl,
        captured: jiraUrl,
      });
    });

    it("detects Jira source from Jira-prefixed tags when explicit source is missing", () => {
      const file = makeFile("2 - Areas/Tasks/active/task.md");
      const app = mockApp([file], {
        [file.path]: makeFrontmatter({
          source: undefined,
          tags: ["task", "jira/PROJ-1234"],
        }),
      });
      const parser = new TaskParser(app, "", defaultSettings);
      const item = parser.parse(file as unknown as TFile);

      expect((item!.metadata as any).source).toMatchObject({
        type: "jira",
        id: "PROJ-1234",
        url: "https://example.atlassian.net/browse/PROJ-1234",
        captured: "jira/PROJ-1234",
      });
    });

    it("fills in Jira source details when source metadata only contains a Jira URL", () => {
      const file = makeFile("2 - Areas/Tasks/active/task.md");
      const jiraUrl = "https://example.atlassian.net/browse/PROJ-9876";
      const app = mockApp([file], {
        [file.path]: makeFrontmatter({
          source: { type: "other", id: "", url: jiraUrl, captured: "" },
        }),
      });
      const parser = new TaskParser(app, "", defaultSettings);
      const item = parser.parse(file as unknown as TFile);

      expect((item!.metadata as any).source).toMatchObject({
        type: "jira",
        id: "PROJ-9876",
        url: jiraUrl,
      });
    });

    it("normalizes explicit Jira source ids to the detected Jira key", () => {
      const file = makeFile("2 - Areas/Tasks/active/task.md");
      const jiraUrl = "https://example.atlassian.net/browse/PROJ-1234";
      const app = mockApp([file], {
        [file.path]: makeFrontmatter({
          source: {
            type: "jira",
            id: "proj-1234",
            url: jiraUrl,
            captured: "proj-1234",
          },
        }),
      });
      const parser = new TaskParser(app, "", defaultSettings);
      const item = parser.parse(file as unknown as TFile);

      expect((item!.metadata as any).source).toMatchObject({
        type: "jira",
        id: "PROJ-1234",
        url: jiraUrl,
        captured: "proj-1234",
      });
    });

    it("preserves explicit non-Jira source metadata", () => {
      const file = makeFile("2 - Areas/Tasks/active/task.md");
      const confluenceUrl = "https://example.atlassian.net/wiki/spaces/ABC/pages/1234";
      const app = mockApp([file], {
        [file.path]: makeFrontmatter({
          source: { type: "confluence", id: "CONF-1", url: confluenceUrl, captured: "" },
        }),
      });
      const parser = new TaskParser(app, "", defaultSettings);
      const item = parser.parse(file as unknown as TFile);

      expect((item!.metadata as any).source).toMatchObject({
        type: "confluence",
        id: "CONF-1",
        url: confluenceUrl,
      });
    });

    it("leaves non-Jira URLs as other when no Jira key is present", () => {
      const file = makeFile("2 - Areas/Tasks/active/task.md");
      const genericUrl = "https://example.com/docs/task";
      const app = mockApp([file], {
        [file.path]: makeFrontmatter({
          source: { type: "other", id: "", url: genericUrl, captured: "" },
        }),
      });
      const parser = new TaskParser(app, "", defaultSettings);
      const item = parser.parse(file as unknown as TFile);

      expect((item!.metadata as any).source).toMatchObject({
        type: "other",
        id: "",
        url: genericUrl,
      });
    });

    it("uses the configured Jira base URL when expanding ticket refs", () => {
      const file = makeFile("2 - Areas/Tasks/active/task.md");
      const app = mockApp([file], {
        [file.path]: makeFrontmatter({
          source: undefined,
          jira: "PROJ-1234",
        }),
      });
      const parser = new TaskParser(app, "", {
        ...defaultSettings,
        "adapter.jiraBaseUrl": "https://example.atlassian.net/browse/",
      });
      const item = parser.parse(file as unknown as TFile);

      expect((item!.metadata as any).source.url).toBe(
        "https://example.atlassian.net/browse/PROJ-1234",
      );
    });

    it("defaults priority.score to 0 when missing", () => {
      const file = makeFile("2 - Areas/Tasks/active/task.md");
      const app = mockApp([file], {
        [file.path]: makeFrontmatter({ priority: undefined }),
      });
      const parser = new TaskParser(app, "", defaultSettings);
      const item = parser.parse(file as unknown as TFile);
      expect((item!.metadata as any).priority.score).toBe(0);
    });
  });

  describe("flat dot-notation frontmatter (new format)", () => {
    it("reads flat source fields", () => {
      const file = makeFile("2 - Areas/Tasks/active/task.md");
      const app = mockApp([file], {
        [file.path]: makeFrontmatter({
          source: undefined,
          "source.type": "slack",
          "source.id": "SLK-001",
          "source.url": "https://slack.example.com/msg/001",
          "source.captured": "2026-04-01",
        }),
      });
      const parser = new TaskParser(app, "", defaultSettings);
      const item = parser.parse(file as unknown as TFile);

      expect((item!.metadata as any).source).toMatchObject({
        type: "slack",
        id: "SLK-001",
        url: "https://slack.example.com/msg/001",
        captured: "2026-04-01",
      });
    });

    it("reads flat priority fields", () => {
      const file = makeFile("2 - Areas/Tasks/active/task.md");
      const app = mockApp([file], {
        [file.path]: makeFrontmatter({
          priority: undefined,
          "priority.score": 75,
          "priority.deadline": "2026-05-01",
          "priority.impact": "high",
          "priority.has-blocker": true,
          "priority.blocker-context": "waiting on API",
        }),
      });
      const parser = new TaskParser(app, "", defaultSettings);
      const item = parser.parse(file as unknown as TFile);

      expect((item!.metadata as any).priority).toMatchObject({
        score: 75,
        deadline: "2026-05-01",
        impact: "high",
        "has-blocker": true,
        "blocker-context": "waiting on API",
      });
    });

    it("flat keys take precedence over nested keys", () => {
      const file = makeFile("2 - Areas/Tasks/active/task.md");
      const app = mockApp([file], {
        [file.path]: makeFrontmatter({
          source: { type: "other", id: "old", url: "", captured: "" },
          "source.type": "jira",
          "source.id": "PROJ-999",
          "source.url": "https://example.atlassian.net/browse/PROJ-999",
          "source.captured": "PROJ-999",
          priority: {
            score: 10,
            deadline: "",
            impact: "low",
            "has-blocker": false,
            "blocker-context": "",
          },
          "priority.score": 90,
          "priority.impact": "critical",
        }),
      });
      const parser = new TaskParser(app, "", defaultSettings);
      const item = parser.parse(file as unknown as TFile);

      expect((item!.metadata as any).source.type).toBe("jira");
      expect((item!.metadata as any).source.id).toBe("PROJ-999");
      expect((item!.metadata as any).priority.score).toBe(90);
      expect((item!.metadata as any).priority.impact).toBe("critical");
    });

    it("empty flat string values take precedence over non-empty nested values", () => {
      const file = makeFile("2 - Areas/Tasks/active/task.md");
      const app = mockApp([file], {
        [file.path]: makeFrontmatter({
          priority: {
            score: 80,
            deadline: "2026-12-31",
            impact: "critical",
            "has-blocker": true,
            "blocker-context": "waiting on deploy",
          },
          "priority.score": 0,
          "priority.deadline": "",
          "priority.impact": "",
          "priority.has-blocker": false,
          "priority.blocker-context": "",
        }),
      });
      const parser = new TaskParser(app, "", defaultSettings);
      const item = parser.parse(file as unknown as TFile);

      expect((item!.metadata as any).priority).toMatchObject({
        score: 0,
        deadline: "",
        impact: "",
        "has-blocker": false,
        "blocker-context": "",
      });
    });

    it("falls back to nested when flat keys are absent", () => {
      const file = makeFile("2 - Areas/Tasks/active/task.md");
      const app = mockApp([file], {
        [file.path]: makeFrontmatter({
          source: {
            type: "confluence",
            id: "C-1",
            url: "https://wiki.example.com",
            captured: "2026-01-01",
          },
          priority: {
            score: 42,
            deadline: "2026-06-01",
            impact: "high",
            "has-blocker": true,
            "blocker-context": "blocked",
          },
        }),
      });
      const parser = new TaskParser(app, "", defaultSettings);
      const item = parser.parse(file as unknown as TFile);

      expect((item!.metadata as any).source).toMatchObject({
        type: "confluence",
        id: "C-1",
        url: "https://wiki.example.com",
        captured: "2026-01-01",
      });
      expect((item!.metadata as any).priority).toMatchObject({
        score: 42,
        deadline: "2026-06-01",
        impact: "high",
        "has-blocker": true,
        "blocker-context": "blocked",
      });
    });

    it("detects Jira source from flat keys", () => {
      const file = makeFile("2 - Areas/Tasks/active/task.md");
      const jiraUrl = "https://example.atlassian.net/browse/PROJ-5555";
      const app = mockApp([file], {
        [file.path]: makeFrontmatter({
          source: undefined,
          "source.type": "other",
          "source.id": "",
          "source.url": jiraUrl,
          "source.captured": "",
        }),
      });
      const parser = new TaskParser(app, "", defaultSettings);
      const item = parser.parse(file as unknown as TFile);

      expect((item!.metadata as any).source).toMatchObject({
        type: "jira",
        id: "PROJ-5555",
        url: jiraUrl,
      });
    });
  });

  describe("goal normalisation", () => {
    it("passes through array goal", () => {
      const file = makeFile("2 - Areas/Tasks/active/task.md");
      const app = mockApp([file], {
        [file.path]: makeFrontmatter({ goal: ["a", "b"] }),
      });
      const parser = new TaskParser(app, "", defaultSettings);
      const item = parser.parse(file as unknown as TFile);
      expect((item!.metadata as any).goal).toEqual(["a", "b"]);
    });

    it("wraps string goal in array", () => {
      const file = makeFile("2 - Areas/Tasks/active/task.md");
      const app = mockApp([file], {
        [file.path]: makeFrontmatter({ goal: "single-goal" }),
      });
      const parser = new TaskParser(app, "", defaultSettings);
      const item = parser.parse(file as unknown as TFile);
      expect((item!.metadata as any).goal).toEqual(["single-goal"]);
    });

    it("returns empty array for missing goal", () => {
      const file = makeFile("2 - Areas/Tasks/active/task.md");
      const app = mockApp([file], {
        [file.path]: makeFrontmatter({ goal: undefined }),
      });
      const parser = new TaskParser(app, "", defaultSettings);
      const item = parser.parse(file as unknown as TFile);
      expect((item!.metadata as any).goal).toEqual([]);
    });

    it("returns empty array for null goal", () => {
      const file = makeFile("2 - Areas/Tasks/active/task.md");
      const app = mockApp([file], {
        [file.path]: makeFrontmatter({ goal: null }),
      });
      const parser = new TaskParser(app, "", defaultSettings);
      const item = parser.parse(file as unknown as TFile);
      expect((item!.metadata as any).goal).toEqual([]);
    });
  });

  describe("color property", () => {
    it("passes through color from frontmatter", () => {
      const file = makeFile("2 - Areas/Tasks/active/task.md");
      const app = mockApp([file], {
        [file.path]: makeFrontmatter({ color: "#0062e3" }),
      });
      const parser = new TaskParser(app, "", defaultSettings);
      const item = parser.parse(file as unknown as TFile);
      expect((item!.metadata as any).color).toBe("#0062e3");
    });

    it("omits color from metadata when not set in frontmatter", () => {
      const file = makeFile("2 - Areas/Tasks/active/task.md");
      const app = mockApp([file], {
        [file.path]: makeFrontmatter({}),
      });
      const parser = new TaskParser(app, "", defaultSettings);
      const item = parser.parse(file as unknown as TFile);
      expect((item!.metadata as any).color).toBeUndefined();
    });
  });

  describe("backgroundIngestion property", () => {
    it("parses background-ingestion: failed from frontmatter", () => {
      const file = makeFile("2 - Areas/Tasks/active/task.md");
      const app = mockApp([file], {
        [file.path]: makeFrontmatter({ "background-ingestion": "failed" }),
      });
      const parser = new TaskParser(app, "", defaultSettings);
      const item = parser.parse(file as unknown as TFile);
      expect((item!.metadata as any).backgroundIngestion).toBe("failed");
    });

    it("parses background-ingestion: retrying from frontmatter", () => {
      const file = makeFile("2 - Areas/Tasks/active/task.md");
      const app = mockApp([file], {
        [file.path]: makeFrontmatter({ "background-ingestion": "retrying" }),
      });
      const parser = new TaskParser(app, "", defaultSettings);
      const item = parser.parse(file as unknown as TFile);
      expect((item!.metadata as any).backgroundIngestion).toBe("retrying");
    });

    it("omits backgroundIngestion when not set in frontmatter", () => {
      const file = makeFile("2 - Areas/Tasks/active/task.md");
      const app = mockApp([file], {
        [file.path]: makeFrontmatter({}),
      });
      const parser = new TaskParser(app, "", defaultSettings);
      const item = parser.parse(file as unknown as TFile);
      expect((item!.metadata as any).backgroundIngestion).toBeUndefined();
    });

    it("ignores unrecognised background-ingestion values", () => {
      const file = makeFile("2 - Areas/Tasks/active/task.md");
      const app = mockApp([file], {
        [file.path]: makeFrontmatter({ "background-ingestion": "unknown" }),
      });
      const parser = new TaskParser(app, "", defaultSettings);
      const item = parser.parse(file as unknown as TFile);
      expect((item!.metadata as any).backgroundIngestion).toBeUndefined();
    });
  });

  describe("groupByColumn", () => {
    it("excludes abandoned tasks", () => {
      const parser = new TaskParser({} as App, "", defaultSettings);
      const items = [
        {
          id: "1",
          path: "a",
          title: "A",
          state: "active",
          metadata: { priority: { score: 0 }, updated: "" },
        },
        {
          id: "2",
          path: "b",
          title: "B",
          state: "abandoned",
          metadata: { priority: { score: 0 }, updated: "" },
        },
      ];
      const groups = parser.groupByColumn(items);
      expect(groups["active"].length).toBe(1);
      expect(groups["priority"].length).toBe(0);
      expect(groups["todo"].length).toBe(0);
      expect(groups["done"].length).toBe(0);
    });

    it("sorts by score descending", () => {
      const parser = new TaskParser({} as App, "", defaultSettings);
      const items = [
        {
          id: "1",
          path: "a",
          title: "Low",
          state: "active",
          metadata: { priority: { score: 20 }, updated: "" },
        },
        {
          id: "2",
          path: "b",
          title: "High",
          state: "active",
          metadata: { priority: { score: 80 }, updated: "" },
        },
      ];
      const groups = parser.groupByColumn(items);
      expect(groups["active"][0].title).toBe("High");
      expect(groups["active"][1].title).toBe("Low");
    });

    it("uses updated timestamp as tiebreaker", () => {
      const parser = new TaskParser({} as App, "", defaultSettings);
      const items = [
        {
          id: "1",
          path: "a",
          title: "Old",
          state: "todo",
          metadata: { priority: { score: 50 }, updated: "2026-03-01" },
        },
        {
          id: "2",
          path: "b",
          title: "New",
          state: "todo",
          metadata: { priority: { score: 50 }, updated: "2026-03-27" },
        },
      ];
      const groups = parser.groupByColumn(items);
      expect(groups["todo"][0].title).toBe("New");
    });
  });

  describe("loadAll", () => {
    it("only logs malformed frontmatter fallback once per file", async () => {
      const malformed = makeFile("2 - Areas/Tasks/todo/broken-task.md");
      const app = mockApp([malformed], {
        [malformed.path]: null,
      });
      const parser = new TaskParser(app, "", defaultSettings);
      const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

      parser.parse(malformed as unknown as TFile);
      parser.parse(malformed as unknown as TFile);

      expect(debugSpy).toHaveBeenCalledTimes(1);
      expect(debugSpy).toHaveBeenCalledWith(
        `[work-terminal] Falling back to path-based task parsing for malformed frontmatter: ${malformed.path}`,
      );

      debugSpy.mockRestore();
    });

    it("keeps malformed task files in the list using folder-derived defaults", async () => {
      const malformed = makeFile("2 - Areas/Tasks/todo/broken-task.md");
      const valid = makeFile("2 - Areas/Tasks/active/working-task.md");
      const app = mockApp([malformed, valid], {
        [malformed.path]: null,
        [valid.path]: makeFrontmatter({ state: "active", title: "Working task" }),
      });
      const parser = new TaskParser(app, "", defaultSettings);

      const items = await parser.loadAll();

      expect(items).toHaveLength(2);
      expect(items.find((item) => item.path === malformed.path)).toMatchObject({
        id: malformed.path,
        title: "broken-task",
        state: "todo",
      });
    });

    it("indexes parent IDs once per load instead of rescanning for each sub-task", async () => {
      const parent = makeFile("2 - Areas/Tasks/active/parent.md");
      const childA = makeFile("2 - Areas/Tasks/active/child-a.md");
      const childB = makeFile("2 - Areas/Tasks/active/child-b.md");
      const app = mockApp([parent, childA, childB], {
        [parent.path]: makeFrontmatter({ id: "parent-uuid", title: "Resolved Parent" }),
        [childA.path]: makeFrontmatter({
          id: "child-a",
          parent: { id: "parent-uuid", title: "Parent" },
        }),
        [childB.path]: makeFrontmatter({
          id: "child-b",
          parent: { id: "parent-uuid", title: "Parent" },
        }),
      });
      const getMarkdownFiles = vi.spyOn(app.vault, "getMarkdownFiles");
      const parser = new TaskParser(app, "", defaultSettings);

      const items = await parser.loadAll();

      expect(items).toHaveLength(3);
      expect(getMarkdownFiles).toHaveBeenCalledTimes(5);
      expect((items.find((item) => item.id === "child-a")!.metadata as any).parent.path).toBe(
        parent.path,
      );
      expect((items.find((item) => item.id === "child-b")!.metadata as any).parent.path).toBe(
        parent.path,
      );
    });
  });

  describe("backfillItemId", () => {
    it("writes a missing frontmatter id and immediately uses it as the working ID", async () => {
      const file = makeFile("2 - Areas/Tasks/active/task-without-id.md");
      const app = mockApp([file], {
        [file.path]: makeFrontmatter({ id: undefined }),
      });
      const parser = new TaskParser(app, "", defaultSettings);
      const item = parser.parse(file as unknown as TFile);
      const readMock = vi.mocked(app.vault.read as any);
      const modifyMock = vi.mocked(app.vault.modify as any);
      const uuidSpy = vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("uuid-123");

      readMock.mockResolvedValue("---\nstate: active\n---\nBody");
      modifyMock.mockResolvedValue(undefined);

      const updatedItem = await parser.backfillItemId(item!);
      const reparsed = parser.parse(file as unknown as TFile);

      expect(updatedItem?.id).toBe("uuid-123");
      expect(modifyMock).toHaveBeenCalledWith(
        expect.objectContaining({ path: file.path }),
        "---\nid: uuid-123\nstate: active\n---\nBody",
      );
      expect(reparsed?.id).toBe("uuid-123");

      uuidSpy.mockRestore();
    });

    it("reuses an already-written raw frontmatter id without modifying the file", async () => {
      const file = makeFile("2 - Areas/Tasks/active/task-with-stale-cache.md");
      const caches = {
        [file.path]: makeFrontmatter({ id: undefined }),
      };
      const app = mockApp([file], caches);
      const parser = new TaskParser(app, "", defaultSettings);
      const item = parser.parse(file as unknown as TFile);
      const readMock = vi.mocked(app.vault.read as any);
      const modifyMock = vi.mocked(app.vault.modify as any);

      readMock.mockResolvedValue("---\nid: raw-uuid\nstate: active\n---\nBody");

      const updatedItem = await parser.backfillItemId(item!);
      const reparsed = parser.parse(file as unknown as TFile);

      expect(updatedItem?.id).toBe("raw-uuid");
      expect(modifyMock).not.toHaveBeenCalled();
      expect(reparsed?.id).toBe("raw-uuid");
    });

    it("normalizes quoted frontmatter ids the same way as YAML metadata parsing", async () => {
      const file = makeFile("2 - Areas/Tasks/active/task-with-quoted-id.md");
      const caches = {
        [file.path]: makeFrontmatter({ id: undefined }),
      };
      const app = mockApp([file], caches);
      const parser = new TaskParser(app, "", defaultSettings);
      const item = parser.parse(file as unknown as TFile);
      const readMock = vi.mocked(app.vault.read as any);
      const modifyMock = vi.mocked(app.vault.modify as any);

      readMock.mockResolvedValue('---\nid: "quoted-uuid"\nstate: active\n---\nBody');

      const updatedItem = await parser.backfillItemId(item!);
      caches[file.path] = makeFrontmatter({ id: "quoted-uuid" });
      const reparsed = parser.parse(file as unknown as TFile);

      expect(updatedItem?.id).toBe("quoted-uuid");
      expect(modifyMock).not.toHaveBeenCalled();
      expect(reparsed?.id).toBe("quoted-uuid");
    });

    it("strips inline YAML comments when reusing an existing frontmatter id", async () => {
      const file = makeFile("2 - Areas/Tasks/active/task-with-comment-id.md");
      const caches = {
        [file.path]: makeFrontmatter({ id: undefined }),
      };
      const app = mockApp([file], caches);
      const parser = new TaskParser(app, "", defaultSettings);
      const item = parser.parse(file as unknown as TFile);
      const readMock = vi.mocked(app.vault.read as any);
      const modifyMock = vi.mocked(app.vault.modify as any);

      readMock.mockResolvedValue("---\nid: inline-uuid # keep comment\nstate: active\n---\nBody");

      const updatedItem = await parser.backfillItemId(item!);
      caches[file.path] = makeFrontmatter({ id: "inline-uuid" });
      const reparsed = parser.parse(file as unknown as TFile);

      expect(updatedItem?.id).toBe("inline-uuid");
      expect(modifyMock).not.toHaveBeenCalled();
      expect(reparsed?.id).toBe("inline-uuid");
    });

    it("preserves an existing id when unrelated frontmatter is malformed", async () => {
      const file = makeFile("2 - Areas/Tasks/active/task-with-bad-frontmatter.md");
      const caches = {
        [file.path]: makeFrontmatter({ id: undefined }),
      };
      const app = mockApp([file], caches);
      const parser = new TaskParser(app, "", defaultSettings);
      const item = parser.parse(file as unknown as TFile);
      const readMock = vi.mocked(app.vault.read as any);
      const modifyMock = vi.mocked(app.vault.modify as any);

      readMock.mockResolvedValue('---\nid: "quoted-uuid"\nbroken: [\n---\nBody');

      const updatedItem = await parser.backfillItemId(item!);

      expect(updatedItem?.id).toBe("quoted-uuid");
      expect(modifyMock).not.toHaveBeenCalled();
    });

    it("does not reuse nested ids from malformed frontmatter when no top-level id exists", async () => {
      const file = makeFile("2 - Areas/Tasks/active/task-with-nested-id.md");
      const caches = {
        [file.path]: makeFrontmatter({ id: undefined }),
      };
      const app = mockApp([file], caches);
      const parser = new TaskParser(app, "", defaultSettings);
      const item = parser.parse(file as unknown as TFile);
      const readMock = vi.mocked(app.vault.read as any);
      const modifyMock = vi.mocked(app.vault.modify as any);
      const uuidSpy = vi
        .spyOn(globalThis.crypto, "randomUUID")
        .mockReturnValue("uuid-from-backfill");

      readMock.mockResolvedValue("---\nsource:\n  id: jira-123\nbroken: [\n---\nBody");
      modifyMock.mockResolvedValue(undefined);

      const updatedItem = await parser.backfillItemId(item!);

      expect(updatedItem?.id).toBe("uuid-from-backfill");
      expect(modifyMock).toHaveBeenCalledWith(
        expect.objectContaining({ path: file.path }),
        "---\nid: uuid-from-backfill\nsource:\n  id: jira-123\nbroken: [\n---\nBody",
      );

      uuidSpy.mockRestore();
    });

    it("backfills into an empty frontmatter block", async () => {
      const file = makeFile("2 - Areas/Tasks/active/task-empty-frontmatter.md");
      const app = mockApp([file], {
        [file.path]: { frontmatter: undefined } as unknown as CachedMetadata,
      });
      const parser = new TaskParser(app, "", defaultSettings);
      const item = parser.parse(file as unknown as TFile);
      const readMock = vi.mocked(app.vault.read as any);
      const modifyMock = vi.mocked(app.vault.modify as any);
      const uuidSpy = vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("uuid-empty-block");

      readMock.mockResolvedValue("---\n---\nBody");
      modifyMock.mockResolvedValue(undefined);

      const updatedItem = await parser.backfillItemId(item!);

      expect(updatedItem?.id).toBe("uuid-empty-block");
      expect(modifyMock).toHaveBeenCalledWith(
        expect.objectContaining({ path: file.path }),
        "---\nid: uuid-empty-block\n---\nBody",
      );

      uuidSpy.mockRestore();
    });

    it("treats a blank id line as missing instead of reading the next line", async () => {
      const file = makeFile("2 - Areas/Tasks/active/task-blank-id.md");
      const app = mockApp([file], {
        [file.path]: makeFrontmatter({ id: undefined }),
      });
      const parser = new TaskParser(app, "", defaultSettings);
      const item = parser.parse(file as unknown as TFile);
      const readMock = vi.mocked(app.vault.read as any);
      const modifyMock = vi.mocked(app.vault.modify as any);
      const uuidSpy = vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("uuid-blank-id");

      readMock.mockResolvedValue("---\nid:\nstate: active\n---\nBody");
      modifyMock.mockResolvedValue(undefined);

      const updatedItem = await parser.backfillItemId(item!);

      expect(updatedItem?.id).toBe("uuid-blank-id");
      expect(modifyMock).toHaveBeenCalledWith(
        expect.objectContaining({ path: file.path }),
        "---\nid: uuid-blank-id\nstate: active\n---\nBody",
      );

      uuidSpy.mockRestore();
    });

    it("treats a quoted empty id as missing and backfills it", async () => {
      const file = makeFile("2 - Areas/Tasks/active/task-quoted-empty-id.md");
      const app = mockApp([file], {
        [file.path]: makeFrontmatter({ id: undefined }),
      });
      const parser = new TaskParser(app, "", defaultSettings);
      const item = parser.parse(file as unknown as TFile);
      const readMock = vi.mocked(app.vault.read as any);
      const modifyMock = vi.mocked(app.vault.modify as any);
      const uuidSpy = vi
        .spyOn(globalThis.crypto, "randomUUID")
        .mockReturnValue("uuid-quoted-empty");

      readMock.mockResolvedValue('---\nid: ""\nstate: active\n---\nBody');
      modifyMock.mockResolvedValue(undefined);

      const updatedItem = await parser.backfillItemId(item!);
      const reparsed = parser.parse(file as unknown as TFile);

      expect(updatedItem?.id).toBe("uuid-quoted-empty");
      expect(modifyMock).toHaveBeenCalledWith(
        expect.objectContaining({ path: file.path }),
        "---\nid: uuid-quoted-empty\nstate: active\n---\nBody",
      );
      expect(reparsed?.id).toBe("uuid-quoted-empty");

      uuidSpy.mockRestore();
    });
  });

  describe("backfillIds", () => {
    it("backfills only items still using the file.path fallback", async () => {
      const missingId = makeFile("2 - Areas/Tasks/active/task-without-id.md");
      const existingId = makeFile("2 - Areas/Tasks/todo/task-with-id.md");
      const app = mockApp([missingId, existingId], {
        [missingId.path]: makeFrontmatter({ id: undefined, state: "active" }),
        [existingId.path]: makeFrontmatter({ id: "durable-uuid", state: "todo" }),
      });
      const parser = new TaskParser(app, "", defaultSettings);
      const readMock = vi.mocked(app.vault.read as any);
      const modifyMock = vi.mocked(app.vault.modify as any);
      const uuidSpy = vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("uuid-456");

      readMock.mockImplementation(async (file: TFile) => {
        if (file.path === missingId.path) {
          return "---\nstate: active\n---\nBody";
        }
        return "---\nid: durable-uuid\nstate: todo\n---\nBody";
      });
      modifyMock.mockResolvedValue(undefined);

      const count = await parser.backfillIds();
      const reparsedMissing = parser.parse(missingId as unknown as TFile);
      const reparsedExisting = parser.parse(existingId as unknown as TFile);

      expect(count).toBe(1);
      expect(modifyMock).toHaveBeenCalledTimes(1);
      expect(reparsedMissing?.id).toBe("uuid-456");
      expect(reparsedExisting?.id).toBe("durable-uuid");

      uuidSpy.mockRestore();
    });
  });

  describe("isItemFile", () => {
    it("matches files under basePath", () => {
      const parser = new TaskParser({} as App, "", defaultSettings);
      expect(parser.isItemFile("2 - Areas/Tasks/active/my-task.md")).toBe(true);
    });

    it("rejects files outside basePath", () => {
      const parser = new TaskParser({} as App, "", defaultSettings);
      expect(parser.isItemFile("3 - Resources/notes.md")).toBe(false);
    });

    it("rejects non-md files", () => {
      const parser = new TaskParser({} as App, "", defaultSettings);
      expect(parser.isItemFile("2 - Areas/Tasks/active/data.json")).toBe(false);
    });
  });
});

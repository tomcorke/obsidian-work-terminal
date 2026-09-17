export interface OpenCodeWebSessionOptions {
  serverUrl: string;
  cwd: string;
  title: string;
  prompt: string;
  signal?: AbortSignal;
  request?: typeof fetch;
}

export interface OpenCodeWebSessionResult {
  sessionId: string;
  pageUrl: string;
}

function requestError(response: Response): Error {
  return new Error(`OpenCode server returned ${response.status} ${response.statusText}`.trim());
}

export async function startOpenCodeWebSession({
  serverUrl,
  cwd,
  title,
  prompt,
  signal,
  request = fetch,
}: OpenCodeWebSessionOptions): Promise<OpenCodeWebSessionResult> {
  const origin = new URL(serverUrl).origin;
  const createUrl = new URL("/session", origin);
  createUrl.searchParams.set("directory", cwd);
  const createResponse = await request(createUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({ title }),
  });
  if (!createResponse.ok) throw requestError(createResponse);

  const session = (await createResponse.json()) as { id?: unknown };
  if (typeof session.id !== "string" || !session.id.startsWith("ses")) {
    throw new Error("OpenCode server returned an invalid session");
  }

  const promptUrl = new URL(`/session/${encodeURIComponent(session.id)}/prompt_async`, origin);
  promptUrl.searchParams.set("directory", cwd);
  const promptResponse = await request(promptUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({ parts: [{ type: "text", text: prompt }] }),
  });
  if (!promptResponse.ok) throw requestError(promptResponse);

  const serverSlug = Buffer.from(origin, "utf8").toString("base64url");
  return {
    sessionId: session.id,
    pageUrl: new URL(`/${serverSlug}/session/${encodeURIComponent(session.id)}`, origin).href,
  };
}

// Privileged handlers: the only code in this artifact that talks to the
// user's Notion workspace. They run on the host (outside the action
// sandbox) and drive the connected Notion account through the
// `notion-cli` MCP helper at /opt/hatch/bin/notion-cli.
//
// Flow verified against the live workspace before building:
//   notion-search            → candidate destination pages
//   notion-create-file-upload → one-time upload URL + headers for the
//                               recording file
//   POST multipart to that URL → markdown_source for the uploaded audio
//   notion-create-pages      → result page under the chosen parent, with
//                              an <audio source="file-upload://…"> block
//
// The bearer token inside upload_headers is used only inside this
// process (parsed from the CLI's JSON output and passed straight to
// fetch); it is never returned to the action layer or the client.

import {
  definePrivilegedContracts,
  definePrivilegedHandlers,
  z,
} from "@hatch/space-sdk";

export const PrivilegedContracts = definePrivilegedContracts({
  notionSearch: {
    request: z.object({ query: z.string().min(1).max(100) }),
    response: z.object({
      results: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          url: z.string(),
          type: z.string(),
          path: z.string().nullable(),
        }),
      ),
    }),
    timeoutMs: 90_000,
  },
  notionSaveResult: {
    request: z.object({
      title: z.string().min(1).max(200),
      content: z.string().min(1).max(20_000),
      parentPageId: z.string().max(64).nullable(),
      // The recording, sent only when the user chose to save it.
      audioBase64: z.string().max(30_000_000).nullable(),
      audioMimeType: z.string().max(100).nullable(),
      audioFilename: z.string().max(120).nullable(),
    }),
    response: z.object({ pageId: z.string(), pageUrl: z.string() }),
    timeoutMs: 240_000,
  },
});

const NOTION_CLI = "/opt/hatch/bin/notion-cli";

function runCli(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = Bun.spawn([NOTION_CLI, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const outPromise = new Response(proc.stdout).text();
    const errPromise = new Response(proc.stderr).text();
    proc.exited
      .then(async (code) => {
        const out = await outPromise;
        if (code === 0) {
          resolve(out);
        } else {
          const err = await errPromise;
          reject(
            new Error(
              `notion-cli exited ${code}: ${(err || out).slice(0, 300)}`,
            ),
          );
        }
      })
      .catch(reject);
  });
}

/** Call one Notion MCP tool through the CLI and parse its JSON payload. */
async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const raw = await runCli([
    "call-tool",
    "--name",
    name,
    "--arguments-json",
    JSON.stringify(args),
  ]);
  let outer: {
    ok?: boolean;
    result?: { content?: { text?: string }[] };
  };
  try {
    outer = JSON.parse(raw) as typeof outer;
  } catch {
    throw new Error(`Notion tool ${name}: unparseable response`);
  }
  if (!outer.ok) {
    throw new Error(`Notion tool ${name} failed: ${raw.slice(0, 300)}`);
  }
  const text = outer.result?.content?.[0]?.text;
  if (typeof text !== "string") return outer.result ?? null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null
    ? (v as Record<string, unknown>)
    : {};
}

export const PrivilegedHandlers = definePrivilegedHandlers(
  PrivilegedContracts,
  {
    async notionSearch(args) {
      const data = asRecord(
        await callTool("notion-search", { query: args.query, page_size: 15 }),
      );
      const rawResults = Array.isArray(data.results) ? data.results : [];
      const results = rawResults
        .map((r) => {
          const rec = asRecord(r);
          return {
            id: typeof rec.id === "string" ? rec.id : "",
            title: typeof rec.title === "string" ? rec.title : "",
            url: typeof rec.url === "string" ? rec.url : "",
            type: typeof rec.type === "string" ? rec.type : "page",
            path: typeof rec.path === "string" ? rec.path : null,
          };
        })
        .filter((r) => r.id !== "" && r.title !== "");
      return { results };
    },

    async notionSaveResult(args) {
      let audioMarkdown: string | null = null;

      if (args.audioBase64 && args.audioFilename) {
        const contentType = (
          args.audioMimeType ?? "audio/webm"
        ).split(";")[0]?.trim() || "audio/webm";
        const upload = asRecord(
          await callTool("notion-create-file-upload", {
            filename: args.audioFilename,
            content_type: contentType,
          }),
        );
        const uploadUrl = upload.upload_url;
        const headers = asRecord(upload.upload_headers);
        const field =
          typeof upload.upload_form_field === "string"
            ? upload.upload_form_field
            : "file";
        if (typeof uploadUrl !== "string" || !uploadUrl) {
          throw new Error("Notion file upload: no upload URL returned");
        }
        const bin = atob(args.audioBase64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const form = new FormData();
        form.append(
          field,
          new Blob([bytes], { type: contentType }),
          args.audioFilename,
        );
        const headerInit: Record<string, string> = {};
        for (const [k, v] of Object.entries(headers)) {
          if (typeof v === "string") headerInit[k] = v;
        }
        const resp = await fetch(uploadUrl, {
          method: "POST",
          headers: headerInit,
          body: form,
        });
        const respText = await resp.text();
        if (!resp.ok) {
          throw new Error(
            `Notion file upload failed (${resp.status}): ${respText.slice(0, 200)}`,
          );
        }
        let uploaded: Record<string, unknown> = {};
        try {
          uploaded = asRecord(JSON.parse(respText));
        } catch {
          uploaded = {};
        }
        const suggested = uploaded.suggested_markdown;
        const source = uploaded.markdown_source;
        if (typeof suggested === "string" && suggested) {
          audioMarkdown = suggested;
        } else if (typeof source === "string" && source) {
          audioMarkdown = `<audio source="${source}" />`;
        } else {
          throw new Error("Notion file upload: no file reference returned");
        }
      }

      const content = audioMarkdown
        ? `${args.content}\n\n## 録音音声\n\n${audioMarkdown}\n`
        : args.content;

      const createArgs: Record<string, unknown> = {
        pages: [{ properties: { title: args.title }, content }],
        allow_async: false,
      };
      if (args.parentPageId) {
        createArgs.parent = { type: "page_id", page_id: args.parentPageId };
      } else {
        createArgs.creation_mode = "draft";
      }
      const created = asRecord(await callTool("notion-create-pages", createArgs));
      const pages = Array.isArray(created.pages) ? created.pages : [];
      const first = asRecord(pages[0]);
      const pageId = typeof first.id === "string" ? first.id : "";
      const pageUrl = typeof first.url === "string" ? first.url : "";
      if (!pageId || !pageUrl) {
        throw new Error("Notion page creation returned no page URL");
      }
      return { pageId, pageUrl };
    },
  },
);

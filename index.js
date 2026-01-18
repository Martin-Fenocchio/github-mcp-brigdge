import "dotenv/config";
import express from "express";
import { z } from "zod";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const token = process.env.GH_PERSONAL_ACCESS_TOKEN;

if (!token) {
  console.error("❌ Falta GH_PERSONAL_ACCESS_TOKEN en el environment");
  process.exit(1);
}

const app = express();
app.use(express.json({ type: "*/*" }));

/** Helpers */
function parsePrUrl(pr_url) {
  // https://github.com/{owner}/{repo}/pull/{number}
  const u = new URL(pr_url);
  const parts = u.pathname.split("/").filter(Boolean);
  const pullIdx = parts.findIndex((p) => p === "pull");
  if (u.hostname !== "github.com" || pullIdx < 2 || !parts[pullIdx + 1]) {
    throw new Error(
      "URL inválida. Esperaba algo como https://github.com/OWNER/REPO/pull/123"
    );
  }
  return { owner: parts[0], repo: parts[1], number: parts[pullIdx + 1] };
}

async function ghFetchJson(url) {
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
    },
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`GitHub API error ${resp.status}: ${text}`);
  }

  return resp.json();
}

async function ghFetchText(url, accept) {
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: accept,
    },
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`GitHub API error ${resp.status}: ${text}`);
  }

  return resp.text();
}

/**
 * Lista archivos del PR con paginación.
 * GitHub devuelve hasta 100 por página.
 */
async function listPrFilesPaginated({ owner, repo, number, max_files }) {
  const perPage = Math.min(100, Math.max(1, max_files));
  let page = 1;
  const all = [];

  while (all.length < max_files) {
    const remaining = max_files - all.length;
    const currentPerPage = Math.min(perPage, remaining);

    const url = new URL(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${number}/files`
    );
    url.searchParams.set("per_page", String(currentPerPage));
    url.searchParams.set("page", String(page));

    const batch = await ghFetchJson(url.toString());
    if (!Array.isArray(batch) || batch.length === 0) break;

    all.push(...batch);
    if (batch.length < currentPerPage) break;

    page += 1;
  }

  return all.slice(0, max_files);
}

async function getServer() {
  const server = new McpServer({ name: "github-mcp", version: "1.1.0" });

  server.tool(
    "github_list_repos",
    "Lista repos accesibles por el usuario autenticado",
    {
      visibility: z.enum(["all", "public", "private"]).optional(),
      per_page: z.number().int().min(1).max(100).optional(),
    },
    async ({ visibility = "all", per_page = 100 }) => {
      const url = new URL("https://api.github.com/user/repos");
      url.searchParams.set("per_page", String(per_page));
      url.searchParams.set("visibility", visibility);

      const repos = await ghFetchJson(url.toString());
      const names = repos.map(
        (r) => `${r.full_name} (${r.private ? "private" : "public"})`
      );

      return { content: [{ type: "text", text: names.join("\n") }] };
    }
  );

  server.tool(
    "github_list_pull_requests",
    "Lista pull requests de un repo (por owner/repo)",
    {
      owner: z.string(),
      repo: z.string(),
      state: z.enum(["open", "closed", "all"]).optional(),
      per_page: z.number().int().min(1).max(100).optional(),
    },
    async ({ owner, repo, state = "open", per_page = 30 }) => {
      const url = new URL(`https://api.github.com/repos/${owner}/${repo}/pulls`);
      url.searchParams.set("state", state);
      url.searchParams.set("per_page", String(per_page));

      const prs = await ghFetchJson(url.toString());
      const lines = prs.map(
        (pr) => `#${pr.number} ${pr.title} — ${pr.user?.login} — ${pr.html_url}`
      );

      return {
        content: [{ type: "text", text: lines.join("\n") || "(no PRs)" }],
      };
    }
  );

  /**
   * ✅ NUEVO: obtiene el unified diff completo del PR (como `git diff`)
   * Esto es lo que necesitás para PRs complejas.
   */
  server.tool(
    "github_get_pull_request_diff",
    "Dado un link de PR, devuelve el unified diff completo (truncable).",
    {
      pr_url: z.string().url(),
      max_diff_chars: z.number().int().min(0).max(200000).optional(),
    },
    async ({ pr_url, max_diff_chars = 40000 }) => {
      const { owner, repo, number } = parsePrUrl(pr_url);

      // Endpoint PR pero pidiendo diff via Accept header.
      const diff = await ghFetchText(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`,
        "application/vnd.github.v3.diff"
      );

      const out =
        max_diff_chars === 0 ? diff : diff.slice(0, max_diff_chars);

      return {
        content: [
          {
            type: "text",
            text:
              `PR Diff (unified) for ${pr_url}\n` +
              (max_diff_chars > 0 && diff.length > max_diff_chars
                ? `(truncado a ${max_diff_chars} chars de ${diff.length})\n\n`
                : "\n\n") +
              out,
          },
        ],
      };
    }
  );

  server.tool(
    "github_summarize_pull_request",
    "Dado un link de GitHub PR, devuelve material para un resumen estructurado (título, objetivo, cambios, archivos, riesgos). Puede incluir patches y/o diff.",
    {
      pr_url: z.string().url(),
      include_patches: z.boolean().optional(),
      max_files: z.number().int().min(1).max(300).optional(), // permitimos más porque paginamos
      max_patch_chars: z.number().int().min(0).max(4000).optional(),

      // ✅ NUEVO: opcional incluir diff global
      include_diff: z.boolean().optional(),
      max_diff_chars: z.number().int().min(0).max(200000).optional(),
    },
    async ({
      pr_url,
      include_patches = true,
      max_files = 50,
      max_patch_chars = 2000,
      include_diff = false,
      max_diff_chars = 40000,
    }) => {
      const { owner, repo, number } = parsePrUrl(pr_url);

      // PR details
      const pr = await ghFetchJson(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`
      );

      // Files changed (paginated)
      const files = await listPrFilesPaginated({
        owner,
        repo,
        number,
        max_files,
      });

      const fileLines = files.map((f) => {
        const base = `- ${f.filename} (+${f.additions}/-${f.deletions}) [${f.status}]`;
        if (!include_patches) return base;

        const patch = (f.patch || "").slice(0, max_patch_chars);
        return patch
          ? `${base}\n  patch:\n${patch.replace(/\n/g, "\n  ")}`
          : base;
      });

      // Optional: diff completo
      let diffBlock = "";
      if (include_diff) {
        const diff = await ghFetchText(
          `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`,
          "application/vnd.github.v3.diff"
        );
        const out = max_diff_chars === 0 ? diff : diff.slice(0, max_diff_chars);
        diffBlock =
          `\n\nUnified diff (global):\n` +
          (max_diff_chars > 0 && diff.length > max_diff_chars
            ? `(truncado a ${max_diff_chars} chars de ${diff.length})\n`
            : "") +
          out;
      }

      const text = [
        `PR: ${pr.html_url}`,
        `Title: ${pr.title}`,
        `Author: ${pr.user?.login}`,
        `State: ${pr.state} | Draft: ${pr.draft ? "yes" : "no"} | Merged: ${
          pr.merged ? "yes" : "no"
        }`,
        `Base: ${pr.base?.ref} <- Head: ${pr.head?.ref}`,
        `Commits: ${pr.commits} | Files changed: ${pr.changed_files} | Additions: ${pr.additions} | Deletions: ${pr.deletions}`,
        ``,
        `Description (body):`,
        pr.body ? pr.body : "(empty)",
        ``,
        `Changed files (up to ${max_files}):`,
        fileLines.join("\n\n"),
      ].join("\n");

      return {
        content: [
          {
            type: "text",
            text:
              "Usá el siguiente material para generar un resumen. " +
              "Incluí: objetivo, cambios principales, archivos tocados, impacto, riesgos, checklist de revisión, y sugerencias de test.\n\n" +
              text +
              diffBlock,
          },
        ],
      };
    }
  );

  // Transport por request (stateless)
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  await server.connect(transport);
  return { server, transport };
}

app.all("/mcp", async (req, res) => {
  const { server, transport } = await getServer();

  try {
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("❌ Error en /mcp:", err);
    if (!res.headersSent) res.status(500).send("MCP error");
  }

  res.on("close", () => {
    transport.close();
    server.close();
  });
});

app.get("/", (_req, res) => res.send("OK - github-mcp"));

const port = process.env.PORT || 3333;
app.listen(port, () => {
  console.log(`✅ github-mcp en http://localhost:${port}  (endpoint MCP: /mcp)`);
});

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Control, FixtureCase, FixturePage } from "../../../fixtures/cases/index.js";
import type { Observation } from "../../../fixtures/oracles/index.js";

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] ?? character);
}

function renderControl(control: Control, interactive: boolean): string {
  const name = escapeHtml(control.name);
  const key = escapeHtml(control.key);
  const actionKey = interactive ? ` data-key="${key}"` : "";
  const field = control.kind === "button"
    ? `<button type="button"${actionKey}>${name}</button>`
    : `<label for="field-${key}">${name}</label><input id="field-${key}"${actionKey} type="text" autocomplete="off">`;
  return `<section class="control">${field}<p>${escapeHtml(control.help ?? "")}</p></section>`;
}

export function renderPage(page: FixturePage, interactive = false): string {
  const groups = new Set<string>();
  const controls = page.controls.map((control) => {
    if (!control.group) return renderControl(control, interactive);
    if (groups.has(control.group)) return "";
    groups.add(control.group);
    return `<fieldset><legend>${escapeHtml(control.group)}</legend>${page.controls.filter((item) => item.group === control.group).map((item) => renderControl(item, interactive)).join("")}</fieldset>`;
  }).join("");
  const script = interactive ? `<script>
document.querySelectorAll("[data-key]").forEach((element) => {
  element.addEventListener(element.tagName === "INPUT" ? "input" : "click", async () => {
    const response = await fetch(location.pathname + "/action", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: element.dataset.key, value: element.value })
    });
    if (!response.ok) throw new Error("Fixture action failed: " + response.status);
    const result = await response.json();
    document.querySelector('[data-testid="status"]').textContent = result.status;
    document.querySelector('[data-testid="business"]').textContent = JSON.stringify(result.state);
  });
});
</script>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(page.heading)}</title><style>
body{font-family:system-ui,sans-serif;max-width:56rem;margin:2rem auto;padding:1rem;color:#19263d;background:#f8fafc}h1{font-size:1.6rem}fieldset,.control{border:1px solid #c5cfdd;border-radius:.6rem;padding:1rem;margin:1rem 0}fieldset .control{border:0}button,input{font:inherit;padding:.7rem;border:1px solid #63758c;border-radius:.3rem}label{display:block;margin-bottom:.4rem}button{background:#123d75;color:white}p{color:#46566f}output{display:block;padding:.8rem;background:#e8eef6;overflow-wrap:anywhere}
</style></head><body><main><h1>${escapeHtml(page.heading)}</h1><p>${escapeHtml(page.introduction)}</p>${controls}<h2>Operation status</h2><output data-testid="status">Ready</output><details><summary>Business state</summary><output data-testid="business">${escapeHtml(JSON.stringify(page.initial))}</output></details></main>${script}</body></html>`;
}

export interface FixtureServer {
  url(phase: "before" | "after"): string;
  reset(phase: "before" | "after"): void;
  observation(phase: "before" | "after"): Observation;
  close(): Promise<void>;
}

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

export async function startFixture(fixture: FixtureCase): Promise<FixtureServer> {
  const observations: Record<"before" | "after", Observation> = {
    before: { lastAction: null, state: { ...fixture.before.initial } },
    after: { lastAction: null, state: { ...fixture.after.initial } },
  };
  const server = createServer(async (request, response) => {
    try {
      const match = /^\/(before|after)(\/action)?$/.exec(request.url ?? "");
      if (!match || (match[1] !== "before" && match[1] !== "after")) {
        response.writeHead(404).end("Not found");
        return;
      }
      const phase = match[1];
      const page = fixture[phase];
      if (!match[2] && request.method === "GET") {
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
          "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'",
        }).end(renderPage(page, true));
        return;
      }
      if (match[2] && request.method === "POST") {
        let body = "";
        for await (const chunk of request) {
          body += String(chunk);
          if (body.length > 8192) throw new Error("Fixture action body exceeds 8 KiB");
        }
        const data: unknown = JSON.parse(body);
        if (!data || typeof data !== "object" || !("key" in data) || typeof data.key !== "string") {
          response.writeHead(400).end("Invalid action");
          return;
        }
        const control = page.controls.find((item) => item.key === data.key);
        if (!control) {
          response.writeHead(404).end("Unknown control");
          return;
        }
        const effect = { ...control.effect };
        if (control.kind === "textbox") {
          if (!("value" in data) || typeof data.value !== "string") {
            response.writeHead(400).end("A textbox requires a string value");
            return;
          }
          for (const key of Object.keys(effect)) {
            if (typeof effect[key] === "string") effect[key] = data.value;
          }
        }
        const observation = observations[phase];
        Object.assign(observation.state, effect);
        observation.lastAction = control.key;
        response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" })
          .end(JSON.stringify({ state: observation.state, status: control.status }));
        return;
      }
      response.writeHead(405).end("Method not allowed");
    } catch (error) {
      response.writeHead(500, { "Content-Type": "text/plain" }).end(error instanceof Error ? error.message : String(error));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    url: (phase) => `http://127.0.0.1:${address.port}/${phase}`,
    reset: (phase) => { observations[phase] = { lastAction: null, state: { ...fixture[phase].initial } }; },
    observation: (phase) => structuredClone(observations[phase]),
    close: () => closeServer(server),
  };
}

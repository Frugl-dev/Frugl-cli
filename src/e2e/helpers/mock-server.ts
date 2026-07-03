import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { Temporal } from "temporal-polyfill";

type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  body: Buffer,
) => void | Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: Handler;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export class MockServer {
  private server: Server;
  private routes: Route[] = [];
  port = 0;

  constructor() {
    this.server = createServer(async (req, res) => {
      const url = (req.url ?? "/").split("?")[0]!;
      const method = req.method ?? "GET";
      const body = await readBody(req);
      let matched: { route: Route; match: RegExpMatchArray } | undefined;
      for (const route of this.routes) {
        if (route.method !== method) continue;
        const match = url.match(route.pattern);
        if (!match) continue;
        matched = { route, match };
        break;
      }
      if (!matched) {
        res.writeHead(404).end("not found");
        return;
      }
      const { route, match } = matched;
      const params: Record<string, string> = {};
      route.paramNames.forEach((name, i) => {
        params[name] = decodeURIComponent(match[i + 1] ?? "");
      });
      try {
        await route.handler(req, res, params, body);
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500).end(String(err));
        }
      }
    });
  }

  on(method: string, path: string, handler: Handler): this {
    const paramNames: string[] = [];
    const escaped = path.replace(/[.+*?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(
      "^" +
        escaped.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name: string) => {
          paramNames.push(name);
          return "([^/]+)";
        }) +
        "$",
    );
    this.routes.push({ method, pattern, paramNames, handler });
    return this;
  }

  json(res: ServerResponse, status: number, data: unknown): void {
    const body = JSON.stringify(data);
    res.writeHead(status, { "Content-Type": "application/json" }).end(body);
  }

  async start(): Promise<this> {
    await new Promise<void>((resolve) => {
      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server.address() as { port: number };
        this.port = addr.port;
        resolve();
      });
    });
    return this;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /**
   * Wires up the standard happy-path upload flow and returns the manifest ID
   * that will be returned in responses.
   */
  static wireHappyPath(server: MockServer): string {
    const manifestId = randomUUID();
    server
      .on("POST", "/api/uploads/manifest", (_req, res) => {
        server.json(res, 200, { upload_id: manifestId });
      })
      .on("POST", "/api/uploads/:id/presign", (_req, res, params) => {
        server.json(res, 200, {
          presigned_url: `${server.url}/fake-put/${encodeURIComponent(params["id"] ?? "")}/${randomUUID()}`,
          method: "PUT",
          headers: {},
          expires_at: Temporal.Now.instant()
            .add({ minutes: 1 })
            .toString({ smallestUnit: "millisecond" }),
        });
      })
      .on("PUT", "/fake-put/:id/:key", (_req, res) => {
        res.writeHead(200).end();
      })
      .on("POST", "/api/uploads/:id/complete", (_req, res) => {
        server.json(res, 200, {
          manifest_id: manifestId,
          dashboard_url: `${server.url}/dashboard/${manifestId}`,
        });
      });
    return manifestId;
  }
}

import { bootFieldCore } from "./field-boot.js";
import { FieldHttpServer } from "./field-server.js";

export interface StartFieldServeOptions {
  tenantId?: string;
  computerBaseDir?: string;
  port?: number;
  host?: string;
}

/**
 * Listen on the field surface. Does not issue a token.
 * A field user must present a token Architect already issued.
 * Product boot is DeepAgentsAdapter (Architect bind required). No DryStem default.
 */
export async function startFieldServe(opts: StartFieldServeOptions = {}): Promise<{
  server: FieldHttpServer;
  url: string;
  port: number;
  tenantId: string;
}> {
  const tenantId = opts.tenantId ?? "t1";
  const { core, pack } = await bootFieldCore(tenantId, { computerBaseDir: opts.computerBaseDir });
  const server = new FieldHttpServer({ core, pack, tenantId });
  const listened = await server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1");
  return { server, url: listened.url, port: listened.port, tenantId };
}

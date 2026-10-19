import { Vault, fault } from "./store.mjs";
import { auth, body, json, serve } from "./http.mjs";
import { Console } from "./console.mjs";
import { readFileSync } from "node:fs";
export function application({ vault, token, targets }) {
  const app = new Console(vault, targets);
  return async (req, res) => {
    const u = new URL(req.url, "http://local");
    if (u.pathname === "/healthz") return json(res, 200, { status: "ok" });
    if (req.method === "GET" && u.pathname === "/") {
      res.setHeader("content-type", "text/html");
      return res.end(
        readFileSync(new URL("../public/index.html", import.meta.url)),
      );
    }
    auth(req, token);
    if (req.method === "GET" && u.pathname === "/services")
      return json(res, 200, app.list());
    if (req.method === "POST" && u.pathname === "/services") {
      const i = await body(req);
      return json(res, 201, await app.import(i.manifest, i.target_id));
    }
    const service = u.pathname.match(/^\/services\/([^/]+)\/(releases|pause)$/);
    if (req.method === "POST" && service) {
      const i = await body(req);
      return json(
        res,
        200,
        service[2] === "pause"
          ? await app.pause(service[1])
          : await app.release(service[1], i.manifest),
      );
    }
    const m = u.pathname.match(
      /^\/releases\/([^/]+)\/(preflight|apply|rollback|observe|manifest)$/,
    );
    if (m) {
      if (m[2] === "manifest" && req.method === "GET") {
        res.setHeader("content-type", "application/yaml");
        return res.end(app.export(m[1]));
      }
      if (req.method === "POST") return json(res, 200, await app[m[2]](m[1]));
    }
    throw fault("not_found", 404);
  };
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  if (!process.env.OPERATOR_TOKEN) throw Error("OPERATOR_TOKEN required");
  serve(
    application({
      vault: new Vault(process.env.DATA_DIR || ".data", process.env.DATA_KEY),
      token: process.env.OPERATOR_TOKEN,
      targets: JSON.parse(process.env.TARGETS_JSON || "{}"),
    }),
    Number(process.env.PORT || 4404),
  );
}

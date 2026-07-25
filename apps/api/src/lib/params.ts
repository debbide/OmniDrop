import type { Request } from "express";

export function paramId(req: Request, name = "id"): string {
  const v = req.params[name];
  return Array.isArray(v) ? String(v[0]) : String(v);
}

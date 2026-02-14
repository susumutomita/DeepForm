import { Hono } from "hono";
import type { AppEnv } from "../../types.ts";
import { analysisRoutes } from "./analysis.ts";
import { campaignRoutes } from "./campaigns.ts";
import { crudRoutes } from "./crud.ts";
import { interviewRoutes } from "./interview.ts";

const sessionRoutes = new Hono<AppEnv>();

sessionRoutes.route("", crudRoutes);
sessionRoutes.route("", interviewRoutes);
sessionRoutes.route("", analysisRoutes);
sessionRoutes.route("", campaignRoutes);

export { sessionRoutes };

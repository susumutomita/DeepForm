import { Hono } from "hono";
import type { AppEnv } from "../../types.ts";
import { analysisRoutes } from "./analysis.ts";
import { campaignRoutes } from "./campaigns.ts";
import { crudRoutes } from "./crud.ts";
import { githubSaveRoutes } from "./github-save.ts";
import { interviewRoutes } from "./interview.ts";
import { pipelineRoutes } from "./pipeline.ts";

const sessionRoutes = new Hono<AppEnv>();

sessionRoutes.route("", crudRoutes);
sessionRoutes.route("", interviewRoutes);
sessionRoutes.route("", analysisRoutes);
sessionRoutes.route("", pipelineRoutes);
sessionRoutes.route("", campaignRoutes);
sessionRoutes.route("", githubSaveRoutes);

export { sessionRoutes };

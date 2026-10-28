#!/usr/bin/env node
/**
 * Pi cost dashboard server.
 *
 * Serves the read API over the SQLite database, the ingest endpoint for running Pi
 * sessions, and the built React app in production.
 *
 * The periodic rescan timer starts in `main()`, not at module load, so importing this
 * module for tests does not start background work.
 */

import "dotenv/config";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";

import { migrateUp, openDatabase } from "./db.js";
import { ingestSession } from "./ingest.js";
import {
  getDailyCost,
  getFilters,
  getHealth,
  getModelCost,
  getSessionById,
  getSessions,
  getSummary,
} from "./queries.js";
import { resolveSessionsDir, scanSessions } from "./scanner/scan.js";

/** Seconds between background rescans of the sessions directory. @type {number} */
const RESCAN_INTERVAL_SECONDS = 60;

/** Default listen port. @type {number} */
const DEFAULT_PORT = 4870;

/** Default listen address; the dashboard is not internet-facing. @type {string} */
const DEFAULT_HOST = "127.0.0.1";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Parse a query parameter as an integer, rejecting anything that is not one.
 * @param {unknown} rawValue
 * @returns {number | null} null when absent and valid, undefined when invalid
 */
const parseInteger = (rawValue) => {
  if (rawValue === undefined || rawValue === "") return null;
  const parsed = Number(rawValue);
  return Number.isInteger(parsed) ? parsed : undefined;
};

/**
 * Validate a YYYY-MM-DD date string.
 * @param {unknown} rawValue
 * @returns {boolean}
 */
const isIsoDate = (rawValue) => typeof rawValue === "string" && /^\d{4}-\d{2}-\d{2}$/.test(rawValue);

/**
 * Express middleware that rejects a malformed integer parameter.
 * @param {(value: number) => object} handler Query consumer
 * @param {string[]} names Parameter names to validate
 * @returns {import("express").RequestHandler}
 */
const requireIntegers = (handler, names) => (req, res, next) => {
  const parsed = {};
  for (const name of names) {
    const value = parseInteger(req.query[name]);
    if (value === undefined) {
      res.status(400).json({ error: "invalid_parameter", parameter: name, received: req.query[name] });
      return;
    }
    if (value !== null) parsed[name] = value;
  }
  req.parsedParams = parsed;
  return handler(req, res, next);
};

/**
 * Build the Express app around an open database.
 *
 * Exported separately from `listen` so tests can drive routes without binding a port.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ sessionsDir: string, fileCount?: () => number, rescan?: () => object }} dependencies
 * @returns {import("express").Express}
 */
export const createApp = (db, dependencies) => {
  const app = express();
  app.disable("x-powered-by");
  app.use(cors());
  app.use(express.json({ limit: "5mb" }));

  // Shared secret, required on writes when PI_COST_TOKEN is set. Reads stay open so the
  // dashboard can be viewed in a browser without a token.
  const requireToken = (req, res, next) => {
    const expected = process.env.PI_COST_TOKEN;
    if (!expected) return next();
    if (req.get("x-pi-cost-token") === expected) return next();
    res.status(401).json({ error: "unauthorized" });
    return undefined;
  };

  app.get("/api/health", (_req, res) => {
    res.json(getHealth(db, dependencies.sessionsDir, dependencies.fileCount?.()));
  });

  app.get(
    "/api/summary",
    requireIntegers((req, res) => res.json(getSummary(db, req.parsedParams.days ?? 7)), ["days"]),
  );

  app.get("/api/daily", (req, res) => {
    const { from, to, cwd, provider } = req.query;
    if (from !== undefined && !isIsoDate(from)) {
      res.status(400).json({ error: "invalid_parameter", parameter: "from", received: from });
      return;
    }
    if (to !== undefined && !isIsoDate(to)) {
      res.status(400).json({ error: "invalid_parameter", parameter: "to", received: to });
      return;
    }
    const offset = parseInteger(req.query.tzOffsetMinutes);
    if (offset === undefined) {
      res.status(400).json({
        error: "invalid_parameter",
        parameter: "tzOffsetMinutes",
        received: req.query.tzOffsetMinutes,
      });
      return;
    }
    res.json(
      getDailyCost(db, {
        from: isIsoDate(from) ? from : undefined,
        to: isIsoDate(to) ? to : undefined,
        cwd: typeof cwd === "string" && cwd.length > 0 ? cwd : undefined,
        provider: typeof provider === "string" && provider.length > 0 ? provider : undefined,
        tzOffsetMinutes: offset ?? 0,
      }),
    );
  });

  app.get(
    "/api/sessions",
    requireIntegers(
      (req, res) =>
        res.json(
          getSessions(db, {
            limit: req.parsedParams.limit,
            offset: req.parsedParams.offset,
            cwd: typeof req.query.cwd === "string" ? req.query.cwd : undefined,
            provider: typeof req.query.provider === "string" ? req.query.provider : undefined,
            sort: req.query.sort === "cost" ? "cost" : "activity",
          }),
        ),
      ["limit", "offset"],
    ),
  );

  app.get("/api/sessions/:id", (req, res) => {
    const session = getSessionById(db, req.params.id);
    if (!session) {
      res.status(404).json({ error: "not_found", sessionId: req.params.id });
      return;
    }
    res.json(session);
  });

  app.get("/api/models", (_req, res) => res.json(getModelCost(db)));
  app.get("/api/filters", (_req, res) => res.json(getFilters(db)));

  app.post("/api/rescan", requireToken, (_req, res) => {
    res.json(dependencies.rescan());
  });

  // Session snapshots from the Pi extension. Validation is strict and rejects unknown
  // keys, so a future extension cannot start sending transcript content by accident.
  app.post("/api/ingest", requireToken, (req, res) => {
    const { status, body } = ingestSession(db, req.body);
    res.status(status).json(body);
  });

  const webDist = join(here, "..", "web", "dist");
  if (existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(join(webDist, "index.html")));
  }

  app.use((req, res) => res.status(404).json({ error: "not_found", path: req.path }));

  app.use((error, _req, res, _next) => {
    const status = Number.isInteger(error?.status) ? error.status : 500;
    res.status(status).json({ error: "server_error", detail: error?.message ?? String(error) });
  });

  return app;
};

/**
 * Open the database, migrate, start the rescan timer, and listen.
 * @param {{ port?: number, host?: string, quiet?: boolean }} [options]
 * @returns {import("http").Server}
 */
export const listen = (options = {}) => {
  const db = openDatabase();
  migrateUp(db);

  const sessionsDir = resolveSessionsDir(process.env.PI_COST_SESSIONS_DIR);
  const runScan = (force = false) => scanSessions(sessionsDir, db, { force });

  const app = createApp(db, { sessionsDir, rescan: () => runScan(true) });

  const port = options.port ?? Number(process.env.PI_COST_PORT ?? DEFAULT_PORT);
  const host = options.host ?? process.env.PI_COST_HOST ?? DEFAULT_HOST;

  const timer = setInterval(() => {
    try {
      runScan(false);
    } catch (error) {
      console.error(`rescan failed: ${error?.message ?? error}`);
    }
  }, RESCAN_INTERVAL_SECONDS * 1000);
  timer.unref();

  const server = app.listen(port, host, () => {
    if (!options.quiet) console.log(`pi-cost dashboard on http://${host}:${port}`);
  });

  const stop = () => {
    clearInterval(timer);
    server.close();
    db.close();
  };

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  return server;
};

// Run only when invoked directly, so importing createApp does not start the server.
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) listen();

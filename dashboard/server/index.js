#!/usr/bin/env node
/**
 * Pi cost dashboard server.
 *
 * Serves the read API over the SQLite database, the ingest endpoint for running Pi
 * sessions, and the built React app in production.
 *
 * The periodic rescan timer starts in `main()`, not at module load, so importing this
 * module for tests does not start background work.
 *
 * Configuration comes from the process environment. This module deliberately does not load
 * a `.env` file: tests import `createApp`, and a file-based side effect would make the
 * suite depend on whatever config the developer running it happens to have. `npm start`
 * and `npm run dev:server` pass Node's `--env-file-if-exists=.env`, and containers get
 * their configuration from the environment.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";

import { migrateUp, openDatabase } from "./db.js";
import { ingestSession } from "./ingest.js";
import {
  getDailyCost,
  getFlows,
  getHourlyCost,
  getFilters,
  getHealth,
  getModelCost,
  getSessionById,
  getSessions,
  getSummary,
} from "./queries.js";
import { isSupportedTimeZone, offsetLabel, utcOffsetMinutes } from "./timezone.js";
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
 * Request state the parameter middleware fills in before a handler runs.
 * @typedef {import("express").Request & {
 *   parsedParams?: Record<string, number>,
 *   flags?: Record<string, boolean>,
 * }} ParsedRequest
 */

/**
 * Parse a 0/1 query flag, and answer 400 when the value is not a flag.
 *
 * Parsing and rejecting used to be two functions, each restating the four accepted spellings,
 * and every route taking a flag called both of them by hand. One middleware does both: it
 * validates, stores the boolean on `req.flags[name]`, and ends the request with a 400 naming
 * the parameter when the value is none of them, so the handler behind it can trust the flag.
 *
 * Absent means "the route's default", which keeps each route's default written in the route.
 *
 * @param {string} name Query parameter name
 * @param {boolean} fallback Value to use when the parameter is absent
 * @returns {import("express").RequestHandler}
 */
const flagParam = (name, fallback) => (req, res, next) => {
  const received = req.query[name];
  const value =
    received === undefined || received === ""
      ? fallback
      : received === "1" || received === "true"
        ? true
        : received === "0" || received === "false"
          ? false
          : undefined;

  if (value === undefined) {
    res.status(400).json({ error: "invalid_parameter", parameter: name, received });
    return;
  }

  req.flags = { ...req.flags, [name]: value };
  next();
};

/**
 * Validate a YYYY-MM-DD date string.
 * @param {unknown} rawValue
 * @returns {boolean}
 */
const isIsoDate = (rawValue) => typeof rawValue === "string" && /^\d{4}-\d{2}-\d{2}$/.test(rawValue);

/**
 * Express middleware that rejects a malformed integer parameter.
 *
 * Valid values land on `req.parsedParams`, so handlers read numbers and never re-parse a query
 * string. It runs ahead of the handler it guards, flag middleware included, so a bad number is
 * reported before anything downstream is evaluated.
 *
 * @param {string[]} names Parameter names to validate
 * @returns {import("express").RequestHandler}
 */
const requireIntegers = (names) => (req, res, next) => {
  const parsed = {};
  for (const name of names) {
    const value = parseInteger(req.query[name]);
    if (value === undefined) {
      res.status(400).json({ error: "invalid_parameter", parameter: name, received: req.query[name] });
      return;
    }
    if (value !== null) parsed[name] = value;
  }
  req.parsedParams = { ...req.parsedParams, ...parsed };
  next();
};

/**
 * Build the Express app around an open database.
 *
 * Exported separately from `listen` so tests can drive routes without binding a port.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{
 *   sessionsDir: string,
 *   rescan: () => object,
 *   fileCount?: () => number,
 *   timeZone?: string | null,
 * }} dependencies `rescan` backs POST /api/rescan; `timeZone` is the zone every bucket is
 *   drawn in, null for UTC
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

  // What the server buckets by, so the page can label its own numbers. There is no
  // per-viewer control: the whole page is drawn in this zone, and it says so.
  app.get("/api/config", (_req, res) => {
    const timeZone = dependencies.timeZone ?? null;
    res.json({
      timezone: timeZone ?? "UTC",
      timezoneSource: timeZone ? "env" : "default",
      offsetLabel: offsetLabel(timeZone),
      utcOffsetMinutes: timeZone ? utcOffsetMinutes(timeZone) : 0,
    });
  });

  app.get(
    "/api/summary",
    requireIntegers(["days"]),
    flagParam("subagents", true),
    (req, res) => {
      res.json(
        getSummary(db, req.parsedParams.days ?? 7, {
          includeSubagents: req.flags.subagents,
          timeZone: dependencies.timeZone ?? null,
        }),
      );
    },
  );

  app.get(
    "/api/hourly",
    flagParam("subagents", true),
    (req, res) => {
      const { day, cwd, provider } = req.query;
      // The drill-down is always one day, and the day comes from a chart bar, so a
      // non-date here means a broken caller rather than a missing filter.
      if (!isIsoDate(day)) {
        res.status(400).json({ error: "invalid_parameter", parameter: "day", received: day });
        return;
      }
      res.json(
        getHourlyCost(db, {
          day,
          cwd: typeof cwd === "string" && cwd.length > 0 ? cwd : undefined,
          provider: typeof provider === "string" && provider.length > 0 ? provider : undefined,
          includeSubagents: req.flags.subagents,
          timeZone: dependencies.timeZone ?? null,
        }),
      );
    },
  );

  app.get(
    "/api/daily",
    flagParam("subagents", true),
    (req, res) => {
      const { from, to, cwd, provider } = req.query;
      if (from !== undefined && !isIsoDate(from)) {
        res.status(400).json({ error: "invalid_parameter", parameter: "from", received: from });
        return;
      }
      if (to !== undefined && !isIsoDate(to)) {
        res.status(400).json({ error: "invalid_parameter", parameter: "to", received: to });
        return;
      }
      res.json(
        getDailyCost(db, {
          from: isIsoDate(from) ? from : undefined,
          to: isIsoDate(to) ? to : undefined,
          cwd: typeof cwd === "string" && cwd.length > 0 ? cwd : undefined,
          provider: typeof provider === "string" && provider.length > 0 ? provider : undefined,
          includeSubagents: req.flags.subagents,
          timeZone: dependencies.timeZone ?? null,
        }),
      );
    },
  );

  app.get(
    "/api/sessions",
    requireIntegers(["limit", "offset"]),
    flagParam("subagents", true),
    (req, res) => {
      res.json(
        getSessions(db, {
          limit: req.parsedParams.limit,
          offset: req.parsedParams.offset,
          cwd: typeof req.query.cwd === "string" ? req.query.cwd : undefined,
          provider: typeof req.query.provider === "string" ? req.query.provider : undefined,
          sort: req.query.sort === "cost" ? "cost" : "activity",
          includeSubagents: req.flags.subagents,
        }),
      );
    },
  );

  app.get("/api/sessions/:id", (req, res) => {
    const session = getSessionById(db, req.params.id);
    if (!session) {
      res.status(404).json({ error: "not_found", sessionId: req.params.id });
      return;
    }
    res.json(session);
  });

  app.get("/api/models", flagParam("subagents", true), (req, res) => {
    res.json(getModelCost(db, { includeSubagents: req.flags.subagents }));
  });

  // Which model spent what in which project, as a bipartite graph for the flow diagram.
  // `metric` picks the unit the bands are sized in: money by default, tokens for the view
  // where the busiest model on the machine is the one priced at zero.
  app.get(
    "/api/flows",
    requireIntegers(["limit"]),
    flagParam("subagents", true),
    (req, res) => {
      const { from, to, cwd, provider, metric } = req.query;
      if (metric !== undefined && metric !== "cost" && metric !== "tokens") {
        res.status(400).json({ error: "invalid_parameter", parameter: "metric", received: metric });
        return;
      }
      if (from !== undefined && !isIsoDate(from)) {
        res.status(400).json({ error: "invalid_parameter", parameter: "from", received: from });
        return;
      }
      if (to !== undefined && !isIsoDate(to)) {
        res.status(400).json({ error: "invalid_parameter", parameter: "to", received: to });
        return;
      }
      res.json(
        getFlows(db, {
          metric: metric === "tokens" ? "tokens" : "cost",
          nodeLimit: req.parsedParams.limit,
          from: isIsoDate(from) ? from : undefined,
          to: isIsoDate(to) ? to : undefined,
          cwd: typeof cwd === "string" && cwd.length > 0 ? cwd : undefined,
          provider: typeof provider === "string" && provider.length > 0 ? provider : undefined,
          includeSubagents: req.flags.subagents,
          timeZone: dependencies.timeZone ?? null,
        }),
      );
    },
  );
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

  // PI_COST_TZ is an IANA zone name (America/Denver, Europe/Berlin, Asia/Kolkata).
  // An unrecognizable name falls back to UTC and says so, because silently charting in the
  // wrong zone is worse than a startup line telling you the name was bad.
  const requestedZone = process.env.PI_COST_TZ;
  const timeZone = isSupportedTimeZone(requestedZone) ? requestedZone : null;
  if (requestedZone && requestedZone !== "" && !timeZone) {
    console.warn(`PI_COST_TZ "${requestedZone}" is not a timezone this Node can resolve; charting in UTC`);
  }

  const app = createApp(db, { sessionsDir, rescan: () => runScan(true), timeZone });

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

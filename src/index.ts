#!/usr/bin/env node
import { buildApp } from "./app.js";
import { PRODUCT } from "./product.js";

const port = Number(process.env.AV_DEV_PORT ?? 8787);
const host = process.env.AV_DEV_HOST ?? "127.0.0.1";

const { app } = await buildApp();
await app.listen({ port, host });
app.log.info(`${PRODUCT.displayName} listening on ${host}:${port}`);

import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
if (!existsSync(dist)) mkdirSync(dist, { recursive: true });
copyFileSync(join(root, "asciilogo.md"), join(dist, "asciilogo.md"));

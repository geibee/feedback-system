import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { build } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const unpacked = join(root, "dist", "unpacked");
rmSync(join(root, "dist"), { recursive: true, force: true });
mkdirSync(unpacked, { recursive: true });

for (const [name, entry] of [
  ["background", "src/background/index.ts"],
  ["content", "src/content/index.tsx"],
  ["options", "src/options/index.tsx"]
]) {
  await build({
    configFile: false,
    root,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: {
      outDir: unpacked,
      emptyOutDir: false,
      sourcemap: false,
      minify: "esbuild",
      lib: { entry: resolve(root, entry), name: `FeedbackRedmine${name}`, formats: ["iife"], fileName: () => `${name}.js` },
      rollupOptions: { output: { inlineDynamicImports: true } }
    }
  });
}

await build({
  configFile: false,
  root,
  publicDir: false,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    outDir: join(root, "dist"),
    emptyOutDir: false,
    sourcemap: false,
    minify: "esbuild",
    lib: {
      entry: resolve(root, "src/conformance.ts"),
      formats: ["es"],
      fileName: () => "conformance.js"
    },
    rollupOptions: { output: { inlineDynamicImports: true } }
  }
});

cpSync(join(root, "manifest.json"), join(unpacked, "manifest.json"));
cpSync(join(root, "options.html"), join(unpacked, "options.html"));
cpSync(join(root, "public"), unpacked, { recursive: true });
const files = collectFiles(unpacked).sort((left, right) => left.localeCompare(right, "en"));
writeFileSync(join(root, "dist", "feedback-redmine-extension.zip"), createZip(files.map((path) => ({
  name: relative(unpacked, path).replaceAll("\\", "/"),
  data: readFileSync(path)
}))));

function collectFiles(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? collectFiles(path) : [path];
  });
}

function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const compressed = deflateRawSync(entry.data, { level: 9 });
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const fs = require("node:fs/promises");
const path = require("node:path");

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        return;
      }

      if (entry.isFile() && entry.name.endsWith(".js")) {
        const cjsPath = fullPath.slice(0, -3) + ".cjs";
        let source = await fs.readFile(fullPath, "utf8");
        source = source.replace(/require\("(\.\/[^"]+|..\/[^"]+)\.js"\)/g, 'require("$1.cjs")');
        await fs.writeFile(cjsPath, source);
        await fs.unlink(fullPath);
      }
    })
  );
}

walk(path.resolve("dist/cjs")).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

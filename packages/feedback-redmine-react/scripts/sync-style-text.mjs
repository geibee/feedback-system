import { readFile, writeFile } from "node:fs/promises";

const sourceUrl = new URL("../src/styles.css", import.meta.url);
const generatedUrl = new URL("../src/style-text.generated.ts", import.meta.url);
const css = `${(await readFile(sourceUrl, "utf8")).trim()}\n`;
const output = `/** styles.cssから生成。直接編集しない。 */\nexport const redmineFeedbackStyles = ${JSON.stringify(css)};\n`;

if (process.argv.includes("--check")) {
  const current = await readFile(generatedUrl, "utf8").catch(() => "");
  if (current !== output) {
    console.error("style-text.generated.tsがstyles.cssと一致しません。npm run styles:syncを実行してください。");
    process.exit(1);
  }
} else {
  await writeFile(generatedUrl, output);
}

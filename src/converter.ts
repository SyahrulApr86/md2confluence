/**
 * Markdown to Confluence converter
 * - Converts Markdown to Confluence storage format
 * - Renders Mermaid diagrams to PNG via @mermaid-js/mermaid-cli (local)
 * - Renders PlantUML diagrams to PNG via plantuml.jar (local)
 */

import { marked } from "marked";
import { createHash } from "crypto";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { writeFileSync, readFileSync, unlinkSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const execFileAsync = promisify(execFile);

interface Attachment {
  filename: string;
  data: Buffer;
}

interface ConversionResult {
  html: string;
  attachments: Attachment[];
}

/**
 * Render Mermaid diagram to PNG using local mmdc CLI
 */
async function renderMermaidToPng(code: string): Promise<Buffer> {
  const hash = createHash("md5").update(code).digest("hex").slice(0, 8);
  const inputFile = join(tmpdir(), `mermaid-${hash}.mmd`);
  const outputFile = join(tmpdir(), `mermaid-${hash}.png`);

  try {
    writeFileSync(inputFile, code, "utf8");

    // Find mmdc: prefer local node_modules, fall back to global
    const pkgRoot = new URL("../", import.meta.url).pathname;
    const mmdcPaths = [
      join(pkgRoot, "node_modules/.bin/mmdc"),
      join(process.cwd(), "node_modules/.bin/mmdc"),
      "mmdc",
    ];
    let mmdc = "mmdc";
    for (const p of mmdcPaths) {
      if (existsSync(p)) { mmdc = p; break; }
    }

    // Puppeteer config: disable sandbox for Linux environments
    const puppeteerConfig = join(pkgRoot, "puppeteer-config.json");
    const extraArgs = existsSync(puppeteerConfig)
      ? ["--puppeteerConfigFile", puppeteerConfig]
      : [];

    await execFileAsync(mmdc, [
      "-i", inputFile,
      "-o", outputFile,
      "-b", "transparent",
      "--quiet",
      ...extraArgs,
    ], { timeout: 30000 });

    const data = readFileSync(outputFile);
    return data;
  } finally {
    if (existsSync(inputFile)) unlinkSync(inputFile);
    if (existsSync(outputFile)) unlinkSync(outputFile);
  }
}

/**
 * Render PlantUML diagram to PNG using local plantuml.jar
 */
async function renderPlantUMLToPng(code: string): Promise<Buffer> {
  // Ensure @startuml/@enduml wrapper
  const uml = code.trim().startsWith("@startuml")
    ? code
    : `@startuml\n${code}\n@enduml`;

  // Find plantuml.jar: check env, package root, and common system locations.
  const pkgRoot = new URL("../", import.meta.url).pathname;
  const jarPaths = [
    process.env.PLANTUML_JAR,
    join(pkgRoot, "plantuml.jar"),
    "/home/rules/.local/bin/plantuml.jar",
    "/usr/share/plantuml/plantuml.jar",
    "/usr/local/lib/plantuml.jar",
  ].filter((path): path is string => Boolean(path));
  const jar = jarPaths.find(existsSync);
  const command = jar ? "java" : "plantuml";
  const args = jar ? ["-jar", jar, "-pipe", "-tpng"] : ["-pipe", "-tpng"];

  return new Promise<Buffer>((resolve, reject) => {
    const proc = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error("PlantUML render timed out"));
    }, 30000);

    proc.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    proc.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      const data = Buffer.concat(stdout);
      if (code === 0 && data.length > 0) {
        resolve(data);
        return;
      }
      const message = Buffer.concat(stderr).toString("utf8").trim();
      reject(new Error(message || `PlantUML exited with code ${code}`));
    });

    proc.stdin.end(uml);
  });
}

/**
 * Generate filename from content hash
 */
function generateFilename(prefix: string, content: string): string {
  const hash = createHash("md5").update(content).digest("hex").slice(0, 12);
  return `${prefix}-${hash}.png`;
}

/**
 * Convert Markdown to Confluence storage format
 */
export async function convertMarkdownToConfluence(
  markdown: string
): Promise<ConversionResult> {
  const attachments: Attachment[] = [];
  const diagramBlocks: Map<string, string> = new Map();
  let processedMarkdown = markdown;

  // Extract and process Mermaid blocks
  const mermaidRegex = /```mermaid\n([\s\S]*?)```/g;
  let match;
  while ((match = mermaidRegex.exec(markdown)) !== null) {
    const code = match[1].trim();
    const filename = generateFilename("mermaid", code);
    try {
      const pngData = await renderMermaidToPng(code);
      attachments.push({ filename, data: pngData });
      diagramBlocks.set(match[0], `![${filename}](${filename})`);
    } catch (error) {
      console.error(`Failed to render Mermaid diagram: ${error}`);
    }
  }

  // Extract and process PlantUML blocks
  const plantumlRegex = /```plantuml\n([\s\S]*?)```/g;
  while ((match = plantumlRegex.exec(markdown)) !== null) {
    const code = match[1].trim();
    const filename = generateFilename("plantuml", code);
    try {
      const pngData = await renderPlantUMLToPng(code);
      attachments.push({ filename, data: pngData });
      diagramBlocks.set(match[0], `![${filename}](${filename})`);
    } catch (error) {
      console.error(`Failed to render PlantUML diagram: ${error}`);
    }
  }

  // Replace diagram blocks with image placeholders
  for (const [original, replacement] of diagramBlocks) {
    processedMarkdown = processedMarkdown.replace(original, replacement);
  }

  // Configure marked for Confluence-compatible output
  marked.setOptions({
    gfm: true,
    breaks: false,
  });

  // Custom renderer for Confluence
  const renderer = new marked.Renderer();

  // Code blocks -> Confluence code macro
  renderer.code = (code: string, language?: string) => {
    const lang = language || "text";
    return `<ac:structured-macro ac:name="code">
      <ac:parameter ac:name="language">${lang}</ac:parameter>
      <ac:parameter ac:name="collapse">false</ac:parameter>
      <ac:plain-text-body><![CDATA[${code}]]></ac:plain-text-body>
    </ac:structured-macro>`;
  };

  // Images -> Confluence attachment or external image
  renderer.image = (href: string, title: string | null, text: string) => {
    // Check if it's a diagram attachment (Mermaid or PlantUML)
    if (href.endsWith(".png") && (href.startsWith("mermaid-") || href.startsWith("plantuml-"))) {
      return `<ac:image><ri:attachment ri:filename="${href}"/></ac:image>`;
    }

    // External image
    return `<ac:image><ri:url ri:value="${href}"/></ac:image>`;
  };

  // Links
  renderer.link = (href: string, title: string | null, text: string) => {
    return `<a href="${href}">${text}</a>`;
  };

  marked.use({ renderer });

  // Convert Markdown to HTML
  let html = marked.parse(processedMarkdown) as string;

  // Clean up whitespace in macros
  html = html.replace(/>\s+</g, "><");

  return { html, attachments };
}

/**
 * Remove YAML front matter from Markdown
 */
export function removeFrontMatter(markdown: string): string {
  return markdown.replace(/^---\n[\s\S]*?\n---\n/, "");
}

/**
 * Extract title from front matter or first heading
 */
export function extractTitle(markdown: string, fallback: string = "Untitled"): string {
  // Try front matter
  const frontMatterMatch = markdown.match(/^---\n[\s\S]*?title:\s*["']?([^"'\n]+)["']?/);
  if (frontMatterMatch) {
    return frontMatterMatch[1].trim();
  }

  // Try first H1
  const h1Match = markdown.match(/^#\s+(.+)$/m);
  if (h1Match) {
    return h1Match[1].trim();
  }

  return fallback;
}

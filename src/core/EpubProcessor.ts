/* eslint-disable @typescript-eslint/no-empty-function */
/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { EpubImporterSettings } from "../settings/settings";
import EpubParser, { Chapter } from "./parser";
import { App, Notice, parseYaml } from "obsidian";
import jetpack from "fs-jetpack";
import beautify from "js-beautify";
import { create } from "./TurndownService";
import * as path from "path";
import { normalize } from "../utils/utils";
import { templateWithVariables, tFrontmatter } from "../utils/obsidianUtils";
import { Section } from "./parser/types";

export default class EpubProcessor {
  private parser?: EpubParser;
  private properties: Record<string, unknown> = {};
  private bookNote: string;
  private assetsPath: string;

  constructor(
    private readonly app: App,
    private readonly settings: EpubImporterSettings,
    private readonly vaultPath: string
  ) {}

  async importEpub(epubPath: string) {
    this.bookNote = "";
    this.assetsPath = "";
    const epubName = normalize(path.basename(epubPath, path.extname(epubPath)));
    const folderPath = await this.initImport(epubPath, epubName);
    if (!folderPath) return;

    this.copyImages(folderPath);
    await this.processNotes(epubName, folderPath);
    jetpack.remove(this.parser!.tmpPath);
    this.showSuccessNotice(epubName);
  }

  private async initImport(epubPath: string, epubName: string): Promise<string | null> {
    const folderPath = this.resolveFolderPath(epubName);
    if (!folderPath) return null;

    await this.app.vault.createFolder(folderPath);
    this.parser = new EpubParser(epubPath, this.settings.moreLog);
    await this.parser.init();
    this.properties = this.parseProperties();
    if (this.settings.moreLog) console.log("toc:", this.parser.toc);
    return folderPath;
  }

  private async processNotes(epubName: string, folderPath: string) {
    if (this.settings.granularity === 0) {
      await this.createFile(`${folderPath}/${epubName}.md`, this.generateSingleNoteContent());
      return;
    }

    this.mergeChapters(this.settings.granularity);
    const chapters = this.parser!.chapters.filter(c => c.level <= this.settings.granularity);
    await this.processChapters(epubName, folderPath, chapters);
  }

  private async processChapters(epubName: string, folderPath: string, chapters: Chapter[]) {
    for (const [i, chapter] of chapters.entries()) {
      const notePath = await this.createChapterNote(chapter, folderPath, i, chapters);
      this.bookNote += `${"\t".repeat(chapter.level)}- [[${notePath}|${chapter.originalName}]]\n`;
    }
    await this.createFile(
      `${folderPath}/${templateWithVariables(this.settings.mocName, { bookName: epubName })}.md`,
      this.bookNote
    );
  }

  private async createChapterNote(chapter: Chapter, folderPath: string, index: number, chapters: Chapter[]) {
    const notePath = path.posix.join(folderPath, ...this.getChapterPaths(chapter));
    await this.ensureFolder(path.dirname(notePath));

    let content = this.settings.noteTemplate
        ? templateWithVariables(this.settings.noteTemplate, this.getChapterMetadata(chapter, index, chapters))
        : this.generateContent([chapter]);

    content = this.processObsidianLinks(content, chapters);

    let finalPath = `${notePath}.md`;
    let counter = 1;
    // 防止重名，自动加 (1)(2)…
    while (await this.app.vault.adapter.exists(finalPath)) {
      finalPath = `${notePath} (${counter}).md`;
      counter++;
    }
    await this.app.vault.create(finalPath, content);
    return finalPath;
}

private processObsidianLinks(content: string, chapters: Chapter[]): string {
  const linkPattern = /\[\[(.*?)\]\]/g;
  
  return content.replace(linkPattern, (match, linkText) => {
      const [linkPart, displayText] = linkText.split("|");
      const [baseLink, href] = linkPart.split("#");
      
      if ((!baseLink.includes(".html") && !baseLink.includes(".xhtml"))|| !href) {
          return match;
      }

      const targetChapter = this.findChapterByHref(chapters, href);
      
      if (targetChapter) {
          const display = displayText || targetChapter.originalName;
          return `[[${targetChapter.name}|${display}]]`;
      }
      
      return match;
  });
}

private findChapterByHref(chapters: Chapter[], href: string): Chapter | null {
  for (const chapter of chapters) {
      for (const section of chapter.sections) {
          if (section.urlHref === href && (section.urlPath.endsWith(".html") || section.urlPath.endsWith(".xhtml"))) {
              return chapter;
          }
      }
      
      for (const section of chapter.sections) {
          if (this.hasHtmlElementWithId(section.html, href)) {
              return chapter;
          }
      }
      
      if (chapter.subItems.length > 0) {
          const found = this.findChapterByHref(chapter.subItems, href);
          if (found) return found;
      }
  }
  return null;
}

private hasHtmlElementWithId(html: string, id: string): boolean {
  const idPattern = new RegExp(`id=["']${id}["']`, "i");
  return idPattern.test(html);
}

  private async createFile(filePath: string, content: string) {
    await this.app.vault.create(filePath, `${tFrontmatter(this.properties)}\n${content}`).catch(error => 
      console.warn(`Failed to create ${filePath}: ${error}`));
  }

  private generateContent(chapters: Chapter[]): string {
    return chapters
      .flatMap(c => c.sections.map(s => this.htmlToMD(s.html)))
      .join("\n\n");
  }

  private generateSingleNoteContent(): string {
    const anchorMap = new Map<string, string>();
    const chapterAnchors = new Map<Chapter, string>();
    this.parser!.toc.forEach((chapter, index) =>
      this.collectSingleNoteAnchors(chapter, anchorMap, chapterAnchors, `${index + 1}`)
    );
    const renderedChapters = this.parser!.toc
      .map((chapter) => this.renderSingleNoteChapter(chapter, anchorMap, chapterAnchors))
      .filter(Boolean);

    return renderedChapters.join("\n\n");
  }

  private renderSingleNoteChapter(
    chapter: Chapter,
    anchorMap: Map<string, string>,
    chapterAnchors: Map<Chapter, string>
  ): string {
    const headingText = chapterAnchors.get(chapter) ?? chapter.originalName;
    const headingLevel = Math.min(chapter.level + 1, 6);
    const heading = `${"#".repeat(headingLevel)} ${headingText}`;
    const body = this.renderSingleNoteBody(chapter, anchorMap);
    const children = chapter.subItems
      .map((child) => this.renderSingleNoteChapter(child, anchorMap, chapterAnchors))
      .filter(Boolean);

    return [heading, body, ...children].filter(part => part.trim().length > 0).join("\n\n");
  }

  private collectSingleNoteAnchors(
    chapter: Chapter,
    anchorMap: Map<string, string>,
    chapterAnchors: Map<Chapter, string>,
    orderKey: string,
    parentHeadingPath = ""
  ) {
    const headingText = this.createSingleNoteHeadingText(chapter, orderKey);
    const headingPath = parentHeadingPath ? `${parentHeadingPath}#${headingText}` : headingText;
    chapterAnchors.set(chapter, headingText);
    this.mapChapterAnchors(chapter, headingPath, anchorMap);

    chapter.subItems.forEach((child, index) =>
      this.collectSingleNoteAnchors(child, anchorMap, chapterAnchors, `${orderKey}.${index + 1}`, headingPath)
    );
  }

  private renderSingleNoteBody(chapter: Chapter, anchorMap: Map<string, string>): string {
    return chapter.sections
      .map(section => this.renderSingleNoteSection(section, chapter, anchorMap))
      .filter(Boolean)
      .join("\n\n");
  }

  private renderSingleNoteSection(section: Section, chapter: Chapter, anchorMap: Map<string, string>): string {
    const rewritten = this.rewriteSingleNoteLinks(this.htmlToMD(section.html), anchorMap, section.urlPath);
    return this.stripLeadingHeadings(rewritten, chapter.level + 1, chapter.originalName);
  }

  private mapChapterAnchors(chapter: Chapter, headingPath: string, anchorMap: Map<string, string>) {
    chapter.sections.forEach(section => {
      const baseKey = this.getSingleNoteKey(section.urlPath);
      const sectionKey = this.getSingleNoteKey(section.urlPath, section.urlHref);

      if (!anchorMap.has(baseKey)) anchorMap.set(baseKey, headingPath);
      anchorMap.set(sectionKey, headingPath);

      this.extractHtmlIds(section.html).forEach(id => {
        const idKey = this.getSingleNoteKey(section.urlPath, id);
        if (!anchorMap.has(idKey)) anchorMap.set(idKey, headingPath);
      });
    });
  }

  private createSingleNoteHeadingText(chapter: Chapter, orderKey: string): string {
    const title = chapter.originalName.trim();
    return this.hasExistingChapterNumber(title) ? title : `${orderKey} ${title}`.trim();
  }

  private hasExistingChapterNumber(title: string): boolean {
    const normalizedTitle = title.trim();

    const numberedPatterns = [
      /^\d+(?:[.\-]\d+)*(?=[^\d\s])/,
      /^\d+(?:[.\-]\d+)*[)\].、:：\-—_\s]+/,
      /^(?:chapter|part|section|book|vol(?:ume)?)\s+\d+/i,
      /^(?:[ivxlcdm]+)[)\].、:：\-—_\s]+/i,
      /^第[\d一二三四五六七八九十百千万两零〇○壹贰叁肆伍陆柒捌玖拾佰仟]+[章节回卷部篇册集讲节]/,
    ];

    return numberedPatterns.some((pattern) => pattern.test(normalizedTitle));
  }

  private rewriteSingleNoteLinks(content: string, anchorMap: Map<string, string>, currentUrlPath: string): string {
    return content.replace(/\[\[([^\]]+)\]\]/g, (match, linkText) => {
      const separatorIndex = linkText.indexOf("|");
      const target = separatorIndex >= 0 ? linkText.slice(0, separatorIndex) : linkText;
      const display = separatorIndex >= 0 ? linkText.slice(separatorIndex + 1) : linkText;
      const anchor = this.resolveSingleNoteAnchor(target, anchorMap, currentUrlPath);

      return anchor ? `[[#${anchor}|${display}]]` : match;
    });
  }

  private resolveSingleNoteAnchor(target: string, anchorMap: Map<string, string>, currentUrlPath: string): string | null {
    const key = this.resolveSingleNoteKey(target, currentUrlPath);
    if (anchorMap.has(key)) return anchorMap.get(key)!;

    const [targetPath] = target.split("#");
    if (targetPath) {
      const baseKey = this.resolveSingleNoteKey(targetPath, currentUrlPath);
      if (anchorMap.has(baseKey)) return anchorMap.get(baseKey)!;
    }

    return null;
  }

  private resolveSingleNoteKey(target: string, currentUrlPath: string): string {
    const [rawPath, rawHref = ""] = target.split("#");
    if (!rawPath) return this.getSingleNoteKey(currentUrlPath, rawHref);

    const absolutePath = path.resolve(path.dirname(currentUrlPath), decodeURIComponent(rawPath));
    return this.getSingleNoteKey(absolutePath, rawHref);
  }

  private getSingleNoteKey(urlPath: string, href = ""): string {
    const relativePath = path.relative(this.parser!.tmpPath, urlPath).replace(/\\/g, "/");
    const decodedPath = decodeURIComponent(relativePath);
    const decodedHref = decodeURIComponent(href);
    return decodedHref ? `${decodedPath}#${decodedHref}` : decodedPath;
  }

  private extractHtmlIds(html: string): string[] {
    const doc = new DOMParser().parseFromString(html, "text/html");
    return Array.from(doc.querySelectorAll("[id]"))
      .map(element => element.getAttribute("id") ?? "")
      .filter(Boolean);
  }

  private stripLeadingHeadings(content: string, maxDepthToStrip: number, chapterTitle: string): string {
    const lines = content.split("\n");
    let index = 0;
    const normalizedTitle = chapterTitle.trim();

    while (index < lines.length && lines[index].trim() === "") index++;

    while (
      index < lines.length &&
      this.isHeadingLine(lines[index]) &&
      this.getHeadingDepth(lines[index]) <= maxDepthToStrip
    ) {
      index++;
      while (index < lines.length && lines[index].trim() === "") index++;
    }

    if (index < lines.length && this.isDuplicateTitleLine(lines[index], normalizedTitle)) {
      index++;
      while (index < lines.length && lines[index].trim() === "") index++;
    }

    return lines.slice(index).join("\n").trim();
  }

  private isDuplicateTitleLine(line: string, chapterTitle: string): boolean {
    const normalizedLine = line.trim();
    if (!normalizedLine || !chapterTitle) return false;

    return normalizedLine === chapterTitle || normalizedLine.replace(/\s+/g, "") === chapterTitle.replace(/\s+/g, "");
  }

  private isHeadingLine(line: string): boolean {
    return /^\s*#{1,6}\s+/.test(line);
  }

  private getHeadingDepth(line: string): number {
    return (line.match(/^\s*(#{1,6})\s+/)?.[1].length) ?? 0;
  }

  private mergeChapters(maxLevel = 0) {
    this.parser!.chapters
      .filter(c => c.level > maxLevel)
      .sort((a, b) => b.level - a.level)
      .forEach(c => c.parent?.sections.push(...c.sections));
  }

  private getChapterPaths(chapter: Chapter): string[] {
    const paths = this.buildPathArray(chapter);
    return chapter.level < this.settings.granularity && chapter.subItems.length
      ? [...paths, chapter.name]
      : paths;
  }

  private buildPathArray(chapter: Chapter): string[] {
    const paths: string[] = [];
    let current: Chapter | undefined = chapter;
    while (current) {
      paths.unshift(current.name);
      current = current.parent;
    }
    return paths;
  }

  private getChapterMetadata(chapter: Chapter, index: number, chapters: Chapter[]): Record<string, string> {
    const content = this.generateContent([chapter]);
    return {
      created_time: Date.now().toString(),
      content,
      prev: index > 0 ? chapters[index - 1].name : "",
      next: index < chapters.length - 1 ? chapters[index + 1].name : "",
      chapter_name: chapter.originalName,
      chapter_level: chapter.level.toString(),
      chapter_index: (index + 1).toString(),
      ...this.parser!.meta,
      total_chars: content.length.toString(),
    };
  }

  private parseProperties(): Record<string, unknown> {
    const props = parseYaml(templateWithVariables(this.settings.mocPropertysTemplate, this.parser!.meta, true));
    props.tags = [...(props.tags ?? []), this.settings.tag];
    return props;
  }

  private copyImages(folderPath: string) {
    this.assetsPath = templateWithVariables(this.settings.assetsPath, {
      bookName: path.basename(folderPath),
      savePath: this.settings.savePath,
    });

    jetpack.find(this.parser!.tmpPath, { matching: ["*.{jpg,jpeg,png}"] })
      .forEach(file => jetpack.copy(file, path.posix.join(this.vaultPath, this.assetsPath, path.basename(file)), { overwrite: true }));

    if (this.parser!.coverPath) {
      this.properties.cover = path.posix.join(this.assetsPath, path.basename(this.parser!.coverPath));
    }
  }

  private htmlToMD(html: string): string {
    if (this.settings.reformatting) html = beautify.html(html, { indent_size: 0 });
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("table:empty").forEach(table => table.remove());

    return this.normalizeHeadings(
      create(this.assetsPath, this.settings.imageFormat).turndown(html) || html.replace(/<[^>]+>/g, "")
    );
  }

  private normalizeHeadings(markdown: string): string {
    if (!/^# /m.test(markdown) && /^(#{1,6}) /m.test(markdown)) {
      const levelDiff = markdown.match(/^(#{1,6}) /m)![1].length - 1;
      return markdown.replace(/^(#{1,6}) /gm, (_, h) => "#".repeat(Math.max(1, h.length - levelDiff)) + " ");
    }
    return markdown;
  }

  private resolveFolderPath(epubName: string): string | null {
    const folderPath = path.posix.join(this.settings.savePath, epubName);
    const fullPath = path.posix.join(this.vaultPath, folderPath);
    return jetpack.exists(fullPath)
      ? this.settings.removeDuplicateFolders
        ? (jetpack.remove(fullPath), folderPath)
        : (new Notice("Duplicate folder exists"), null)
      : folderPath;
  }

  private async ensureFolder(folderPath: string) {
    await this.app.vault.createFolder(folderPath).catch(() => {});
  }

  private showSuccessNotice(epubName: string) {
    const message = `Successfully imported ${epubName}`;
    console.log(message);
    new Notice(message);
  }
}

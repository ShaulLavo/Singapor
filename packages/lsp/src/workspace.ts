import type * as lsp from "vscode-languageserver-protocol";
import type { LspClient } from "./client";
import type {
  LspDocument,
  LspDocumentOpenOptions,
  LspTextDocumentSnapshot,
  LspTextSnapshot,
  LspTextEdit,
  LspWorkspaceEditOptions,
  LspWorkspaceSnapshotEditOptions,
} from "./types";

type MutableLspDocument = {
  uri: lsp.DocumentUri;
  languageId: string;
  version: number;
  textCache?: string;
  textSnapshot: LspTextSnapshot;
  lineStarts: readonly number[];
};

export class LspWorkspace {
  private readonly documentsByUri = new Map<lsp.DocumentUri, MutableLspDocument>();
  private readonly versionsByUri = new Map<lsp.DocumentUri, number>();
  private client: LspClient | null = null;

  public get documents(): readonly LspDocument[] {
    return [...this.documentsByUri.values()].map(cloneDocument);
  }

  public attachClient(client: LspClient): void {
    this.client = client;
  }

  public openDocument(options: LspDocumentOpenOptions): LspDocument {
    if (this.documentsByUri.has(options.uri)) {
      throw new Error(`LSP document already open: ${options.uri}`);
    }

    const document = {
      uri: options.uri,
      languageId: options.languageId,
      textCache: options.text,
      textSnapshot: createStringTextSnapshot(options.text),
      lineStarts: computeLineStarts(options.text),
      version: this.nextVersion(options.uri),
    };
    this.documentsByUri.set(options.uri, document);
    this.client?.didOpenDocument(cloneDocument(document));
    return cloneDocument(document);
  }

  public updateDocument(
    uri: lsp.DocumentUri,
    text: string,
    options: LspWorkspaceEditOptions = {},
  ): LspDocument {
    const document = this.requireDocument(uri);
    const previousText = materializeDocumentText(document);
    if (previousText === text && !hasEffectiveEdits(options.edits)) return cloneDocument(document);

    const previousSnapshot = documentSnapshot(document);
    document.textCache = text;
    document.textSnapshot = createStringTextSnapshot(text);
    document.lineStarts = computeLineStarts(text);
    document.version = this.nextVersion(uri);
    this.client?.didChangeDocument(cloneDocument(document), {
      edits: options.edits ?? [],
      previousSnapshot,
      previousText,
    });
    return cloneDocument(document);
  }

  public updateDocumentSnapshot(
    uri: lsp.DocumentUri,
    options: LspWorkspaceSnapshotEditOptions,
  ): LspDocument {
    const document = this.requireDocument(uri);
    const previousSnapshot = documentSnapshot(document);
    if (sameSnapshotDocument(previousSnapshot, options) && !hasEffectiveEdits(options.edits)) {
      return cloneDocument(document);
    }

    document.textCache = undefined;
    document.textSnapshot = options.textSnapshot;
    document.lineStarts = options.lineStarts;
    document.version = this.nextVersion(uri);
    this.client?.didChangeDocument(cloneDocument(document), {
      edits: options.edits ?? [],
      previousSnapshot,
    });
    return cloneDocument(document);
  }

  public closeDocument(uri: lsp.DocumentUri): void {
    const document = this.documentsByUri.get(uri);
    if (!document) return;

    this.documentsByUri.delete(uri);
    this.client?.didCloseDocument(cloneDocument(document));
  }

  public getDocument(uri: lsp.DocumentUri): LspDocument | null {
    const document = this.documentsByUri.get(uri);
    return document ? cloneDocument(document) : null;
  }

  public connected(): void {
    for (const document of this.documentsByUri.values()) {
      this.client?.didOpenDocument(cloneDocument(document));
    }
  }

  public disconnected(): void {
    return;
  }

  private nextVersion(uri: lsp.DocumentUri): number {
    const version = (this.versionsByUri.get(uri) ?? -1) + 1;
    this.versionsByUri.set(uri, version);
    return version;
  }

  private requireDocument(uri: lsp.DocumentUri): MutableLspDocument {
    const document = this.documentsByUri.get(uri);
    if (document) return document;
    throw new Error(`LSP document is not open: ${uri}`);
  }
}

function cloneDocument(document: MutableLspDocument): LspDocument {
  return defineLazyDocumentText({
    uri: document.uri,
    languageId: document.languageId,
    version: document.version,
    textSnapshot: document.textSnapshot,
    lineStarts: document.lineStarts,
  });
}

function defineLazyDocumentText<TDocument extends Omit<LspDocument, "text">>(
  document: TDocument,
): TDocument & { readonly text: string } {
  Object.defineProperty(document, "text", {
    configurable: true,
    enumerable: true,
    get: () => document.textSnapshot.getText(),
  });
  return document as TDocument & { readonly text: string };
}

function documentSnapshot(document: MutableLspDocument): LspTextDocumentSnapshot {
  return {
    textSnapshot: document.textSnapshot,
    lineStarts: document.lineStarts,
  };
}

function materializeDocumentText(document: MutableLspDocument): string {
  return document.textCache ?? document.textSnapshot.getText();
}

function createStringTextSnapshot(text: string): LspTextSnapshot {
  return {
    length: text.length,
    getText: () => text,
    getTextInRange: (start, end) => text.slice(start, end),
  };
}

function computeLineStarts(text: string): number[] {
  const starts = [0];
  let index = text.indexOf("\n");

  while (index !== -1) {
    starts.push(index + 1);
    index = text.indexOf("\n", index + 1);
  }

  return starts;
}

function sameSnapshotDocument(
  left: LspTextDocumentSnapshot,
  right: LspTextDocumentSnapshot,
): boolean {
  return left.textSnapshot === right.textSnapshot && left.lineStarts === right.lineStarts;
}

const hasEffectiveEdits = (edits: readonly LspTextEdit[] | undefined): boolean => {
  if (!edits) return false;
  return edits.some((edit) => edit.from !== edit.to || edit.text.length > 0);
};

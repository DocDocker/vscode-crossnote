import * as vscode from "vscode";
import * as path from "path";
import { CrossnoteTreeItem } from "../extension/TreeItem";
import { createNotesPanelWebviewPanel } from "../extension/NotesPanelWebviewPanel";
import { Message, MessageAction } from "./message";
import { OneDay, randomID } from "../util/util";
import { Notebook } from "./notebook";
import { CrossnoteSectionType, SelectedSection } from "./section";
import { createEditorPanelWebviewPanel } from "../extension/EditorPanelWebviewPanel";
import { Note, NoteConfig } from "./note";

export class Crossnote {
  public notebooks: Notebook[] = [];

  private notesPanelWebviewPanel: vscode.WebviewPanel | undefined;
  private notesPanelWebviewInitialized: boolean = false;
  private editorPanelWebviewPanel: vscode.WebviewPanel | undefined;
  private editorPanelWebviewInitialized: boolean = false;
  private needsToRefreshNotesPanel: boolean = false;

  private selectedTreeItem: CrossnoteTreeItem | undefined;
  private selectedNote: Note | undefined;

  constructor(private context: vscode.ExtensionContext) {
    this.startNotesPanelRefreshTimer();
  }
  public addNotebook(name: string, dir: string): Notebook {
    let nb = this.notebooks.find((nb) => nb.dir === dir);
    if (!nb) {
      const notebook = new Notebook(name, dir);
      this.notebooks.push(notebook);
      return notebook;
    } else {
      return nb;
    }
  }
  public removeNotebook(dir: string) {
    const index = this.notebooks.findIndex((nb) => nb.dir === dir);
    if (index >= 0) {
      this.notebooks.splice(index, 1);
    }
    // TODO: Check selectedTreeItem and selectedNote
  }

  public getNotebookByPath(path: string): Notebook | undefined {
    return this.notebooks.find((nb) => nb.dir === path);
  }

  public refreshNotesPanelWebview() {
    this.openNotesPanelWebview(this.selectedTreeItem);
  }

  private onDidReceiveMessage(message: Message) {
    switch (message.action) {
      case MessageAction.InitializedNotesPanelWebview:
        this.notesPanelWebviewInitialized = true;
        this.sendNotesToNotesPanelWebview();
        break;
      case MessageAction.InitializedEditorPanelWebview:
        this.editorPanelWebviewInitialized = true;
        this.sendNoteToEditorWebviewPanel();
        break;
      case MessageAction.OpenNote:
        this.openEditorPanelWebview(message.data);
        break;
      case MessageAction.OpenNoteIfNoNoteSelected:
        if (!this.selectedNote) {
          this.openEditorPanelWebview(message.data);
        }
        break;
      case MessageAction.CreateNewNote:
        this.createNewNote(message.data);
        break;
      case MessageAction.UpdateNote:
        const notebook = this.getNotebookByPath(message.data.note.notebookPath);
        if (notebook) {
          const { note, markdown, password } = message.data;
          notebook
            .writeNote(note.filePath, markdown, note.config, password)
            .then((newNote) => {
              this.checkToRefreshNotesPanel(notebook, newNote);
              // TODO: Check if necessary to update TagNodes
            });
        }
        break;
      default:
        break;
    }
  }

  private checkToRefreshNotesPanel(notebook: Notebook, newNote: Note) {
    if (!notebook || !newNote) {
      return;
    }
    const oldNote = notebook.notes.find((n) => n.filePath === newNote.filePath);
    if (oldNote) {
      oldNote.config = newNote.config;
      oldNote.markdown = newNote.markdown;
      this.needsToRefreshNotesPanel = true;
    }
  }

  private startNotesPanelRefreshTimer = () => {
    setInterval(() => {
      if (this.needsToRefreshNotesPanel) {
        this.sendNotesToNotesPanelWebview();
        this.needsToRefreshNotesPanel = false;
      }
    }, 15000);
  };

  public async openNoteByPath(absFilePath: string) {
    let note: Note | null = null;
    for (let i = 0; i < this.notebooks.length; i++) {
      const notebook = this.notebooks[i];
      if (absFilePath.startsWith(notebook.dir)) {
        note = await notebook.getNote(path.relative(notebook.dir, absFilePath));
        if (note) {
          break;
        }
      }
    }

    if (note) {
      this.openEditorPanelWebview(note);
    } else {
      vscode.window.showErrorMessage(
        "Please save this markdown file and make sure it belongs to a folder in current workspace"
      );
    }
  }

  public async updateNoteMarkdownIfNecessary(uri: vscode.Uri) {
    if (
      this.editorPanelWebviewInitialized &&
      this.editorPanelWebviewPanel &&
      this.selectedNote &&
      path.normalize(
        path.join(this.selectedNote.notebookPath, this.selectedNote.filePath)
      ) === path.normalize(uri.fsPath)
    ) {
      const notebook = this.getNotebookByPath(this.selectedNote.notebookPath);
      const note = await notebook?.getNote(this.selectedNote.filePath);
      if (notebook && note) {
        const message: Message = {
          action: MessageAction.UpdatedNote,
          data: note,
        };
        this.editorPanelWebviewPanel.webview.postMessage(message);

        this.checkToRefreshNotesPanel(notebook, note);
      }
    }
  }

  public openNotesPanelWebview(
    selectedTreeItem: CrossnoteTreeItem | undefined
  ) {
    if (!selectedTreeItem) {
      return;
    }
    if (!this.notesPanelWebviewPanel) {
      this.notesPanelWebviewPanel = createNotesPanelWebviewPanel(
        this.context,
        () => {
          this.notesPanelWebviewPanel = undefined;
          this.notesPanelWebviewInitialized = false;
        }
      );
      this.notesPanelWebviewPanel.webview.onDidReceiveMessage(
        this.onDidReceiveMessage.bind(this),
        undefined,
        this.context.subscriptions
      );
    } else {
      this.notesPanelWebviewPanel.reveal(vscode.ViewColumn.One);
    }

    this.selectedTreeItem = selectedTreeItem;
    this.sendNotesToNotesPanelWebview();
  }

  public openEditorPanelWebview(note: Note) {
    if (!this.editorPanelWebviewPanel) {
      this.editorPanelWebviewPanel = createEditorPanelWebviewPanel(
        this.context,
        () => {
          this.editorPanelWebviewPanel = undefined;
          this.editorPanelWebviewInitialized = false;
        }
      );
      this.editorPanelWebviewPanel.webview.onDidReceiveMessage(
        this.onDidReceiveMessage.bind(this),
        undefined,
        this.context.subscriptions
      );
    } else {
      this.editorPanelWebviewPanel.reveal(vscode.ViewColumn.Two);
    }

    this.selectedNote = note;
    this.sendNoteToEditorWebviewPanel();
  }

  private sendNotesToNotesPanelWebview() {
    if (
      !this.selectedTreeItem ||
      !this.notesPanelWebviewPanel ||
      !this.notesPanelWebviewInitialized
    ) {
      return;
    }

    let notes = this.selectedTreeItem.notebook.notes || [];
    if (
      this.selectedTreeItem.type === CrossnoteSectionType.Notes ||
      this.selectedTreeItem.type === CrossnoteSectionType.Notebook
    ) {
      // Do nothing
    } else if (this.selectedTreeItem.type === CrossnoteSectionType.Todo) {
      notes = notes.filter((note) =>
        note.markdown.match(/(\*|-|\d+\.)\s\[(\s+|x|X)\]\s/gm)
      );
    } else if (this.selectedTreeItem.type === CrossnoteSectionType.Today) {
      notes = notes.filter(
        (note) => Date.now() - note.config.modifiedAt.getTime() <= OneDay
      );
    } else if (this.selectedTreeItem.type === CrossnoteSectionType.Tagged) {
      notes = notes.filter(
        (note) => note.config.tags && note.config.tags.length > 0
      );
    } else if (this.selectedTreeItem.type === CrossnoteSectionType.Untagged) {
      notes = notes.filter(
        (note) => note.config.tags && note.config.tags.length === 0
      );
    } else if (this.selectedTreeItem.type === CrossnoteSectionType.Tag) {
      notes = notes.filter((note) => {
        const tags = note.config.tags || [];
        return tags.find(
          (tag) =>
            (tag.toLocaleLowerCase() + "/").indexOf(
              // @ts-ignore
              this.selectedTreeItem.path + "/"
            ) === 0
        );
      });
    } else if (this.selectedTreeItem.type === CrossnoteSectionType.Encrypted) {
      notes = notes.filter((note) => {
        return note.config.encryption;
      });
    } else if (this.selectedTreeItem.type === CrossnoteSectionType.Wiki) {
      // Do nothing here
    } else {
      // CrossnoteSectionType.Directory
      notes = notes.filter(
        // @ts-ignore
        (note) => note.filePath.indexOf(this.selectedTreeItem.path + "/") === 0
      );
    }

    if (
      this.selectedNote &&
      this.selectedNote.notebookPath !== this.selectedTreeItem.notebook.dir
    ) {
      this.selectedNote = undefined;
    }

    let message: Message = {
      action: MessageAction.SendNotes,
      data: notes,
    };
    this.notesPanelWebviewPanel.webview.postMessage(message);

    message = {
      action: MessageAction.SelectedTreeItem,
      data: {
        path: this.selectedTreeItem.path,
        type: this.selectedTreeItem.type,
        notebook: {
          name: this.selectedTreeItem.notebook.name,
          dir: this.selectedTreeItem.notebook.dir,
        },
      },
    };
    this.notesPanelWebviewPanel.webview.postMessage(message);
  }

  private async sendNoteToEditorWebviewPanel() {
    if (
      !this.selectedNote ||
      !this.editorPanelWebviewPanel ||
      !this.editorPanelWebviewInitialized
    ) {
      return;
    }

    const notebook = this.getNotebookByPath(this.selectedNote.notebookPath);
    if (!notebook) {
      return;
    }
    const note = await notebook.getNote(this.selectedNote.filePath);
    if (!note) {
      return;
    }
    this.editorPanelWebviewPanel.title = path.basename(note.filePath);

    let message: Message = {
      action: MessageAction.SendNote,
      data: note,
    };
    this.editorPanelWebviewPanel.webview.postMessage(message);

    if (!notebook.rootTagNode) {
      await notebook.initData();
    }
    message = {
      action: MessageAction.SendNotebookTagNode,
      data: notebook.rootTagNode,
    };
    this.editorPanelWebviewPanel.webview.postMessage(message);
  }

  private async createNewNote(selectedSection: SelectedSection) {
    const notebook = this.getNotebookByPath(selectedSection.notebook.dir);
    if (!notebook) {
      return;
    }
    const fileName = "unnamed_" + randomID() + ".md";
    let filePath;
    let tags: string[] = [];
    if (selectedSection.type === CrossnoteSectionType.Tag) {
      filePath = fileName;
      tags = [selectedSection.path];
    } else if (selectedSection.type === CrossnoteSectionType.Directory) {
      filePath = path.relative(
        notebook.dir,
        path.resolve(notebook.dir, selectedSection.path, fileName)
      );
    } else {
      filePath = fileName;
    }

    const noteConfig: NoteConfig = {
      tags: tags,
      modifiedAt: new Date(),
      createdAt: new Date(),
    };
    await notebook.writeNote(filePath, "", noteConfig);

    if (this.notesPanelWebviewPanel && this.notesPanelWebviewInitialized) {
      const note = await notebook.getNote(filePath);
      if (!note) {
        return;
      }
      const message: Message = {
        action: MessageAction.CreatedNewNote,
        data: note,
      };
      this.notesPanelWebviewPanel.webview.postMessage(message);
      this.openEditorPanelWebview(note);
    }
  }
}

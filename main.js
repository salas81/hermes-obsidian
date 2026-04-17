"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => HermesObsidianMVPPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");

// src/transport/hermes-acp-client.ts
var import_child_process = require("child_process");
var import_fs = require("fs");
var HermesACPClient = class {
  constructor(hermesCommand) {
    this.hermesCommand = hermesCommand;
    this.proc = null;
    this.buffer = "";
    this.nextId = 1;
    this.pending = /* @__PURE__ */ new Map();
    this.initialized = false;
    this.sessionId = null;
  }
  resolveHermesCommand() {
    if (this.hermesCommand.includes("/") || this.hermesCommand.includes("\\")) {
      return this.hermesCommand;
    }
    const home = process.env.HOME;
    const candidates = [
      this.hermesCommand,
      home ? `${home}/.local/bin/${this.hermesCommand}` : null,
      home ? `${home}/.npm-global/bin/${this.hermesCommand}` : null,
      `/usr/local/bin/${this.hermesCommand}`,
      `/opt/homebrew/bin/${this.hermesCommand}`
    ].filter((value) => Boolean(value));
    for (const candidate of candidates) {
      if (candidate === this.hermesCommand || (0, import_fs.existsSync)(candidate)) return candidate;
    }
    return this.hermesCommand;
  }
  ensureStarted(cwd) {
    if (this.proc) return;
    const command = this.resolveHermesCommand();
    this.proc = (0, import_child_process.spawn)(command, ["acp"], {
      cwd: cwd || process.cwd(),
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.proc.stdout.on("data", (chunk) => {
      this.buffer += chunk.toString("utf8");
      this.consumeBuffer();
    });
    this.proc.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8").trim();
      if (text && this.onStatus) this.onStatus(text);
    });
    this.proc.on("error", (error) => {
      const extra = command === this.hermesCommand ? "" : ` (resolved from ${this.hermesCommand} to ${command})`;
      this.onError?.(`Failed to start Hermes ACP${extra}: ${String(error)}`);
    });
    this.proc.on("exit", (code) => {
      const error = `Hermes ACP exited${code !== null ? ` with code ${code}` : ""}`;
      for (const pending of this.pending.values()) pending.reject(new Error(error));
      this.pending.clear();
      this.proc = null;
      this.initialized = false;
      this.sessionId = null;
      this.onStatus?.(error);
    });
  }
  consumeBuffer() {
    let newlineIndex = -1;
    while ((newlineIndex = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        this.handleMessage(msg);
      } catch (error) {
        this.onError?.(`Failed to parse ACP output: ${String(error)}`);
      }
    }
  }
  handleMessage(msg) {
    if (typeof msg.id === "number" && this.pending.has(msg.id)) {
      const pending = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) {
        const detail = typeof msg.error === "string" ? msg.error : msg.error?.message || JSON.stringify(msg.error);
        pending.reject(new Error(detail));
      } else pending.resolve(msg.result);
      return;
    }
    if (msg.method === "session/update") {
      this.handleSessionUpdate(msg.params ?? {});
    }
  }
  handleSessionUpdate(params) {
    const update = params.update ?? params;
    if (!update || typeof update !== "object") return;
    const sessionUpdate = update.sessionUpdate ?? update.session_update;
    if (sessionUpdate === "agent_message_chunk" || sessionUpdate === "agent_message") {
      const text = this.extractText(update);
      if (text) this.onAssistantText?.(text);
      return;
    }
    if (sessionUpdate === "agent_thought_chunk" || sessionUpdate === "tool_call" || sessionUpdate === "tool_call_update") {
      const text = this.extractText(update);
      if (text) this.onStatus?.(text);
      return;
    }
    if (sessionUpdate === "available_commands_update") {
      return;
    }
    const fallback = this.extractText(update);
    if (fallback) this.onStatus?.(fallback);
  }
  extractText(value) {
    const parts = [];
    const walk = (node) => {
      if (node == null) return;
      if (typeof node === "string") return;
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      if (typeof node !== "object") return;
      if (typeof node.text === "string") parts.push(node.text);
      if (typeof node.content === "string") parts.push(node.content);
      if (typeof node.result === "string") parts.push(node.result);
      if (typeof node.description === "string") parts.push(node.description);
      for (const key of Object.keys(node)) {
        walk(node[key]);
      }
    };
    walk(value);
    return parts.join("");
  }
  request(method, params) {
    if (!this.proc) throw new Error("Hermes ACP process is not running");
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    this.proc.stdin.write(`${JSON.stringify(payload)}
`);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }
  async ensureInitialized(cwd) {
    this.ensureStarted(cwd);
    if (this.initialized) return;
    await this.request("initialize", {
      protocol_version: 1,
      client_capabilities: {},
      client_info: {
        name: "hermes-obsidian-mvp",
        version: "0.0.4"
      }
    });
    this.initialized = true;
  }
  async listSessions(cwd) {
    await this.ensureInitialized(cwd);
    const result = await this.request("session/list", {});
    const sessions = Array.isArray(result?.sessions) ? result.sessions : [];
    return sessions.map((session) => {
      const id = session?.id ?? session?.sessionId ?? session?.session_id;
      return id ? { ...session, id } : null;
    }).filter((session) => Boolean(session));
  }
  async resumeSession(sessionId, cwd) {
    await this.ensureInitialized(cwd);
    const result = await this.request("session/resume", {
      sessionId,
      cwd: cwd || process.cwd()
    });
    this.sessionId = result?.sessionId ?? result?.session_id ?? result?.id ?? sessionId;
    return result;
  }
  async loadSession(sessionId, cwd) {
    await this.ensureInitialized(cwd);
    const result = await this.request("session/load", {
      sessionId,
      cwd: cwd || process.cwd(),
      mcpServers: []
    });
    this.sessionId = result?.sessionId ?? result?.session_id ?? result?.id ?? sessionId;
    return result;
  }
  async restoreLatestSession(cwd) {
    const sessions = await this.listSessions(cwd);
    if (!sessions.length) return null;
    const latest = [...sessions].sort((a, b) => {
      const aTs = Number(a.updatedAt ?? a.updated_at ?? a.createdAt ?? a.created_at ?? 0);
      const bTs = Number(b.updatedAt ?? b.updated_at ?? b.createdAt ?? b.created_at ?? 0);
      return bTs - aTs;
    })[0];
    try {
      return await this.loadSession(latest.id, cwd);
    } catch {
      return this.resumeSession(latest.id, cwd);
    }
  }
  async ensureSession(cwd) {
    if (this.sessionId) return this.sessionId;
    const result = await this.request("session/new", { cwd: cwd || process.cwd(), mcpServers: [] });
    this.sessionId = result?.sessionId ?? result?.session_id ?? result?.id;
    if (!this.sessionId) throw new Error("Hermes ACP did not return a session id");
    return this.sessionId;
  }
  async sendPrompt(text, cwd) {
    await this.ensureInitialized(cwd);
    const sessionId = await this.ensureSession(cwd);
    return this.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text }]
    });
  }
};

// src/main.ts
var VIEW_TYPE_HERMES_MVP = "hermes-obsidian-mvp";
var DEFAULT_SETTINGS = {
  hermesCommand: "hermes",
  messages: []
};
var HermesMVPView = class extends import_obsidian.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.messages = [];
    this.inputValue = "";
    this.isSending = false;
    this.plugin = plugin;
  }
  getViewType() {
    return VIEW_TYPE_HERMES_MVP;
  }
  getDisplayText() {
    return "Hermes";
  }
  async onOpen() {
    this.plugin.registerViewInstance(this);
    this.messages = Array.isArray(this.plugin.settings.messages) ? this.plugin.settings.messages.map((message) => ({ ...message })) : [];
    this.render();
    void this.plugin.restoreRemoteConversation();
  }
  async onClose() {
    this.plugin.unregisterViewInstance(this);
  }
  setMessages(messages) {
    this.messages = messages.map((message) => ({ ...message }));
    this.plugin.persistMessages(this.messages);
    this.render();
  }
  appendMessage(role, text) {
    if (!text) return;
    if (role === "assistant") {
      const last = this.messages[this.messages.length - 1];
      if (last && last.role === "assistant") {
        last.text += text;
      } else {
        this.messages.push({ role, text });
      }
    } else if (role === "status") {
      const last = this.messages[this.messages.length - 1];
      if (last && last.role === "status") {
        last.text = text;
      } else {
        this.messages.push({ role, text });
      }
    } else {
      this.messages.push({ role, text });
    }
    this.plugin.persistMessages(this.messages);
    this.render();
  }
  async submitPrompt() {
    const text = this.inputValue.trim();
    if (!text || this.isSending) return;
    this.inputValue = "";
    this.isSending = true;
    this.messages.push({ role: "user", text });
    this.messages.push({ role: "assistant", text: "" });
    this.plugin.persistMessages(this.messages);
    this.render();
    try {
      await this.plugin.client.sendPrompt(text, this.plugin.getVaultPath());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.appendMessage("error", message);
    } finally {
      this.isSending = false;
      this.render();
    }
  }
  getLabel(role) {
    switch (role) {
      case "user":
        return "You";
      case "assistant":
        return "Hermes";
      case "status":
        return "Status";
      case "error":
        return "Error";
    }
  }
  async renderMessageBody(container, msg) {
    if (msg.role === "assistant") {
      await import_obsidian.MarkdownRenderer.render(this.app, msg.text || "\u2026", container, "", this.plugin);
      return;
    }
    if (msg.role === "status") {
      container.setText(msg.text);
      return;
    }
    container.setText(msg.text || (msg.role === "assistant" ? "\u2026" : ""));
  }
  render() {
    const root = this.containerEl.children[1];
    root.empty();
    root.addClass("hermes-mvp-root");
    const wrap = root.createDiv({ cls: "hermes-mvp-wrap" });
    const header = wrap.createDiv({ cls: "hermes-mvp-header" });
    header.createDiv({ cls: "hermes-mvp-title", text: "Hermes" });
    header.createDiv({
      cls: "hermes-mvp-subtitle",
      text: this.isSending ? "Thinking\u2026" : "Local Obsidian chat"
    });
    const list = wrap.createDiv({ cls: "hermes-mvp-messages" });
    if (this.messages.length === 0) {
      const empty = list.createDiv({ cls: "hermes-mvp-empty" });
      empty.createDiv({ cls: "hermes-mvp-empty-title", text: "Start a conversation" });
      empty.createDiv({
        cls: "hermes-mvp-empty-subtitle",
        text: "Ask Hermes to brainstorm, write, summarize, or help you think through a note."
      });
    }
    for (const msg of this.messages) {
      const row = list.createDiv({ cls: `hermes-mvp-row hermes-mvp-row-${msg.role}` });
      const bubble = row.createDiv({ cls: `hermes-mvp-bubble hermes-mvp-bubble-${msg.role}` });
      bubble.createDiv({ cls: "hermes-mvp-bubble-label", text: this.getLabel(msg.role) });
      const body = bubble.createDiv({ cls: "hermes-mvp-bubble-body" });
      void this.renderMessageBody(body, msg);
    }
    const composer = wrap.createDiv({ cls: "hermes-mvp-composer" });
    const inputWrap = composer.createDiv({ cls: "hermes-mvp-input-wrap" });
    const input = inputWrap.createEl("textarea", {
      cls: "hermes-mvp-input",
      attr: { rows: "1", placeholder: "Message Hermes\u2026" }
    });
    input.value = this.inputValue;
    input.disabled = this.isSending;
    input.addEventListener("input", () => {
      this.inputValue = input.value;
      input.style.height = "0px";
      input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
    });
    input.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter" && !evt.shiftKey) {
        evt.preventDefault();
        void this.submitPrompt();
      }
    });
    input.style.height = "0px";
    input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
    const button = composer.createEl("button", {
      cls: "mod-cta hermes-mvp-send",
      text: this.isSending ? "Sending\u2026" : "Send"
    });
    button.disabled = this.isSending;
    button.addEventListener("click", () => {
      void this.submitPrompt();
    });
    list.scrollTop = list.scrollHeight;
  }
};
var HermesSettingTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new import_obsidian.Setting(containerEl).setName("Hermes command").setDesc("Command used to launch Hermes ACP locally.").addText(
      (text) => text.setPlaceholder("hermes").setValue(this.plugin.settings.hermesCommand).onChange(async (value) => {
        this.plugin.settings.hermesCommand = value.trim() || "hermes";
        await this.plugin.saveSettings();
        new import_obsidian.Notice("Hermes command saved");
      })
    );
  }
};
var HermesObsidianMVPPlugin = class extends import_obsidian.Plugin {
  constructor() {
    super(...arguments);
    this.activeView = null;
    this.restoreAttempted = false;
  }
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.client = new HermesACPClient(this.settings.hermesCommand);
    this.wireClientCallbacks();
    this.injectStyles();
    this.registerView(VIEW_TYPE_HERMES_MVP, (leaf) => new HermesMVPView(leaf, this));
    this.addSettingTab(new HermesSettingTab(this.app, this));
    this.addRibbonIcon("bot", "Open Hermes MVP", async () => {
      await this.activateView();
    });
    this.addCommand({
      id: "open-hermes-mvp",
      name: "Open Hermes MVP",
      callback: async () => this.activateView()
    });
  }
  async onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_HERMES_MVP);
  }
  registerViewInstance(view) {
    this.activeView = view;
  }
  unregisterViewInstance(view) {
    if (this.activeView === view) this.activeView = null;
  }
  getVaultPath() {
    return this.app.vault.adapter.basePath || process.cwd();
  }
  async saveSettings() {
    await this.saveData(this.settings);
    this.client = new HermesACPClient(this.settings.hermesCommand);
    this.wireClientCallbacks();
  }
  persistMessages(messages) {
    this.settings.messages = messages.map((message) => ({ ...message }));
    void this.saveData(this.settings);
  }
  async restoreRemoteConversation() {
    if (this.restoreAttempted) return;
    this.restoreAttempted = true;
    try {
      await this.client.restoreLatestSession(this.getVaultPath());
    } catch (error) {
      console.warn("[Hermes MVP] Failed to restore latest session", error);
    }
  }
  wireClientCallbacks() {
    this.client.onAssistantText = (text) => {
      this.activeView?.appendMessage("assistant", text);
    };
    this.client.onStatus = (text) => {
      this.activeView?.appendMessage("status", text);
    };
    this.client.onError = (text) => {
      this.activeView?.appendMessage("error", text);
      new import_obsidian.Notice(text);
    };
  }
  injectStyles() {
    const styleId = "hermes-mvp-inline-styles";
    document.getElementById(styleId)?.remove();
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
      .hermes-mvp-root {
        height: 100%;
      }

      .hermes-mvp-wrap {
        display: flex;
        flex-direction: column;
        height: 100%;
        background: var(--background-primary);
        color: var(--text-normal);
      }

      .hermes-mvp-header {
        padding: 14px 16px 10px;
        border-bottom: 1px solid var(--background-modifier-border);
        background: color-mix(in srgb, var(--background-secondary) 70%, transparent);
      }

      .hermes-mvp-title {
        font-size: 18px;
        font-weight: 700;
        letter-spacing: -0.01em;
      }

      .hermes-mvp-subtitle {
        margin-top: 2px;
        font-size: 12px;
        color: var(--text-muted);
      }

      .hermes-mvp-messages {
        flex: 1;
        overflow-y: auto;
        padding: 18px 16px 24px;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      .hermes-mvp-empty {
        margin: auto 0;
        padding: 24px 18px;
        border: 1px dashed var(--background-modifier-border);
        border-radius: 16px;
        background: color-mix(in srgb, var(--background-secondary) 55%, transparent);
      }

      .hermes-mvp-empty-title {
        font-size: 16px;
        font-weight: 600;
        margin-bottom: 6px;
      }

      .hermes-mvp-empty-subtitle {
        font-size: 13px;
        line-height: 1.5;
        color: var(--text-muted);
      }

      .hermes-mvp-row {
        display: flex;
      }

      .hermes-mvp-row-user {
        justify-content: flex-end;
      }

      .hermes-mvp-row-assistant,
      .hermes-mvp-row-status,
      .hermes-mvp-row-error {
        justify-content: flex-start;
      }

      .hermes-mvp-bubble {
        max-width: min(680px, 92%);
        border-radius: 16px;
        padding: 10px 12px;
        box-shadow: 0 1px 2px rgb(0 0 0 / 0.08);
      }

      .hermes-mvp-bubble-user {
        background: var(--interactive-accent);
        color: var(--text-on-accent);
        border-bottom-right-radius: 6px;
      }

      .hermes-mvp-bubble-assistant {
        background: var(--background-secondary);
        border: 1px solid var(--background-modifier-border);
        border-bottom-left-radius: 6px;
      }

      .hermes-mvp-bubble-status {
        background: color-mix(in srgb, var(--color-blue) 10%, var(--background-secondary));
        border: 1px solid color-mix(in srgb, var(--color-blue) 28%, var(--background-modifier-border));
        color: var(--text-muted);
        max-width: 100%;
      }

      .hermes-mvp-bubble-error {
        background: color-mix(in srgb, var(--color-red) 10%, var(--background-secondary));
        border: 1px solid color-mix(in srgb, var(--color-red) 30%, var(--background-modifier-border));
        color: var(--text-normal);
        max-width: 100%;
      }

      .hermes-mvp-bubble-label {
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        opacity: 0.7;
        margin-bottom: 6px;
      }

      .hermes-mvp-bubble-body {
        font-size: 14px;
        line-height: 1.55;
        word-break: break-word;
        user-select: text;
        -webkit-user-select: text;
        cursor: text;
      }

      .hermes-mvp-bubble-body * {
        user-select: text;
        -webkit-user-select: text;
      }

      .hermes-mvp-bubble-body > :first-child {
        margin-top: 0;
      }

      .hermes-mvp-bubble-body > :last-child {
        margin-bottom: 0;
      }

      .hermes-mvp-composer {
        display: flex;
        align-items: flex-end;
        gap: 10px;
        padding: 14px 16px 16px;
        border-top: 1px solid var(--background-modifier-border);
        background: var(--background-primary);
      }

      .hermes-mvp-input-wrap {
        flex: 1;
        background: var(--background-secondary);
        border: 1px solid var(--background-modifier-border);
        border-radius: 16px;
        padding: 10px 12px;
      }

      .hermes-mvp-input {
        width: 100%;
        min-height: 24px;
        max-height: 220px;
        resize: none;
        border: 0;
        outline: none;
        background: transparent;
        box-shadow: none;
        color: var(--text-normal);
        font: inherit;
        line-height: 1.5;
        padding: 0;
      }

      .hermes-mvp-input::placeholder {
        color: var(--text-faint);
      }

      .hermes-mvp-send {
        border-radius: 14px;
        min-width: 80px;
        height: 44px;
      }
    `;
    document.head.appendChild(style);
  }
  async activateView() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_HERMES_MVP)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE_HERMES_MVP, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
  }
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsic3JjL21haW4udHMiLCAic3JjL3RyYW5zcG9ydC9oZXJtZXMtYWNwLWNsaWVudC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgQXBwLCBJdGVtVmlldywgTWFya2Rvd25SZW5kZXJlciwgTm90aWNlLCBQbHVnaW4sIFBsdWdpblNldHRpbmdUYWIsIFNldHRpbmcsIFdvcmtzcGFjZUxlYWYgfSBmcm9tICdvYnNpZGlhbic7XG5pbXBvcnQgeyBIZXJtZXNBQ1BDbGllbnQgfSBmcm9tICcuL3RyYW5zcG9ydC9oZXJtZXMtYWNwLWNsaWVudCc7XG5cbmNvbnN0IFZJRVdfVFlQRV9IRVJNRVNfTVZQID0gJ2hlcm1lcy1vYnNpZGlhbi1tdnAnO1xuXG50eXBlIENoYXRNZXNzYWdlID0ge1xuICByb2xlOiAndXNlcicgfCAnYXNzaXN0YW50JyB8ICdzdGF0dXMnIHwgJ2Vycm9yJztcbiAgdGV4dDogc3RyaW5nO1xufTtcblxuaW50ZXJmYWNlIEhlcm1lc1BsdWdpblNldHRpbmdzIHtcbiAgaGVybWVzQ29tbWFuZDogc3RyaW5nO1xuICBtZXNzYWdlczogQ2hhdE1lc3NhZ2VbXTtcbn1cblxuY29uc3QgREVGQVVMVF9TRVRUSU5HUzogSGVybWVzUGx1Z2luU2V0dGluZ3MgPSB7XG4gIGhlcm1lc0NvbW1hbmQ6ICdoZXJtZXMnLFxuICBtZXNzYWdlczogW10sXG59O1xuXG5jbGFzcyBIZXJtZXNNVlBWaWV3IGV4dGVuZHMgSXRlbVZpZXcge1xuICBwbHVnaW46IEhlcm1lc09ic2lkaWFuTVZQUGx1Z2luO1xuICBtZXNzYWdlczogQ2hhdE1lc3NhZ2VbXSA9IFtdO1xuICBwcml2YXRlIGlucHV0VmFsdWUgPSAnJztcbiAgcHJpdmF0ZSBpc1NlbmRpbmcgPSBmYWxzZTtcblxuICBjb25zdHJ1Y3RvcihsZWFmOiBXb3Jrc3BhY2VMZWFmLCBwbHVnaW46IEhlcm1lc09ic2lkaWFuTVZQUGx1Z2luKSB7XG4gICAgc3VwZXIobGVhZik7XG4gICAgdGhpcy5wbHVnaW4gPSBwbHVnaW47XG4gIH1cblxuICBnZXRWaWV3VHlwZSgpIHtcbiAgICByZXR1cm4gVklFV19UWVBFX0hFUk1FU19NVlA7XG4gIH1cblxuICBnZXREaXNwbGF5VGV4dCgpIHtcbiAgICByZXR1cm4gJ0hlcm1lcyc7XG4gIH1cblxuICBhc3luYyBvbk9wZW4oKSB7XG4gICAgdGhpcy5wbHVnaW4ucmVnaXN0ZXJWaWV3SW5zdGFuY2UodGhpcyk7XG4gICAgdGhpcy5tZXNzYWdlcyA9IEFycmF5LmlzQXJyYXkodGhpcy5wbHVnaW4uc2V0dGluZ3MubWVzc2FnZXMpXG4gICAgICA/IHRoaXMucGx1Z2luLnNldHRpbmdzLm1lc3NhZ2VzLm1hcChtZXNzYWdlID0+ICh7IC4uLm1lc3NhZ2UgfSkpXG4gICAgICA6IFtdO1xuICAgIHRoaXMucmVuZGVyKCk7XG4gICAgdm9pZCB0aGlzLnBsdWdpbi5yZXN0b3JlUmVtb3RlQ29udmVyc2F0aW9uKCk7XG4gIH1cblxuICBhc3luYyBvbkNsb3NlKCkge1xuICAgIHRoaXMucGx1Z2luLnVucmVnaXN0ZXJWaWV3SW5zdGFuY2UodGhpcyk7XG4gIH1cblxuICBzZXRNZXNzYWdlcyhtZXNzYWdlczogQ2hhdE1lc3NhZ2VbXSkge1xuICAgIHRoaXMubWVzc2FnZXMgPSBtZXNzYWdlcy5tYXAobWVzc2FnZSA9PiAoeyAuLi5tZXNzYWdlIH0pKTtcbiAgICB0aGlzLnBsdWdpbi5wZXJzaXN0TWVzc2FnZXModGhpcy5tZXNzYWdlcyk7XG4gICAgdGhpcy5yZW5kZXIoKTtcbiAgfVxuXG4gIGFwcGVuZE1lc3NhZ2Uocm9sZTogQ2hhdE1lc3NhZ2VbJ3JvbGUnXSwgdGV4dDogc3RyaW5nKSB7XG4gICAgaWYgKCF0ZXh0KSByZXR1cm47XG5cbiAgICBpZiAocm9sZSA9PT0gJ2Fzc2lzdGFudCcpIHtcbiAgICAgIGNvbnN0IGxhc3QgPSB0aGlzLm1lc3NhZ2VzW3RoaXMubWVzc2FnZXMubGVuZ3RoIC0gMV07XG4gICAgICBpZiAobGFzdCAmJiBsYXN0LnJvbGUgPT09ICdhc3Npc3RhbnQnKSB7XG4gICAgICAgIGxhc3QudGV4dCArPSB0ZXh0O1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhpcy5tZXNzYWdlcy5wdXNoKHsgcm9sZSwgdGV4dCB9KTtcbiAgICAgIH1cbiAgICB9IGVsc2UgaWYgKHJvbGUgPT09ICdzdGF0dXMnKSB7XG4gICAgICBjb25zdCBsYXN0ID0gdGhpcy5tZXNzYWdlc1t0aGlzLm1lc3NhZ2VzLmxlbmd0aCAtIDFdO1xuICAgICAgaWYgKGxhc3QgJiYgbGFzdC5yb2xlID09PSAnc3RhdHVzJykge1xuICAgICAgICBsYXN0LnRleHQgPSB0ZXh0O1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhpcy5tZXNzYWdlcy5wdXNoKHsgcm9sZSwgdGV4dCB9KTtcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5tZXNzYWdlcy5wdXNoKHsgcm9sZSwgdGV4dCB9KTtcbiAgICB9XG5cbiAgICB0aGlzLnBsdWdpbi5wZXJzaXN0TWVzc2FnZXModGhpcy5tZXNzYWdlcyk7XG4gICAgdGhpcy5yZW5kZXIoKTtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgc3VibWl0UHJvbXB0KCkge1xuICAgIGNvbnN0IHRleHQgPSB0aGlzLmlucHV0VmFsdWUudHJpbSgpO1xuICAgIGlmICghdGV4dCB8fCB0aGlzLmlzU2VuZGluZykgcmV0dXJuO1xuXG4gICAgdGhpcy5pbnB1dFZhbHVlID0gJyc7XG4gICAgdGhpcy5pc1NlbmRpbmcgPSB0cnVlO1xuICAgIHRoaXMubWVzc2FnZXMucHVzaCh7IHJvbGU6ICd1c2VyJywgdGV4dCB9KTtcbiAgICB0aGlzLm1lc3NhZ2VzLnB1c2goeyByb2xlOiAnYXNzaXN0YW50JywgdGV4dDogJycgfSk7XG4gICAgdGhpcy5wbHVnaW4ucGVyc2lzdE1lc3NhZ2VzKHRoaXMubWVzc2FnZXMpO1xuICAgIHRoaXMucmVuZGVyKCk7XG5cbiAgICB0cnkge1xuICAgICAgYXdhaXQgdGhpcy5wbHVnaW4uY2xpZW50LnNlbmRQcm9tcHQodGV4dCwgdGhpcy5wbHVnaW4uZ2V0VmF1bHRQYXRoKCkpO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBjb25zdCBtZXNzYWdlID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpO1xuICAgICAgdGhpcy5hcHBlbmRNZXNzYWdlKCdlcnJvcicsIG1lc3NhZ2UpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICB0aGlzLmlzU2VuZGluZyA9IGZhbHNlO1xuICAgICAgdGhpcy5yZW5kZXIoKTtcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIGdldExhYmVsKHJvbGU6IENoYXRNZXNzYWdlWydyb2xlJ10pIHtcbiAgICBzd2l0Y2ggKHJvbGUpIHtcbiAgICAgIGNhc2UgJ3VzZXInOlxuICAgICAgICByZXR1cm4gJ1lvdSc7XG4gICAgICBjYXNlICdhc3Npc3RhbnQnOlxuICAgICAgICByZXR1cm4gJ0hlcm1lcyc7XG4gICAgICBjYXNlICdzdGF0dXMnOlxuICAgICAgICByZXR1cm4gJ1N0YXR1cyc7XG4gICAgICBjYXNlICdlcnJvcic6XG4gICAgICAgIHJldHVybiAnRXJyb3InO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgcmVuZGVyTWVzc2FnZUJvZHkoY29udGFpbmVyOiBIVE1MRWxlbWVudCwgbXNnOiBDaGF0TWVzc2FnZSkge1xuICAgIGlmIChtc2cucm9sZSA9PT0gJ2Fzc2lzdGFudCcpIHtcbiAgICAgIGF3YWl0IE1hcmtkb3duUmVuZGVyZXIucmVuZGVyKHRoaXMuYXBwLCBtc2cudGV4dCB8fCAnXHUyMDI2JywgY29udGFpbmVyLCAnJywgdGhpcy5wbHVnaW4pO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGlmIChtc2cucm9sZSA9PT0gJ3N0YXR1cycpIHtcbiAgICAgIGNvbnRhaW5lci5zZXRUZXh0KG1zZy50ZXh0KTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjb250YWluZXIuc2V0VGV4dChtc2cudGV4dCB8fCAobXNnLnJvbGUgPT09ICdhc3Npc3RhbnQnID8gJ1x1MjAyNicgOiAnJykpO1xuICB9XG5cbiAgcmVuZGVyKCkge1xuICAgIGNvbnN0IHJvb3QgPSB0aGlzLmNvbnRhaW5lckVsLmNoaWxkcmVuWzFdIGFzIEhUTUxFbGVtZW50O1xuICAgIHJvb3QuZW1wdHkoKTtcbiAgICByb290LmFkZENsYXNzKCdoZXJtZXMtbXZwLXJvb3QnKTtcblxuICAgIGNvbnN0IHdyYXAgPSByb290LmNyZWF0ZURpdih7IGNsczogJ2hlcm1lcy1tdnAtd3JhcCcgfSk7XG4gICAgY29uc3QgaGVhZGVyID0gd3JhcC5jcmVhdGVEaXYoeyBjbHM6ICdoZXJtZXMtbXZwLWhlYWRlcicgfSk7XG4gICAgaGVhZGVyLmNyZWF0ZURpdih7IGNsczogJ2hlcm1lcy1tdnAtdGl0bGUnLCB0ZXh0OiAnSGVybWVzJyB9KTtcbiAgICBoZWFkZXIuY3JlYXRlRGl2KHtcbiAgICAgIGNsczogJ2hlcm1lcy1tdnAtc3VidGl0bGUnLFxuICAgICAgdGV4dDogdGhpcy5pc1NlbmRpbmcgPyAnVGhpbmtpbmdcdTIwMjYnIDogJ0xvY2FsIE9ic2lkaWFuIGNoYXQnLFxuICAgIH0pO1xuXG4gICAgY29uc3QgbGlzdCA9IHdyYXAuY3JlYXRlRGl2KHsgY2xzOiAnaGVybWVzLW12cC1tZXNzYWdlcycgfSk7XG5cbiAgICBpZiAodGhpcy5tZXNzYWdlcy5sZW5ndGggPT09IDApIHtcbiAgICAgIGNvbnN0IGVtcHR5ID0gbGlzdC5jcmVhdGVEaXYoeyBjbHM6ICdoZXJtZXMtbXZwLWVtcHR5JyB9KTtcbiAgICAgIGVtcHR5LmNyZWF0ZURpdih7IGNsczogJ2hlcm1lcy1tdnAtZW1wdHktdGl0bGUnLCB0ZXh0OiAnU3RhcnQgYSBjb252ZXJzYXRpb24nIH0pO1xuICAgICAgZW1wdHkuY3JlYXRlRGl2KHtcbiAgICAgICAgY2xzOiAnaGVybWVzLW12cC1lbXB0eS1zdWJ0aXRsZScsXG4gICAgICAgIHRleHQ6ICdBc2sgSGVybWVzIHRvIGJyYWluc3Rvcm0sIHdyaXRlLCBzdW1tYXJpemUsIG9yIGhlbHAgeW91IHRoaW5rIHRocm91Z2ggYSBub3RlLicsXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICBmb3IgKGNvbnN0IG1zZyBvZiB0aGlzLm1lc3NhZ2VzKSB7XG4gICAgICBjb25zdCByb3cgPSBsaXN0LmNyZWF0ZURpdih7IGNsczogYGhlcm1lcy1tdnAtcm93IGhlcm1lcy1tdnAtcm93LSR7bXNnLnJvbGV9YCB9KTtcbiAgICAgIGNvbnN0IGJ1YmJsZSA9IHJvdy5jcmVhdGVEaXYoeyBjbHM6IGBoZXJtZXMtbXZwLWJ1YmJsZSBoZXJtZXMtbXZwLWJ1YmJsZS0ke21zZy5yb2xlfWAgfSk7XG4gICAgICBidWJibGUuY3JlYXRlRGl2KHsgY2xzOiAnaGVybWVzLW12cC1idWJibGUtbGFiZWwnLCB0ZXh0OiB0aGlzLmdldExhYmVsKG1zZy5yb2xlKSB9KTtcbiAgICAgIGNvbnN0IGJvZHkgPSBidWJibGUuY3JlYXRlRGl2KHsgY2xzOiAnaGVybWVzLW12cC1idWJibGUtYm9keScgfSk7XG4gICAgICB2b2lkIHRoaXMucmVuZGVyTWVzc2FnZUJvZHkoYm9keSwgbXNnKTtcbiAgICB9XG5cbiAgICBjb25zdCBjb21wb3NlciA9IHdyYXAuY3JlYXRlRGl2KHsgY2xzOiAnaGVybWVzLW12cC1jb21wb3NlcicgfSk7XG4gICAgY29uc3QgaW5wdXRXcmFwID0gY29tcG9zZXIuY3JlYXRlRGl2KHsgY2xzOiAnaGVybWVzLW12cC1pbnB1dC13cmFwJyB9KTtcbiAgICBjb25zdCBpbnB1dCA9IGlucHV0V3JhcC5jcmVhdGVFbCgndGV4dGFyZWEnLCB7XG4gICAgICBjbHM6ICdoZXJtZXMtbXZwLWlucHV0JyxcbiAgICAgIGF0dHI6IHsgcm93czogJzEnLCBwbGFjZWhvbGRlcjogJ01lc3NhZ2UgSGVybWVzXHUyMDI2JyB9LFxuICAgIH0pO1xuICAgIGlucHV0LnZhbHVlID0gdGhpcy5pbnB1dFZhbHVlO1xuICAgIGlucHV0LmRpc2FibGVkID0gdGhpcy5pc1NlbmRpbmc7XG4gICAgaW5wdXQuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLCAoKSA9PiB7XG4gICAgICB0aGlzLmlucHV0VmFsdWUgPSBpbnB1dC52YWx1ZTtcbiAgICAgIGlucHV0LnN0eWxlLmhlaWdodCA9ICcwcHgnO1xuICAgICAgaW5wdXQuc3R5bGUuaGVpZ2h0ID0gYCR7TWF0aC5taW4oaW5wdXQuc2Nyb2xsSGVpZ2h0LCAyMjApfXB4YDtcbiAgICB9KTtcbiAgICBpbnB1dC5hZGRFdmVudExpc3RlbmVyKCdrZXlkb3duJywgZXZ0ID0+IHtcbiAgICAgIGlmIChldnQua2V5ID09PSAnRW50ZXInICYmICFldnQuc2hpZnRLZXkpIHtcbiAgICAgICAgZXZ0LnByZXZlbnREZWZhdWx0KCk7XG4gICAgICAgIHZvaWQgdGhpcy5zdWJtaXRQcm9tcHQoKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgICBpbnB1dC5zdHlsZS5oZWlnaHQgPSAnMHB4JztcbiAgICBpbnB1dC5zdHlsZS5oZWlnaHQgPSBgJHtNYXRoLm1pbihpbnB1dC5zY3JvbGxIZWlnaHQsIDIyMCl9cHhgO1xuXG4gICAgY29uc3QgYnV0dG9uID0gY29tcG9zZXIuY3JlYXRlRWwoJ2J1dHRvbicsIHtcbiAgICAgIGNsczogJ21vZC1jdGEgaGVybWVzLW12cC1zZW5kJyxcbiAgICAgIHRleHQ6IHRoaXMuaXNTZW5kaW5nID8gJ1NlbmRpbmdcdTIwMjYnIDogJ1NlbmQnLFxuICAgIH0pO1xuICAgIGJ1dHRvbi5kaXNhYmxlZCA9IHRoaXMuaXNTZW5kaW5nO1xuICAgIGJ1dHRvbi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHtcbiAgICAgIHZvaWQgdGhpcy5zdWJtaXRQcm9tcHQoKTtcbiAgICB9KTtcblxuICAgIGxpc3Quc2Nyb2xsVG9wID0gbGlzdC5zY3JvbGxIZWlnaHQ7XG4gIH1cbn1cblxuY2xhc3MgSGVybWVzU2V0dGluZ1RhYiBleHRlbmRzIFBsdWdpblNldHRpbmdUYWIge1xuICBwbHVnaW46IEhlcm1lc09ic2lkaWFuTVZQUGx1Z2luO1xuXG4gIGNvbnN0cnVjdG9yKGFwcDogQXBwLCBwbHVnaW46IEhlcm1lc09ic2lkaWFuTVZQUGx1Z2luKSB7XG4gICAgc3VwZXIoYXBwLCBwbHVnaW4pO1xuICAgIHRoaXMucGx1Z2luID0gcGx1Z2luO1xuICB9XG5cbiAgZGlzcGxheSgpOiB2b2lkIHtcbiAgICBjb25zdCB7IGNvbnRhaW5lckVsIH0gPSB0aGlzO1xuICAgIGNvbnRhaW5lckVsLmVtcHR5KCk7XG5cbiAgICBuZXcgU2V0dGluZyhjb250YWluZXJFbClcbiAgICAgIC5zZXROYW1lKCdIZXJtZXMgY29tbWFuZCcpXG4gICAgICAuc2V0RGVzYygnQ29tbWFuZCB1c2VkIHRvIGxhdW5jaCBIZXJtZXMgQUNQIGxvY2FsbHkuJylcbiAgICAgIC5hZGRUZXh0KHRleHQgPT5cbiAgICAgICAgdGV4dFxuICAgICAgICAgIC5zZXRQbGFjZWhvbGRlcignaGVybWVzJylcbiAgICAgICAgICAuc2V0VmFsdWUodGhpcy5wbHVnaW4uc2V0dGluZ3MuaGVybWVzQ29tbWFuZClcbiAgICAgICAgICAub25DaGFuZ2UoYXN5bmMgdmFsdWUgPT4ge1xuICAgICAgICAgICAgdGhpcy5wbHVnaW4uc2V0dGluZ3MuaGVybWVzQ29tbWFuZCA9IHZhbHVlLnRyaW0oKSB8fCAnaGVybWVzJztcbiAgICAgICAgICAgIGF3YWl0IHRoaXMucGx1Z2luLnNhdmVTZXR0aW5ncygpO1xuICAgICAgICAgICAgbmV3IE5vdGljZSgnSGVybWVzIGNvbW1hbmQgc2F2ZWQnKTtcbiAgICAgICAgICB9KSxcbiAgICAgICk7XG4gIH1cbn1cblxuZXhwb3J0IGRlZmF1bHQgY2xhc3MgSGVybWVzT2JzaWRpYW5NVlBQbHVnaW4gZXh0ZW5kcyBQbHVnaW4ge1xuICBzZXR0aW5ncyE6IEhlcm1lc1BsdWdpblNldHRpbmdzO1xuICBjbGllbnQhOiBIZXJtZXNBQ1BDbGllbnQ7XG4gIHByaXZhdGUgYWN0aXZlVmlldzogSGVybWVzTVZQVmlldyB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIHJlc3RvcmVBdHRlbXB0ZWQgPSBmYWxzZTtcblxuICBhc3luYyBvbmxvYWQoKSB7XG4gICAgdGhpcy5zZXR0aW5ncyA9IE9iamVjdC5hc3NpZ24oe30sIERFRkFVTFRfU0VUVElOR1MsIGF3YWl0IHRoaXMubG9hZERhdGEoKSk7XG4gICAgdGhpcy5jbGllbnQgPSBuZXcgSGVybWVzQUNQQ2xpZW50KHRoaXMuc2V0dGluZ3MuaGVybWVzQ29tbWFuZCk7XG4gICAgdGhpcy53aXJlQ2xpZW50Q2FsbGJhY2tzKCk7XG4gICAgdGhpcy5pbmplY3RTdHlsZXMoKTtcblxuICAgIHRoaXMucmVnaXN0ZXJWaWV3KFZJRVdfVFlQRV9IRVJNRVNfTVZQLCBsZWFmID0+IG5ldyBIZXJtZXNNVlBWaWV3KGxlYWYsIHRoaXMpKTtcbiAgICB0aGlzLmFkZFNldHRpbmdUYWIobmV3IEhlcm1lc1NldHRpbmdUYWIodGhpcy5hcHAsIHRoaXMpKTtcblxuICAgIHRoaXMuYWRkUmliYm9uSWNvbignYm90JywgJ09wZW4gSGVybWVzIE1WUCcsIGFzeW5jICgpID0+IHtcbiAgICAgIGF3YWl0IHRoaXMuYWN0aXZhdGVWaWV3KCk7XG4gICAgfSk7XG5cbiAgICB0aGlzLmFkZENvbW1hbmQoe1xuICAgICAgaWQ6ICdvcGVuLWhlcm1lcy1tdnAnLFxuICAgICAgbmFtZTogJ09wZW4gSGVybWVzIE1WUCcsXG4gICAgICBjYWxsYmFjazogYXN5bmMgKCkgPT4gdGhpcy5hY3RpdmF0ZVZpZXcoKSxcbiAgICB9KTtcbiAgfVxuXG4gIGFzeW5jIG9udW5sb2FkKCkge1xuICAgIHRoaXMuYXBwLndvcmtzcGFjZS5kZXRhY2hMZWF2ZXNPZlR5cGUoVklFV19UWVBFX0hFUk1FU19NVlApO1xuICB9XG5cbiAgcmVnaXN0ZXJWaWV3SW5zdGFuY2UodmlldzogSGVybWVzTVZQVmlldykge1xuICAgIHRoaXMuYWN0aXZlVmlldyA9IHZpZXc7XG4gIH1cblxuICB1bnJlZ2lzdGVyVmlld0luc3RhbmNlKHZpZXc6IEhlcm1lc01WUFZpZXcpIHtcbiAgICBpZiAodGhpcy5hY3RpdmVWaWV3ID09PSB2aWV3KSB0aGlzLmFjdGl2ZVZpZXcgPSBudWxsO1xuICB9XG5cbiAgZ2V0VmF1bHRQYXRoKCkge1xuICAgIHJldHVybiB0aGlzLmFwcC52YXVsdC5hZGFwdGVyLmJhc2VQYXRoIHx8IHByb2Nlc3MuY3dkKCk7XG4gIH1cblxuICBhc3luYyBzYXZlU2V0dGluZ3MoKSB7XG4gICAgYXdhaXQgdGhpcy5zYXZlRGF0YSh0aGlzLnNldHRpbmdzKTtcbiAgICB0aGlzLmNsaWVudCA9IG5ldyBIZXJtZXNBQ1BDbGllbnQodGhpcy5zZXR0aW5ncy5oZXJtZXNDb21tYW5kKTtcbiAgICB0aGlzLndpcmVDbGllbnRDYWxsYmFja3MoKTtcbiAgfVxuXG4gIHBlcnNpc3RNZXNzYWdlcyhtZXNzYWdlczogQ2hhdE1lc3NhZ2VbXSkge1xuICAgIHRoaXMuc2V0dGluZ3MubWVzc2FnZXMgPSBtZXNzYWdlcy5tYXAobWVzc2FnZSA9PiAoeyAuLi5tZXNzYWdlIH0pKTtcbiAgICB2b2lkIHRoaXMuc2F2ZURhdGEodGhpcy5zZXR0aW5ncyk7XG4gIH1cblxuICBhc3luYyByZXN0b3JlUmVtb3RlQ29udmVyc2F0aW9uKCkge1xuICAgIGlmICh0aGlzLnJlc3RvcmVBdHRlbXB0ZWQpIHJldHVybjtcbiAgICB0aGlzLnJlc3RvcmVBdHRlbXB0ZWQgPSB0cnVlO1xuXG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IHRoaXMuY2xpZW50LnJlc3RvcmVMYXRlc3RTZXNzaW9uKHRoaXMuZ2V0VmF1bHRQYXRoKCkpO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBjb25zb2xlLndhcm4oJ1tIZXJtZXMgTVZQXSBGYWlsZWQgdG8gcmVzdG9yZSBsYXRlc3Qgc2Vzc2lvbicsIGVycm9yKTtcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIHdpcmVDbGllbnRDYWxsYmFja3MoKSB7XG4gICAgdGhpcy5jbGllbnQub25Bc3Npc3RhbnRUZXh0ID0gKHRleHQ6IHN0cmluZykgPT4ge1xuICAgICAgdGhpcy5hY3RpdmVWaWV3Py5hcHBlbmRNZXNzYWdlKCdhc3Npc3RhbnQnLCB0ZXh0KTtcbiAgICB9O1xuXG4gICAgdGhpcy5jbGllbnQub25TdGF0dXMgPSAodGV4dDogc3RyaW5nKSA9PiB7XG4gICAgICB0aGlzLmFjdGl2ZVZpZXc/LmFwcGVuZE1lc3NhZ2UoJ3N0YXR1cycsIHRleHQpO1xuICAgIH07XG5cbiAgICB0aGlzLmNsaWVudC5vbkVycm9yID0gKHRleHQ6IHN0cmluZykgPT4ge1xuICAgICAgdGhpcy5hY3RpdmVWaWV3Py5hcHBlbmRNZXNzYWdlKCdlcnJvcicsIHRleHQpO1xuICAgICAgbmV3IE5vdGljZSh0ZXh0KTtcbiAgICB9O1xuICB9XG5cbiAgcHJpdmF0ZSBpbmplY3RTdHlsZXMoKSB7XG4gICAgY29uc3Qgc3R5bGVJZCA9ICdoZXJtZXMtbXZwLWlubGluZS1zdHlsZXMnO1xuICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKHN0eWxlSWQpPy5yZW1vdmUoKTtcblxuICAgIGNvbnN0IHN0eWxlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnc3R5bGUnKTtcbiAgICBzdHlsZS5pZCA9IHN0eWxlSWQ7XG4gICAgc3R5bGUudGV4dENvbnRlbnQgPSBgXG4gICAgICAuaGVybWVzLW12cC1yb290IHtcbiAgICAgICAgaGVpZ2h0OiAxMDAlO1xuICAgICAgfVxuXG4gICAgICAuaGVybWVzLW12cC13cmFwIHtcbiAgICAgICAgZGlzcGxheTogZmxleDtcbiAgICAgICAgZmxleC1kaXJlY3Rpb246IGNvbHVtbjtcbiAgICAgICAgaGVpZ2h0OiAxMDAlO1xuICAgICAgICBiYWNrZ3JvdW5kOiB2YXIoLS1iYWNrZ3JvdW5kLXByaW1hcnkpO1xuICAgICAgICBjb2xvcjogdmFyKC0tdGV4dC1ub3JtYWwpO1xuICAgICAgfVxuXG4gICAgICAuaGVybWVzLW12cC1oZWFkZXIge1xuICAgICAgICBwYWRkaW5nOiAxNHB4IDE2cHggMTBweDtcbiAgICAgICAgYm9yZGVyLWJvdHRvbTogMXB4IHNvbGlkIHZhcigtLWJhY2tncm91bmQtbW9kaWZpZXItYm9yZGVyKTtcbiAgICAgICAgYmFja2dyb3VuZDogY29sb3ItbWl4KGluIHNyZ2IsIHZhcigtLWJhY2tncm91bmQtc2Vjb25kYXJ5KSA3MCUsIHRyYW5zcGFyZW50KTtcbiAgICAgIH1cblxuICAgICAgLmhlcm1lcy1tdnAtdGl0bGUge1xuICAgICAgICBmb250LXNpemU6IDE4cHg7XG4gICAgICAgIGZvbnQtd2VpZ2h0OiA3MDA7XG4gICAgICAgIGxldHRlci1zcGFjaW5nOiAtMC4wMWVtO1xuICAgICAgfVxuXG4gICAgICAuaGVybWVzLW12cC1zdWJ0aXRsZSB7XG4gICAgICAgIG1hcmdpbi10b3A6IDJweDtcbiAgICAgICAgZm9udC1zaXplOiAxMnB4O1xuICAgICAgICBjb2xvcjogdmFyKC0tdGV4dC1tdXRlZCk7XG4gICAgICB9XG5cbiAgICAgIC5oZXJtZXMtbXZwLW1lc3NhZ2VzIHtcbiAgICAgICAgZmxleDogMTtcbiAgICAgICAgb3ZlcmZsb3cteTogYXV0bztcbiAgICAgICAgcGFkZGluZzogMThweCAxNnB4IDI0cHg7XG4gICAgICAgIGRpc3BsYXk6IGZsZXg7XG4gICAgICAgIGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47XG4gICAgICAgIGdhcDogMTJweDtcbiAgICAgIH1cblxuICAgICAgLmhlcm1lcy1tdnAtZW1wdHkge1xuICAgICAgICBtYXJnaW46IGF1dG8gMDtcbiAgICAgICAgcGFkZGluZzogMjRweCAxOHB4O1xuICAgICAgICBib3JkZXI6IDFweCBkYXNoZWQgdmFyKC0tYmFja2dyb3VuZC1tb2RpZmllci1ib3JkZXIpO1xuICAgICAgICBib3JkZXItcmFkaXVzOiAxNnB4O1xuICAgICAgICBiYWNrZ3JvdW5kOiBjb2xvci1taXgoaW4gc3JnYiwgdmFyKC0tYmFja2dyb3VuZC1zZWNvbmRhcnkpIDU1JSwgdHJhbnNwYXJlbnQpO1xuICAgICAgfVxuXG4gICAgICAuaGVybWVzLW12cC1lbXB0eS10aXRsZSB7XG4gICAgICAgIGZvbnQtc2l6ZTogMTZweDtcbiAgICAgICAgZm9udC13ZWlnaHQ6IDYwMDtcbiAgICAgICAgbWFyZ2luLWJvdHRvbTogNnB4O1xuICAgICAgfVxuXG4gICAgICAuaGVybWVzLW12cC1lbXB0eS1zdWJ0aXRsZSB7XG4gICAgICAgIGZvbnQtc2l6ZTogMTNweDtcbiAgICAgICAgbGluZS1oZWlnaHQ6IDEuNTtcbiAgICAgICAgY29sb3I6IHZhcigtLXRleHQtbXV0ZWQpO1xuICAgICAgfVxuXG4gICAgICAuaGVybWVzLW12cC1yb3cge1xuICAgICAgICBkaXNwbGF5OiBmbGV4O1xuICAgICAgfVxuXG4gICAgICAuaGVybWVzLW12cC1yb3ctdXNlciB7XG4gICAgICAgIGp1c3RpZnktY29udGVudDogZmxleC1lbmQ7XG4gICAgICB9XG5cbiAgICAgIC5oZXJtZXMtbXZwLXJvdy1hc3Npc3RhbnQsXG4gICAgICAuaGVybWVzLW12cC1yb3ctc3RhdHVzLFxuICAgICAgLmhlcm1lcy1tdnAtcm93LWVycm9yIHtcbiAgICAgICAganVzdGlmeS1jb250ZW50OiBmbGV4LXN0YXJ0O1xuICAgICAgfVxuXG4gICAgICAuaGVybWVzLW12cC1idWJibGUge1xuICAgICAgICBtYXgtd2lkdGg6IG1pbig2ODBweCwgOTIlKTtcbiAgICAgICAgYm9yZGVyLXJhZGl1czogMTZweDtcbiAgICAgICAgcGFkZGluZzogMTBweCAxMnB4O1xuICAgICAgICBib3gtc2hhZG93OiAwIDFweCAycHggcmdiKDAgMCAwIC8gMC4wOCk7XG4gICAgICB9XG5cbiAgICAgIC5oZXJtZXMtbXZwLWJ1YmJsZS11c2VyIHtcbiAgICAgICAgYmFja2dyb3VuZDogdmFyKC0taW50ZXJhY3RpdmUtYWNjZW50KTtcbiAgICAgICAgY29sb3I6IHZhcigtLXRleHQtb24tYWNjZW50KTtcbiAgICAgICAgYm9yZGVyLWJvdHRvbS1yaWdodC1yYWRpdXM6IDZweDtcbiAgICAgIH1cblxuICAgICAgLmhlcm1lcy1tdnAtYnViYmxlLWFzc2lzdGFudCB7XG4gICAgICAgIGJhY2tncm91bmQ6IHZhcigtLWJhY2tncm91bmQtc2Vjb25kYXJ5KTtcbiAgICAgICAgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYmFja2dyb3VuZC1tb2RpZmllci1ib3JkZXIpO1xuICAgICAgICBib3JkZXItYm90dG9tLWxlZnQtcmFkaXVzOiA2cHg7XG4gICAgICB9XG5cbiAgICAgIC5oZXJtZXMtbXZwLWJ1YmJsZS1zdGF0dXMge1xuICAgICAgICBiYWNrZ3JvdW5kOiBjb2xvci1taXgoaW4gc3JnYiwgdmFyKC0tY29sb3ItYmx1ZSkgMTAlLCB2YXIoLS1iYWNrZ3JvdW5kLXNlY29uZGFyeSkpO1xuICAgICAgICBib3JkZXI6IDFweCBzb2xpZCBjb2xvci1taXgoaW4gc3JnYiwgdmFyKC0tY29sb3ItYmx1ZSkgMjglLCB2YXIoLS1iYWNrZ3JvdW5kLW1vZGlmaWVyLWJvcmRlcikpO1xuICAgICAgICBjb2xvcjogdmFyKC0tdGV4dC1tdXRlZCk7XG4gICAgICAgIG1heC13aWR0aDogMTAwJTtcbiAgICAgIH1cblxuICAgICAgLmhlcm1lcy1tdnAtYnViYmxlLWVycm9yIHtcbiAgICAgICAgYmFja2dyb3VuZDogY29sb3ItbWl4KGluIHNyZ2IsIHZhcigtLWNvbG9yLXJlZCkgMTAlLCB2YXIoLS1iYWNrZ3JvdW5kLXNlY29uZGFyeSkpO1xuICAgICAgICBib3JkZXI6IDFweCBzb2xpZCBjb2xvci1taXgoaW4gc3JnYiwgdmFyKC0tY29sb3ItcmVkKSAzMCUsIHZhcigtLWJhY2tncm91bmQtbW9kaWZpZXItYm9yZGVyKSk7XG4gICAgICAgIGNvbG9yOiB2YXIoLS10ZXh0LW5vcm1hbCk7XG4gICAgICAgIG1heC13aWR0aDogMTAwJTtcbiAgICAgIH1cblxuICAgICAgLmhlcm1lcy1tdnAtYnViYmxlLWxhYmVsIHtcbiAgICAgICAgZm9udC1zaXplOiAxMXB4O1xuICAgICAgICBmb250LXdlaWdodDogNzAwO1xuICAgICAgICB0ZXh0LXRyYW5zZm9ybTogdXBwZXJjYXNlO1xuICAgICAgICBsZXR0ZXItc3BhY2luZzogMC4wNGVtO1xuICAgICAgICBvcGFjaXR5OiAwLjc7XG4gICAgICAgIG1hcmdpbi1ib3R0b206IDZweDtcbiAgICAgIH1cblxuICAgICAgLmhlcm1lcy1tdnAtYnViYmxlLWJvZHkge1xuICAgICAgICBmb250LXNpemU6IDE0cHg7XG4gICAgICAgIGxpbmUtaGVpZ2h0OiAxLjU1O1xuICAgICAgICB3b3JkLWJyZWFrOiBicmVhay13b3JkO1xuICAgICAgICB1c2VyLXNlbGVjdDogdGV4dDtcbiAgICAgICAgLXdlYmtpdC11c2VyLXNlbGVjdDogdGV4dDtcbiAgICAgICAgY3Vyc29yOiB0ZXh0O1xuICAgICAgfVxuXG4gICAgICAuaGVybWVzLW12cC1idWJibGUtYm9keSAqIHtcbiAgICAgICAgdXNlci1zZWxlY3Q6IHRleHQ7XG4gICAgICAgIC13ZWJraXQtdXNlci1zZWxlY3Q6IHRleHQ7XG4gICAgICB9XG5cbiAgICAgIC5oZXJtZXMtbXZwLWJ1YmJsZS1ib2R5ID4gOmZpcnN0LWNoaWxkIHtcbiAgICAgICAgbWFyZ2luLXRvcDogMDtcbiAgICAgIH1cblxuICAgICAgLmhlcm1lcy1tdnAtYnViYmxlLWJvZHkgPiA6bGFzdC1jaGlsZCB7XG4gICAgICAgIG1hcmdpbi1ib3R0b206IDA7XG4gICAgICB9XG5cbiAgICAgIC5oZXJtZXMtbXZwLWNvbXBvc2VyIHtcbiAgICAgICAgZGlzcGxheTogZmxleDtcbiAgICAgICAgYWxpZ24taXRlbXM6IGZsZXgtZW5kO1xuICAgICAgICBnYXA6IDEwcHg7XG4gICAgICAgIHBhZGRpbmc6IDE0cHggMTZweCAxNnB4O1xuICAgICAgICBib3JkZXItdG9wOiAxcHggc29saWQgdmFyKC0tYmFja2dyb3VuZC1tb2RpZmllci1ib3JkZXIpO1xuICAgICAgICBiYWNrZ3JvdW5kOiB2YXIoLS1iYWNrZ3JvdW5kLXByaW1hcnkpO1xuICAgICAgfVxuXG4gICAgICAuaGVybWVzLW12cC1pbnB1dC13cmFwIHtcbiAgICAgICAgZmxleDogMTtcbiAgICAgICAgYmFja2dyb3VuZDogdmFyKC0tYmFja2dyb3VuZC1zZWNvbmRhcnkpO1xuICAgICAgICBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1iYWNrZ3JvdW5kLW1vZGlmaWVyLWJvcmRlcik7XG4gICAgICAgIGJvcmRlci1yYWRpdXM6IDE2cHg7XG4gICAgICAgIHBhZGRpbmc6IDEwcHggMTJweDtcbiAgICAgIH1cblxuICAgICAgLmhlcm1lcy1tdnAtaW5wdXQge1xuICAgICAgICB3aWR0aDogMTAwJTtcbiAgICAgICAgbWluLWhlaWdodDogMjRweDtcbiAgICAgICAgbWF4LWhlaWdodDogMjIwcHg7XG4gICAgICAgIHJlc2l6ZTogbm9uZTtcbiAgICAgICAgYm9yZGVyOiAwO1xuICAgICAgICBvdXRsaW5lOiBub25lO1xuICAgICAgICBiYWNrZ3JvdW5kOiB0cmFuc3BhcmVudDtcbiAgICAgICAgYm94LXNoYWRvdzogbm9uZTtcbiAgICAgICAgY29sb3I6IHZhcigtLXRleHQtbm9ybWFsKTtcbiAgICAgICAgZm9udDogaW5oZXJpdDtcbiAgICAgICAgbGluZS1oZWlnaHQ6IDEuNTtcbiAgICAgICAgcGFkZGluZzogMDtcbiAgICAgIH1cblxuICAgICAgLmhlcm1lcy1tdnAtaW5wdXQ6OnBsYWNlaG9sZGVyIHtcbiAgICAgICAgY29sb3I6IHZhcigtLXRleHQtZmFpbnQpO1xuICAgICAgfVxuXG4gICAgICAuaGVybWVzLW12cC1zZW5kIHtcbiAgICAgICAgYm9yZGVyLXJhZGl1czogMTRweDtcbiAgICAgICAgbWluLXdpZHRoOiA4MHB4O1xuICAgICAgICBoZWlnaHQ6IDQ0cHg7XG4gICAgICB9XG4gICAgYDtcblxuICAgIGRvY3VtZW50LmhlYWQuYXBwZW5kQ2hpbGQoc3R5bGUpO1xuICB9XG5cbiAgYXN5bmMgYWN0aXZhdGVWaWV3KCkge1xuICAgIGxldCBsZWFmID0gdGhpcy5hcHAud29ya3NwYWNlLmdldExlYXZlc09mVHlwZShWSUVXX1RZUEVfSEVSTUVTX01WUClbMF07XG4gICAgaWYgKCFsZWFmKSB7XG4gICAgICBsZWFmID0gdGhpcy5hcHAud29ya3NwYWNlLmdldFJpZ2h0TGVhZihmYWxzZSk7XG4gICAgICBhd2FpdCBsZWFmLnNldFZpZXdTdGF0ZSh7IHR5cGU6IFZJRVdfVFlQRV9IRVJNRVNfTVZQLCBhY3RpdmU6IHRydWUgfSk7XG4gICAgfVxuICAgIGF3YWl0IHRoaXMuYXBwLndvcmtzcGFjZS5yZXZlYWxMZWFmKGxlYWYpO1xuICB9XG59XG4iLCAiaW1wb3J0IHsgQ2hpbGRQcm9jZXNzV2l0aG91dE51bGxTdHJlYW1zLCBzcGF3biB9IGZyb20gJ2NoaWxkX3Byb2Nlc3MnO1xuaW1wb3J0IHsgZXhpc3RzU3luYyB9IGZyb20gJ2ZzJztcblxudHlwZSBQZW5kaW5nUmVxdWVzdCA9IHtcbiAgcmVzb2x2ZTogKHZhbHVlOiBhbnkpID0+IHZvaWQ7XG4gIHJlamVjdDogKHJlYXNvbj86IHVua25vd24pID0+IHZvaWQ7XG59O1xuXG50eXBlIFNlc3Npb25VcGRhdGVQYXJhbXMgPSB7XG4gIHNlc3Npb25JZD86IHN0cmluZztcbiAgc2Vzc2lvbl9pZD86IHN0cmluZztcbiAgdXBkYXRlPzogUmVjb3JkPHN0cmluZywgYW55Pjtcbn07XG5cbnR5cGUgU2Vzc2lvblN1bW1hcnkgPSB7XG4gIGlkOiBzdHJpbmc7XG4gIFtrZXk6IHN0cmluZ106IGFueTtcbn07XG5cbmV4cG9ydCBjbGFzcyBIZXJtZXNBQ1BDbGllbnQge1xuICBwcml2YXRlIHByb2M6IENoaWxkUHJvY2Vzc1dpdGhvdXROdWxsU3RyZWFtcyB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIGJ1ZmZlciA9ICcnO1xuICBwcml2YXRlIG5leHRJZCA9IDE7XG4gIHByaXZhdGUgcGVuZGluZyA9IG5ldyBNYXA8bnVtYmVyLCBQZW5kaW5nUmVxdWVzdD4oKTtcbiAgcHJpdmF0ZSBpbml0aWFsaXplZCA9IGZhbHNlO1xuICBwcml2YXRlIHNlc3Npb25JZDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gIG9uQXNzaXN0YW50VGV4dD86ICh0ZXh0OiBzdHJpbmcpID0+IHZvaWQ7XG4gIG9uU3RhdHVzPzogKHRleHQ6IHN0cmluZykgPT4gdm9pZDtcbiAgb25FcnJvcj86ICh0ZXh0OiBzdHJpbmcpID0+IHZvaWQ7XG5cbiAgY29uc3RydWN0b3IocHJpdmF0ZSBoZXJtZXNDb21tYW5kOiBzdHJpbmcpIHt9XG5cbiAgcHJpdmF0ZSByZXNvbHZlSGVybWVzQ29tbWFuZCgpIHtcbiAgICBpZiAodGhpcy5oZXJtZXNDb21tYW5kLmluY2x1ZGVzKCcvJykgfHwgdGhpcy5oZXJtZXNDb21tYW5kLmluY2x1ZGVzKCdcXFxcJykpIHtcbiAgICAgIHJldHVybiB0aGlzLmhlcm1lc0NvbW1hbmQ7XG4gICAgfVxuXG4gICAgY29uc3QgaG9tZSA9IHByb2Nlc3MuZW52LkhPTUU7XG4gICAgY29uc3QgY2FuZGlkYXRlcyA9IFtcbiAgICAgIHRoaXMuaGVybWVzQ29tbWFuZCxcbiAgICAgIGhvbWUgPyBgJHtob21lfS8ubG9jYWwvYmluLyR7dGhpcy5oZXJtZXNDb21tYW5kfWAgOiBudWxsLFxuICAgICAgaG9tZSA/IGAke2hvbWV9Ly5ucG0tZ2xvYmFsL2Jpbi8ke3RoaXMuaGVybWVzQ29tbWFuZH1gIDogbnVsbCxcbiAgICAgIGAvdXNyL2xvY2FsL2Jpbi8ke3RoaXMuaGVybWVzQ29tbWFuZH1gLFxuICAgICAgYC9vcHQvaG9tZWJyZXcvYmluLyR7dGhpcy5oZXJtZXNDb21tYW5kfWAsXG4gICAgXS5maWx0ZXIoKHZhbHVlKTogdmFsdWUgaXMgc3RyaW5nID0+IEJvb2xlYW4odmFsdWUpKTtcblxuICAgIGZvciAoY29uc3QgY2FuZGlkYXRlIG9mIGNhbmRpZGF0ZXMpIHtcbiAgICAgIGlmIChjYW5kaWRhdGUgPT09IHRoaXMuaGVybWVzQ29tbWFuZCB8fCBleGlzdHNTeW5jKGNhbmRpZGF0ZSkpIHJldHVybiBjYW5kaWRhdGU7XG4gICAgfVxuXG4gICAgcmV0dXJuIHRoaXMuaGVybWVzQ29tbWFuZDtcbiAgfVxuXG4gIHByaXZhdGUgZW5zdXJlU3RhcnRlZChjd2Q/OiBzdHJpbmcpIHtcbiAgICBpZiAodGhpcy5wcm9jKSByZXR1cm47XG5cbiAgICBjb25zdCBjb21tYW5kID0gdGhpcy5yZXNvbHZlSGVybWVzQ29tbWFuZCgpO1xuXG4gICAgdGhpcy5wcm9jID0gc3Bhd24oY29tbWFuZCwgWydhY3AnXSwge1xuICAgICAgY3dkOiBjd2QgfHwgcHJvY2Vzcy5jd2QoKSxcbiAgICAgIHN0ZGlvOiBbJ3BpcGUnLCAncGlwZScsICdwaXBlJ10sXG4gICAgfSk7XG5cbiAgICB0aGlzLnByb2Muc3Rkb3V0Lm9uKCdkYXRhJywgY2h1bmsgPT4ge1xuICAgICAgdGhpcy5idWZmZXIgKz0gY2h1bmsudG9TdHJpbmcoJ3V0ZjgnKTtcbiAgICAgIHRoaXMuY29uc3VtZUJ1ZmZlcigpO1xuICAgIH0pO1xuXG4gICAgdGhpcy5wcm9jLnN0ZGVyci5vbignZGF0YScsIGNodW5rID0+IHtcbiAgICAgIGNvbnN0IHRleHQgPSBjaHVuay50b1N0cmluZygndXRmOCcpLnRyaW0oKTtcbiAgICAgIGlmICh0ZXh0ICYmIHRoaXMub25TdGF0dXMpIHRoaXMub25TdGF0dXModGV4dCk7XG4gICAgfSk7XG5cbiAgICB0aGlzLnByb2Mub24oJ2Vycm9yJywgZXJyb3IgPT4ge1xuICAgICAgY29uc3QgZXh0cmEgPSBjb21tYW5kID09PSB0aGlzLmhlcm1lc0NvbW1hbmRcbiAgICAgICAgPyAnJ1xuICAgICAgICA6IGAgKHJlc29sdmVkIGZyb20gJHt0aGlzLmhlcm1lc0NvbW1hbmR9IHRvICR7Y29tbWFuZH0pYDtcbiAgICAgIHRoaXMub25FcnJvcj8uKGBGYWlsZWQgdG8gc3RhcnQgSGVybWVzIEFDUCR7ZXh0cmF9OiAke1N0cmluZyhlcnJvcil9YCk7XG4gICAgfSk7XG5cbiAgICB0aGlzLnByb2Mub24oJ2V4aXQnLCBjb2RlID0+IHtcbiAgICAgIGNvbnN0IGVycm9yID0gYEhlcm1lcyBBQ1AgZXhpdGVkJHtjb2RlICE9PSBudWxsID8gYCB3aXRoIGNvZGUgJHtjb2RlfWAgOiAnJ31gO1xuICAgICAgZm9yIChjb25zdCBwZW5kaW5nIG9mIHRoaXMucGVuZGluZy52YWx1ZXMoKSkgcGVuZGluZy5yZWplY3QobmV3IEVycm9yKGVycm9yKSk7XG4gICAgICB0aGlzLnBlbmRpbmcuY2xlYXIoKTtcbiAgICAgIHRoaXMucHJvYyA9IG51bGw7XG4gICAgICB0aGlzLmluaXRpYWxpemVkID0gZmFsc2U7XG4gICAgICB0aGlzLnNlc3Npb25JZCA9IG51bGw7XG4gICAgICB0aGlzLm9uU3RhdHVzPy4oZXJyb3IpO1xuICAgIH0pO1xuICB9XG5cbiAgcHJpdmF0ZSBjb25zdW1lQnVmZmVyKCkge1xuICAgIGxldCBuZXdsaW5lSW5kZXggPSAtMTtcbiAgICB3aGlsZSAoKG5ld2xpbmVJbmRleCA9IHRoaXMuYnVmZmVyLmluZGV4T2YoJ1xcbicpKSA+PSAwKSB7XG4gICAgICBjb25zdCBsaW5lID0gdGhpcy5idWZmZXIuc2xpY2UoMCwgbmV3bGluZUluZGV4KS50cmltKCk7XG4gICAgICB0aGlzLmJ1ZmZlciA9IHRoaXMuYnVmZmVyLnNsaWNlKG5ld2xpbmVJbmRleCArIDEpO1xuICAgICAgaWYgKCFsaW5lKSBjb250aW51ZTtcblxuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgbXNnID0gSlNPTi5wYXJzZShsaW5lKTtcbiAgICAgICAgdGhpcy5oYW5kbGVNZXNzYWdlKG1zZyk7XG4gICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICB0aGlzLm9uRXJyb3I/LihgRmFpbGVkIHRvIHBhcnNlIEFDUCBvdXRwdXQ6ICR7U3RyaW5nKGVycm9yKX1gKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBwcml2YXRlIGhhbmRsZU1lc3NhZ2UobXNnOiBhbnkpIHtcbiAgICBpZiAodHlwZW9mIG1zZy5pZCA9PT0gJ251bWJlcicgJiYgdGhpcy5wZW5kaW5nLmhhcyhtc2cuaWQpKSB7XG4gICAgICBjb25zdCBwZW5kaW5nID0gdGhpcy5wZW5kaW5nLmdldChtc2cuaWQpITtcbiAgICAgIHRoaXMucGVuZGluZy5kZWxldGUobXNnLmlkKTtcbiAgICAgIGlmIChtc2cuZXJyb3IpIHtcbiAgICAgICAgY29uc3QgZGV0YWlsID0gdHlwZW9mIG1zZy5lcnJvciA9PT0gJ3N0cmluZydcbiAgICAgICAgICA/IG1zZy5lcnJvclxuICAgICAgICAgIDogbXNnLmVycm9yPy5tZXNzYWdlIHx8IEpTT04uc3RyaW5naWZ5KG1zZy5lcnJvcik7XG4gICAgICAgIHBlbmRpbmcucmVqZWN0KG5ldyBFcnJvcihkZXRhaWwpKTtcbiAgICAgIH0gZWxzZSBwZW5kaW5nLnJlc29sdmUobXNnLnJlc3VsdCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgaWYgKG1zZy5tZXRob2QgPT09ICdzZXNzaW9uL3VwZGF0ZScpIHtcbiAgICAgIHRoaXMuaGFuZGxlU2Vzc2lvblVwZGF0ZShtc2cucGFyYW1zID8/IHt9KTtcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIGhhbmRsZVNlc3Npb25VcGRhdGUocGFyYW1zOiBTZXNzaW9uVXBkYXRlUGFyYW1zKSB7XG4gICAgY29uc3QgdXBkYXRlID0gcGFyYW1zLnVwZGF0ZSA/PyBwYXJhbXM7XG4gICAgaWYgKCF1cGRhdGUgfHwgdHlwZW9mIHVwZGF0ZSAhPT0gJ29iamVjdCcpIHJldHVybjtcblxuICAgIGNvbnN0IHNlc3Npb25VcGRhdGUgPSB1cGRhdGUuc2Vzc2lvblVwZGF0ZSA/PyB1cGRhdGUuc2Vzc2lvbl91cGRhdGU7XG5cbiAgICBpZiAoc2Vzc2lvblVwZGF0ZSA9PT0gJ2FnZW50X21lc3NhZ2VfY2h1bmsnIHx8IHNlc3Npb25VcGRhdGUgPT09ICdhZ2VudF9tZXNzYWdlJykge1xuICAgICAgY29uc3QgdGV4dCA9IHRoaXMuZXh0cmFjdFRleHQodXBkYXRlKTtcbiAgICAgIGlmICh0ZXh0KSB0aGlzLm9uQXNzaXN0YW50VGV4dD8uKHRleHQpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGlmIChzZXNzaW9uVXBkYXRlID09PSAnYWdlbnRfdGhvdWdodF9jaHVuaycgfHwgc2Vzc2lvblVwZGF0ZSA9PT0gJ3Rvb2xfY2FsbCcgfHwgc2Vzc2lvblVwZGF0ZSA9PT0gJ3Rvb2xfY2FsbF91cGRhdGUnKSB7XG4gICAgICBjb25zdCB0ZXh0ID0gdGhpcy5leHRyYWN0VGV4dCh1cGRhdGUpO1xuICAgICAgaWYgKHRleHQpIHRoaXMub25TdGF0dXM/Lih0ZXh0KTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBpZiAoc2Vzc2lvblVwZGF0ZSA9PT0gJ2F2YWlsYWJsZV9jb21tYW5kc191cGRhdGUnKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3QgZmFsbGJhY2sgPSB0aGlzLmV4dHJhY3RUZXh0KHVwZGF0ZSk7XG4gICAgaWYgKGZhbGxiYWNrKSB0aGlzLm9uU3RhdHVzPy4oZmFsbGJhY2spO1xuICB9XG5cbiAgcHJpdmF0ZSBleHRyYWN0VGV4dCh2YWx1ZTogYW55KTogc3RyaW5nIHtcbiAgICBjb25zdCBwYXJ0czogc3RyaW5nW10gPSBbXTtcblxuICAgIGNvbnN0IHdhbGsgPSAobm9kZTogYW55KSA9PiB7XG4gICAgICBpZiAobm9kZSA9PSBudWxsKSByZXR1cm47XG4gICAgICBpZiAodHlwZW9mIG5vZGUgPT09ICdzdHJpbmcnKSByZXR1cm47XG4gICAgICBpZiAoQXJyYXkuaXNBcnJheShub2RlKSkge1xuICAgICAgICBmb3IgKGNvbnN0IGl0ZW0gb2Ygbm9kZSkgd2FsayhpdGVtKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgaWYgKHR5cGVvZiBub2RlICE9PSAnb2JqZWN0JykgcmV0dXJuO1xuXG4gICAgICBpZiAodHlwZW9mIG5vZGUudGV4dCA9PT0gJ3N0cmluZycpIHBhcnRzLnB1c2gobm9kZS50ZXh0KTtcbiAgICAgIGlmICh0eXBlb2Ygbm9kZS5jb250ZW50ID09PSAnc3RyaW5nJykgcGFydHMucHVzaChub2RlLmNvbnRlbnQpO1xuICAgICAgaWYgKHR5cGVvZiBub2RlLnJlc3VsdCA9PT0gJ3N0cmluZycpIHBhcnRzLnB1c2gobm9kZS5yZXN1bHQpO1xuICAgICAgaWYgKHR5cGVvZiBub2RlLmRlc2NyaXB0aW9uID09PSAnc3RyaW5nJykgcGFydHMucHVzaChub2RlLmRlc2NyaXB0aW9uKTtcblxuICAgICAgZm9yIChjb25zdCBrZXkgb2YgT2JqZWN0LmtleXMobm9kZSkpIHtcbiAgICAgICAgd2Fsayhub2RlW2tleV0pO1xuICAgICAgfVxuICAgIH07XG5cbiAgICB3YWxrKHZhbHVlKTtcbiAgICByZXR1cm4gcGFydHMuam9pbignJyk7XG4gIH1cblxuICBwcml2YXRlIHJlcXVlc3QobWV0aG9kOiBzdHJpbmcsIHBhcmFtczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pIHtcbiAgICBpZiAoIXRoaXMucHJvYykgdGhyb3cgbmV3IEVycm9yKCdIZXJtZXMgQUNQIHByb2Nlc3MgaXMgbm90IHJ1bm5pbmcnKTtcblxuICAgIGNvbnN0IGlkID0gdGhpcy5uZXh0SWQrKztcbiAgICBjb25zdCBwYXlsb2FkID0geyBqc29ucnBjOiAnMi4wJywgaWQsIG1ldGhvZCwgcGFyYW1zIH07XG4gICAgdGhpcy5wcm9jLnN0ZGluLndyaXRlKGAke0pTT04uc3RyaW5naWZ5KHBheWxvYWQpfVxcbmApO1xuXG4gICAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgIHRoaXMucGVuZGluZy5zZXQoaWQsIHsgcmVzb2x2ZSwgcmVqZWN0IH0pO1xuICAgIH0pO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBlbnN1cmVJbml0aWFsaXplZChjd2Q/OiBzdHJpbmcpIHtcbiAgICB0aGlzLmVuc3VyZVN0YXJ0ZWQoY3dkKTtcbiAgICBpZiAodGhpcy5pbml0aWFsaXplZCkgcmV0dXJuO1xuXG4gICAgYXdhaXQgdGhpcy5yZXF1ZXN0KCdpbml0aWFsaXplJywge1xuICAgICAgcHJvdG9jb2xfdmVyc2lvbjogMSxcbiAgICAgIGNsaWVudF9jYXBhYmlsaXRpZXM6IHt9LFxuICAgICAgY2xpZW50X2luZm86IHtcbiAgICAgICAgbmFtZTogJ2hlcm1lcy1vYnNpZGlhbi1tdnAnLFxuICAgICAgICB2ZXJzaW9uOiAnMC4wLjQnLFxuICAgICAgfSxcbiAgICB9KTtcbiAgICB0aGlzLmluaXRpYWxpemVkID0gdHJ1ZTtcbiAgfVxuXG4gIGFzeW5jIGxpc3RTZXNzaW9ucyhjd2Q/OiBzdHJpbmcpOiBQcm9taXNlPFNlc3Npb25TdW1tYXJ5W10+IHtcbiAgICBhd2FpdCB0aGlzLmVuc3VyZUluaXRpYWxpemVkKGN3ZCk7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgdGhpcy5yZXF1ZXN0KCdzZXNzaW9uL2xpc3QnLCB7fSk7XG4gICAgY29uc3Qgc2Vzc2lvbnMgPSBBcnJheS5pc0FycmF5KHJlc3VsdD8uc2Vzc2lvbnMpID8gcmVzdWx0LnNlc3Npb25zIDogW107XG4gICAgcmV0dXJuIHNlc3Npb25zXG4gICAgICAubWFwKChzZXNzaW9uOiBhbnkpID0+IHtcbiAgICAgICAgY29uc3QgaWQgPSBzZXNzaW9uPy5pZCA/PyBzZXNzaW9uPy5zZXNzaW9uSWQgPz8gc2Vzc2lvbj8uc2Vzc2lvbl9pZDtcbiAgICAgICAgcmV0dXJuIGlkID8geyAuLi5zZXNzaW9uLCBpZCB9IDogbnVsbDtcbiAgICAgIH0pXG4gICAgICAuZmlsdGVyKChzZXNzaW9uOiBTZXNzaW9uU3VtbWFyeSB8IG51bGwpOiBzZXNzaW9uIGlzIFNlc3Npb25TdW1tYXJ5ID0+IEJvb2xlYW4oc2Vzc2lvbikpO1xuICB9XG5cbiAgYXN5bmMgcmVzdW1lU2Vzc2lvbihzZXNzaW9uSWQ6IHN0cmluZywgY3dkPzogc3RyaW5nKSB7XG4gICAgYXdhaXQgdGhpcy5lbnN1cmVJbml0aWFsaXplZChjd2QpO1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHRoaXMucmVxdWVzdCgnc2Vzc2lvbi9yZXN1bWUnLCB7XG4gICAgICBzZXNzaW9uSWQsXG4gICAgICBjd2Q6IGN3ZCB8fCBwcm9jZXNzLmN3ZCgpLFxuICAgIH0pO1xuICAgIHRoaXMuc2Vzc2lvbklkID0gcmVzdWx0Py5zZXNzaW9uSWQgPz8gcmVzdWx0Py5zZXNzaW9uX2lkID8/IHJlc3VsdD8uaWQgPz8gc2Vzc2lvbklkO1xuICAgIHJldHVybiByZXN1bHQ7XG4gIH1cblxuICBhc3luYyBsb2FkU2Vzc2lvbihzZXNzaW9uSWQ6IHN0cmluZywgY3dkPzogc3RyaW5nKSB7XG4gICAgYXdhaXQgdGhpcy5lbnN1cmVJbml0aWFsaXplZChjd2QpO1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHRoaXMucmVxdWVzdCgnc2Vzc2lvbi9sb2FkJywge1xuICAgICAgc2Vzc2lvbklkLFxuICAgICAgY3dkOiBjd2QgfHwgcHJvY2Vzcy5jd2QoKSxcbiAgICAgIG1jcFNlcnZlcnM6IFtdLFxuICAgIH0pO1xuICAgIHRoaXMuc2Vzc2lvbklkID0gcmVzdWx0Py5zZXNzaW9uSWQgPz8gcmVzdWx0Py5zZXNzaW9uX2lkID8/IHJlc3VsdD8uaWQgPz8gc2Vzc2lvbklkO1xuICAgIHJldHVybiByZXN1bHQ7XG4gIH1cblxuICBhc3luYyByZXN0b3JlTGF0ZXN0U2Vzc2lvbihjd2Q/OiBzdHJpbmcpIHtcbiAgICBjb25zdCBzZXNzaW9ucyA9IGF3YWl0IHRoaXMubGlzdFNlc3Npb25zKGN3ZCk7XG4gICAgaWYgKCFzZXNzaW9ucy5sZW5ndGgpIHJldHVybiBudWxsO1xuXG4gICAgY29uc3QgbGF0ZXN0ID0gWy4uLnNlc3Npb25zXS5zb3J0KChhLCBiKSA9PiB7XG4gICAgICBjb25zdCBhVHMgPSBOdW1iZXIoYS51cGRhdGVkQXQgPz8gYS51cGRhdGVkX2F0ID8/IGEuY3JlYXRlZEF0ID8/IGEuY3JlYXRlZF9hdCA/PyAwKTtcbiAgICAgIGNvbnN0IGJUcyA9IE51bWJlcihiLnVwZGF0ZWRBdCA/PyBiLnVwZGF0ZWRfYXQgPz8gYi5jcmVhdGVkQXQgPz8gYi5jcmVhdGVkX2F0ID8/IDApO1xuICAgICAgcmV0dXJuIGJUcyAtIGFUcztcbiAgICB9KVswXTtcblxuICAgIHRyeSB7XG4gICAgICByZXR1cm4gYXdhaXQgdGhpcy5sb2FkU2Vzc2lvbihsYXRlc3QuaWQsIGN3ZCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm4gdGhpcy5yZXN1bWVTZXNzaW9uKGxhdGVzdC5pZCwgY3dkKTtcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIGVuc3VyZVNlc3Npb24oY3dkPzogc3RyaW5nKSB7XG4gICAgaWYgKHRoaXMuc2Vzc2lvbklkKSByZXR1cm4gdGhpcy5zZXNzaW9uSWQ7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgdGhpcy5yZXF1ZXN0KCdzZXNzaW9uL25ldycsIHsgY3dkOiBjd2QgfHwgcHJvY2Vzcy5jd2QoKSwgbWNwU2VydmVyczogW10gfSk7XG4gICAgdGhpcy5zZXNzaW9uSWQgPSByZXN1bHQ/LnNlc3Npb25JZCA/PyByZXN1bHQ/LnNlc3Npb25faWQgPz8gcmVzdWx0Py5pZDtcbiAgICBpZiAoIXRoaXMuc2Vzc2lvbklkKSB0aHJvdyBuZXcgRXJyb3IoJ0hlcm1lcyBBQ1AgZGlkIG5vdCByZXR1cm4gYSBzZXNzaW9uIGlkJyk7XG4gICAgcmV0dXJuIHRoaXMuc2Vzc2lvbklkO1xuICB9XG5cbiAgYXN5bmMgc2VuZFByb21wdCh0ZXh0OiBzdHJpbmcsIGN3ZD86IHN0cmluZykge1xuICAgIGF3YWl0IHRoaXMuZW5zdXJlSW5pdGlhbGl6ZWQoY3dkKTtcbiAgICBjb25zdCBzZXNzaW9uSWQgPSBhd2FpdCB0aGlzLmVuc3VyZVNlc3Npb24oY3dkKTtcbiAgICByZXR1cm4gdGhpcy5yZXF1ZXN0KCdzZXNzaW9uL3Byb21wdCcsIHtcbiAgICAgIHNlc3Npb25JZCxcbiAgICAgIHByb21wdDogW3sgdHlwZTogJ3RleHQnLCB0ZXh0IH1dLFxuICAgIH0pO1xuICB9XG59XG4iXSwKICAibWFwcGluZ3MiOiAiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxzQkFBMEc7OztBQ0ExRywyQkFBc0Q7QUFDdEQsZ0JBQTJCO0FBa0JwQixJQUFNLGtCQUFO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

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
        version: "0.0.2"
      }
    });
    this.initialized = true;
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
  }
  async onClose() {
    this.plugin.unregisterViewInstance(this);
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsic3JjL21haW4udHMiLCAic3JjL3RyYW5zcG9ydC9oZXJtZXMtYWNwLWNsaWVudC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgQXBwLCBJdGVtVmlldywgTWFya2Rvd25SZW5kZXJlciwgTm90aWNlLCBQbHVnaW4sIFBsdWdpblNldHRpbmdUYWIsIFNldHRpbmcsIFdvcmtzcGFjZUxlYWYgfSBmcm9tICdvYnNpZGlhbic7XG5pbXBvcnQgeyBIZXJtZXNBQ1BDbGllbnQgfSBmcm9tICcuL3RyYW5zcG9ydC9oZXJtZXMtYWNwLWNsaWVudCc7XG5cbmNvbnN0IFZJRVdfVFlQRV9IRVJNRVNfTVZQID0gJ2hlcm1lcy1vYnNpZGlhbi1tdnAnO1xuXG50eXBlIENoYXRNZXNzYWdlID0ge1xuICByb2xlOiAndXNlcicgfCAnYXNzaXN0YW50JyB8ICdzdGF0dXMnIHwgJ2Vycm9yJztcbiAgdGV4dDogc3RyaW5nO1xufTtcblxuaW50ZXJmYWNlIEhlcm1lc1BsdWdpblNldHRpbmdzIHtcbiAgaGVybWVzQ29tbWFuZDogc3RyaW5nO1xuICBtZXNzYWdlczogQ2hhdE1lc3NhZ2VbXTtcbn1cblxuY29uc3QgREVGQVVMVF9TRVRUSU5HUzogSGVybWVzUGx1Z2luU2V0dGluZ3MgPSB7XG4gIGhlcm1lc0NvbW1hbmQ6ICdoZXJtZXMnLFxuICBtZXNzYWdlczogW10sXG59O1xuXG5jbGFzcyBIZXJtZXNNVlBWaWV3IGV4dGVuZHMgSXRlbVZpZXcge1xuICBwbHVnaW46IEhlcm1lc09ic2lkaWFuTVZQUGx1Z2luO1xuICBtZXNzYWdlczogQ2hhdE1lc3NhZ2VbXSA9IFtdO1xuICBwcml2YXRlIGlucHV0VmFsdWUgPSAnJztcbiAgcHJpdmF0ZSBpc1NlbmRpbmcgPSBmYWxzZTtcblxuICBjb25zdHJ1Y3RvcihsZWFmOiBXb3Jrc3BhY2VMZWFmLCBwbHVnaW46IEhlcm1lc09ic2lkaWFuTVZQUGx1Z2luKSB7XG4gICAgc3VwZXIobGVhZik7XG4gICAgdGhpcy5wbHVnaW4gPSBwbHVnaW47XG4gIH1cblxuICBnZXRWaWV3VHlwZSgpIHtcbiAgICByZXR1cm4gVklFV19UWVBFX0hFUk1FU19NVlA7XG4gIH1cblxuICBnZXREaXNwbGF5VGV4dCgpIHtcbiAgICByZXR1cm4gJ0hlcm1lcyc7XG4gIH1cblxuICBhc3luYyBvbk9wZW4oKSB7XG4gICAgdGhpcy5wbHVnaW4ucmVnaXN0ZXJWaWV3SW5zdGFuY2UodGhpcyk7XG4gICAgdGhpcy5tZXNzYWdlcyA9IEFycmF5LmlzQXJyYXkodGhpcy5wbHVnaW4uc2V0dGluZ3MubWVzc2FnZXMpXG4gICAgICA/IHRoaXMucGx1Z2luLnNldHRpbmdzLm1lc3NhZ2VzLm1hcChtZXNzYWdlID0+ICh7IC4uLm1lc3NhZ2UgfSkpXG4gICAgICA6IFtdO1xuICAgIHRoaXMucmVuZGVyKCk7XG4gIH1cblxuICBhc3luYyBvbkNsb3NlKCkge1xuICAgIHRoaXMucGx1Z2luLnVucmVnaXN0ZXJWaWV3SW5zdGFuY2UodGhpcyk7XG4gIH1cblxuICBhcHBlbmRNZXNzYWdlKHJvbGU6IENoYXRNZXNzYWdlWydyb2xlJ10sIHRleHQ6IHN0cmluZykge1xuICAgIGlmICghdGV4dCkgcmV0dXJuO1xuXG4gICAgaWYgKHJvbGUgPT09ICdhc3Npc3RhbnQnKSB7XG4gICAgICBjb25zdCBsYXN0ID0gdGhpcy5tZXNzYWdlc1t0aGlzLm1lc3NhZ2VzLmxlbmd0aCAtIDFdO1xuICAgICAgaWYgKGxhc3QgJiYgbGFzdC5yb2xlID09PSAnYXNzaXN0YW50Jykge1xuICAgICAgICBsYXN0LnRleHQgKz0gdGV4dDtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRoaXMubWVzc2FnZXMucHVzaCh7IHJvbGUsIHRleHQgfSk7XG4gICAgICB9XG4gICAgfSBlbHNlIGlmIChyb2xlID09PSAnc3RhdHVzJykge1xuICAgICAgY29uc3QgbGFzdCA9IHRoaXMubWVzc2FnZXNbdGhpcy5tZXNzYWdlcy5sZW5ndGggLSAxXTtcbiAgICAgIGlmIChsYXN0ICYmIGxhc3Qucm9sZSA9PT0gJ3N0YXR1cycpIHtcbiAgICAgICAgbGFzdC50ZXh0ID0gdGV4dDtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRoaXMubWVzc2FnZXMucHVzaCh7IHJvbGUsIHRleHQgfSk7XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMubWVzc2FnZXMucHVzaCh7IHJvbGUsIHRleHQgfSk7XG4gICAgfVxuXG4gICAgdGhpcy5wbHVnaW4ucGVyc2lzdE1lc3NhZ2VzKHRoaXMubWVzc2FnZXMpO1xuICAgIHRoaXMucmVuZGVyKCk7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIHN1Ym1pdFByb21wdCgpIHtcbiAgICBjb25zdCB0ZXh0ID0gdGhpcy5pbnB1dFZhbHVlLnRyaW0oKTtcbiAgICBpZiAoIXRleHQgfHwgdGhpcy5pc1NlbmRpbmcpIHJldHVybjtcblxuICAgIHRoaXMuaW5wdXRWYWx1ZSA9ICcnO1xuICAgIHRoaXMuaXNTZW5kaW5nID0gdHJ1ZTtcbiAgICB0aGlzLm1lc3NhZ2VzLnB1c2goeyByb2xlOiAndXNlcicsIHRleHQgfSk7XG4gICAgdGhpcy5tZXNzYWdlcy5wdXNoKHsgcm9sZTogJ2Fzc2lzdGFudCcsIHRleHQ6ICcnIH0pO1xuICAgIHRoaXMucmVuZGVyKCk7XG5cbiAgICB0cnkge1xuICAgICAgYXdhaXQgdGhpcy5wbHVnaW4uY2xpZW50LnNlbmRQcm9tcHQodGV4dCwgdGhpcy5wbHVnaW4uZ2V0VmF1bHRQYXRoKCkpO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBjb25zdCBtZXNzYWdlID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpO1xuICAgICAgdGhpcy5hcHBlbmRNZXNzYWdlKCdlcnJvcicsIG1lc3NhZ2UpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICB0aGlzLmlzU2VuZGluZyA9IGZhbHNlO1xuICAgICAgdGhpcy5yZW5kZXIoKTtcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIGdldExhYmVsKHJvbGU6IENoYXRNZXNzYWdlWydyb2xlJ10pIHtcbiAgICBzd2l0Y2ggKHJvbGUpIHtcbiAgICAgIGNhc2UgJ3VzZXInOlxuICAgICAgICByZXR1cm4gJ1lvdSc7XG4gICAgICBjYXNlICdhc3Npc3RhbnQnOlxuICAgICAgICByZXR1cm4gJ0hlcm1lcyc7XG4gICAgICBjYXNlICdzdGF0dXMnOlxuICAgICAgICByZXR1cm4gJ1N0YXR1cyc7XG4gICAgICBjYXNlICdlcnJvcic6XG4gICAgICAgIHJldHVybiAnRXJyb3InO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgcmVuZGVyTWVzc2FnZUJvZHkoY29udGFpbmVyOiBIVE1MRWxlbWVudCwgbXNnOiBDaGF0TWVzc2FnZSkge1xuICAgIGlmIChtc2cucm9sZSA9PT0gJ2Fzc2lzdGFudCcpIHtcbiAgICAgIGF3YWl0IE1hcmtkb3duUmVuZGVyZXIucmVuZGVyKHRoaXMuYXBwLCBtc2cudGV4dCB8fCAnXHUyMDI2JywgY29udGFpbmVyLCAnJywgdGhpcy5wbHVnaW4pO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGlmIChtc2cucm9sZSA9PT0gJ3N0YXR1cycpIHtcbiAgICAgIGNvbnRhaW5lci5zZXRUZXh0KG1zZy50ZXh0KTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjb250YWluZXIuc2V0VGV4dChtc2cudGV4dCB8fCAobXNnLnJvbGUgPT09ICdhc3Npc3RhbnQnID8gJ1x1MjAyNicgOiAnJykpO1xuICB9XG5cbiAgcmVuZGVyKCkge1xuICAgIGNvbnN0IHJvb3QgPSB0aGlzLmNvbnRhaW5lckVsLmNoaWxkcmVuWzFdIGFzIEhUTUxFbGVtZW50O1xuICAgIHJvb3QuZW1wdHkoKTtcbiAgICByb290LmFkZENsYXNzKCdoZXJtZXMtbXZwLXJvb3QnKTtcblxuICAgIGNvbnN0IHdyYXAgPSByb290LmNyZWF0ZURpdih7IGNsczogJ2hlcm1lcy1tdnAtd3JhcCcgfSk7XG4gICAgY29uc3QgaGVhZGVyID0gd3JhcC5jcmVhdGVEaXYoeyBjbHM6ICdoZXJtZXMtbXZwLWhlYWRlcicgfSk7XG4gICAgaGVhZGVyLmNyZWF0ZURpdih7IGNsczogJ2hlcm1lcy1tdnAtdGl0bGUnLCB0ZXh0OiAnSGVybWVzJyB9KTtcbiAgICBoZWFkZXIuY3JlYXRlRGl2KHtcbiAgICAgIGNsczogJ2hlcm1lcy1tdnAtc3VidGl0bGUnLFxuICAgICAgdGV4dDogdGhpcy5pc1NlbmRpbmcgPyAnVGhpbmtpbmdcdTIwMjYnIDogJ0xvY2FsIE9ic2lkaWFuIGNoYXQnLFxuICAgIH0pO1xuXG4gICAgY29uc3QgbGlzdCA9IHdyYXAuY3JlYXRlRGl2KHsgY2xzOiAnaGVybWVzLW12cC1tZXNzYWdlcycgfSk7XG5cbiAgICBpZiAodGhpcy5tZXNzYWdlcy5sZW5ndGggPT09IDApIHtcbiAgICAgIGNvbnN0IGVtcHR5ID0gbGlzdC5jcmVhdGVEaXYoeyBjbHM6ICdoZXJtZXMtbXZwLWVtcHR5JyB9KTtcbiAgICAgIGVtcHR5LmNyZWF0ZURpdih7IGNsczogJ2hlcm1lcy1tdnAtZW1wdHktdGl0bGUnLCB0ZXh0OiAnU3RhcnQgYSBjb252ZXJzYXRpb24nIH0pO1xuICAgICAgZW1wdHkuY3JlYXRlRGl2KHtcbiAgICAgICAgY2xzOiAnaGVybWVzLW12cC1lbXB0eS1zdWJ0aXRsZScsXG4gICAgICAgIHRleHQ6ICdBc2sgSGVybWVzIHRvIGJyYWluc3Rvcm0sIHdyaXRlLCBzdW1tYXJpemUsIG9yIGhlbHAgeW91IHRoaW5rIHRocm91Z2ggYSBub3RlLicsXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICBmb3IgKGNvbnN0IG1zZyBvZiB0aGlzLm1lc3NhZ2VzKSB7XG4gICAgICBjb25zdCByb3cgPSBsaXN0LmNyZWF0ZURpdih7IGNsczogYGhlcm1lcy1tdnAtcm93IGhlcm1lcy1tdnAtcm93LSR7bXNnLnJvbGV9YCB9KTtcbiAgICAgIGNvbnN0IGJ1YmJsZSA9IHJvdy5jcmVhdGVEaXYoeyBjbHM6IGBoZXJtZXMtbXZwLWJ1YmJsZSBoZXJtZXMtbXZwLWJ1YmJsZS0ke21zZy5yb2xlfWAgfSk7XG4gICAgICBidWJibGUuY3JlYXRlRGl2KHsgY2xzOiAnaGVybWVzLW12cC1idWJibGUtbGFiZWwnLCB0ZXh0OiB0aGlzLmdldExhYmVsKG1zZy5yb2xlKSB9KTtcbiAgICAgIGNvbnN0IGJvZHkgPSBidWJibGUuY3JlYXRlRGl2KHsgY2xzOiAnaGVybWVzLW12cC1idWJibGUtYm9keScgfSk7XG4gICAgICB2b2lkIHRoaXMucmVuZGVyTWVzc2FnZUJvZHkoYm9keSwgbXNnKTtcbiAgICB9XG5cbiAgICBjb25zdCBjb21wb3NlciA9IHdyYXAuY3JlYXRlRGl2KHsgY2xzOiAnaGVybWVzLW12cC1jb21wb3NlcicgfSk7XG4gICAgY29uc3QgaW5wdXRXcmFwID0gY29tcG9zZXIuY3JlYXRlRGl2KHsgY2xzOiAnaGVybWVzLW12cC1pbnB1dC13cmFwJyB9KTtcbiAgICBjb25zdCBpbnB1dCA9IGlucHV0V3JhcC5jcmVhdGVFbCgndGV4dGFyZWEnLCB7XG4gICAgICBjbHM6ICdoZXJtZXMtbXZwLWlucHV0JyxcbiAgICAgIGF0dHI6IHsgcm93czogJzEnLCBwbGFjZWhvbGRlcjogJ01lc3NhZ2UgSGVybWVzXHUyMDI2JyB9LFxuICAgIH0pO1xuICAgIGlucHV0LnZhbHVlID0gdGhpcy5pbnB1dFZhbHVlO1xuICAgIGlucHV0LmRpc2FibGVkID0gdGhpcy5pc1NlbmRpbmc7XG4gICAgaW5wdXQuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLCAoKSA9PiB7XG4gICAgICB0aGlzLmlucHV0VmFsdWUgPSBpbnB1dC52YWx1ZTtcbiAgICAgIGlucHV0LnN0eWxlLmhlaWdodCA9ICcwcHgnO1xuICAgICAgaW5wdXQuc3R5bGUuaGVpZ2h0ID0gYCR7TWF0aC5taW4oaW5wdXQuc2Nyb2xsSGVpZ2h0LCAyMjApfXB4YDtcbiAgICB9KTtcbiAgICBpbnB1dC5hZGRFdmVudExpc3RlbmVyKCdrZXlkb3duJywgZXZ0ID0+IHtcbiAgICAgIGlmIChldnQua2V5ID09PSAnRW50ZXInICYmICFldnQuc2hpZnRLZXkpIHtcbiAgICAgICAgZXZ0LnByZXZlbnREZWZhdWx0KCk7XG4gICAgICAgIHZvaWQgdGhpcy5zdWJtaXRQcm9tcHQoKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgICBpbnB1dC5zdHlsZS5oZWlnaHQgPSAnMHB4JztcbiAgICBpbnB1dC5zdHlsZS5oZWlnaHQgPSBgJHtNYXRoLm1pbihpbnB1dC5zY3JvbGxIZWlnaHQsIDIyMCl9cHhgO1xuXG4gICAgY29uc3QgYnV0dG9uID0gY29tcG9zZXIuY3JlYXRlRWwoJ2J1dHRvbicsIHtcbiAgICAgIGNsczogJ21vZC1jdGEgaGVybWVzLW12cC1zZW5kJyxcbiAgICAgIHRleHQ6IHRoaXMuaXNTZW5kaW5nID8gJ1NlbmRpbmdcdTIwMjYnIDogJ1NlbmQnLFxuICAgIH0pO1xuICAgIGJ1dHRvbi5kaXNhYmxlZCA9IHRoaXMuaXNTZW5kaW5nO1xuICAgIGJ1dHRvbi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHtcbiAgICAgIHZvaWQgdGhpcy5zdWJtaXRQcm9tcHQoKTtcbiAgICB9KTtcblxuICAgIGxpc3Quc2Nyb2xsVG9wID0gbGlzdC5zY3JvbGxIZWlnaHQ7XG4gIH1cbn1cblxuY2xhc3MgSGVybWVzU2V0dGluZ1RhYiBleHRlbmRzIFBsdWdpblNldHRpbmdUYWIge1xuICBwbHVnaW46IEhlcm1lc09ic2lkaWFuTVZQUGx1Z2luO1xuXG4gIGNvbnN0cnVjdG9yKGFwcDogQXBwLCBwbHVnaW46IEhlcm1lc09ic2lkaWFuTVZQUGx1Z2luKSB7XG4gICAgc3VwZXIoYXBwLCBwbHVnaW4pO1xuICAgIHRoaXMucGx1Z2luID0gcGx1Z2luO1xuICB9XG5cbiAgZGlzcGxheSgpOiB2b2lkIHtcbiAgICBjb25zdCB7IGNvbnRhaW5lckVsIH0gPSB0aGlzO1xuICAgIGNvbnRhaW5lckVsLmVtcHR5KCk7XG5cbiAgICBuZXcgU2V0dGluZyhjb250YWluZXJFbClcbiAgICAgIC5zZXROYW1lKCdIZXJtZXMgY29tbWFuZCcpXG4gICAgICAuc2V0RGVzYygnQ29tbWFuZCB1c2VkIHRvIGxhdW5jaCBIZXJtZXMgQUNQIGxvY2FsbHkuJylcbiAgICAgIC5hZGRUZXh0KHRleHQgPT5cbiAgICAgICAgdGV4dFxuICAgICAgICAgIC5zZXRQbGFjZWhvbGRlcignaGVybWVzJylcbiAgICAgICAgICAuc2V0VmFsdWUodGhpcy5wbHVnaW4uc2V0dGluZ3MuaGVybWVzQ29tbWFuZClcbiAgICAgICAgICAub25DaGFuZ2UoYXN5bmMgdmFsdWUgPT4ge1xuICAgICAgICAgICAgdGhpcy5wbHVnaW4uc2V0dGluZ3MuaGVybWVzQ29tbWFuZCA9IHZhbHVlLnRyaW0oKSB8fCAnaGVybWVzJztcbiAgICAgICAgICAgIGF3YWl0IHRoaXMucGx1Z2luLnNhdmVTZXR0aW5ncygpO1xuICAgICAgICAgICAgbmV3IE5vdGljZSgnSGVybWVzIGNvbW1hbmQgc2F2ZWQnKTtcbiAgICAgICAgICB9KSxcbiAgICAgICk7XG4gIH1cbn1cblxuZXhwb3J0IGRlZmF1bHQgY2xhc3MgSGVybWVzT2JzaWRpYW5NVlBQbHVnaW4gZXh0ZW5kcyBQbHVnaW4ge1xuICBzZXR0aW5ncyE6IEhlcm1lc1BsdWdpblNldHRpbmdzO1xuICBjbGllbnQhOiBIZXJtZXNBQ1BDbGllbnQ7XG4gIHByaXZhdGUgYWN0aXZlVmlldzogSGVybWVzTVZQVmlldyB8IG51bGwgPSBudWxsO1xuXG4gIGFzeW5jIG9ubG9hZCgpIHtcbiAgICB0aGlzLnNldHRpbmdzID0gT2JqZWN0LmFzc2lnbih7fSwgREVGQVVMVF9TRVRUSU5HUywgYXdhaXQgdGhpcy5sb2FkRGF0YSgpKTtcbiAgICB0aGlzLmNsaWVudCA9IG5ldyBIZXJtZXNBQ1BDbGllbnQodGhpcy5zZXR0aW5ncy5oZXJtZXNDb21tYW5kKTtcbiAgICB0aGlzLndpcmVDbGllbnRDYWxsYmFja3MoKTtcbiAgICB0aGlzLmluamVjdFN0eWxlcygpO1xuXG4gICAgdGhpcy5yZWdpc3RlclZpZXcoVklFV19UWVBFX0hFUk1FU19NVlAsIGxlYWYgPT4gbmV3IEhlcm1lc01WUFZpZXcobGVhZiwgdGhpcykpO1xuICAgIHRoaXMuYWRkU2V0dGluZ1RhYihuZXcgSGVybWVzU2V0dGluZ1RhYih0aGlzLmFwcCwgdGhpcykpO1xuXG4gICAgdGhpcy5hZGRSaWJib25JY29uKCdib3QnLCAnT3BlbiBIZXJtZXMgTVZQJywgYXN5bmMgKCkgPT4ge1xuICAgICAgYXdhaXQgdGhpcy5hY3RpdmF0ZVZpZXcoKTtcbiAgICB9KTtcblxuICAgIHRoaXMuYWRkQ29tbWFuZCh7XG4gICAgICBpZDogJ29wZW4taGVybWVzLW12cCcsXG4gICAgICBuYW1lOiAnT3BlbiBIZXJtZXMgTVZQJyxcbiAgICAgIGNhbGxiYWNrOiBhc3luYyAoKSA9PiB0aGlzLmFjdGl2YXRlVmlldygpLFxuICAgIH0pO1xuICB9XG5cbiAgYXN5bmMgb251bmxvYWQoKSB7XG4gICAgdGhpcy5hcHAud29ya3NwYWNlLmRldGFjaExlYXZlc09mVHlwZShWSUVXX1RZUEVfSEVSTUVTX01WUCk7XG4gIH1cblxuICByZWdpc3RlclZpZXdJbnN0YW5jZSh2aWV3OiBIZXJtZXNNVlBWaWV3KSB7XG4gICAgdGhpcy5hY3RpdmVWaWV3ID0gdmlldztcbiAgfVxuXG4gIHVucmVnaXN0ZXJWaWV3SW5zdGFuY2UodmlldzogSGVybWVzTVZQVmlldykge1xuICAgIGlmICh0aGlzLmFjdGl2ZVZpZXcgPT09IHZpZXcpIHRoaXMuYWN0aXZlVmlldyA9IG51bGw7XG4gIH1cblxuICBnZXRWYXVsdFBhdGgoKSB7XG4gICAgcmV0dXJuIHRoaXMuYXBwLnZhdWx0LmFkYXB0ZXIuYmFzZVBhdGggfHwgcHJvY2Vzcy5jd2QoKTtcbiAgfVxuXG4gIGFzeW5jIHNhdmVTZXR0aW5ncygpIHtcbiAgICBhd2FpdCB0aGlzLnNhdmVEYXRhKHRoaXMuc2V0dGluZ3MpO1xuICAgIHRoaXMuY2xpZW50ID0gbmV3IEhlcm1lc0FDUENsaWVudCh0aGlzLnNldHRpbmdzLmhlcm1lc0NvbW1hbmQpO1xuICAgIHRoaXMud2lyZUNsaWVudENhbGxiYWNrcygpO1xuICB9XG5cbiAgcGVyc2lzdE1lc3NhZ2VzKG1lc3NhZ2VzOiBDaGF0TWVzc2FnZVtdKSB7XG4gICAgdGhpcy5zZXR0aW5ncy5tZXNzYWdlcyA9IG1lc3NhZ2VzLm1hcChtZXNzYWdlID0+ICh7IC4uLm1lc3NhZ2UgfSkpO1xuICAgIHZvaWQgdGhpcy5zYXZlRGF0YSh0aGlzLnNldHRpbmdzKTtcbiAgfVxuXG4gIHByaXZhdGUgd2lyZUNsaWVudENhbGxiYWNrcygpIHtcbiAgICB0aGlzLmNsaWVudC5vbkFzc2lzdGFudFRleHQgPSAodGV4dDogc3RyaW5nKSA9PiB7XG4gICAgICB0aGlzLmFjdGl2ZVZpZXc/LmFwcGVuZE1lc3NhZ2UoJ2Fzc2lzdGFudCcsIHRleHQpO1xuICAgIH07XG5cbiAgICB0aGlzLmNsaWVudC5vblN0YXR1cyA9ICh0ZXh0OiBzdHJpbmcpID0+IHtcbiAgICAgIHRoaXMuYWN0aXZlVmlldz8uYXBwZW5kTWVzc2FnZSgnc3RhdHVzJywgdGV4dCk7XG4gICAgfTtcblxuICAgIHRoaXMuY2xpZW50Lm9uRXJyb3IgPSAodGV4dDogc3RyaW5nKSA9PiB7XG4gICAgICB0aGlzLmFjdGl2ZVZpZXc/LmFwcGVuZE1lc3NhZ2UoJ2Vycm9yJywgdGV4dCk7XG4gICAgICBuZXcgTm90aWNlKHRleHQpO1xuICAgIH07XG4gIH1cblxuICBwcml2YXRlIGluamVjdFN0eWxlcygpIHtcbiAgICBjb25zdCBzdHlsZUlkID0gJ2hlcm1lcy1tdnAtaW5saW5lLXN0eWxlcyc7XG4gICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoc3R5bGVJZCk/LnJlbW92ZSgpO1xuXG4gICAgY29uc3Qgc3R5bGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzdHlsZScpO1xuICAgIHN0eWxlLmlkID0gc3R5bGVJZDtcbiAgICBzdHlsZS50ZXh0Q29udGVudCA9IGBcbiAgICAgIC5oZXJtZXMtbXZwLXJvb3Qge1xuICAgICAgICBoZWlnaHQ6IDEwMCU7XG4gICAgICB9XG5cbiAgICAgIC5oZXJtZXMtbXZwLXdyYXAge1xuICAgICAgICBkaXNwbGF5OiBmbGV4O1xuICAgICAgICBmbGV4LWRpcmVjdGlvbjogY29sdW1uO1xuICAgICAgICBoZWlnaHQ6IDEwMCU7XG4gICAgICAgIGJhY2tncm91bmQ6IHZhcigtLWJhY2tncm91bmQtcHJpbWFyeSk7XG4gICAgICAgIGNvbG9yOiB2YXIoLS10ZXh0LW5vcm1hbCk7XG4gICAgICB9XG5cbiAgICAgIC5oZXJtZXMtbXZwLWhlYWRlciB7XG4gICAgICAgIHBhZGRpbmc6IDE0cHggMTZweCAxMHB4O1xuICAgICAgICBib3JkZXItYm90dG9tOiAxcHggc29saWQgdmFyKC0tYmFja2dyb3VuZC1tb2RpZmllci1ib3JkZXIpO1xuICAgICAgICBiYWNrZ3JvdW5kOiBjb2xvci1taXgoaW4gc3JnYiwgdmFyKC0tYmFja2dyb3VuZC1zZWNvbmRhcnkpIDcwJSwgdHJhbnNwYXJlbnQpO1xuICAgICAgfVxuXG4gICAgICAuaGVybWVzLW12cC10aXRsZSB7XG4gICAgICAgIGZvbnQtc2l6ZTogMThweDtcbiAgICAgICAgZm9udC13ZWlnaHQ6IDcwMDtcbiAgICAgICAgbGV0dGVyLXNwYWNpbmc6IC0wLjAxZW07XG4gICAgICB9XG5cbiAgICAgIC5oZXJtZXMtbXZwLXN1YnRpdGxlIHtcbiAgICAgICAgbWFyZ2luLXRvcDogMnB4O1xuICAgICAgICBmb250LXNpemU6IDEycHg7XG4gICAgICAgIGNvbG9yOiB2YXIoLS10ZXh0LW11dGVkKTtcbiAgICAgIH1cblxuICAgICAgLmhlcm1lcy1tdnAtbWVzc2FnZXMge1xuICAgICAgICBmbGV4OiAxO1xuICAgICAgICBvdmVyZmxvdy15OiBhdXRvO1xuICAgICAgICBwYWRkaW5nOiAxOHB4IDE2cHggMjRweDtcbiAgICAgICAgZGlzcGxheTogZmxleDtcbiAgICAgICAgZmxleC1kaXJlY3Rpb246IGNvbHVtbjtcbiAgICAgICAgZ2FwOiAxMnB4O1xuICAgICAgfVxuXG4gICAgICAuaGVybWVzLW12cC1lbXB0eSB7XG4gICAgICAgIG1hcmdpbjogYXV0byAwO1xuICAgICAgICBwYWRkaW5nOiAyNHB4IDE4cHg7XG4gICAgICAgIGJvcmRlcjogMXB4IGRhc2hlZCB2YXIoLS1iYWNrZ3JvdW5kLW1vZGlmaWVyLWJvcmRlcik7XG4gICAgICAgIGJvcmRlci1yYWRpdXM6IDE2cHg7XG4gICAgICAgIGJhY2tncm91bmQ6IGNvbG9yLW1peChpbiBzcmdiLCB2YXIoLS1iYWNrZ3JvdW5kLXNlY29uZGFyeSkgNTUlLCB0cmFuc3BhcmVudCk7XG4gICAgICB9XG5cbiAgICAgIC5oZXJtZXMtbXZwLWVtcHR5LXRpdGxlIHtcbiAgICAgICAgZm9udC1zaXplOiAxNnB4O1xuICAgICAgICBmb250LXdlaWdodDogNjAwO1xuICAgICAgICBtYXJnaW4tYm90dG9tOiA2cHg7XG4gICAgICB9XG5cbiAgICAgIC5oZXJtZXMtbXZwLWVtcHR5LXN1YnRpdGxlIHtcbiAgICAgICAgZm9udC1zaXplOiAxM3B4O1xuICAgICAgICBsaW5lLWhlaWdodDogMS41O1xuICAgICAgICBjb2xvcjogdmFyKC0tdGV4dC1tdXRlZCk7XG4gICAgICB9XG5cbiAgICAgIC5oZXJtZXMtbXZwLXJvdyB7XG4gICAgICAgIGRpc3BsYXk6IGZsZXg7XG4gICAgICB9XG5cbiAgICAgIC5oZXJtZXMtbXZwLXJvdy11c2VyIHtcbiAgICAgICAganVzdGlmeS1jb250ZW50OiBmbGV4LWVuZDtcbiAgICAgIH1cblxuICAgICAgLmhlcm1lcy1tdnAtcm93LWFzc2lzdGFudCxcbiAgICAgIC5oZXJtZXMtbXZwLXJvdy1zdGF0dXMsXG4gICAgICAuaGVybWVzLW12cC1yb3ctZXJyb3Ige1xuICAgICAgICBqdXN0aWZ5LWNvbnRlbnQ6IGZsZXgtc3RhcnQ7XG4gICAgICB9XG5cbiAgICAgIC5oZXJtZXMtbXZwLWJ1YmJsZSB7XG4gICAgICAgIG1heC13aWR0aDogbWluKDY4MHB4LCA5MiUpO1xuICAgICAgICBib3JkZXItcmFkaXVzOiAxNnB4O1xuICAgICAgICBwYWRkaW5nOiAxMHB4IDEycHg7XG4gICAgICAgIGJveC1zaGFkb3c6IDAgMXB4IDJweCByZ2IoMCAwIDAgLyAwLjA4KTtcbiAgICAgIH1cblxuICAgICAgLmhlcm1lcy1tdnAtYnViYmxlLXVzZXIge1xuICAgICAgICBiYWNrZ3JvdW5kOiB2YXIoLS1pbnRlcmFjdGl2ZS1hY2NlbnQpO1xuICAgICAgICBjb2xvcjogdmFyKC0tdGV4dC1vbi1hY2NlbnQpO1xuICAgICAgICBib3JkZXItYm90dG9tLXJpZ2h0LXJhZGl1czogNnB4O1xuICAgICAgfVxuXG4gICAgICAuaGVybWVzLW12cC1idWJibGUtYXNzaXN0YW50IHtcbiAgICAgICAgYmFja2dyb3VuZDogdmFyKC0tYmFja2dyb3VuZC1zZWNvbmRhcnkpO1xuICAgICAgICBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1iYWNrZ3JvdW5kLW1vZGlmaWVyLWJvcmRlcik7XG4gICAgICAgIGJvcmRlci1ib3R0b20tbGVmdC1yYWRpdXM6IDZweDtcbiAgICAgIH1cblxuICAgICAgLmhlcm1lcy1tdnAtYnViYmxlLXN0YXR1cyB7XG4gICAgICAgIGJhY2tncm91bmQ6IGNvbG9yLW1peChpbiBzcmdiLCB2YXIoLS1jb2xvci1ibHVlKSAxMCUsIHZhcigtLWJhY2tncm91bmQtc2Vjb25kYXJ5KSk7XG4gICAgICAgIGJvcmRlcjogMXB4IHNvbGlkIGNvbG9yLW1peChpbiBzcmdiLCB2YXIoLS1jb2xvci1ibHVlKSAyOCUsIHZhcigtLWJhY2tncm91bmQtbW9kaWZpZXItYm9yZGVyKSk7XG4gICAgICAgIGNvbG9yOiB2YXIoLS10ZXh0LW11dGVkKTtcbiAgICAgICAgbWF4LXdpZHRoOiAxMDAlO1xuICAgICAgfVxuXG4gICAgICAuaGVybWVzLW12cC1idWJibGUtZXJyb3Ige1xuICAgICAgICBiYWNrZ3JvdW5kOiBjb2xvci1taXgoaW4gc3JnYiwgdmFyKC0tY29sb3ItcmVkKSAxMCUsIHZhcigtLWJhY2tncm91bmQtc2Vjb25kYXJ5KSk7XG4gICAgICAgIGJvcmRlcjogMXB4IHNvbGlkIGNvbG9yLW1peChpbiBzcmdiLCB2YXIoLS1jb2xvci1yZWQpIDMwJSwgdmFyKC0tYmFja2dyb3VuZC1tb2RpZmllci1ib3JkZXIpKTtcbiAgICAgICAgY29sb3I6IHZhcigtLXRleHQtbm9ybWFsKTtcbiAgICAgICAgbWF4LXdpZHRoOiAxMDAlO1xuICAgICAgfVxuXG4gICAgICAuaGVybWVzLW12cC1idWJibGUtbGFiZWwge1xuICAgICAgICBmb250LXNpemU6IDExcHg7XG4gICAgICAgIGZvbnQtd2VpZ2h0OiA3MDA7XG4gICAgICAgIHRleHQtdHJhbnNmb3JtOiB1cHBlcmNhc2U7XG4gICAgICAgIGxldHRlci1zcGFjaW5nOiAwLjA0ZW07XG4gICAgICAgIG9wYWNpdHk6IDAuNztcbiAgICAgICAgbWFyZ2luLWJvdHRvbTogNnB4O1xuICAgICAgfVxuXG4gICAgICAuaGVybWVzLW12cC1idWJibGUtYm9keSB7XG4gICAgICAgIGZvbnQtc2l6ZTogMTRweDtcbiAgICAgICAgbGluZS1oZWlnaHQ6IDEuNTU7XG4gICAgICAgIHdvcmQtYnJlYWs6IGJyZWFrLXdvcmQ7XG4gICAgICAgIHVzZXItc2VsZWN0OiB0ZXh0O1xuICAgICAgICAtd2Via2l0LXVzZXItc2VsZWN0OiB0ZXh0O1xuICAgICAgICBjdXJzb3I6IHRleHQ7XG4gICAgICB9XG5cbiAgICAgIC5oZXJtZXMtbXZwLWJ1YmJsZS1ib2R5ICoge1xuICAgICAgICB1c2VyLXNlbGVjdDogdGV4dDtcbiAgICAgICAgLXdlYmtpdC11c2VyLXNlbGVjdDogdGV4dDtcbiAgICAgIH1cblxuICAgICAgLmhlcm1lcy1tdnAtYnViYmxlLWJvZHkgPiA6Zmlyc3QtY2hpbGQge1xuICAgICAgICBtYXJnaW4tdG9wOiAwO1xuICAgICAgfVxuXG4gICAgICAuaGVybWVzLW12cC1idWJibGUtYm9keSA+IDpsYXN0LWNoaWxkIHtcbiAgICAgICAgbWFyZ2luLWJvdHRvbTogMDtcbiAgICAgIH1cblxuICAgICAgLmhlcm1lcy1tdnAtY29tcG9zZXIge1xuICAgICAgICBkaXNwbGF5OiBmbGV4O1xuICAgICAgICBhbGlnbi1pdGVtczogZmxleC1lbmQ7XG4gICAgICAgIGdhcDogMTBweDtcbiAgICAgICAgcGFkZGluZzogMTRweCAxNnB4IDE2cHg7XG4gICAgICAgIGJvcmRlci10b3A6IDFweCBzb2xpZCB2YXIoLS1iYWNrZ3JvdW5kLW1vZGlmaWVyLWJvcmRlcik7XG4gICAgICAgIGJhY2tncm91bmQ6IHZhcigtLWJhY2tncm91bmQtcHJpbWFyeSk7XG4gICAgICB9XG5cbiAgICAgIC5oZXJtZXMtbXZwLWlucHV0LXdyYXAge1xuICAgICAgICBmbGV4OiAxO1xuICAgICAgICBiYWNrZ3JvdW5kOiB2YXIoLS1iYWNrZ3JvdW5kLXNlY29uZGFyeSk7XG4gICAgICAgIGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJhY2tncm91bmQtbW9kaWZpZXItYm9yZGVyKTtcbiAgICAgICAgYm9yZGVyLXJhZGl1czogMTZweDtcbiAgICAgICAgcGFkZGluZzogMTBweCAxMnB4O1xuICAgICAgfVxuXG4gICAgICAuaGVybWVzLW12cC1pbnB1dCB7XG4gICAgICAgIHdpZHRoOiAxMDAlO1xuICAgICAgICBtaW4taGVpZ2h0OiAyNHB4O1xuICAgICAgICBtYXgtaGVpZ2h0OiAyMjBweDtcbiAgICAgICAgcmVzaXplOiBub25lO1xuICAgICAgICBib3JkZXI6IDA7XG4gICAgICAgIG91dGxpbmU6IG5vbmU7XG4gICAgICAgIGJhY2tncm91bmQ6IHRyYW5zcGFyZW50O1xuICAgICAgICBib3gtc2hhZG93OiBub25lO1xuICAgICAgICBjb2xvcjogdmFyKC0tdGV4dC1ub3JtYWwpO1xuICAgICAgICBmb250OiBpbmhlcml0O1xuICAgICAgICBsaW5lLWhlaWdodDogMS41O1xuICAgICAgICBwYWRkaW5nOiAwO1xuICAgICAgfVxuXG4gICAgICAuaGVybWVzLW12cC1pbnB1dDo6cGxhY2Vob2xkZXIge1xuICAgICAgICBjb2xvcjogdmFyKC0tdGV4dC1mYWludCk7XG4gICAgICB9XG5cbiAgICAgIC5oZXJtZXMtbXZwLXNlbmQge1xuICAgICAgICBib3JkZXItcmFkaXVzOiAxNHB4O1xuICAgICAgICBtaW4td2lkdGg6IDgwcHg7XG4gICAgICAgIGhlaWdodDogNDRweDtcbiAgICAgIH1cbiAgICBgO1xuXG4gICAgZG9jdW1lbnQuaGVhZC5hcHBlbmRDaGlsZChzdHlsZSk7XG4gIH1cblxuICBhc3luYyBhY3RpdmF0ZVZpZXcoKSB7XG4gICAgbGV0IGxlYWYgPSB0aGlzLmFwcC53b3Jrc3BhY2UuZ2V0TGVhdmVzT2ZUeXBlKFZJRVdfVFlQRV9IRVJNRVNfTVZQKVswXTtcbiAgICBpZiAoIWxlYWYpIHtcbiAgICAgIGxlYWYgPSB0aGlzLmFwcC53b3Jrc3BhY2UuZ2V0UmlnaHRMZWFmKGZhbHNlKTtcbiAgICAgIGF3YWl0IGxlYWYuc2V0Vmlld1N0YXRlKHsgdHlwZTogVklFV19UWVBFX0hFUk1FU19NVlAsIGFjdGl2ZTogdHJ1ZSB9KTtcbiAgICB9XG4gICAgYXdhaXQgdGhpcy5hcHAud29ya3NwYWNlLnJldmVhbExlYWYobGVhZik7XG4gIH1cbn1cbiIsICJpbXBvcnQgeyBDaGlsZFByb2Nlc3NXaXRob3V0TnVsbFN0cmVhbXMsIHNwYXduIH0gZnJvbSAnY2hpbGRfcHJvY2Vzcyc7XG5pbXBvcnQgeyBleGlzdHNTeW5jIH0gZnJvbSAnZnMnO1xuXG5cbnR5cGUgUGVuZGluZ1JlcXVlc3QgPSB7XG4gIHJlc29sdmU6ICh2YWx1ZTogYW55KSA9PiB2b2lkO1xuICByZWplY3Q6IChyZWFzb24/OiB1bmtub3duKSA9PiB2b2lkO1xufTtcblxudHlwZSBTZXNzaW9uVXBkYXRlUGFyYW1zID0ge1xuICBzZXNzaW9uSWQ/OiBzdHJpbmc7XG4gIHNlc3Npb25faWQ/OiBzdHJpbmc7XG4gIHVwZGF0ZT86IFJlY29yZDxzdHJpbmcsIGFueT47XG59O1xuXG5leHBvcnQgY2xhc3MgSGVybWVzQUNQQ2xpZW50IHtcbiAgcHJpdmF0ZSBwcm9jOiBDaGlsZFByb2Nlc3NXaXRob3V0TnVsbFN0cmVhbXMgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBidWZmZXIgPSAnJztcbiAgcHJpdmF0ZSBuZXh0SWQgPSAxO1xuICBwcml2YXRlIHBlbmRpbmcgPSBuZXcgTWFwPG51bWJlciwgUGVuZGluZ1JlcXVlc3Q+KCk7XG4gIHByaXZhdGUgaW5pdGlhbGl6ZWQgPSBmYWxzZTtcbiAgcHJpdmF0ZSBzZXNzaW9uSWQ6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICBvbkFzc2lzdGFudFRleHQ/OiAodGV4dDogc3RyaW5nKSA9PiB2b2lkO1xuICBvblN0YXR1cz86ICh0ZXh0OiBzdHJpbmcpID0+IHZvaWQ7XG4gIG9uRXJyb3I/OiAodGV4dDogc3RyaW5nKSA9PiB2b2lkO1xuXG4gIGNvbnN0cnVjdG9yKHByaXZhdGUgaGVybWVzQ29tbWFuZDogc3RyaW5nKSB7fVxuXG4gIHByaXZhdGUgcmVzb2x2ZUhlcm1lc0NvbW1hbmQoKSB7XG4gICAgaWYgKHRoaXMuaGVybWVzQ29tbWFuZC5pbmNsdWRlcygnLycpIHx8IHRoaXMuaGVybWVzQ29tbWFuZC5pbmNsdWRlcygnXFxcXCcpKSB7XG4gICAgICByZXR1cm4gdGhpcy5oZXJtZXNDb21tYW5kO1xuICAgIH1cblxuICAgIGNvbnN0IGhvbWUgPSBwcm9jZXNzLmVudi5IT01FO1xuICAgIGNvbnN0IGNhbmRpZGF0ZXMgPSBbXG4gICAgICB0aGlzLmhlcm1lc0NvbW1hbmQsXG4gICAgICBob21lID8gYCR7aG9tZX0vLmxvY2FsL2Jpbi8ke3RoaXMuaGVybWVzQ29tbWFuZH1gIDogbnVsbCxcbiAgICAgIGhvbWUgPyBgJHtob21lfS8ubnBtLWdsb2JhbC9iaW4vJHt0aGlzLmhlcm1lc0NvbW1hbmR9YCA6IG51bGwsXG4gICAgICBgL3Vzci9sb2NhbC9iaW4vJHt0aGlzLmhlcm1lc0NvbW1hbmR9YCxcbiAgICAgIGAvb3B0L2hvbWVicmV3L2Jpbi8ke3RoaXMuaGVybWVzQ29tbWFuZH1gLFxuICAgIF0uZmlsdGVyKCh2YWx1ZSk6IHZhbHVlIGlzIHN0cmluZyA9PiBCb29sZWFuKHZhbHVlKSk7XG5cbiAgICBmb3IgKGNvbnN0IGNhbmRpZGF0ZSBvZiBjYW5kaWRhdGVzKSB7XG4gICAgICBpZiAoY2FuZGlkYXRlID09PSB0aGlzLmhlcm1lc0NvbW1hbmQgfHwgZXhpc3RzU3luYyhjYW5kaWRhdGUpKSByZXR1cm4gY2FuZGlkYXRlO1xuICAgIH1cblxuICAgIHJldHVybiB0aGlzLmhlcm1lc0NvbW1hbmQ7XG4gIH1cblxuICBwcml2YXRlIGVuc3VyZVN0YXJ0ZWQoY3dkPzogc3RyaW5nKSB7XG4gICAgaWYgKHRoaXMucHJvYykgcmV0dXJuO1xuXG4gICAgY29uc3QgY29tbWFuZCA9IHRoaXMucmVzb2x2ZUhlcm1lc0NvbW1hbmQoKTtcblxuICAgIHRoaXMucHJvYyA9IHNwYXduKGNvbW1hbmQsIFsnYWNwJ10sIHtcbiAgICAgIGN3ZDogY3dkIHx8IHByb2Nlc3MuY3dkKCksXG4gICAgICBzdGRpbzogWydwaXBlJywgJ3BpcGUnLCAncGlwZSddLFxuICAgIH0pO1xuXG4gICAgdGhpcy5wcm9jLnN0ZG91dC5vbignZGF0YScsIGNodW5rID0+IHtcbiAgICAgIHRoaXMuYnVmZmVyICs9IGNodW5rLnRvU3RyaW5nKCd1dGY4Jyk7XG4gICAgICB0aGlzLmNvbnN1bWVCdWZmZXIoKTtcbiAgICB9KTtcblxuICAgIHRoaXMucHJvYy5zdGRlcnIub24oJ2RhdGEnLCBjaHVuayA9PiB7XG4gICAgICBjb25zdCB0ZXh0ID0gY2h1bmsudG9TdHJpbmcoJ3V0ZjgnKS50cmltKCk7XG4gICAgICBpZiAodGV4dCAmJiB0aGlzLm9uU3RhdHVzKSB0aGlzLm9uU3RhdHVzKHRleHQpO1xuICAgIH0pO1xuXG4gICAgdGhpcy5wcm9jLm9uKCdlcnJvcicsIGVycm9yID0+IHtcbiAgICAgIGNvbnN0IGV4dHJhID0gY29tbWFuZCA9PT0gdGhpcy5oZXJtZXNDb21tYW5kXG4gICAgICAgID8gJydcbiAgICAgICAgOiBgIChyZXNvbHZlZCBmcm9tICR7dGhpcy5oZXJtZXNDb21tYW5kfSB0byAke2NvbW1hbmR9KWA7XG4gICAgICB0aGlzLm9uRXJyb3I/LihgRmFpbGVkIHRvIHN0YXJ0IEhlcm1lcyBBQ1Ake2V4dHJhfTogJHtTdHJpbmcoZXJyb3IpfWApO1xuICAgIH0pO1xuXG4gICAgdGhpcy5wcm9jLm9uKCdleGl0JywgY29kZSA9PiB7XG4gICAgICBjb25zdCBlcnJvciA9IGBIZXJtZXMgQUNQIGV4aXRlZCR7Y29kZSAhPT0gbnVsbCA/IGAgd2l0aCBjb2RlICR7Y29kZX1gIDogJyd9YDtcbiAgICAgIGZvciAoY29uc3QgcGVuZGluZyBvZiB0aGlzLnBlbmRpbmcudmFsdWVzKCkpIHBlbmRpbmcucmVqZWN0KG5ldyBFcnJvcihlcnJvcikpO1xuICAgICAgdGhpcy5wZW5kaW5nLmNsZWFyKCk7XG4gICAgICB0aGlzLnByb2MgPSBudWxsO1xuICAgICAgdGhpcy5pbml0aWFsaXplZCA9IGZhbHNlO1xuICAgICAgdGhpcy5zZXNzaW9uSWQgPSBudWxsO1xuICAgICAgdGhpcy5vblN0YXR1cz8uKGVycm9yKTtcbiAgICB9KTtcbiAgfVxuXG4gIHByaXZhdGUgY29uc3VtZUJ1ZmZlcigpIHtcbiAgICBsZXQgbmV3bGluZUluZGV4ID0gLTE7XG4gICAgd2hpbGUgKChuZXdsaW5lSW5kZXggPSB0aGlzLmJ1ZmZlci5pbmRleE9mKCdcXG4nKSkgPj0gMCkge1xuICAgICAgY29uc3QgbGluZSA9IHRoaXMuYnVmZmVyLnNsaWNlKDAsIG5ld2xpbmVJbmRleCkudHJpbSgpO1xuICAgICAgdGhpcy5idWZmZXIgPSB0aGlzLmJ1ZmZlci5zbGljZShuZXdsaW5lSW5kZXggKyAxKTtcbiAgICAgIGlmICghbGluZSkgY29udGludWU7XG5cbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IG1zZyA9IEpTT04ucGFyc2UobGluZSk7XG4gICAgICAgIHRoaXMuaGFuZGxlTWVzc2FnZShtc2cpO1xuICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgdGhpcy5vbkVycm9yPy4oYEZhaWxlZCB0byBwYXJzZSBBQ1Agb3V0cHV0OiAke1N0cmluZyhlcnJvcil9YCk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBoYW5kbGVNZXNzYWdlKG1zZzogYW55KSB7XG4gICAgaWYgKHR5cGVvZiBtc2cuaWQgPT09ICdudW1iZXInICYmIHRoaXMucGVuZGluZy5oYXMobXNnLmlkKSkge1xuICAgICAgY29uc3QgcGVuZGluZyA9IHRoaXMucGVuZGluZy5nZXQobXNnLmlkKSE7XG4gICAgICB0aGlzLnBlbmRpbmcuZGVsZXRlKG1zZy5pZCk7XG4gICAgICBpZiAobXNnLmVycm9yKSB7XG4gICAgICAgIGNvbnN0IGRldGFpbCA9IHR5cGVvZiBtc2cuZXJyb3IgPT09ICdzdHJpbmcnXG4gICAgICAgICAgPyBtc2cuZXJyb3JcbiAgICAgICAgICA6IG1zZy5lcnJvcj8ubWVzc2FnZSB8fCBKU09OLnN0cmluZ2lmeShtc2cuZXJyb3IpO1xuICAgICAgICBwZW5kaW5nLnJlamVjdChuZXcgRXJyb3IoZGV0YWlsKSk7XG4gICAgICB9XG4gICAgICBlbHNlIHBlbmRpbmcucmVzb2x2ZShtc2cucmVzdWx0KTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBpZiAobXNnLm1ldGhvZCA9PT0gJ3Nlc3Npb24vdXBkYXRlJykge1xuICAgICAgdGhpcy5oYW5kbGVTZXNzaW9uVXBkYXRlKG1zZy5wYXJhbXMgPz8ge30pO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgaGFuZGxlU2Vzc2lvblVwZGF0ZShwYXJhbXM6IFNlc3Npb25VcGRhdGVQYXJhbXMpIHtcbiAgICBjb25zdCB1cGRhdGUgPSBwYXJhbXMudXBkYXRlID8/IHBhcmFtcztcbiAgICBpZiAoIXVwZGF0ZSB8fCB0eXBlb2YgdXBkYXRlICE9PSAnb2JqZWN0JykgcmV0dXJuO1xuXG4gICAgY29uc3Qgc2Vzc2lvblVwZGF0ZSA9IHVwZGF0ZS5zZXNzaW9uVXBkYXRlID8/IHVwZGF0ZS5zZXNzaW9uX3VwZGF0ZTtcblxuICAgIGlmIChzZXNzaW9uVXBkYXRlID09PSAnYWdlbnRfbWVzc2FnZV9jaHVuaycgfHwgc2Vzc2lvblVwZGF0ZSA9PT0gJ2FnZW50X21lc3NhZ2UnKSB7XG4gICAgICBjb25zdCB0ZXh0ID0gdGhpcy5leHRyYWN0VGV4dCh1cGRhdGUpO1xuICAgICAgaWYgKHRleHQpIHRoaXMub25Bc3Npc3RhbnRUZXh0Py4odGV4dCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgaWYgKHNlc3Npb25VcGRhdGUgPT09ICdhZ2VudF90aG91Z2h0X2NodW5rJyB8fCBzZXNzaW9uVXBkYXRlID09PSAndG9vbF9jYWxsJyB8fCBzZXNzaW9uVXBkYXRlID09PSAndG9vbF9jYWxsX3VwZGF0ZScpIHtcbiAgICAgIGNvbnN0IHRleHQgPSB0aGlzLmV4dHJhY3RUZXh0KHVwZGF0ZSk7XG4gICAgICBpZiAodGV4dCkgdGhpcy5vblN0YXR1cz8uKHRleHQpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGlmIChzZXNzaW9uVXBkYXRlID09PSAnYXZhaWxhYmxlX2NvbW1hbmRzX3VwZGF0ZScpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjb25zdCBmYWxsYmFjayA9IHRoaXMuZXh0cmFjdFRleHQodXBkYXRlKTtcbiAgICBpZiAoZmFsbGJhY2spIHRoaXMub25TdGF0dXM/LihmYWxsYmFjayk7XG4gIH1cblxuICBwcml2YXRlIGV4dHJhY3RUZXh0KHZhbHVlOiBhbnkpOiBzdHJpbmcge1xuICAgIGNvbnN0IHBhcnRzOiBzdHJpbmdbXSA9IFtdO1xuXG4gICAgY29uc3Qgd2FsayA9IChub2RlOiBhbnkpID0+IHtcbiAgICAgIGlmIChub2RlID09IG51bGwpIHJldHVybjtcbiAgICAgIGlmICh0eXBlb2Ygbm9kZSA9PT0gJ3N0cmluZycpIHJldHVybjtcbiAgICAgIGlmIChBcnJheS5pc0FycmF5KG5vZGUpKSB7XG4gICAgICAgIGZvciAoY29uc3QgaXRlbSBvZiBub2RlKSB3YWxrKGl0ZW0pO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBpZiAodHlwZW9mIG5vZGUgIT09ICdvYmplY3QnKSByZXR1cm47XG5cbiAgICAgIGlmICh0eXBlb2Ygbm9kZS50ZXh0ID09PSAnc3RyaW5nJykgcGFydHMucHVzaChub2RlLnRleHQpO1xuICAgICAgaWYgKHR5cGVvZiBub2RlLmNvbnRlbnQgPT09ICdzdHJpbmcnKSBwYXJ0cy5wdXNoKG5vZGUuY29udGVudCk7XG4gICAgICBpZiAodHlwZW9mIG5vZGUucmVzdWx0ID09PSAnc3RyaW5nJykgcGFydHMucHVzaChub2RlLnJlc3VsdCk7XG4gICAgICBpZiAodHlwZW9mIG5vZGUuZGVzY3JpcHRpb24gPT09ICdzdHJpbmcnKSBwYXJ0cy5wdXNoKG5vZGUuZGVzY3JpcHRpb24pO1xuXG4gICAgICBmb3IgKGNvbnN0IGtleSBvZiBPYmplY3Qua2V5cyhub2RlKSkge1xuICAgICAgICB3YWxrKG5vZGVba2V5XSk7XG4gICAgICB9XG4gICAgfTtcblxuICAgIHdhbGsodmFsdWUpO1xuICAgIHJldHVybiBwYXJ0cy5qb2luKCcnKTtcbiAgfVxuXG4gIHByaXZhdGUgcmVxdWVzdChtZXRob2Q6IHN0cmluZywgcGFyYW1zOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikge1xuICAgIGlmICghdGhpcy5wcm9jKSB0aHJvdyBuZXcgRXJyb3IoJ0hlcm1lcyBBQ1AgcHJvY2VzcyBpcyBub3QgcnVubmluZycpO1xuXG4gICAgY29uc3QgaWQgPSB0aGlzLm5leHRJZCsrO1xuICAgIGNvbnN0IHBheWxvYWQgPSB7IGpzb25ycGM6ICcyLjAnLCBpZCwgbWV0aG9kLCBwYXJhbXMgfTtcbiAgICB0aGlzLnByb2Muc3RkaW4ud3JpdGUoYCR7SlNPTi5zdHJpbmdpZnkocGF5bG9hZCl9XFxuYCk7XG5cbiAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgdGhpcy5wZW5kaW5nLnNldChpZCwgeyByZXNvbHZlLCByZWplY3QgfSk7XG4gICAgfSk7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIGVuc3VyZUluaXRpYWxpemVkKGN3ZD86IHN0cmluZykge1xuICAgIHRoaXMuZW5zdXJlU3RhcnRlZChjd2QpO1xuICAgIGlmICh0aGlzLmluaXRpYWxpemVkKSByZXR1cm47XG5cbiAgICBhd2FpdCB0aGlzLnJlcXVlc3QoJ2luaXRpYWxpemUnLCB7XG4gICAgICBwcm90b2NvbF92ZXJzaW9uOiAxLFxuICAgICAgY2xpZW50X2NhcGFiaWxpdGllczoge30sXG4gICAgICBjbGllbnRfaW5mbzoge1xuICAgICAgICBuYW1lOiAnaGVybWVzLW9ic2lkaWFuLW12cCcsXG4gICAgICAgIHZlcnNpb246ICcwLjAuMicsXG4gICAgICB9LFxuICAgIH0pO1xuICAgIHRoaXMuaW5pdGlhbGl6ZWQgPSB0cnVlO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBlbnN1cmVTZXNzaW9uKGN3ZD86IHN0cmluZykge1xuICAgIGlmICh0aGlzLnNlc3Npb25JZCkgcmV0dXJuIHRoaXMuc2Vzc2lvbklkO1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHRoaXMucmVxdWVzdCgnc2Vzc2lvbi9uZXcnLCB7IGN3ZDogY3dkIHx8IHByb2Nlc3MuY3dkKCksIG1jcFNlcnZlcnM6IFtdIH0pO1xuICAgIHRoaXMuc2Vzc2lvbklkID0gcmVzdWx0Py5zZXNzaW9uSWQgPz8gcmVzdWx0Py5zZXNzaW9uX2lkID8/IHJlc3VsdD8uaWQ7XG4gICAgaWYgKCF0aGlzLnNlc3Npb25JZCkgdGhyb3cgbmV3IEVycm9yKCdIZXJtZXMgQUNQIGRpZCBub3QgcmV0dXJuIGEgc2Vzc2lvbiBpZCcpO1xuICAgIHJldHVybiB0aGlzLnNlc3Npb25JZDtcbiAgfVxuXG4gIGFzeW5jIHNlbmRQcm9tcHQodGV4dDogc3RyaW5nLCBjd2Q/OiBzdHJpbmcpIHtcbiAgICBhd2FpdCB0aGlzLmVuc3VyZUluaXRpYWxpemVkKGN3ZCk7XG4gICAgY29uc3Qgc2Vzc2lvbklkID0gYXdhaXQgdGhpcy5lbnN1cmVTZXNzaW9uKGN3ZCk7XG4gICAgcmV0dXJuIHRoaXMucmVxdWVzdCgnc2Vzc2lvbi9wcm9tcHQnLCB7XG4gICAgICBzZXNzaW9uSWQsXG4gICAgICBwcm9tcHQ6IFt7IHR5cGU6ICd0ZXh0JywgdGV4dCB9XSxcbiAgICB9KTtcbiAgfVxufVxuIl0sCiAgIm1hcHBpbmdzIjogIjs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUEsc0JBQTBHOzs7QUNBMUcsMkJBQXNEO0FBQ3RELGdCQUEyQjtBQWNwQixJQUFNLGtCQUFOLE1BQXNCO0FBQUEsRUFXM0IsWUFBb0IsZUFBdUI7QUFBdkI7QUFWcEIsU0FBUSxPQUE4QztBQUN0RCxTQUFRLFNBQVM7QUFDakIsU0FBUSxTQUFTO0FBQ2pCLFNBQVEsVUFBVSxvQkFBSSxJQUE0QjtBQUNsRCxTQUFRLGNBQWM7QUFDdEIsU0FBUSxZQUEyQjtBQUFBLEVBS1M7QUFBQSxFQUVwQyx1QkFBdUI7QUFDN0IsUUFBSSxLQUFLLGNBQWMsU0FBUyxHQUFHLEtBQUssS0FBSyxjQUFjLFNBQVMsSUFBSSxHQUFHO0FBQ3pFLGFBQU8sS0FBSztBQUFBLElBQ2Q7QUFFQSxVQUFNLE9BQU8sUUFBUSxJQUFJO0FBQ3pCLFVBQU0sYUFBYTtBQUFBLE1BQ2pCLEtBQUs7QUFBQSxNQUNMLE9BQU8sR0FBRyxJQUFJLGVBQWUsS0FBSyxhQUFhLEtBQUs7QUFBQSxNQUNwRCxPQUFPLEdBQUcsSUFBSSxvQkFBb0IsS0FBSyxhQUFhLEtBQUs7QUFBQSxNQUN6RCxrQkFBa0IsS0FBSyxhQUFhO0FBQUEsTUFDcEMscUJBQXFCLEtBQUssYUFBYTtBQUFBLElBQ3pDLEVBQUUsT0FBTyxDQUFDLFVBQTJCLFFBQVEsS0FBSyxDQUFDO0FBRW5ELGVBQVcsYUFBYSxZQUFZO0FBQ2xDLFVBQUksY0FBYyxLQUFLLHFCQUFpQixzQkFBVyxTQUFTLEVBQUcsUUFBTztBQUFBLElBQ3hFO0FBRUEsV0FBTyxLQUFLO0FBQUEsRUFDZDtBQUFBLEVBRVEsY0FBYyxLQUFjO0FBQ2xDLFFBQUksS0FBSyxLQUFNO0FBRWYsVUFBTSxV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

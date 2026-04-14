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
  ensureStarted(cwd) {
    if (this.proc) return;
    this.proc = (0, import_child_process.spawn)(this.hermesCommand, ["acp"], {
      cwd: cwd || process.cwd(),
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.proc.stdout.on("data", (chunk) => {
      this.buffer += chunk.toString("utf8");
      this.consumeBuffer();
    });
    this.proc.stderr.on("data", (chunk) => {
      console.log("[Hermes ACP stderr]", chunk.toString("utf8"));
    });
    this.proc.on("exit", (code) => {
      console.log("[Hermes ACP exited]", code);
      this.proc = null;
      this.initialized = false;
      this.sessionId = null;
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
        console.warn("Failed to parse ACP output line", error, line);
      }
    }
  }
  handleMessage(msg) {
    if (typeof msg.id === "number" && this.pending.has(msg.id)) {
      const pending = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(msg.error);
      else pending.resolve(msg.result);
      return;
    }
    if (msg.method === "session/update") {
      const serialized = JSON.stringify(msg.params ?? {});
      const match = serialized.match(/"text"\s*:\s*"([^"]*)"/g);
      if (!match || !this.onAssistantText) return;
      for (const part of match) {
        const textMatch = part.match(/"text"\s*:\s*"([^"]*)"/);
        const text = textMatch?.[1]?.replace(/\\n/g, "\n")?.replace(/\\"/g, '"');
        if (text) this.onAssistantText(text);
      }
    }
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
      protocolVersion: 1,
      clientCapabilities: {}
    });
    this.initialized = true;
  }
  async ensureSession(cwd) {
    if (this.sessionId) return this.sessionId;
    const result = await this.request("session/new", cwd ? { cwd } : {});
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
  hermesCommand: "hermes"
};
var HermesMVPView = class extends import_obsidian.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.messages = [];
    this.plugin = plugin;
  }
  getViewType() {
    return VIEW_TYPE_HERMES_MVP;
  }
  getDisplayText() {
    return "Hermes";
  }
  async onOpen() {
    this.plugin.client.onAssistantText = (text) => {
      const last = this.messages[this.messages.length - 1];
      if (!last || last.role !== "assistant") {
        this.messages.push({ role: "assistant", text });
      } else {
        last.text += text;
      }
      this.render();
    };
    this.render();
  }
  render() {
    const root = this.containerEl.children[1];
    root.empty();
    const wrap = root.createDiv({ cls: "hermes-mvp-wrap" });
    const list = wrap.createDiv({ cls: "hermes-mvp-messages" });
    for (const msg of this.messages) {
      const row = list.createDiv({ cls: `hermes-mvp-msg hermes-mvp-${msg.role}` });
      row.createEl("strong", { text: msg.role === "user" ? "You" : "Hermes" });
      row.createDiv({ text: msg.text });
    }
    const form = wrap.createDiv({ cls: "hermes-mvp-form" });
    const input = form.createEl("textarea", {
      attr: { rows: "4", placeholder: "Ask Hermes..." }
    });
    const button = form.createEl("button", { text: "Send" });
    button.addEventListener("click", async () => {
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      this.messages.push({ role: "user", text });
      this.messages.push({ role: "assistant", text: "" });
      this.render();
      await this.plugin.client.sendPrompt(text, this.plugin.app.vault.adapter.basePath);
    });
  }
};
var HermesObsidianMVPPlugin = class extends import_obsidian.Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.client = new HermesACPClient(this.settings.hermesCommand);
    this.registerView(VIEW_TYPE_HERMES_MVP, (leaf) => new HermesMVPView(leaf, this));
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
  async activateView() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_HERMES_MVP)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE_HERMES_MVP, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
  }
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsic3JjL21haW4udHMiLCAic3JjL3RyYW5zcG9ydC9oZXJtZXMtYWNwLWNsaWVudC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgSXRlbVZpZXcsIFBsdWdpbiwgV29ya3NwYWNlTGVhZiB9IGZyb20gJ29ic2lkaWFuJztcbmltcG9ydCB7IEhlcm1lc0FDUENsaWVudCB9IGZyb20gJy4vdHJhbnNwb3J0L2hlcm1lcy1hY3AtY2xpZW50JztcblxuY29uc3QgVklFV19UWVBFX0hFUk1FU19NVlAgPSAnaGVybWVzLW9ic2lkaWFuLW12cCc7XG5cbmludGVyZmFjZSBIZXJtZXNQbHVnaW5TZXR0aW5ncyB7XG4gIGhlcm1lc0NvbW1hbmQ6IHN0cmluZztcbn1cblxuY29uc3QgREVGQVVMVF9TRVRUSU5HUzogSGVybWVzUGx1Z2luU2V0dGluZ3MgPSB7XG4gIGhlcm1lc0NvbW1hbmQ6ICdoZXJtZXMnLFxufTtcblxuY2xhc3MgSGVybWVzTVZQVmlldyBleHRlbmRzIEl0ZW1WaWV3IHtcbiAgcGx1Z2luOiBIZXJtZXNPYnNpZGlhbk1WUFBsdWdpbjtcbiAgbWVzc2FnZXM6IEFycmF5PHsgcm9sZTogJ3VzZXInIHwgJ2Fzc2lzdGFudCc7IHRleHQ6IHN0cmluZyB9PiA9IFtdO1xuXG4gIGNvbnN0cnVjdG9yKGxlYWY6IFdvcmtzcGFjZUxlYWYsIHBsdWdpbjogSGVybWVzT2JzaWRpYW5NVlBQbHVnaW4pIHtcbiAgICBzdXBlcihsZWFmKTtcbiAgICB0aGlzLnBsdWdpbiA9IHBsdWdpbjtcbiAgfVxuXG4gIGdldFZpZXdUeXBlKCkge1xuICAgIHJldHVybiBWSUVXX1RZUEVfSEVSTUVTX01WUDtcbiAgfVxuXG4gIGdldERpc3BsYXlUZXh0KCkge1xuICAgIHJldHVybiAnSGVybWVzJztcbiAgfVxuXG4gIGFzeW5jIG9uT3BlbigpIHtcbiAgICB0aGlzLnBsdWdpbi5jbGllbnQub25Bc3Npc3RhbnRUZXh0ID0gKHRleHQ6IHN0cmluZykgPT4ge1xuICAgICAgY29uc3QgbGFzdCA9IHRoaXMubWVzc2FnZXNbdGhpcy5tZXNzYWdlcy5sZW5ndGggLSAxXTtcbiAgICAgIGlmICghbGFzdCB8fCBsYXN0LnJvbGUgIT09ICdhc3Npc3RhbnQnKSB7XG4gICAgICAgIHRoaXMubWVzc2FnZXMucHVzaCh7IHJvbGU6ICdhc3Npc3RhbnQnLCB0ZXh0IH0pO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgbGFzdC50ZXh0ICs9IHRleHQ7XG4gICAgICB9XG4gICAgICB0aGlzLnJlbmRlcigpO1xuICAgIH07XG5cbiAgICB0aGlzLnJlbmRlcigpO1xuICB9XG5cbiAgcmVuZGVyKCkge1xuICAgIGNvbnN0IHJvb3QgPSB0aGlzLmNvbnRhaW5lckVsLmNoaWxkcmVuWzFdIGFzIEhUTUxFbGVtZW50O1xuICAgIHJvb3QuZW1wdHkoKTtcblxuICAgIGNvbnN0IHdyYXAgPSByb290LmNyZWF0ZURpdih7IGNsczogJ2hlcm1lcy1tdnAtd3JhcCcgfSk7XG4gICAgY29uc3QgbGlzdCA9IHdyYXAuY3JlYXRlRGl2KHsgY2xzOiAnaGVybWVzLW12cC1tZXNzYWdlcycgfSk7XG5cbiAgICBmb3IgKGNvbnN0IG1zZyBvZiB0aGlzLm1lc3NhZ2VzKSB7XG4gICAgICBjb25zdCByb3cgPSBsaXN0LmNyZWF0ZURpdih7IGNsczogYGhlcm1lcy1tdnAtbXNnIGhlcm1lcy1tdnAtJHttc2cucm9sZX1gIH0pO1xuICAgICAgcm93LmNyZWF0ZUVsKCdzdHJvbmcnLCB7IHRleHQ6IG1zZy5yb2xlID09PSAndXNlcicgPyAnWW91JyA6ICdIZXJtZXMnIH0pO1xuICAgICAgcm93LmNyZWF0ZURpdih7IHRleHQ6IG1zZy50ZXh0IH0pO1xuICAgIH1cblxuICAgIGNvbnN0IGZvcm0gPSB3cmFwLmNyZWF0ZURpdih7IGNsczogJ2hlcm1lcy1tdnAtZm9ybScgfSk7XG4gICAgY29uc3QgaW5wdXQgPSBmb3JtLmNyZWF0ZUVsKCd0ZXh0YXJlYScsIHtcbiAgICAgIGF0dHI6IHsgcm93czogJzQnLCBwbGFjZWhvbGRlcjogJ0FzayBIZXJtZXMuLi4nIH0sXG4gICAgfSk7XG4gICAgY29uc3QgYnV0dG9uID0gZm9ybS5jcmVhdGVFbCgnYnV0dG9uJywgeyB0ZXh0OiAnU2VuZCcgfSk7XG5cbiAgICBidXR0b24uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCB0ZXh0ID0gaW5wdXQudmFsdWUudHJpbSgpO1xuICAgICAgaWYgKCF0ZXh0KSByZXR1cm47XG5cbiAgICAgIGlucHV0LnZhbHVlID0gJyc7XG4gICAgICB0aGlzLm1lc3NhZ2VzLnB1c2goeyByb2xlOiAndXNlcicsIHRleHQgfSk7XG4gICAgICB0aGlzLm1lc3NhZ2VzLnB1c2goeyByb2xlOiAnYXNzaXN0YW50JywgdGV4dDogJycgfSk7XG4gICAgICB0aGlzLnJlbmRlcigpO1xuXG4gICAgICBhd2FpdCB0aGlzLnBsdWdpbi5jbGllbnQuc2VuZFByb21wdCh0ZXh0LCB0aGlzLnBsdWdpbi5hcHAudmF1bHQuYWRhcHRlci5iYXNlUGF0aCk7XG4gICAgfSk7XG4gIH1cbn1cblxuZXhwb3J0IGRlZmF1bHQgY2xhc3MgSGVybWVzT2JzaWRpYW5NVlBQbHVnaW4gZXh0ZW5kcyBQbHVnaW4ge1xuICBzZXR0aW5ncyE6IEhlcm1lc1BsdWdpblNldHRpbmdzO1xuICBjbGllbnQhOiBIZXJtZXNBQ1BDbGllbnQ7XG5cbiAgYXN5bmMgb25sb2FkKCkge1xuICAgIHRoaXMuc2V0dGluZ3MgPSBPYmplY3QuYXNzaWduKHt9LCBERUZBVUxUX1NFVFRJTkdTLCBhd2FpdCB0aGlzLmxvYWREYXRhKCkpO1xuICAgIHRoaXMuY2xpZW50ID0gbmV3IEhlcm1lc0FDUENsaWVudCh0aGlzLnNldHRpbmdzLmhlcm1lc0NvbW1hbmQpO1xuXG4gICAgdGhpcy5yZWdpc3RlclZpZXcoVklFV19UWVBFX0hFUk1FU19NVlAsIGxlYWYgPT4gbmV3IEhlcm1lc01WUFZpZXcobGVhZiwgdGhpcykpO1xuXG4gICAgdGhpcy5hZGRSaWJib25JY29uKCdib3QnLCAnT3BlbiBIZXJtZXMgTVZQJywgYXN5bmMgKCkgPT4ge1xuICAgICAgYXdhaXQgdGhpcy5hY3RpdmF0ZVZpZXcoKTtcbiAgICB9KTtcblxuICAgIHRoaXMuYWRkQ29tbWFuZCh7XG4gICAgICBpZDogJ29wZW4taGVybWVzLW12cCcsXG4gICAgICBuYW1lOiAnT3BlbiBIZXJtZXMgTVZQJyxcbiAgICAgIGNhbGxiYWNrOiBhc3luYyAoKSA9PiB0aGlzLmFjdGl2YXRlVmlldygpLFxuICAgIH0pO1xuICB9XG5cbiAgYXN5bmMgb251bmxvYWQoKSB7XG4gICAgdGhpcy5hcHAud29ya3NwYWNlLmRldGFjaExlYXZlc09mVHlwZShWSUVXX1RZUEVfSEVSTUVTX01WUCk7XG4gIH1cblxuICBhc3luYyBhY3RpdmF0ZVZpZXcoKSB7XG4gICAgbGV0IGxlYWYgPSB0aGlzLmFwcC53b3Jrc3BhY2UuZ2V0TGVhdmVzT2ZUeXBlKFZJRVdfVFlQRV9IRVJNRVNfTVZQKVswXTtcbiAgICBpZiAoIWxlYWYpIHtcbiAgICAgIGxlYWYgPSB0aGlzLmFwcC53b3Jrc3BhY2UuZ2V0UmlnaHRMZWFmKGZhbHNlKTtcbiAgICAgIGF3YWl0IGxlYWYuc2V0Vmlld1N0YXRlKHsgdHlwZTogVklFV19UWVBFX0hFUk1FU19NVlAsIGFjdGl2ZTogdHJ1ZSB9KTtcbiAgICB9XG4gICAgYXdhaXQgdGhpcy5hcHAud29ya3NwYWNlLnJldmVhbExlYWYobGVhZik7XG4gIH1cbn1cbiIsICJpbXBvcnQgeyBzcGF3biwgQ2hpbGRQcm9jZXNzV2l0aG91dE51bGxTdHJlYW1zIH0gZnJvbSAnY2hpbGRfcHJvY2Vzcyc7XG5cbnR5cGUgUGVuZGluZ1JlcXVlc3QgPSB7XG4gIHJlc29sdmU6ICh2YWx1ZTogYW55KSA9PiB2b2lkO1xuICByZWplY3Q6IChyZWFzb24/OiB1bmtub3duKSA9PiB2b2lkO1xufTtcblxuZXhwb3J0IGNsYXNzIEhlcm1lc0FDUENsaWVudCB7XG4gIHByaXZhdGUgcHJvYzogQ2hpbGRQcm9jZXNzV2l0aG91dE51bGxTdHJlYW1zIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgYnVmZmVyID0gJyc7XG4gIHByaXZhdGUgbmV4dElkID0gMTtcbiAgcHJpdmF0ZSBwZW5kaW5nID0gbmV3IE1hcDxudW1iZXIsIFBlbmRpbmdSZXF1ZXN0PigpO1xuICBwcml2YXRlIGluaXRpYWxpemVkID0gZmFsc2U7XG4gIHByaXZhdGUgc2Vzc2lvbklkOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgb25Bc3Npc3RhbnRUZXh0PzogKHRleHQ6IHN0cmluZykgPT4gdm9pZDtcblxuICBjb25zdHJ1Y3Rvcihwcml2YXRlIGhlcm1lc0NvbW1hbmQ6IHN0cmluZykge31cblxuICBwcml2YXRlIGVuc3VyZVN0YXJ0ZWQoY3dkPzogc3RyaW5nKSB7XG4gICAgaWYgKHRoaXMucHJvYykgcmV0dXJuO1xuXG4gICAgdGhpcy5wcm9jID0gc3Bhd24odGhpcy5oZXJtZXNDb21tYW5kLCBbJ2FjcCddLCB7XG4gICAgICBjd2Q6IGN3ZCB8fCBwcm9jZXNzLmN3ZCgpLFxuICAgICAgc3RkaW86IFsncGlwZScsICdwaXBlJywgJ3BpcGUnXSxcbiAgICB9KTtcblxuICAgIHRoaXMucHJvYy5zdGRvdXQub24oJ2RhdGEnLCBjaHVuayA9PiB7XG4gICAgICB0aGlzLmJ1ZmZlciArPSBjaHVuay50b1N0cmluZygndXRmOCcpO1xuICAgICAgdGhpcy5jb25zdW1lQnVmZmVyKCk7XG4gICAgfSk7XG5cbiAgICB0aGlzLnByb2Muc3RkZXJyLm9uKCdkYXRhJywgY2h1bmsgPT4ge1xuICAgICAgY29uc29sZS5sb2coJ1tIZXJtZXMgQUNQIHN0ZGVycl0nLCBjaHVuay50b1N0cmluZygndXRmOCcpKTtcbiAgICB9KTtcblxuICAgIHRoaXMucHJvYy5vbignZXhpdCcsIGNvZGUgPT4ge1xuICAgICAgY29uc29sZS5sb2coJ1tIZXJtZXMgQUNQIGV4aXRlZF0nLCBjb2RlKTtcbiAgICAgIHRoaXMucHJvYyA9IG51bGw7XG4gICAgICB0aGlzLmluaXRpYWxpemVkID0gZmFsc2U7XG4gICAgICB0aGlzLnNlc3Npb25JZCA9IG51bGw7XG4gICAgfSk7XG4gIH1cblxuICBwcml2YXRlIGNvbnN1bWVCdWZmZXIoKSB7XG4gICAgbGV0IG5ld2xpbmVJbmRleCA9IC0xO1xuICAgIHdoaWxlICgobmV3bGluZUluZGV4ID0gdGhpcy5idWZmZXIuaW5kZXhPZignXFxuJykpID49IDApIHtcbiAgICAgIGNvbnN0IGxpbmUgPSB0aGlzLmJ1ZmZlci5zbGljZSgwLCBuZXdsaW5lSW5kZXgpLnRyaW0oKTtcbiAgICAgIHRoaXMuYnVmZmVyID0gdGhpcy5idWZmZXIuc2xpY2UobmV3bGluZUluZGV4ICsgMSk7XG4gICAgICBpZiAoIWxpbmUpIGNvbnRpbnVlO1xuXG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBtc2cgPSBKU09OLnBhcnNlKGxpbmUpO1xuICAgICAgICB0aGlzLmhhbmRsZU1lc3NhZ2UobXNnKTtcbiAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGNvbnNvbGUud2FybignRmFpbGVkIHRvIHBhcnNlIEFDUCBvdXRwdXQgbGluZScsIGVycm9yLCBsaW5lKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBwcml2YXRlIGhhbmRsZU1lc3NhZ2UobXNnOiBhbnkpIHtcbiAgICBpZiAodHlwZW9mIG1zZy5pZCA9PT0gJ251bWJlcicgJiYgdGhpcy5wZW5kaW5nLmhhcyhtc2cuaWQpKSB7XG4gICAgICBjb25zdCBwZW5kaW5nID0gdGhpcy5wZW5kaW5nLmdldChtc2cuaWQpITtcbiAgICAgIHRoaXMucGVuZGluZy5kZWxldGUobXNnLmlkKTtcbiAgICAgIGlmIChtc2cuZXJyb3IpIHBlbmRpbmcucmVqZWN0KG1zZy5lcnJvcik7XG4gICAgICBlbHNlIHBlbmRpbmcucmVzb2x2ZShtc2cucmVzdWx0KTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBpZiAobXNnLm1ldGhvZCA9PT0gJ3Nlc3Npb24vdXBkYXRlJykge1xuICAgICAgY29uc3Qgc2VyaWFsaXplZCA9IEpTT04uc3RyaW5naWZ5KG1zZy5wYXJhbXMgPz8ge30pO1xuICAgICAgY29uc3QgbWF0Y2ggPSBzZXJpYWxpemVkLm1hdGNoKC9cInRleHRcIlxccyo6XFxzKlwiKFteXCJdKilcIi9nKTtcbiAgICAgIGlmICghbWF0Y2ggfHwgIXRoaXMub25Bc3Npc3RhbnRUZXh0KSByZXR1cm47XG5cbiAgICAgIGZvciAoY29uc3QgcGFydCBvZiBtYXRjaCkge1xuICAgICAgICBjb25zdCB0ZXh0TWF0Y2ggPSBwYXJ0Lm1hdGNoKC9cInRleHRcIlxccyo6XFxzKlwiKFteXCJdKilcIi8pO1xuICAgICAgICBjb25zdCB0ZXh0ID0gdGV4dE1hdGNoPy5bMV1cbiAgICAgICAgICA/LnJlcGxhY2UoL1xcXFxuL2csICdcXG4nKVxuICAgICAgICAgID8ucmVwbGFjZSgvXFxcXFwiL2csICdcIicpO1xuICAgICAgICBpZiAodGV4dCkgdGhpcy5vbkFzc2lzdGFudFRleHQodGV4dCk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSByZXF1ZXN0KG1ldGhvZDogc3RyaW5nLCBwYXJhbXM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSB7XG4gICAgaWYgKCF0aGlzLnByb2MpIHRocm93IG5ldyBFcnJvcignSGVybWVzIEFDUCBwcm9jZXNzIGlzIG5vdCBydW5uaW5nJyk7XG5cbiAgICBjb25zdCBpZCA9IHRoaXMubmV4dElkKys7XG4gICAgY29uc3QgcGF5bG9hZCA9IHsganNvbnJwYzogJzIuMCcsIGlkLCBtZXRob2QsIHBhcmFtcyB9O1xuICAgIHRoaXMucHJvYy5zdGRpbi53cml0ZShgJHtKU09OLnN0cmluZ2lmeShwYXlsb2FkKX1cXG5gKTtcblxuICAgIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICB0aGlzLnBlbmRpbmcuc2V0KGlkLCB7IHJlc29sdmUsIHJlamVjdCB9KTtcbiAgICB9KTtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgZW5zdXJlSW5pdGlhbGl6ZWQoY3dkPzogc3RyaW5nKSB7XG4gICAgdGhpcy5lbnN1cmVTdGFydGVkKGN3ZCk7XG4gICAgaWYgKHRoaXMuaW5pdGlhbGl6ZWQpIHJldHVybjtcblxuICAgIGF3YWl0IHRoaXMucmVxdWVzdCgnaW5pdGlhbGl6ZScsIHtcbiAgICAgIHByb3RvY29sVmVyc2lvbjogMSxcbiAgICAgIGNsaWVudENhcGFiaWxpdGllczoge30sXG4gICAgfSk7XG4gICAgdGhpcy5pbml0aWFsaXplZCA9IHRydWU7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIGVuc3VyZVNlc3Npb24oY3dkPzogc3RyaW5nKSB7XG4gICAgaWYgKHRoaXMuc2Vzc2lvbklkKSByZXR1cm4gdGhpcy5zZXNzaW9uSWQ7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgdGhpcy5yZXF1ZXN0KCdzZXNzaW9uL25ldycsIGN3ZCA/IHsgY3dkIH0gOiB7fSk7XG4gICAgdGhpcy5zZXNzaW9uSWQgPSByZXN1bHQ/LnNlc3Npb25JZCA/PyByZXN1bHQ/LnNlc3Npb25faWQgPz8gcmVzdWx0Py5pZDtcbiAgICBpZiAoIXRoaXMuc2Vzc2lvbklkKSB0aHJvdyBuZXcgRXJyb3IoJ0hlcm1lcyBBQ1AgZGlkIG5vdCByZXR1cm4gYSBzZXNzaW9uIGlkJyk7XG4gICAgcmV0dXJuIHRoaXMuc2Vzc2lvbklkO1xuICB9XG5cbiAgYXN5bmMgc2VuZFByb21wdCh0ZXh0OiBzdHJpbmcsIGN3ZD86IHN0cmluZykge1xuICAgIGF3YWl0IHRoaXMuZW5zdXJlSW5pdGlhbGl6ZWQoY3dkKTtcbiAgICBjb25zdCBzZXNzaW9uSWQgPSBhd2FpdCB0aGlzLmVuc3VyZVNlc3Npb24oY3dkKTtcbiAgICByZXR1cm4gdGhpcy5yZXF1ZXN0KCdzZXNzaW9uL3Byb21wdCcsIHtcbiAgICAgIHNlc3Npb25JZCxcbiAgICAgIHByb21wdDogW3sgdHlwZTogJ3RleHQnLCB0ZXh0IH1dLFxuICAgIH0pO1xuICB9XG59XG4iXSwKICAibWFwcGluZ3MiOiAiOzs7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Q0FBQztBQUNELFVBQU0sU0FBUyxLQUFLLFNBQVMsVUFBVSxFQUFFLE1BQU0sT0FBTyxDQUFDO0FBRXZELFdBQU8saUJBQWlCLFNBQVMsWUFBWTtBQUMzQyxZQUFNLE9BQU8sTUFBTSxNQUFNLEtBQUs7QUFDOUIsVUFBSSxDQUFDLEtBQU07QUFFWCxZQUFNLFFBQVE7QUFDZCxXQUFLLFNBQVMsS0FBSyxFQUFFLE1BQU0sUUFBUSxLQUFLLENBQUM7QUFDekMsV0FBSyxTQUFTLEtBQUssRUFBRSxNQUFNLGFBQWEsTUFBTSxHQUFHLENBQUM7QUFDbEQsV0FBSyxPQUFPO0FBRVosWUFBTSxLQUFLLE9BQU8sT0FBTyxXQUFXLE1BQU0sS0FBSyxPQUFPLElBQUksTUFBTSxRQUFRLFFBQVE7QUFBQSxJQUNsRixDQUFDO0FBQUEsRUFDSDtBQUNGO0FBRUEsSUFBcUIsMEJBQXJCLGNBQXFELHVCQUFPO0FBQUEsRUFJMUQsTUFBTSxTQUFTO0FBQ2IsU0FBSyxXQUFXLE9BQU8sT0FBTyxDQUFDLEdBQUcsa0JBQWtCLE1BQU0sS0FBSyxTQUFTLENBQUM7QUFDekUsU0FBSyxTQUFTLElBQUksZ0JBQWdCLEtBQUssU0FBUyxhQUFhO0FBRTdELFNBQUssYUFBYSxzQkFBc0IsVUFBUSxJQUFJLGNBQWMsTUFBTSxJQUFJLENBQUM7QUFFN0UsU0FBSyxjQUFjLE9BQU8sbUJBQW1CLFlBQVk7QUFDdkQsWUFBTSxLQUFLLGFBQWE7QUFBQSxJQUMxQixDQUFDO0FBRUQsU0FBSyxXQUFXO0FBQUEsTUFDZCxJQUFJO0FBQUEsTUFDSixNQUFNO0FBQUEsTUFDTixVQUFVLFlBQVksS0FBSyxhQUFhO0FBQUEsSUFDMUMsQ0FBQztBQUFBLEVBQ0g7QUFBQSxFQUVBLE1BQU0sV0FBVztBQUNmLFNBQUssSUFBSSxVQUFVLG1CQUFtQixvQkFBb0I7QUFBQSxFQUM1RDtBQUFBLEVBRUEsTUFBTSxlQUFlO0FBQ25CLFFBQUksT0FBTyxLQUFLLElBQUksVUFBVSxnQkFBZ0Isb0JBQW9CLEVBQUUsQ0FBQztBQUNyRSxRQUFJLENBQUMsTUFBTTtBQUNULGFBQU8sS0FBSyxJQUFJLFVBQVUsYUFBYSxLQUFLO0FBQzVDLFlBQU0sS0FBSyxhQUFhLEVBQUUsTUFBTSxzQkFBc0IsUUFBUSxLQUFLLENBQUM7QUFBQSxJQUN0RTtBQUNBLFVBQU0sS0FBSyxJQUFJLFVBQVUsV0FBVyxJQUFJO0FBQUEsRUFDMUM7QUFDRjsiLAogICJuYW1lcyI6IFtdCn0K

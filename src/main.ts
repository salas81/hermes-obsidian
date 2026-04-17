import { App, ItemView, MarkdownRenderer, Notice, Plugin, PluginSettingTab, Setting, WorkspaceLeaf } from 'obsidian';
import { HermesACPClient } from './transport/hermes-acp-client';

const VIEW_TYPE_HERMES_MVP = 'hermes-obsidian-mvp';

type ChatMessage = {
  role: 'user' | 'assistant' | 'status' | 'error';
  text: string;
};

interface HermesPluginSettings {
  hermesCommand: string;
  messages: ChatMessage[];
}

const DEFAULT_SETTINGS: HermesPluginSettings = {
  hermesCommand: 'hermes',
  messages: [],
};

class HermesMVPView extends ItemView {
  plugin: HermesObsidianMVPPlugin;
  messages: ChatMessage[] = [];
  private inputValue = '';
  private isSending = false;

  constructor(leaf: WorkspaceLeaf, plugin: HermesObsidianMVPPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return VIEW_TYPE_HERMES_MVP;
  }

  getDisplayText() {
    return 'Hermes';
  }

  async onOpen() {
    this.plugin.registerViewInstance(this);
    this.messages = Array.isArray(this.plugin.settings.messages)
      ? this.plugin.settings.messages.map(message => ({ ...message }))
      : [];
    this.render();
  }

  async onClose() {
    this.plugin.unregisterViewInstance(this);
  }

  appendMessage(role: ChatMessage['role'], text: string) {
    if (!text) return;

    if (role === 'assistant') {
      const last = this.messages[this.messages.length - 1];
      if (last && last.role === 'assistant') {
        last.text += text;
      } else {
        this.messages.push({ role, text });
      }
    } else if (role === 'status') {
      const last = this.messages[this.messages.length - 1];
      if (last && last.role === 'status') {
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

  private async submitPrompt() {
    const text = this.inputValue.trim();
    if (!text || this.isSending) return;

    this.inputValue = '';
    this.isSending = true;
    this.messages.push({ role: 'user', text });
    this.messages.push({ role: 'assistant', text: '' });
    this.render();

    try {
      await this.plugin.client.sendPrompt(text, this.plugin.getVaultPath());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.appendMessage('error', message);
    } finally {
      this.isSending = false;
      this.render();
    }
  }

  private getLabel(role: ChatMessage['role']) {
    switch (role) {
      case 'user':
        return 'You';
      case 'assistant':
        return 'Hermes';
      case 'status':
        return 'Status';
      case 'error':
        return 'Error';
    }
  }

  private async renderMessageBody(container: HTMLElement, msg: ChatMessage) {
    if (msg.role === 'assistant') {
      await MarkdownRenderer.render(this.app, msg.text || '…', container, '', this.plugin);
      return;
    }

    if (msg.role === 'status') {
      container.setText(msg.text);
      return;
    }

    container.setText(msg.text || (msg.role === 'assistant' ? '…' : ''));
  }

  render() {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass('hermes-mvp-root');

    const wrap = root.createDiv({ cls: 'hermes-mvp-wrap' });
    const header = wrap.createDiv({ cls: 'hermes-mvp-header' });
    header.createDiv({ cls: 'hermes-mvp-title', text: 'Hermes' });
    header.createDiv({
      cls: 'hermes-mvp-subtitle',
      text: this.isSending ? 'Thinking…' : 'Local Obsidian chat',
    });

    const list = wrap.createDiv({ cls: 'hermes-mvp-messages' });

    if (this.messages.length === 0) {
      const empty = list.createDiv({ cls: 'hermes-mvp-empty' });
      empty.createDiv({ cls: 'hermes-mvp-empty-title', text: 'Start a conversation' });
      empty.createDiv({
        cls: 'hermes-mvp-empty-subtitle',
        text: 'Ask Hermes to brainstorm, write, summarize, or help you think through a note.',
      });
    }

    for (const msg of this.messages) {
      const row = list.createDiv({ cls: `hermes-mvp-row hermes-mvp-row-${msg.role}` });
      const bubble = row.createDiv({ cls: `hermes-mvp-bubble hermes-mvp-bubble-${msg.role}` });
      bubble.createDiv({ cls: 'hermes-mvp-bubble-label', text: this.getLabel(msg.role) });
      const body = bubble.createDiv({ cls: 'hermes-mvp-bubble-body' });
      void this.renderMessageBody(body, msg);
    }

    const composer = wrap.createDiv({ cls: 'hermes-mvp-composer' });
    const inputWrap = composer.createDiv({ cls: 'hermes-mvp-input-wrap' });
    const input = inputWrap.createEl('textarea', {
      cls: 'hermes-mvp-input',
      attr: { rows: '1', placeholder: 'Message Hermes…' },
    });
    input.value = this.inputValue;
    input.disabled = this.isSending;
    input.addEventListener('input', () => {
      this.inputValue = input.value;
      input.style.height = '0px';
      input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
    });
    input.addEventListener('keydown', evt => {
      if (evt.key === 'Enter' && !evt.shiftKey) {
        evt.preventDefault();
        void this.submitPrompt();
      }
    });
    input.style.height = '0px';
    input.style.height = `${Math.min(input.scrollHeight, 220)}px`;

    const button = composer.createEl('button', {
      cls: 'mod-cta hermes-mvp-send',
      text: this.isSending ? 'Sending…' : 'Send',
    });
    button.disabled = this.isSending;
    button.addEventListener('click', () => {
      void this.submitPrompt();
    });

    list.scrollTop = list.scrollHeight;
  }
}

class HermesSettingTab extends PluginSettingTab {
  plugin: HermesObsidianMVPPlugin;

  constructor(app: App, plugin: HermesObsidianMVPPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Hermes command')
      .setDesc('Command used to launch Hermes ACP locally.')
      .addText(text =>
        text
          .setPlaceholder('hermes')
          .setValue(this.plugin.settings.hermesCommand)
          .onChange(async value => {
            this.plugin.settings.hermesCommand = value.trim() || 'hermes';
            await this.plugin.saveSettings();
            new Notice('Hermes command saved');
          }),
      );
  }
}

export default class HermesObsidianMVPPlugin extends Plugin {
  settings!: HermesPluginSettings;
  client!: HermesACPClient;
  private activeView: HermesMVPView | null = null;

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.client = new HermesACPClient(this.settings.hermesCommand);
    this.wireClientCallbacks();
    this.injectStyles();

    this.registerView(VIEW_TYPE_HERMES_MVP, leaf => new HermesMVPView(leaf, this));
    this.addSettingTab(new HermesSettingTab(this.app, this));

    this.addRibbonIcon('bot', 'Open Hermes MVP', async () => {
      await this.activateView();
    });

    this.addCommand({
      id: 'open-hermes-mvp',
      name: 'Open Hermes MVP',
      callback: async () => this.activateView(),
    });
  }

  async onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_HERMES_MVP);
  }

  registerViewInstance(view: HermesMVPView) {
    this.activeView = view;
  }

  unregisterViewInstance(view: HermesMVPView) {
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

  persistMessages(messages: ChatMessage[]) {
    this.settings.messages = messages.map(message => ({ ...message }));
    void this.saveData(this.settings);
  }

  private wireClientCallbacks() {
    this.client.onAssistantText = (text: string) => {
      this.activeView?.appendMessage('assistant', text);
    };

    this.client.onStatus = (text: string) => {
      this.activeView?.appendMessage('status', text);
    };

    this.client.onError = (text: string) => {
      this.activeView?.appendMessage('error', text);
      new Notice(text);
    };
  }

  private injectStyles() {
    const styleId = 'hermes-mvp-inline-styles';
    document.getElementById(styleId)?.remove();

    const style = document.createElement('style');
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
}

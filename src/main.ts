import { App, ItemView, Notice, Plugin, PluginSettingTab, Setting, WorkspaceLeaf } from 'obsidian';
import { HermesACPClient } from './transport/hermes-acp-client';

const VIEW_TYPE_HERMES_MVP = 'hermes-obsidian-mvp';

type ChatMessage = {
  role: 'user' | 'assistant' | 'status' | 'error';
  text: string;
};

interface HermesPluginSettings {
  hermesCommand: string;
}

const DEFAULT_SETTINGS: HermesPluginSettings = {
  hermesCommand: 'hermes',
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

    this.render();
  }

  markSending(isSending: boolean) {
    this.isSending = isSending;
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

  render() {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();

    const wrap = root.createDiv({ cls: 'hermes-mvp-wrap' });
    const list = wrap.createDiv({ cls: 'hermes-mvp-messages' });

    for (const msg of this.messages) {
      const row = list.createDiv({ cls: `hermes-mvp-msg hermes-mvp-${msg.role}` });
      const label = msg.role === 'user'
        ? 'You'
        : msg.role === 'assistant'
          ? 'Hermes'
          : msg.role === 'status'
            ? 'Status'
            : 'Error';
      row.createEl('strong', { text: label });
      row.createDiv({ text: msg.text || (msg.role === 'assistant' ? '...' : '') });
    }

    const form = wrap.createDiv({ cls: 'hermes-mvp-form' });
    const input = form.createEl('textarea', {
      attr: { rows: '4', placeholder: 'Ask Hermes...' },
    });
    input.value = this.inputValue;
    input.disabled = this.isSending;
    input.addEventListener('input', () => {
      this.inputValue = input.value;
    });
    input.addEventListener('keydown', evt => {
      if (evt.key === 'Enter' && (evt.metaKey || evt.ctrlKey)) {
        evt.preventDefault();
        void this.submitPrompt();
      }
    });

    const button = form.createEl('button', { text: this.isSending ? 'Sending...' : 'Send' });
    button.disabled = this.isSending;
    button.addEventListener('click', () => {
      void this.submitPrompt();
    });
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

  async activateView() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_HERMES_MVP)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE_HERMES_MVP, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
  }
}

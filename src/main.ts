import { ItemView, Plugin, WorkspaceLeaf } from 'obsidian';
import { HermesACPClient } from './transport/hermes-acp-client';

const VIEW_TYPE_HERMES_MVP = 'hermes-obsidian-mvp';

interface HermesPluginSettings {
  hermesCommand: string;
}

const DEFAULT_SETTINGS: HermesPluginSettings = {
  hermesCommand: 'hermes',
};

class HermesMVPView extends ItemView {
  plugin: HermesObsidianMVPPlugin;
  messages: Array<{ role: 'user' | 'assistant'; text: string }> = [];

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
    this.plugin.client.onAssistantText = (text: string) => {
      const last = this.messages[this.messages.length - 1];
      if (!last || last.role !== 'assistant') {
        this.messages.push({ role: 'assistant', text });
      } else {
        last.text += text;
      }
      this.render();
    };

    this.render();
  }

  render() {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();

    const wrap = root.createDiv({ cls: 'hermes-mvp-wrap' });
    const list = wrap.createDiv({ cls: 'hermes-mvp-messages' });

    for (const msg of this.messages) {
      const row = list.createDiv({ cls: `hermes-mvp-msg hermes-mvp-${msg.role}` });
      row.createEl('strong', { text: msg.role === 'user' ? 'You' : 'Hermes' });
      row.createDiv({ text: msg.text });
    }

    const form = wrap.createDiv({ cls: 'hermes-mvp-form' });
    const input = form.createEl('textarea', {
      attr: { rows: '4', placeholder: 'Ask Hermes...' },
    });
    const button = form.createEl('button', { text: 'Send' });

    button.addEventListener('click', async () => {
      const text = input.value.trim();
      if (!text) return;

      input.value = '';
      this.messages.push({ role: 'user', text });
      this.messages.push({ role: 'assistant', text: '' });
      this.render();

      await this.plugin.client.sendPrompt(text, this.plugin.app.vault.adapter.basePath);
    });
  }
}

export default class HermesObsidianMVPPlugin extends Plugin {
  settings!: HermesPluginSettings;
  client!: HermesACPClient;

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.client = new HermesACPClient(this.settings.hermesCommand);

    this.registerView(VIEW_TYPE_HERMES_MVP, leaf => new HermesMVPView(leaf, this));

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

  async activateView() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_HERMES_MVP)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE_HERMES_MVP, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
  }
}

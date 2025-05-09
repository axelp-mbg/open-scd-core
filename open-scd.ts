import { css, html, LitElement, nothing, TemplateResult } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { html as staticHtml, unsafeStatic } from 'lit/static-html.js';

import { configureLocalization, localized, msg, str } from '@lit/localize';

import '@material/mwc-button';
import '@material/mwc-dialog';
import '@material/mwc-drawer';
import '@material/mwc-icon';
import '@material/mwc-icon-button';
import '@material/mwc-list';
import '@material/mwc-tab-bar';
import '@material/mwc-top-app-bar-fixed';
import type { ActionDetail } from '@material/mwc-list';
import type { Dialog } from '@material/mwc-dialog';
import type { Drawer } from '@material/mwc-drawer';

import './components/code-wizard.js';
import './components/oscd-card.js';
import {
  convertEdit,
  EditV2,
  handleEdit,
  isComplex,
  isInsert,
  isRemove,
  isSetAttributes,
} from '@openenergytools/xml-lib';
import type { CodeWizard } from './components/code-wizard.js';

import { allLocales, sourceLocale, targetLocales } from './locales.js';

import { cyrb64, EditEvent, OpenEvent } from './foundation.js';

import {
  CloseWizardEvent,
  CreateWizardEvent,
  EditWizardEvent,
  WizardRequest,
} from './foundation/wizard-event.js';
import { EditEventV2 } from './foundation/edit-event-v2.js';

import { ConfigurePluginEvent, Plugin } from './foundation/plugin-event.js';

export type LogEntry = { undo: EditV2; redo: EditV2; title?: string };

export type PluginSet = { menu: Plugin[]; editor: Plugin[] };

const pluginTags = new Map<string, string>();

/** @returns a valid customElement tagName containing the URI hash. */
function pluginTag(uri: string): string {
  if (!pluginTags.has(uri)) pluginTags.set(uri, `oscd-p${cyrb64(uri)}`);
  return pluginTags.get(uri)!;
}

type Control = {
  icon: string;
  getName: () => string;
  isDisabled: () => boolean;
  action?: () => unknown;
};

type RenderedPlugin = Control & { tagName: string };

type LocaleTag = typeof allLocales[number];

const { getLocale, setLocale } = configureLocalization({
  sourceLocale,
  targetLocales,
  loadLocale: locale =>
    import(new URL(`./locales/${locale}.js`, import.meta.url).href),
});

function describe({ undo, redo, title }: LogEntry) {
  if (title) return title;

  let result = msg('Something unexpected happened!');
  if (isComplex(redo)) result = msg(str`≥ ${redo.length} nodes changed`);
  if (isInsert(redo))
    if (isInsert(undo))
      result = msg(str`${redo.node.nodeName} moved to ${redo.parent.nodeName}`);
    else
      result = msg(
        str`${redo.node.nodeName} inserted into ${redo.parent.nodeName}`
      );
  if (isRemove(redo)) result = msg(str`${redo.node.nodeName} removed`);
  if (isSetAttributes(redo)) result = msg(str`${redo.element.tagName} updated`);
  return result;
}

function renderActionItem(
  control: Control,
  slot = 'actionItems'
): TemplateResult {
  return html`<mwc-icon-button
    slot="${slot}"
    icon="${control.icon}"
    label="${control.getName()}"
    ?disabled=${control.isDisabled()}
    @click=${control.action}
  ></mwc-icon-button>`;
}

function renderMenuItem(control: Control): TemplateResult {
  return html`
    <mwc-list-item graphic="icon" .disabled=${control.isDisabled()}
      ><mwc-icon slot="graphic">${control.icon}</mwc-icon>
      <span>${control.getName()}</span>
    </mwc-list-item>
  `;
}

@customElement('open-scd')
@localized()
export class OpenSCD extends LitElement {
  @state()
  /** The `XMLDocument` currently being edited */
  get doc(): XMLDocument {
    return this.docs[this.docName];
  }

  @state()
  history: LogEntry[] = [];

  @state()
  docVersion = 0;

  @state()
  editCount: number = 0;

  @state()
  get last(): number {
    return this.editCount - 1;
  }

  @state()
  get canUndo(): boolean {
    return this.last >= 0;
  }

  @state()
  get canRedo(): boolean {
    return this.editCount < this.history.length;
  }

  /** The set of `XMLDocument`s currently loaded */
  @state()
  docs: Record<string, XMLDocument> = {};

  /** The name of the [[`doc`]] currently being edited */
  @property({ type: String, reflect: true }) docName = '';

  #loadedPlugins = new Map<string, Plugin>();

  @state()
  get loadedPlugins(): Map<string, Plugin> {
    return this.#loadedPlugins;
  }

  #plugins: PluginSet = { menu: [], editor: [] };

  @property({ type: Object })
  get plugins(): PluginSet {
    return this.#plugins;
  }

  set plugins(plugins: Partial<PluginSet>) {
    Object.values(plugins).forEach(kind =>
      kind.forEach(plugin => this.loadPlugin(plugin))
    );

    this.#plugins = { menu: [], editor: [], ...plugins };
    this.requestUpdate();
  }

  loadPlugin(plugin: Plugin): void {
    const tagName = pluginTag(plugin.src);
    if (this.loadedPlugins.has(tagName)) return;
    this.#loadedPlugins.set(tagName, plugin);
    if (customElements.get(tagName)) return;
    const url = new URL(plugin.src, window.location.href).toString();
    import(url).then(mod => customElements.define(tagName, mod.default));
  }

  unloadPlugin(name: string, kind: 'menu' | 'editor'): void {
    const plugin = this.#plugins[kind].find(plug => plug.name === name);
    if (!plugin) return;

    const index = this.#plugins[kind].indexOf(plugin);
    this.#plugins[kind].splice(index, 1);
    const tagName = pluginTag(plugin.src);
    this.loadedPlugins.delete(tagName);
  }

  private onConfigurePlugin(evt: ConfigurePluginEvent): void {
    const { name, kind, config } = evt.detail;

    if (config === null) this.unloadPlugin(name, kind);
    else {
      this.loadPlugin(config);
      this.#plugins[kind].push(config);
    }
  }

  handleOpenDoc({ detail: { docName, doc } }: OpenEvent) {
    this.docName = docName;
    this.docs[this.docName] = doc;
  }

  updateVersion(): void {
    this.docVersion += 1;
  }

  handleEditEvent(event: EditEvent) {
    const edit = event.detail;
    const editV2 = convertEdit(edit);

    this.history.splice(this.editCount);
    this.history.push({ undo: handleEdit(editV2), redo: editV2 });

    this.editCount += 1;
    this.updateVersion();
  }

  squashUndo(undoEdits: EditV2): EditV2 {
    const lastHistory = this.history[this.history.length - 1];
    if (!lastHistory) return undoEdits;

    const lastUndo = lastHistory.undo;
    if (lastUndo instanceof Array && undoEdits instanceof Array)
      return [...undoEdits, ...lastUndo];

    if (lastUndo instanceof Array && !(undoEdits instanceof Array))
      return [undoEdits, ...lastUndo];

    if (!(lastUndo instanceof Array) && undoEdits instanceof Array)
      return [...undoEdits, lastUndo];

    return [undoEdits, lastUndo];
  }

  squashRedo(edits: EditV2): EditV2 {
    const lastHistory = this.history[this.history.length - 1];
    if (!lastHistory) return edits;

    const lastRedo = lastHistory.redo;
    if (lastRedo instanceof Array && edits instanceof Array)
      return [...lastRedo, ...edits];

    if (lastRedo instanceof Array && !(edits instanceof Array))
      return [...lastRedo, edits];

    if (!(lastRedo instanceof Array) && edits instanceof Array)
      return [lastRedo, ...edits];

    return [lastRedo, edits];
  }

  handleEditEventV2(event: EditEventV2) {
    const { edit, title } = event.detail;
    const squash = !!event.detail.squash;

    this.history.splice(this.editCount); // cut history at editCount

    const undo = squash ? this.squashUndo(handleEdit(edit)) : handleEdit(edit);
    const redo = squash ? this.squashRedo(edit) : edit;

    const logTitle = title || this.history[this.history.length - 1]?.title;

    if (squash) this.history.pop(); // combine with last edit in history

    this.history.push({ undo, redo, title: logTitle });
    this.editCount = this.history.length;
    this.updateVersion();
  }

  /** Undo the last `n` [[Edit]]s committed */
  undo(n = 1) {
    if (!this.canUndo || n < 1) return;
    handleEdit(this.history[this.last!].undo);
    this.editCount -= 1;
    this.updateVersion();
    if (n > 1) this.undo(n - 1);
  }

  /** Redo the last `n` [[Edit]]s that have been undone */
  redo(n = 1) {
    if (!this.canRedo || n < 1) return;
    handleEdit(this.history[this.editCount].redo);
    this.editCount += 1;
    this.updateVersion();
    if (n > 1) this.redo(n - 1);
  }

  @query('#log')
  logUI!: Dialog;

  @query('#menu')
  menuUI!: Drawer;

  @property({ type: String, reflect: true })
  get locale() {
    return getLocale() as LocaleTag;
  }

  set locale(tag: LocaleTag) {
    try {
      setLocale(tag);
    } catch {
      // don't change locale if tag is invalid
    }
  }

  @state()
  private editorIndex = 0;

  @state()
  get editor() {
    const enabledEditors = this.editors?.filter(
      enabledEditor => !enabledEditor.isDisabled()
    );
    if (enabledEditors.length === 0) return '';
    return enabledEditors[this.editorIndex]?.tagName ?? '';
  }

  private controls: Record<
    'undo' | 'redo' | 'log' | 'menu',
    Required<Control>
  > = {
    undo: {
      icon: 'undo',
      getName: () => msg('Undo'),
      action: () => this.undo(),
      isDisabled: () => !this.canUndo,
    },
    redo: {
      icon: 'redo',
      getName: () => msg('Redo'),
      action: () => this.redo(),
      isDisabled: () => !this.canRedo,
    },
    log: {
      icon: 'history',
      getName: () => msg('Editing history'),
      action: () => (this.logUI.open ? this.logUI.close() : this.logUI.show()),
      isDisabled: () => false,
    },
    menu: {
      icon: 'menu',
      getName: () => msg('Menu'),
      action: async () => {
        this.menuUI.open = !this.menuUI.open;
        await this.menuUI.updateComplete;
        if (this.menuUI.open) this.menuUI.querySelector('mwc-list')!.focus();
      },
      isDisabled: () => false,
    },
  };

  #actions = [this.controls.undo, this.controls.redo, this.controls.log];

  @state()
  get menu() {
    return (<Required<Control>[]>this.plugins.menu
      ?.map((plugin): RenderedPlugin | undefined =>
        plugin.active
          ? {
              icon: plugin.icon,
              getName: () =>
                plugin.translations?.[
                  this.locale as typeof targetLocales[number]
                ] || plugin.name,
              isDisabled: () => (plugin.requireDoc && !this.docName) ?? false,
              tagName: pluginTag(plugin.src),
              action: () =>
                this.shadowRoot!.querySelector<
                  HTMLElement & { run: () => Promise<void> }
                >(pluginTag(plugin.src))!.run?.(),
            }
          : undefined
      )
      .filter(p => p !== undefined)).concat(this.#actions);
  }

  @state()
  get editors() {
    return <RenderedPlugin[]>this.plugins.editor
      ?.map((plugin): RenderedPlugin | undefined =>
        plugin.active
          ? {
              icon: plugin.icon,
              getName: () =>
                plugin.translations?.[
                  this.locale as typeof targetLocales[number]
                ] || plugin.name,
              isDisabled: () => (plugin.requireDoc && !this.docName) ?? false,
              tagName: pluginTag(plugin.src),
            }
          : undefined
      )
      .filter(p => p !== undefined);
  }

  /** FIFO queue of [[`Wizard`]]s to display. */
  @state()
  workflow: WizardRequest[] = [];

  @query('.wizard.code') codeWizard?: CodeWizard;

  private closeWizard(we: CloseWizardEvent): void {
    const wizard = we.detail;

    this.workflow.splice(this.workflow.indexOf(wizard), 1);
    this.requestUpdate();
  }

  private onWizard(we: EditWizardEvent | CreateWizardEvent) {
    const wizard = we.detail;

    if (wizard.subWizard) this.workflow.unshift(wizard);
    else this.workflow.push(wizard);

    this.requestUpdate();
  }

  private hotkeys: Partial<Record<string, () => void>> = {
    m: this.controls.menu.action,
    z: this.controls.undo.action,
    y: this.controls.redo.action,
    Z: this.controls.redo.action,
    l: this.controls.log.action,
  };

  private handleKeyPress(e: KeyboardEvent): void {
    if (!e.ctrlKey) return;
    if (!Object.prototype.hasOwnProperty.call(this.hotkeys, e.key)) return;
    this.hotkeys[e.key]!();
    e.preventDefault();
  }

  firstUpdated() {
    const background = getComputedStyle(this.menuUI).getPropertyValue(
      '--oscd-base2'
    );
    document.body.style.background = background;
  }

  constructor() {
    super();

    document.addEventListener('keydown', event => this.handleKeyPress(event));

    this.addEventListener('oscd-open', event => this.handleOpenDoc(event));
    this.addEventListener('oscd-edit', event => this.handleEditEvent(event));
    this.addEventListener('oscd-edit-v2', event =>
      this.handleEditEventV2(event)
    );

    this.addEventListener('oscd-edit-wizard-request', event =>
      this.onWizard(event as EditWizardEvent)
    );
    this.addEventListener('oscd-create-wizard-request', event =>
      this.onWizard(event as CreateWizardEvent)
    );
    this.addEventListener('oscd-close-wizard', event =>
      this.closeWizard(event as CloseWizardEvent)
    );

    this.addEventListener('oscd-configure-plugin', event =>
      this.onConfigurePlugin(event as ConfigurePluginEvent)
    );
  }

  private renderWizard(): TemplateResult {
    if (!this.workflow.length) return html``;

    return html`${this.workflow.map(
      (wizard, i, arr) =>
        html`<oscd-card .stackLevel="${arr.length - i - 1}"
          ><code-wizard class="wizard code" .wizard=${wizard}></code-wizard
        ></oscd-card>`
    )}`;
  }

  private renderLogEntry(entry: LogEntry) {
    return html` <abbr title="${describe(entry)}">
      <mwc-list-item
        graphic="icon"
        ?activated=${this.history[this.last] === entry}
      >
        <span>${describe(entry)}</span>
        <mwc-icon slot="graphic">history</mwc-icon>
      </mwc-list-item></abbr
    >`;
  }

  private renderHistory(): TemplateResult[] | TemplateResult {
    if (this.history.length > 0)
      return this.history.slice().reverse().map(this.renderLogEntry, this);
    return html`<mwc-list-item disabled graphic="icon">
      <span>${msg('Your editing history will be displayed here.')}</span>
      <mwc-icon slot="graphic">info</mwc-icon>
    </mwc-list-item>`;
  }

  render() {
    return html`<mwc-drawer
        class="mdc-theme--surface"
        hasheader
        type="modal"
        id="menu"
      >
        <span slot="title">${msg('Menu')}</span>
        ${this.docName
          ? html`<span slot="subtitle">${this.docName}</span>`
          : ''}
        <mwc-list
          wrapFocus
          @action=${(e: CustomEvent<ActionDetail>) =>
            this.menu[e.detail.index]!.action()}
        >
          <li divider padded role="separator"></li>
          ${this.menu.map(renderMenuItem)}
        </mwc-list>
        <mwc-top-app-bar-fixed slot="appContent">
          ${renderActionItem(this.controls.menu, 'navigationIcon')}
          <div slot="title" id="title">${this.docName}</div>
          ${this.#actions.map(op => renderActionItem(op))}
          <mwc-tab-bar
            activeIndex=${this.editors.filter(p => !p.isDisabled()).length
              ? 0
              : -1}
            @MDCTabBar:activated=${({
              detail: { index },
            }: {
              detail: { index: number };
            }) => {
              this.editorIndex = index;
            }}
          >
            ${this.editors.map(editor =>
              editor.isDisabled()
                ? nothing
                : html`<mwc-tab
                    label="${editor.getName()}"
                    icon="${editor.icon}"
                  ></mwc-tab>`
            )}
          </mwc-tab-bar>
          ${this.editor
            ? staticHtml`<${unsafeStatic(this.editor)} docName="${
                this.docName
              }" .doc=${this.doc} locale="${this.locale}" .docs=${
                this.docs
              } .editCount=${this.editCount} .docVersion=${
                this.docVersion
              } .history=${this.history} .plugins=${
                this.plugins
              }></${unsafeStatic(this.editor)}>`
            : nothing}
        </mwc-top-app-bar-fixed>
      </mwc-drawer>
      <mwc-dialog id="log" heading="${this.controls.log.getName()}">
        <mwc-list wrapFocus>${this.renderHistory()}</mwc-list>
        <mwc-button
          icon="undo"
          label="${msg('Undo')}"
          ?disabled=${!this.canUndo}
          @click=${this.undo}
          slot="secondaryAction"
        ></mwc-button>
        <mwc-button
          icon="redo"
          label="${msg('Redo')}"
          ?disabled=${!this.canRedo}
          @click=${this.redo}
          slot="secondaryAction"
        ></mwc-button>
        <mwc-button slot="primaryAction" dialogaction="close"
          >${msg('Close')}</mwc-button
        >
      </mwc-dialog>
      ${this.renderWizard()}
      <aside>
        ${this.plugins.menu.map(
          plugin =>
            staticHtml`<${unsafeStatic(pluginTag(plugin.src))} docName="${
              this.docName
            }" .doc=${this.doc} locale="${this.locale}" .docs=${
              this.docs
            } .editCount=${this.editCount} .docVersion=${
              this.docVersion
            } .history=${this.history} .plugins=${
              this.plugins
            } ></${unsafeStatic(pluginTag(plugin.src))}>`
        )}
      </aside>`;
  }

  static styles = css`
    aside {
      position: absolute;
      top: 0;
      left: 0;
      width: 0;
      height: 0;
      overflow: hidden;
      margin: 0;
      padding: 0;
    }

    abbr {
      text-decoration: none;
    }

    mwc-top-app-bar-fixed {
      --mdc-theme-text-disabled-on-light: rgba(255, 255, 255, 0.38);
    } /* hack to fix disabled icon buttons rendering black */

    mwc-dialog {
      display: flex;
      flex-direction: column;
    }

    mwc-tab {
      background-color: var(--oscd-primary);
      --mdc-theme-primary: var(--mdc-theme-on-primary);
    }

    * {
      --oscd-accent-yellow: var(--oscd-theme-accent-yellow, #b58900);
      --oscd-accent-orange: var(--oscd-theme-accent-orange, #cb4b16);
      --oscd-accent-red: var(--oscd-theme-accent-red, #dc322f);
      --oscd-accent-magenta: var(--oscd-theme-accent-magenta, #d33682);
      --oscd-accent-violet: var(--oscd-theme-accent-violet, #6c71c4);
      --oscd-accent-blue: var(--oscd-theme-accent-blue, #268bd2);
      --oscd-accent-cyan: var(--oscd-theme-accent-cyan, #2aa198);
      --oscd-accent-green: var(--oscd-theme-accent-green, #859900);

      --oscd-base03: var(--oscd-theme-base03, #002b36);
      --oscd-base02: var(--oscd-theme-base02, #073642);
      --oscd-base01: var(--oscd-theme-base01, #586e75);
      --oscd-base00: var(--oscd-theme-base00, #657b83);
      --oscd-base0: var(--oscd-theme-base0, #839496);
      --oscd-base1: var(--oscd-theme-base1, #93a1a1);
      --oscd-base2: var(--oscd-theme-base2, #eee8d5);
      --oscd-base3: var(--oscd-theme-base3, #fdf6e3);
    }

    * {
      --oscd-primary: var(--oscd-theme-primary, var(--oscd-accent-cyan));
      --oscd-secondary: var(--oscd-theme-secondary, var(--oscd-accent-violet));
      --oscd-error: var(--oscd-theme-error, var(--oscd-accent-red));

      --oscd-text-font: var(--oscd-theme-text-font, 'Roboto');
      --oscd-icon-font: var(--oscd-theme-icon-font, 'Material Icons');

      --mdc-theme-primary: var(--oscd-primary);
      --mdc-theme-secondary: var(--oscd-secondary);
      --mdc-theme-background: var(--oscd-base3);
      --mdc-theme-surface: var(--oscd-base3);
      --mdc-theme-on-primary: var(--oscd-base2);
      --mdc-theme-on-secondary: var(--oscd-base2);
      --mdc-theme-on-background: var(--oscd-base00);
      --mdc-theme-on-surface: var(--oscd-base00);
      --mdc-theme-text-primary-on-background: var(--oscd-base01);
      --mdc-theme-text-secondary-on-background: var(--oscd-base00);
      --mdc-theme-text-icon-on-background: var(--oscd-base00);
      --mdc-theme-error: var(--oscd-error);
      --mdc-button-disabled-ink-color: var(--oscd-base1);
      --mdc-drawer-heading-ink-color: var(--oscd-base00);
      --mdc-dialog-heading-ink-color: var(--oscd-base00);
      --mdc-typography-font-family: var(--oscd-text-font);
      --mdc-icon-font: var(--oscd-icon-font);
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    'open-scd': OpenSCD;
  }
}

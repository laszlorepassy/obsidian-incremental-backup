'use strict';

class Plugin {
  addRibbonIcon() {}
  addCommand() {}
  addSettingTab() {}
  registerInterval() {}
  register() {}
}
class PluginSettingTab {
  constructor(app, plugin) { this.app = app; this.plugin = plugin; }
}
class Modal {
  constructor(app) { this.app = app; this.contentEl = {}; }
  open() {}
  close() {}
}
class Setting {
  constructor() { return this; }
  setName() { return this; }
  setDesc() { return this; }
  addText() { return this; }
  addToggle() { return this; }
  addButton() { return this; }
  addTextArea() { return this; }
}
class Notice {
  constructor() {}
  setMessage() {}
  hide() {}
}

module.exports = { Plugin, PluginSettingTab, Setting, Notice, Modal };

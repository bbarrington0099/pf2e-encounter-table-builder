class PF2eEncounterTableBuilder extends FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "pf2e-encounter-table-builder",
      title: "PF2e Encounter Table Builder",
      template: "modules/pf2e-encounter-table-builder/templates/builder.html",
      classes: ["pf2e-encounter-table-builder"],
      width: 1260,
      height: 900,
      resizable: true,
      popOut: true,
      closeOnSubmit: false,
      submitOnClose: false
    });
  }

  constructor(options = {}) {
    super(options);

    this.sessionTimestamp = this._formatTimestamp(new Date());

    const cachedPartyCount = game.settings.get("pf2e-encounter-table-builder", "cachedPartyCount");
    const cachedPartyLevel = game.settings.get("pf2e-encounter-table-builder", "cachedPartyLevel");


    this.state = {
      partyCount: cachedPartyCount ?? 4,
      partyLevel: cachedPartyLevel ?? 1,

      tableNameTouched: false,
      tableName: "",
      rows: [this._newRow()]
    };
    this.state.tableName = this._defaultTableName();
  }

  static BASE_BUDGETS = {
    trivial: 40,
    low: 60,
    moderate: 80,
    severe: 120,
    extreme: 160
  };

  static PARTY_SIZE_ADJUSTMENTS = {
    trivial: 10,
    low: 15,
    moderate: 20,
    severe: 30,
    extreme: 40
  };

  getData() {
    const partyCount = Math.max(1, Number(this.state.partyCount) || 4);
    const partyLevel = Math.max(1, Number(this.state.partyLevel) || 1);
    const budgets = this._partyBudgets(partyCount);
    const budgetMap = Object.fromEntries(budgets.map((b) => [b.key, b.xp]));

    return {
      partyCount,
      partyLevel,
      tableName: this.state.tableName,
      budgets,
      hasRows: this.state.rows.length > 0,
      rows: this.state.rows.map((row, index) => this._viewRow(row, index + 1, partyLevel, budgetMap))
    };
  }

  activateListeners(html) {
    super.activateListeners(html);

    html.find('[name="partyCount"]').on("change", async (event) => {
      this.state.partyCount = Math.max(1, Number(event.currentTarget.value) || 4);
      
      await game.settings.set(
        "pf2e-encounter-table-builder",
        "cachedPartyCount",
        this.state.partyCount
      );
      
      this._syncDefaultTableName();
      this.render(false);
    });

    html.find('[name="partyLevel"]').on("change", async (event) => {
      this.state.partyLevel = Math.max(1, Number(event.currentTarget.value) || 1);
      
      await game.settings.set(
        "pf2e-encounter-table-builder",
        "cachedPartyLevel",
        this.state.partyLevel
      );
      
      this._syncDefaultTableName();
      this.render(false);
    });

    html.find('[name="tableName"]').on("input", (event) => {
      this.state.tableNameTouched = true;
      this.state.tableName = String(event.currentTarget.value ?? "");
    });

    html.find("[data-action='add-row']").on("click", () => {
      this.state.rows.push(this._newRow());
      this.render(false);
    });

    html.find("[data-action='create-table']").on("click", async () => {
      await this._createRollTable();
    });

    html.find("[data-action='toggle-row']").on("click", (event) => {
      const row = this._getRow(event.currentTarget.dataset.rowId);
      if (!row) return;
      row.expanded = !row.expanded;
      this.render(false);
    });

    html.find("[data-action='remove-row']").on("click", (event) => {
      const rowId = event.currentTarget.dataset.rowId;
      this.state.rows = this.state.rows.filter((r) => r.id !== rowId);
      this.render(false);
    });

    html.find("input[data-action='row-weight']").on("change", (event) => {
      const row = this._getRow(event.currentTarget.dataset.rowId);
      if (!row) return;
      row.weight = Math.max(1, Number(event.currentTarget.value) || 1);
      this.render(false);
    });

    html.find(".encounter-dropzone").on("dragover", (event) => event.preventDefault());
    html.find(".encounter-dropzone").on("drop", async (event) => {
      event.preventDefault();

      const row = this._getRow(event.currentTarget.dataset.rowId);
      if (!row) return;

      const original = event.originalEvent ?? event;
      const dataTransfer = original.dataTransfer;
      if (!dataTransfer) return;

      let payload = null;
      for (const type of ["text/plain", "application/json"]) {
        const raw = dataTransfer.getData(type);
        if (!raw) continue;
        try {
          payload = JSON.parse(raw);
          break;
        } catch {
          // ignore
        }
      }

      const actor = await this._resolveActorFromDrop(payload);
      if (!actor) return ui.notifications.warn("Drop an Actor here.");

      const existing = row.members.find((m) => m.uuid === actor.uuid);
      if (existing) {
        existing.qty += 1;
      } else {
        row.members.push({
          uuid: actor.uuid,
          name: actor.name,
          level: this._getActorLevel(actor),
          qty: 1,
          img: actor.img || "icons/svg/mystery-man.svg"
        });
      }

      this.render(false);
    });

    html.find("[data-action='member-plus']").on("click", (event) => {
      const row = this._getRow(event.currentTarget.dataset.rowId);
      if (!row) return;
      const member = row.members.find((m) => m.uuid === event.currentTarget.dataset.memberUuid);
      if (!member) return;
      member.qty += 1;
      this.render(false);
    });

    html.find("[data-action='member-minus']").on("click", (event) => {
      const row = this._getRow(event.currentTarget.dataset.rowId);
      if (!row) return;
      const member = row.members.find((m) => m.uuid === event.currentTarget.dataset.memberUuid);
      if (!member) return;
      member.qty -= 1;
      if (member.qty <= 0) row.members = row.members.filter((m) => m.uuid !== member.uuid);
      this.render(false);
    });

    html.find("[data-action='member-remove']").on("click", (event) => {
      const row = this._getRow(event.currentTarget.dataset.rowId);
      if (!row) return;
      row.members = row.members.filter((m) => m.uuid !== event.currentTarget.dataset.memberUuid);
      this.render(false);
    });

    html.find("[data-action='clear-table']").on("click", () => {
      this._clearTable();
    });
  }

  _newRow() {
    return {
      id: foundry.utils.randomID(),
      weight: 1,
      expanded: true,
      members: []
    };
  }

  _formatTimestamp(date = new Date()) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  _defaultTableName() {
    const base = `${this.state.partyCount} Adventurers of Level ${this.state.partyLevel}`;
    return `${base} (${this.sessionTimestamp})`;
  }

  _syncDefaultTableName() {
    if (!this.state.tableNameTouched) this.state.tableName = this._defaultTableName();
  }

  _resetSessionTimestampAndTableName() {
    this.sessionTimestamp = this._formatTimestamp(new Date());

    this.state.tableNameTouched = false;

    this.state.tableName = this._defaultTableName();
  }

  _getRow(rowId) {
    return this.state.rows.find((r) => r.id === rowId);
  }

  _partyBudgets(partyCount) {
    const count = Math.max(1, Number(partyCount) || 4);
    const delta = count - 4;
    return Object.entries(PF2eEncounterTableBuilder.BASE_BUDGETS).map(([key, base]) => ({
      key,
      label: key.charAt(0).toUpperCase() + key.slice(1),
      cssLabel: key.toLowerCase(),
      xp: Math.max(0, base + delta * PF2eEncounterTableBuilder.PARTY_SIZE_ADJUSTMENTS[key])
    }));
  }

  _viewRow(row, index, partyLevel, budgets) {
    const baseMembers = row.members.map((m) => {
      const xp = this._creatureXpForLevelDelta(Number(m.level) - partyLevel);
      const totalXp = xp * m.qty;
      return {
        ...m,
        displayName: pluralize(m.name, m.qty),
        xp,
        totalXp,
        singleDifficulty: this._getDifficultyClass(this._difficultyLabel(xp, budgets)),
        totalDifficulty: this._getDifficultyClass(this._difficultyLabel(totalXp, budgets))
      };
    });

    const totalXp = baseMembers.reduce((sum, m) => sum + m.totalXp, 0);
    const difficultyLabel = baseMembers.length ? this._difficultyLabel(totalXp, budgets) : "Empty";

    const members = baseMembers.map((m) => ({
      ...m,
      label: `${m.qty} @UUID[${m.uuid}]{${m.displayName}}`
    }));
    
    const summaryText = members.length ? members.map((m) => m.label).join(" & ") : "Empty";
    
    return {
      id: row.id,
      index,
      weight: Number(row.weight) || 1,
      expanded: !!row.expanded,
      members,
      hasMembers: members.length > 0,
      totalXp,
      difficultyLabel,
      difficultyClass: this._getDifficultyClass(difficultyLabel),
      summaryText,
      displaySummary: members.length
        ? `${summaryText} - ${difficultyLabel} ${totalXp}xp`
        : "Empty"
    };
  }

  _clearTable() {
    if (!this.state.rows.length) return;

    this.state.rows = [
      {
        id: this.state.rows[0].id,
        weight: 1,
        expanded: true,
        members: []
      }
    ];

    this._resetSessionTimestampAndTableName();
    this.render(false);
  }

  _difficultyLabel(totalXp, budgets) {
    const { trivial, low, moderate, severe, extreme } = budgets;

    const overBudget = (total, threshold) => {
      if (total > threshold) return "+";
      if (total < threshold) return "-";
      return "";
    };

    if (totalXp >= extreme) {
      return `Extreme${overBudget(totalXp, extreme)}`;
    }

    if (totalXp >= severe) {
      return `Severe${overBudget(totalXp, severe)}`;
    }

    if (totalXp >= moderate) {
      return `Moderate${overBudget(totalXp, moderate)}`;
    }

    if (totalXp >= low) {
      return `Low${overBudget(totalXp, low)}`;
    }

    return `Trivial${overBudget(totalXp, trivial)}`;
  }

  _getDifficultyClass(label) {
    return label.toLowerCase().replace("-", "-minus").replace("+", "-plus");
  }

  _creatureXpForLevelDelta(delta) {
    if (delta <= -4) return 10;
    if (delta === -3) return 15;
    if (delta === -2) return 20;
    if (delta === -1) return 30;
    if (delta === 0) return 40;
    if (delta === 1) return 60;
    if (delta === 2) return 80;
    if (delta === 3) return 120;
    return 160;
  }

  _getActorLevel(actor) {
    const fromSystemDetails = foundry.utils.getProperty(actor, "system.details.level.value");
    const fromSystemLevel = foundry.utils.getProperty(actor, "system.level.value");
    const fromDirect = actor.level;
    const raw = fromSystemDetails ?? fromSystemLevel ?? fromDirect ?? 0;
    return Number.isFinite(Number(raw)) ? Number(raw) : 0;
  }

  async _resolveActorFromDrop(data) {
    if (!data) return null;

    if (data.uuid) {
      try {
        const doc = await fromUuid(data.uuid);
        if (doc?.documentName === "Actor") return doc;
      } catch (err) {
        console.warn("PF2e Encounter Table Builder | Failed to resolve UUID drop", err);
      }
    }

    if (data.pack && data.id) {
      const pack = game.packs.get(data.pack);
      if (!pack) return null;
      try {
        const doc = await pack.getDocument(data.id);
        if (doc?.documentName === "Actor") return doc;
      } catch (err) {
        console.warn("PF2e Encounter Table Builder | Failed to resolve pack drop", err);
      }
    }

    return null;
  }

  async _createRollTable() {
    const tableName = this.state.tableNameTouched && this.state.tableName?.trim()
      ? this.state.tableName.trim()
      : this._defaultTableName();
    const partyLevel = Math.max(1, Number(this.state.partyLevel) || 1);
    const partyCount = Math.max(1, Number(this.state.partyCount) || 4);
    const budgets = Object.fromEntries(this._partyBudgets(partyCount).map((b) => [b.key, b.xp]));

    const rows = this.state.rows
      .map((row) => this._viewRow(row, 0, partyLevel, budgets))
      .filter((row) => row.hasMembers);

    if (!rows.length) {
      ui.notifications.warn("Add at least one encounter row with actors before creating a roll table.");
      return;
    }

    const totalWeight = rows.reduce((sum, row) => sum + Math.max(1, Number(row.weight) || 1), 0);
    const tableResults = [];
    let cursor = 1;

    for (const row of rows) {
      const weight = Math.max(1, Number(row.weight) || 1);
      const end = cursor + weight - 1;
      tableResults.push({
        text: row.displaySummary,
        weight,
        range: [cursor, end],
        drawn: false
      });
      cursor = end + 1;
    }

    try {
      const table = await RollTable.create({
        name: tableName,
        formula: `1d${Math.max(1, totalWeight)}`,
        replacement: true,
        displayRoll: true
      });

      await table.createEmbeddedDocuments("TableResult", tableResults);
      await table.sheet.render(true);
      ui.notifications.info(`Created roll table: ${tableName}`);
      this._resetSessionTimestampAndTableName();
      this.render(false);
    } catch (err) {
      console.error("PF2e Encounter Table Builder | Failed to create roll table", err);
      ui.notifications.error("Could not create the roll table. Check the console for details.");
    }
  }
}

function pluralize(name, qty) {
  if (qty === 1) return name;

  if (name.endsWith("y") && !/[aeiou]y$/i.test(name)) {
    return name.slice(0, -1) + "ies";
  }

  return name + "s";
}

Hooks.once("init", () => {
  game.settings.register("pf2e-encounter-table-builder", "chatCommandHint", {
    name: "PF2e Encounter Table Builder",
    hint: "This module exposes a global opener function and a settings launcher.",
    scope: "world",
    config: false,
    type: Boolean,
    default: true
  });

  game.settings.register("pf2e-encounter-table-builder", "cachedPartyCount", {
    name: "Cached Party Count",
    scope: "world",
    config: false,
    type: Number,
    default: 4
  });

  game.settings.register("pf2e-encounter-table-builder", "cachedPartyLevel", {
    name: "Cached Party Level",
    scope: "world",
    config: false,
    type: Number,
    default: 1
  });

  game.pf2eEncounterTableBuilder = {
    open: () => new PF2eEncounterTableBuilder().render(true),
    Builder: PF2eEncounterTableBuilder
  };
});

Hooks.once("ready", () => {
  console.log("PF2e Encounter Table Builder loaded. Use game.pf2eEncounterTableBuilder.open() to launch.");

  const macroName = "Build Encounter Table";
  const existingMacro = game.macros.getName(macroName);
  if (!existingMacro) {
    Macro.create({
      name: macroName,
      type: "script",
      command: "game.pf2eEncounterTableBuilder.open();",
      img: "icons/svg/sword.svg",
      scope: "global"
    }).then(macro => {
      console.log(`PF2e Encounter Table Builder | Created macro "${macroName}"`);
    }).catch(err => {
      console.error("PF2e Encounter Table Builder | Failed to create macro", err);
    });
  }
});
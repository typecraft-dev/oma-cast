// The backend's method surface (SPEC §3.4), shared by every host: the
// Omarchy shell plugin (Backend.qml) and the macOS app (macos/). Pure logic:
// all I/O goes through `host`, and modules arrive in `deps`, because core
// files never import each other. [D, 2026-11-12]
//
// deps: { Rpc, Schema, Ranker, Frecency, RootSearch, Calculator, OmarchyMenu }
//
// host:
//   version, paths, startedAt
//   stores: { settings, frecency, calculator }, each { loaded, readOnly,
//     lastError, doc, update(mutator) }
//   calculatorData: { rates, zones, ratesFetchedAt, fetchRates() }
//   config()                 config.json with defaults
//   hour12()                 12-hour clock for calculator answers
//   ready()                  true once the stores have loaded
//   now()                    ms since the epoch (optional)
//   log(level, category, message, metadata)
//   notify(method, data)     every emitted notification, after subscribers
//   info()                   extra fields for system.info
//   copy(text), paste(text)  clipboard, never through argv
//   openUrl(url)
//   openApp(candidate)       focus an open window, else launch
//   launchApp(candidate)     always a new window
//   runSystem(name, candidate)       built-ins with run.system (macOS)
//   summonPlugin(id, payload)        built-ins with run.summon (Omarchy)
//   runShell(command)                Omarchy menu actions
//   menuTree()                       Omarchy menu tree, or null
//   adjustActions(candidate, list)   optional: platform labels
//   adjustAbout(candidate, rows)     optional
//   copyId(candidate)                optional: text for "copy-id"

function create(host, deps) {
  var Rpc = deps.Rpc, Schema = deps.Schema, Frecency = deps.Frecency
  var RootSearch = deps.RootSearch, Calculator = deps.Calculator, OmarchyMenu = deps.OmarchyMenu
  var stores = host.stores
  var searchDeps = { Ranker: deps.Ranker, Frecency: Frecency, OmarchyMenu: OmarchyMenu }

  var self = {
    registry: Rpc.createRegistry(),
    candidates: [],
    candidatesById: {}
  }

  function now() { return host.now ? host.now() : Date.now() }
  function log(level, category, message, metadata) { if (host.log) host.log(level, category, message, metadata) }

  self.call = function(method, data) { return Rpc.call(self.registry, method, data) }
  self.callSync = function(method, data) { return Rpc.callSync(self.registry, method, data) }
  self.subscribe = function(method, callback) { return Rpc.subscribe(self.registry, method, callback) }
  self.emit = function(method, data) {
    Rpc.emit(self.registry, method, data, function(m, error) { log("error", "rpc", "subscriber of " + m + " threw: " + error) })
    if (host.notify) host.notify(method, data)
  }

  self.setCandidates = function(list) {
    var byId = {}
    for (var i = 0; i < list.length; i++) byId[list[i].id] = list[i]
    self.candidates = list
    self.candidatesById = byId
  }

  function searchContext() {
    var settings = stores.settings, frecency = stores.frecency
    return {
      commands: settings.loaded ? settings.doc.commands : {},
      frecency: frecency.loaded ? frecency.doc.items : {},
      nowMs: now(),
      sensitivity: settings.loaded ? settings.doc.general.rootSearchSensitivity : "medium"
    }
  }
  self.searchContext = searchContext

  function decorated(id) {
    var c = self.candidatesById[id]
    return c ? RootSearch.decorate(c, searchContext(), searchDeps) : null
  }
  self.decorated = decorated

  // ------------------------------------------------------------ calculator

  function calculatorEnv() {
    var config = host.config()
    var data = host.calculatorData
    return {
      nowMs: now(),
      localOffset: -new Date(now()).getTimezoneOffset(),
      hour12: host.hour12(),
      rates: config.currencyRates ? data.rates : null,
      zones: data.zones,
      remToPxRate: config.remToPxRate,
      workHoursPerDay: config.workHoursPerDay
    }
  }

  function calculate(query) {
    try {
      return Calculator.evaluate(query, calculatorEnv())
    } catch (e) {
      log("error", "calculator", "evaluating failed: " + e, { query: query })
      return null
    }
  }
  self.calculate = calculate

  function saveCalculation(entry) {
    stores.calculator.update(function(doc) {
      doc.history = Calculator.pushHistory(doc.history, {
        id: String(now()), query: entry.query, result: entry.result, copy: entry.copy, kind: entry.kind
      }, now())
    })
    self.emit("calculator.historyStateChanged", null)
  }

  // An action on the inline Calculator row or a Calculator History entry.
  // entry: {query, result, copy, kind}; historyId: set when already saved.
  function calculatorAction(action, entry, historyId) {
    switch (action) {
      case "open":
      case "copy-answer":
        if (!historyId) saveCalculation(entry)
        host.copy(entry.copy)
        return { close: true, hud: "Copied to Clipboard" }
      case "paste-answer":
        if (!historyId) saveCalculation(entry)
        // The host copies, waits for the launcher to go, then pastes.
        host.paste(entry.copy)
        return { close: true }
      case "copy-question-answer":
        if (!historyId) saveCalculation(entry)
        host.copy(entry.query + " = " + entry.result)
        return { close: true, hud: "Copied to Clipboard" }
      case "open-history":
        return { push: { kind: "calculator-history", title: "Calculator History" } }
      case "delete-entry":
        stores.calculator.update(function(doc) { doc.history = doc.history.filter(function(h) { return h.id !== historyId }) })
        self.emit("calculator.historyStateChanged", null)
        return { toast: { style: "success", title: "Entry deleted" } }
      case "delete-all-entries":
        stores.calculator.update(function(doc) { doc.history = [] })
        self.emit("calculator.historyStateChanged", null)
        return { toast: { style: "success", title: "History cleared" } }
    }
    throw new Error("Unknown action " + action)
  }

  function historyEntry(id) {
    var key = String(id).slice("calculator-history:".length)
    var list = stores.calculator.loaded ? stores.calculator.doc.history : []
    for (var i = 0; i < list.length; i++) if (list[i].id === key) return list[i]
    return null
  }

  // ------------------------------------------------------------- execution

  function runShell(command) {
    var summon = OmarchyMenu.summonAction(command)
    if (summon) host.summonPlugin(summon.id, summon.payload)
    else host.runShell(command)
  }

  function recordVisit(id, query) {
    if (!stores.frecency.loaded) return
    stores.frecency.update(function(doc) {
      doc.items[id] = Frecency.recordVisit(doc.items[id] || null, now(), query || "")
      if (query) doc.searchHistory = Schema.pushSearchHistory(doc.searchHistory, query)
    })
  }

  function updateCommand(id, mutator) {
    stores.settings.update(function(doc) {
      var current = doc.commands[id] || {}
      var next = mutator(JSON.parse(JSON.stringify(current)))
      var empty = true
      for (var k in next) if (next[k] !== null && next[k] !== undefined && next[k] !== "") empty = false
      if (empty) delete doc.commands[id]
      else doc.commands[id] = next
    })
    self.emit("settings.commandSettingsChanged", { commandId: id })
  }

  function menuItems() {
    var tree = host.menuTree ? host.menuTree() : null
    return tree ? tree.items : {}
  }

  function omarchyRouteFor(candidate) {
    if (candidate.kind === "omarchy-action") {
      var item = menuItems()[candidate.menuId]
      return item && item.parent ? item.parent : "root"
    }
    return candidate.kind === "omarchy-link" ? candidate.target : candidate.menuId
  }

  function openMenu(item) {
    if (item.provider && !OmarchyMenu.PROVIDERS[item.provider]) {
      host.summonPlugin("omarchy.menu", JSON.stringify({ menu: item.id }))
      return { close: true }
    }
    return { push: { kind: "menu", menuId: item.id, title: item.label } }
  }

  function performAction(data) {
    var id = String(data && data.id || "")
    var action = String(data && data.action || "open")
    var query = String(data && data.query || "").trim()
    var candidate = decorated(id)
    if (!candidate) throw new Error("Unknown command " + id)

    if (action === "open") {
      switch (candidate.kind) {
        case "app":
          recordVisit(id, query)
          host.openApp(candidate)
          return { close: true }
        case "omarchy-action":
          if (candidate.disabled) return { toast: { style: "failure", title: candidate.title + " is already set up" } }
          recordVisit(id, query)
          runShell(candidate.action)
          return { close: true }
        case "omarchy-menu":
          recordVisit(id, query)
          return openMenu(menuItems()[candidate.menuId])
        case "omarchy-link":
          recordVisit(id, query)
          var target = menuItems()[candidate.target]
          if (!target) return { toast: { style: "failure", title: "Menu " + candidate.target + " not found" } }
          return openMenu(target)
        case "builtin":
          if (candidate.run.url) {
            var values = (data && data.arguments) || {}
            var missing = RootSearch.missingArgument(candidate.arguments, values)
            if (missing >= 0) throw new Error("Type a " + candidate.arguments[missing].placeholder.toLowerCase() + " first")
            recordVisit(id, query)
            host.openUrl(RootSearch.fillArguments(candidate.run.url, values))
            return { close: true }
          }
          recordVisit(id, query)
          if (candidate.run.push) return { push: candidate.run.push }
          if (candidate.run.system) {
            var outcome = host.runSystem(candidate.run.system, candidate)
            return outcome || { close: true }
          }
          if (candidate.run.summon) host.summonPlugin(candidate.run.summon, candidate.run.payload || "{}")
          return { close: true }
        case "fallback":
          host.openUrl(RootSearch.fallbackUrl(candidate, query))
          return { close: true }
      }
      throw new Error("Cannot open " + id)
    }

    switch (action) {
      case "open-new":
        recordVisit(id, query)
        host.launchApp(candidate)
        return { close: true }
      case "open-in-omarchy-menu":
        host.summonPlugin("omarchy.menu", JSON.stringify({ menu: omarchyRouteFor(candidate) }))
        return { close: true }
      case "copy-command":
      case "copy-id":
        host.copy(action === "copy-id" ? (host.copyId ? host.copyId(candidate) : candidate.appId + ".desktop") : candidate.action)
        return { close: true, hud: "Copied to Clipboard" }
      case "favorite-add":
      case "favorite-remove":
      case "favorite-up":
      case "favorite-down":
        var orders = RootSearch.reorderFavorites(stores.settings.doc.commands, id, action)
        stores.settings.update(function(doc) {
          for (var key in orders) {
            var entry = doc.commands[key] || {}
            if (orders[key] === null) delete entry.favoriteOrder
            else entry.favoriteOrder = orders[key]
            if (Object.keys(entry).length === 0) delete doc.commands[key]
            else doc.commands[key] = entry
          }
        })
        var titles = { "favorite-add": "Added to Favorites", "favorite-remove": "Removed from Favorites", "favorite-up": "Moved Up", "favorite-down": "Moved Down" }
        return { toast: { style: "success", title: titles[action] } }
      case "set-alias":
        return { push: { kind: "alias", commandId: id, title: "Alias for " + candidate.title, value: candidate.alias } }
      case "remove-alias":
        updateCommand(id, function(s) { delete s.alias; return s })
        return { toast: { style: "success", title: "Alias removed" } }
      case "reset-ranking":
        stores.frecency.update(function(doc) { delete doc.items[id] })
        return { toast: { style: "success", title: "Ranking reset" } }
      case "disable":
        updateCommand(id, function(s) { s.enabled = false; return s })
        return { toast: { style: "success", title: candidate.title + " disabled", actions: [
          { id: "undo", title: "Undo", done: candidate.title + " enabled",
            call: { method: "settings.updateCommandSettings", data: { commandId: id, enabled: true } } }
        ] } }
    }
    throw new Error("Unknown action " + action)
  }

  function findFallback(id) {
    return RootSearch.FALLBACKS.filter(function(f) { return f.id === id })[0] || null
  }

  function actionsFor(candidate) {
    var list = RootSearch.actionsFor(candidate)
    return host.adjustActions ? host.adjustActions(candidate, list) : list
  }

  function aboutFor(candidate, nowMs) {
    var rows = RootSearch.aboutFor(candidate, nowMs)
    return host.adjustAbout ? host.adjustAbout(candidate, rows) : rows
  }

  // ------------------------------------------------------------- services

  Rpc.register(self.registry, "system", {
    healthPing: function() { return null },
    healthDatabase: function() {
      var t0 = Date.now()
      JSON.stringify(stores.settings.doc)
      JSON.stringify(stores.frecency.doc)
      var s = stores.settings, f = stores.frecency
      return {
        workMs: Date.now() - t0,
        settings: { loaded: s.loaded, readOnly: s.readOnly, error: s.lastError },
        frecency: { loaded: f.loaded, readOnly: f.readOnly, error: f.lastError },
        loaded: s.loaded, readOnly: s.readOnly, error: s.lastError
      }
    },
    info: function() {
      var out = {
        version: host.version,
        ready: host.ready(),
        uptimeMs: Date.now() - host.startedAt,
        candidates: self.candidates.length,
        methods: Rpc.methods(self.registry)
      }
      var extra = host.info ? host.info() : {}
      for (var k in extra) out[k] = extra[k]
      return out
    },
    getPaths: function() { return host.paths }
  })

  Rpc.register(self.registry, "settings", {
    getGeneralSettings: function() {
      if (!stores.settings.loaded) throw new Error("settings not loaded")
      return stores.settings.doc.general
    },
    updateGeneralSettings: function(data) {
      var settings = stores.settings
      if (!settings.loaded) throw new Error("settings not loaded")
      if (settings.readOnly) throw new Error("settings are read-only: " + (settings.lastError || "written by a newer build"))
      var patch = data && typeof data === "object" ? data : {}
      var current = settings.doc.general
      for (var key in patch) {
        if (current[key] === undefined) throw new Error("Unknown general setting " + key)
        if (typeof patch[key] !== typeof current[key]) throw new Error("Setting " + key + " must be a " + typeof current[key])
        var choices = Schema.generalChoices[key]
        if (choices && choices.indexOf(patch[key]) < 0) throw new Error("Setting " + key + " must be one of " + choices.join(", "))
      }
      settings.update(function(doc) { for (var k in patch) doc.general[k] = patch[k] })
      self.emit("settings.generalSettingsChanged", settings.doc.general)
      return settings.doc.general
    },
    getAllCommandSettings: function() { return stores.settings.doc.commands },
    getCommandSettings: function(data) { return stores.settings.doc.commands[String(data && data.commandId || "")] || {} },
    updateCommandSettings: function(data) {
      var id = String(data && data.commandId || "")
      if (!self.candidatesById[id]) throw new Error("Unknown command " + id)
      if (data.alias !== undefined && data.alias !== null) {
        var alias = String(data.alias).trim().toLowerCase()
        if (/\s/.test(alias)) throw new Error("An alias cannot contain spaces")
        var commands = stores.settings.doc.commands
        for (var other in commands) {
          if (other !== id && commands[other].alias === alias && alias) throw new Error("Alias “" + alias + "” is already used by " + ((self.candidatesById[other] || {}).title || other))
        }
      }
      updateCommand(id, function(s) {
        if (data.alias !== undefined) { if (data.alias) s.alias = String(data.alias).trim().toLowerCase(); else delete s.alias }
        if (data.enabled !== undefined) { if (data.enabled === false) s.enabled = false; else delete s.enabled }
        return s
      })
      return stores.settings.doc.commands[id] || {}
    }
  })

  Rpc.register(self.registry, "rootSearch", {
    search: function(data) {
      var query = String(data && data.query || "")
      var view = data && data.view
      var ctx = searchContext()
      if (data && data.fleaHits) ctx.fleaHits = data.fleaHits
      var sections
      if (view && view.kind === "menu") sections = RootSearch.submenuSections(self.candidates, view.menuId, query, ctx, searchDeps)
      else if (view && view.kind === "calculator-history") sections = RootSearch.historySections(stores.calculator.doc.history, query, ctx.nowMs, Calculator.filterHistory)
      else {
        ctx.filter = String(data && data.filter || "all")
        if (query.trim() && ctx.filter === "all") ctx.calculation = calculate(query)
        sections = RootSearch.rootSections(self.candidates, query, ctx, searchDeps)
      }
      return sections.map(function(s) {
        return { id: s.id, title: s.title, rows: s.rows.map(function(r) { return r.candidate }) }
      })
    },
    getActions: function(data) {
      var rowId = String(data && data.id || "")
      if (rowId === RootSearch.CALCULATOR_ID) return actionsFor({ kind: "calculator" })
      if (rowId.indexOf("calculator-history:") === 0) return actionsFor({ kind: "calculator-history" })
      var candidate = decorated(rowId)
      if (!candidate) {
        var fallback = findFallback(data.id)
        if (!fallback) throw new Error("Unknown command " + (data && data.id))
        return actionsFor({ kind: "fallback", title: fallback.title })
      }
      return actionsFor(candidate)
    },
    getItemInfo: function(data) {
      var rowId = String(data && data.id || "")
      var nowMs = now()
      if (rowId === RootSearch.CALCULATOR_ID) {
        var calc = calculate(String(data.query || ""))
        return calc ? aboutFor(RootSearch.calculatorCandidate(calc), nowMs) : []
      }
      if (rowId.indexOf("calculator-history:") === 0) {
        var entry = historyEntry(rowId)
        return entry ? aboutFor(RootSearch.historyCandidate(entry, nowMs), nowMs) : []
      }
      var candidate = decorated(rowId)
      if (!candidate) {
        var f = findFallback(rowId)
        if (!f) throw new Error("Unknown command " + rowId)
        return aboutFor({ id: f.id, kind: "fallback", title: f.title, typeLabel: "Fallback", url: f.url }, nowMs)
      }
      return aboutFor(candidate, nowMs)
    },
    performAction: function(data) {
      // Destructive commands come back as a confirmation unless confirmed.
      if (!(data && data.confirmed)) {
        var id = String(data && data.id || ""), action = String(data && data.action || "open")
        var confirm = RootSearch.confirmationFor(id, action)
        var c = self.candidatesById[id]
        if (!confirm && c && c.confirm && action === "open")
          confirm = { title: c.confirm.title, message: c.confirm.message, primary: c.confirm.primary, destructive: true }
        if (confirm) return { confirm: confirm }
      }
      var fallback = findFallback(data && data.id)
      if (fallback) {
        host.openUrl(RootSearch.fallbackUrl(fallback, data.query))
        return { close: true }
      }
      // The calculator row is the query itself, evaluated again.
      if (data && data.id === RootSearch.CALCULATOR_ID) {
        var calc = calculate(String(data.query || ""))
        if (!calc) throw new Error("Nothing to calculate")
        return calculatorAction(String(data.action || "open"), { query: calc.input, result: calc.result, copy: calc.copy, kind: calc.kind }, "")
      }
      if (data && String(data.id).indexOf("calculator-history:") === 0) {
        var entry = historyEntry(data.id)
        if (!entry) throw new Error("No such history entry")
        return calculatorAction(String(data.action || "open"), entry, entry.id)
      }
      return performAction(data)
    },
    getSearchHistory: function() { return stores.frecency.loaded ? stores.frecency.doc.searchHistory : [] }
  })

  // Names from Raycast's calculator namespace (ref 02 §2).
  Rpc.register(self.registry, "calculator", {
    calculate: function(data) { return calculate(String(data && data.query || "")) },
    historyGetAll: function() { return stores.calculator.loaded ? stores.calculator.doc.history : [] },
    historyDelete: function(data) { return calculatorAction("delete-entry", null, String(data && data.id || "")) },
    historyDeleteAll: function() { return calculatorAction("delete-all-entries", null, "") },
    refreshCurrencies: function() {
      if (!host.config().currencyRates) throw new Error("currencyRates is off in config.json")
      host.calculatorData.fetchRates()
      return null
    },
    getCurrencies: function() {
      var data = host.calculatorData
      var r = data.rates
      return {
        enabled: host.config().currencyRates,
        date: r ? r.date : null,
        base: r ? r.base : null,
        currencies: r ? Object.keys(r.rates).concat([r.base]).sort() : [],
        fetchedAt: data.ratesFetchedAt || null,
        zones: Object.keys(data.zones).length
      }
    }
  })

  Rpc.register(self.registry, "frecency", {
    visit: function(data) { recordVisit(String(data.id), String(data.query || "")); return null },
    get: function(data) {
      var entry = stores.frecency.doc.items[String(data && data.id || "")]
      return entry ? { anchor: entry.anchor, openedAt: entry.openedAt, score: Frecency.score(entry.anchor, now() / 1000), searchTerms: entry.searchTerms } : null
    }
  })

  return self
}

if (typeof module !== "undefined") module.exports = { create: create }

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer, ToolResultOf } from 'claude-code'

import type { AgentPhase, AgentRow, DashboardSettings, GatekeeperMode, LogRow, PlanStatus, PlanTask, RunningCall, Stats } from '../types'

const PANE = 'agenten-dashboard'
const TITLE = 'Agenten'
const MAIN = 'main'
const MAX_LOG = 60
const FEED_ROWS = 8
const STALL_MS = 120_000
const ORPHAN_MS = 180_000
const TICK_MS = 1_000
const IDLE_REDRAW_MS = 10_000
const RECONCILE_MS = 3_000
const PLAN_ROWS = 5
const STORE_SETTINGS = 'einstellungen'
const CLASSIFY_TIMEOUT_MS = 5_000

// Tag ändern, wenn sich die Felder ändern: ältere gespeicherte Werte werden dann verworfen.
const agents = atom({ plugin: 'agenten-dashboard', key: 'agents' } as const, [], { shape: 'agents-5' })
const log = atom({ plugin: 'agenten-dashboard', key: 'log' } as const, [], { shape: 'log-1' })
const plan = atom({ plugin: 'agenten-dashboard', key: 'plan' } as const, [], { shape: 'plan-1' })
const DEFAULT_SETTINGS: DashboardSettings = { gatekeeper: 'normal', planer: true }
const settings = atom({ plugin: 'agenten-dashboard', key: 'settings' } as const, { gatekeeper: 'normal', planer: true }, { shape: 'settings-2' })
const stats = atom({ plugin: 'agenten-dashboard', key: 'stats' } as const, { routedDown: 0, checked: 0 }, { shape: 'stats-1' })

// Modulvariablen: gehen bei einem Neuladen verloren (dann Standardverhalten).
// Aufwand je Subagent: erst nach Prompt (bis die Agent-ID bekannt ist), dann nach ID.
const pendingEffort = new Map<string, Effort>()
const effortByAgent = new Map<string, Effort>()
// Verstärkung: herabgestufte Subagenten dürfen kurz auf das stärkere Chat-Modell wechseln.
const BOOST_AFTER_ERRORS = 3
const BOOST_STEPS = 4
const strongerModel = new Map<string, string>() // Agent-ID → Modell des Auftraggebers
const errorStreak = new Map<string, number>()
const boostLeft = new Map<string, number>()
// Laufende Uhr: zeichnet jede Sekunde neu, solange ein Agent aktiv ist.
let ticker: Timer | undefined
let lastReconcile = 0
let lastIdleRedraw = 0
let lastTickAt = 0

// ───────────────────────── Anzeige-Hilfen ─────────────────────────

const TOOL_LABEL: Record<string, string> = {
  Bash: 'führt Befehl aus',
  Read: 'liest',
  Write: 'schreibt',
  Edit: 'bearbeitet',
  MultiEdit: 'bearbeitet',
  NotebookEdit: 'bearbeitet Notebook',
  Glob: 'sucht Dateien',
  Grep: 'durchsucht',
  WebSearch: 'sucht im Web',
  WebFetch: 'ruft Webseite ab',
  Agent: 'gibt Auftrag an Subagent',
  Task: 'gibt Auftrag an Subagent',
  Skill: 'lädt Skill',
  ToolSearch: 'lädt Werkzeuge',
  TaskCreate: 'plant Aufgabe',
  TaskUpdate: 'aktualisiert Plan',
  TaskList: 'liest Plan',
  TodoWrite: 'aktualisiert Plan',
  AskUserQuestion: 'stellt dir eine Frage',
  SendUserMessage: 'schreibt dir',
  SendUserFile: 'sendet Datei',
  Artifact: 'arbeitet am Artifact',
  TaskGet: 'liest Aufgabe',
  TaskOutput: 'liest Ergebnis eines Hintergrund-Agenten',
  TaskStop: 'stoppt Hintergrund-Aufgabe',
  SendMessage: 'schreibt einem Agenten',
  Monitor: 'beobachtet Hintergrund-Aufgabe',
  ExitPlanMode: 'legt dir den Plan vor',
  EnterPlanMode: 'wechselt in den Planmodus',
}

// Werkzeuge, die auf dich warten.
const WAIT_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])

const DETAIL_KEYS = ['description', 'subject', 'command', 'file_path', 'pattern', 'query', 'url', 'path', 'skill', 'prompt']

function short(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  const room = Math.max(8, max)
  return one.length > room ? `${one.slice(0, room - 1)}…` : one
}

function toolLabel(tool: string): string {
  const known = TOOL_LABEL[tool]
  if (known) return known
  if (tool.startsWith('mcp__')) {
    const parts = tool.split('__')
    const server = (parts[1] ?? 'Connector').replace(/_/g, ' ')
    const action = parts.slice(2).join(' ').replace(/_/g, ' ')
    return `${server}: ${action}`
  }
  return tool
}

function describeCall(tool: string, input: Record<string, unknown>): string {
  let detail = ''
  for (const key of DETAIL_KEYS) {
    const value = input[key]
    if (typeof value === 'string' && value.trim() !== '') {
      detail = value
      break
    }
  }
  if (detail.startsWith('/') || detail.startsWith('~')) {
    detail = detail.split('/').filter(Boolean).pop() ?? detail
  }
  const label = toolLabel(tool)
  return detail ? `${label}: ${short(detail, 80)}` : label
}

function since(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ${s % 60} s`
  return `${Math.floor(m / 60)} h ${m % 60} min`
}

function modelName(id: string): string {
  const lower = id.toLowerCase()
  for (const name of ['haiku', 'sonnet', 'opus', 'fable']) {
    if (lower.includes(name)) {
      const version = lower.match(/(\d+)[-.](\d+)/)
      const nice = name.charAt(0).toUpperCase() + name.slice(1)
      return version ? `${nice} ${version[1]}.${version[2]}` : nice
    }
  }
  return id
}

// Farbe nach Modellstufe, damit man auf einen Blick sieht, wer mit welchem Modell arbeitet.
function tierColor(model: string): 'success' | 'warning' | 'suggestion' | undefined {
  const m = model.toLowerCase()
  if (m.includes('haiku')) return 'success'
  if (m.includes('sonnet')) return 'suggestion'
  if (m.includes('opus') || m.includes('fable')) return 'warning'
  return undefined
}

function modelLabel(row: AgentRow): string {
  if (!row.model) return 'Modell wird ermittelt'
  return row.effort ? `${row.model} · Aufwand ${row.effort}` : row.model
}

function isActive(row: AgentRow): boolean {
  return row.phase === 'denkt' || row.phase === 'arbeitet' || row.phase === 'delegiert'
}

const PHASE: Record<AgentPhase, { mark: string; word: string; color: 'success' | 'warning' | 'error' | 'subtle' | 'suggestion' }> = {
  denkt: { mark: '◆', word: 'denkt', color: 'suggestion' },
  arbeitet: { mark: '●', word: 'arbeitet', color: 'success' },
  delegiert: { mark: '◎', word: 'wartet auf Subagent', color: 'suggestion' },
  wartet: { mark: '◐', word: 'wartet auf dich', color: 'warning' },
  fertig: { mark: '✓', word: 'fertig', color: 'subtle' },
  fehler: { mark: '✕', word: 'Fehler', color: 'error' },
  abgebrochen: { mark: '■', word: 'abgebrochen', color: 'subtle' },
}

function bar(done: number, total: number, width: number): string {
  if (total <= 0) return ''
  const filled = Math.round((done / total) * width)
  return '▰'.repeat(filled) + '▱'.repeat(Math.max(0, width - filled))
}

function newRow(id: string, now: number, patch: Partial<AgentRow>): AgentRow {
  return {
    id,
    name: id === MAIN ? 'Claude' : `Subagent ${id.slice(0, 6)}`,
    task: '',
    kind: id === MAIN ? 'Hauptagent' : 'Subagent',
    model: '',
    effort: '',
    route: '',
    parentId: '',
    phase: 'denkt',
    phaseSince: now,
    running: [],
    last: '',
    tools: 0,
    steps: 0,
    errors: 0,
    startedAt: now,
    endedAt: 0,
    lastEventAt: now,
    turn: 0,
    ...patch,
  }
}

// ───────────────────────── Zustand schreiben ─────────────────────────

// create=false: nur bestehende Agenten ändern (unbekannte IDs, z. B. interne Abzweige der Engine, werden ignoriert).
async function patchAgent(
  $: EngineInterface,
  id: string,
  fn: (row: AgentRow | undefined, now: number) => Partial<AgentRow>,
  create = true,
) {
  const now = await $.clock.now()
  await update($, agents, list => {
    const existing = list.find(one => one.id === id)
    if (!existing) return create ? [...list, newRow(id, now, { ...fn(undefined, now), lastEventAt: now })] : list
    const patch = fn(existing, now)
    if (Object.keys(patch).length === 0) return list
    return list.map(one => (one.id === id ? { ...one, ...patch, lastEventAt: now } : one))
  })
}

async function addLog($: EngineInterface, agentId: string, text: string, isError = false) {
  const at = await $.clock.now()
  const row: LogRow = { at, agentId, text, isError }
  await update($, log, list => [...list, row].slice(-MAX_LOG))
}

async function refreshStatus($: EngineInterface) {
  const list = await read($, agents)
  const active = list.filter(isActive)
  // Ist das Dashboard geschlossen, steht unter dem Eingabefeld ein Hinweis, wie man es wieder öffnet.
  let closed = false
  try {
    closed = !(await $.ui.panes()).some(pane => pane.id === PANE)
  } catch {
    closed = false
  }
  const hint = closed ? ' · Dashboard zu: /agenten öffnet es' : ''
  if (active.length === 0) {
    $.ui.status(closed ? `Agenten-Dashboard geschlossen · /agenten öffnet es` : undefined)
    return
  }
  // Den Schritt zeigen, an dem tatsächlich gearbeitet wird: der zuletzt aktive Subagent vor dem Hauptagenten.
  const lead = [...active].sort((a, b) => (a.id === MAIN ? 1 : 0) - (b.id === MAIN ? 1 : 0) || b.lastEventAt - a.lastEventAt)[0]
  if (!lead) return
  const step = lead.running[lead.running.length - 1]?.label ?? (lead.phase === 'denkt' ? 'denkt nach' : PHASE[lead.phase].word)
  const who = lead.id === MAIN ? '' : `${short(lead.name, 24)}: `
  const model = lead.model ? `[${lead.model}] ` : ''
  $.ui.status(`● ${active.length} aktiv · ${model}${who}${short(step, 60)}${hint}`)
}

// Ein Werkzeugaufruf endet: Phase ergibt sich aus den noch laufenden Aufrufen.
function phaseAfter(running: RunningCall[]): AgentPhase {
  if (running.length === 0) return 'denkt'
  // Nur eine Frage an dich ist echtes Warten. Eine angefragte Freigabe kann der Modus auch
  // selbst erteilen, und nach deinem Ja läuft der Aufruf weiter: das zählt als Arbeit.
  const working = running.filter(call => call.wait !== 'frage')
  if (working.length === 0) return 'wartet'
  return working.some(call => call.tool === 'Agent' || call.tool === 'Task') ? 'delegiert' : 'arbeitet'
}

// Abgleich mit der Engine: Was sie als beendet führt, ist beendet, auch wenn
// das Dashboard das Ende nicht gehört hat (z. B. Hintergrund-Agenten).
async function reconcile($: EngineInterface) {
  let listed: { id: string; status: string }[]
  try {
    listed = await $.agent.list()
  } catch {
    return
  }
  const byId = new Map(listed.map(one => [one.id, one.status]))
  const now = await $.clock.now()
  await update($, agents, list =>
    list.map(row => {
      if (row.id === MAIN || !isActive(row)) return row
      const status = byId.get(row.id)
      if (status === undefined) {
        // Nicht in der Liste der Engine (z. B. Workflow-Agenten): erst nach längerer Stille als beendet führen.
        if (now - row.lastEventAt < ORPHAN_MS) return row
        return { ...row, phase: 'fertig' as const, running: [], endedAt: now, phaseSince: now, last: row.last || 'ohne Abschlussmeldung beendet' }
      }
      if (status === 'running' || status === 'pending' || status === 'waiting') return row
      const phase: AgentPhase = status === 'failed' ? 'fehler' : status === 'killed' ? 'abgebrochen' : 'fertig'
      return { ...row, phase, running: [], endedAt: now, phaseSince: now }
    }),
  )
}

// Die Uhr läuft durchgehend: jede Sekunde, solange gearbeitet wird; sonst alle 10 s,
// damit Angaben wie „wartet seit …“ nicht einfrieren. Sie wird nie gestoppt (kein Wettlauf
// zwischen Stoppen und Neustart).
async function tick($: EngineInterface) {
  lastTickAt = Date.now()
  try {
    const now = await $.clock.now()
    const list = await read($, agents)
    const busy = list.some(isActive)
    if (busy && now - lastReconcile >= RECONCILE_MS) {
      lastReconcile = now
      await reconcile($)
    }
    if (busy) {
      $.ui.invalidate('ui.render')
      await refreshStatus($)
    } else if (now - lastIdleRedraw >= IDLE_REDRAW_MS) {
      lastIdleRedraw = now
      $.ui.invalidate('ui.render')
      await refreshStatus($)
    }
  } catch {
    // Die Uhr darf nie etwas anderes stören.
  }
}

function ensureTicker($: EngineInterface) {
  // Eine abgelehnte Periode beendet ein Intervall still: dann neu starten.
  if (ticker && (lastTickAt === 0 || Date.now() - lastTickAt < 5 * TICK_MS)) return
  ticker?.cancel()
  lastTickAt = Date.now()
  ticker = $.clock.every(TICK_MS, () => {
    void tick($)
  })
}

function isMode(value: unknown): value is GatekeeperMode {
  return value === 'aus' || value === 'normal' || value === 'qualitaet'
}

async function registerCommand($: EngineInterface, command: { name: string; description: string; argumentHint?: string }) {
  try {
    await $.command.register(command)
  } catch {
    // Name schon vergeben: Befehl fehlt, alles andere läuft.
  }
}

async function saveSettings($: EngineInterface, patch: Partial<DashboardSettings>) {
  await update($, settings, current => ({ ...DEFAULT_SETTINGS, ...current, ...patch }))
  const now = await read($, settings)
  await $.store.set(STORE_SETTINGS, now)
}

// ───────────────────────── Mod 1: Gatekeeper ─────────────────────────
//
// Entscheidet beim Start eines Subagenten Modell UND Aufwand (effort).
// Grundlage: Anthropic „Choosing the right model“, „Effort“ und „Optimizing for
// cost and intelligence“ (Stand Nov. 2026):
// - Haiku 5.5 ist für Subagenten und einfache, gleichförmige Aufgaben gedacht,
//   aber auf „low“ überspringt es Suchen und hört früh auf → „medium“.
// - Opus 5.5 als Auftraggeber mit Sonnet-5.5-Zuarbeitern: kein messbarer
//   Qualitätsverlust bei verteilter Arbeit, rund ein Drittel günstiger.
// - Haiku-Zuarbeiter senkten bei Fehlersuche und Programmieren die Qualität
//   → Haiku nur für mechanisches Nachschlagen.
// - Urteil (planen, prüfen, bewerten) bleibt auf dem Chat-Modell, mit „high“.
// Im Zweifel wird nicht abgestuft; ein ausdrücklich gesetztes Modell gilt.

type Category = 'nachschlagen' | 'zuarbeit' | 'urteil'
type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
const EFFORT_RANK: Record<Effort, number> = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 }

const LABEL: Record<Category, string> = {
  nachschlagen:
    'nachschlagen: etwas Bestimmtes finden, auflisten, abschreiben, umformatieren oder sortieren; mechanisch, ohne Zusammenfassung, Urteil oder neuen Inhalt',
  zuarbeit:
    'zuarbeiten: recherchieren, Quellen sammeln und zusammenfassen, viele Dokumente durchgehen, nach klarer Vorgabe Text, Code oder Daten erstellen oder auswerten',
  urteil:
    'urteilen: planen, prüfen, bewerten, abwägen, entscheiden, Strategie, rechtliche oder finanzielle Fragen, kreative Kernarbeit oder das Endergebnis für den Nutzer',
}

const CATEGORY_NAME: Record<Category, string> = {
  nachschlagen: 'Nachschlagen',
  zuarbeit: 'Zuarbeit',
  urteil: 'Urteil',
}

// Wörter, bei denen nie abgestuft wird (Urteil).
const KEEP_STRONG =
  /(prüf|review|bewert|beurteil|entscheid|analys|abwäg|strateg|konzept|architekt|\bplan(?:e|en|ung|t|st)?\b|\brecht(?:s|lich\w*)?\b|steuer|vertrag|sicherheit|security|audit|final|freigab|verif|evaluat|assess|kritik|critique|design)/i

// Wörter für Aufgaben, die etwas zerstören oder unumkehrbar ändern können: nie an Haiku
// (Erfahrungsbericht: ein kleines Modell löschte „alte Dateien“, die wichtig waren).
const DESTRUCTIVE =
  /(lösch|loesch|delete|entfern|remove|\brm\b|überschreib|ueberschreib|overwrite|zurücksetz|reset|migrat|migrier|deploy|veröffentlich|veroeffentlich|publish|verschieb|benenn|rename|\bmv\b|\bpush|drop |truncate|aufräum|cleanup|clean up|purge)/i

type Route = {
  /** Modell, das der Gatekeeper setzt; leer = Chat-Modell / unverändert. */
  model?: string
  /** Aufwand, den der Gatekeeper setzt; leer = Standard des Modells. */
  effort?: Effort
  category?: Category
  reason: string
}

async function classify($: EngineInterface, text: string): Promise<Category | undefined> {
  // Schlägt die Einstufung fehl oder dauert sie zu lange, bleibt der Agent auf dem Chat-Modell.
  let label: string | undefined
  try {
    const timeout = $.clock.sleep(CLASSIFY_TIMEOUT_MS).then(() => undefined)
    label = await Promise.race([$.model.classify(text, [LABEL.nachschlagen, LABEL.zuarbeit, LABEL.urteil], { model: 'haiku' }), timeout])
  } catch {
    return undefined
  }
  if (label === LABEL.nachschlagen) return 'nachschlagen'
  if (label === LABEL.zuarbeit) return 'zuarbeit'
  if (label === LABEL.urteil) return 'urteil'
  return undefined
}

function tierOf(model: string): 'haiku' | 'sonnet' | 'opus' | 'other' {
  const m = model.toLowerCase()
  if (m.includes('haiku')) return 'haiku'
  if (m.includes('sonnet')) return 'sonnet'
  if (m.includes('opus') || m.includes('fable') || m.includes('mythos')) return 'opus'
  return 'other'
}

async function decideRoute(
  $: EngineInterface,
  mode: GatekeeperMode,
  spawn: { subagentType: string; description: string; prompt: string; model?: string; parentModel: string },
): Promise<Route> {
  const parent = tierOf(spawn.parentModel ?? '')

  if (spawn.model) return { reason: `Modell vom Auftraggeber festgelegt (${modelName(spawn.model)})` }
  if (parent === 'haiku') return { reason: 'Chat läuft schon auf Haiku' }

  const type = spawn.subagentType.toLowerCase()
  let category: Category | undefined
  if (type === 'plan' || KEEP_STRONG.test(spawn.description) || KEEP_STRONG.test(spawn.prompt.slice(0, 600))) {
    category = 'urteil'
  } else {
    category = await classify($, short(`${spawn.description}\n${spawn.prompt}`, 1_500))
  }

  if (category === undefined) return { reason: 'Einstufung unklar → Chat-Modell' }

  if (category === 'urteil') {
    // Opus 5.5 startet auf „medium“; für Planen/Prüfen lieber gründlich.
    return { effort: 'high', category, reason: 'Urteil → Chat-Modell, Aufwand hoch' }
  }

  if (category === 'nachschlagen' && (DESTRUCTIVE.test(spawn.description) || DESTRUCTIVE.test(spawn.prompt.slice(0, 600)))) {
    // Löschen, Überschreiben, Zurücksetzen: mindestens Zuarbeit-Stufe, nie Haiku.
    category = 'zuarbeit'
  }

  if (category === 'nachschlagen') {
    if (mode === 'qualitaet') {
      // Qualität: Nachschlagen nie auf Haiku. Läuft der Chat auf Opus → Sonnet, sonst bleibt das Chat-Modell.
      if (parent === 'opus') return { model: 'sonnet', effort: 'medium', category, reason: 'Nachschlagen → Sonnet, Aufwand mittel' }
      return { category, reason: 'Nachschlagen → Chat-Modell (Modus qualitaet)' }
    }
    return { model: 'haiku', effort: 'medium', category, reason: 'Nachschlagen → Haiku, Aufwand mittel' }
  }

  // Zuarbeit
  if (mode === 'qualitaet' || parent !== 'opus') return { category, reason: 'Zuarbeit → Chat-Modell' }
  return { model: 'sonnet', category, reason: 'Zuarbeit → Sonnet, Aufwand Standard (hoch)' }
}

// Haiku 5.5 hat bekannte Schwächen (überspringt Suchen, hört früh auf, meldet
// „erledigt“ ohne Prüfung, kennt aktuelle Fakten nicht). Die Anweisung gleicht das aus.
function haikuBrief(today: string): string {
  return `\n\n---\nHinweise für diese Aufgabe: Heute ist ${today}. Suche nach, statt aus dem Gedächtnis zu antworten, wenn sich Angaben ändern können. Arbeite die Aufgabe vollständig ab, bevor du antwortest. Prüfe Ergebnisse, statt sie nur als erledigt zu melden. Sag ausdrücklich, was du nicht gefunden hast oder unsicher ist.`
}

// ───────────────────────── Mod 2: Planer ─────────────────────────
//
// Der Planer gibt dem Hauptagenten ein festes Vorgehen für größere Aufgaben
// (Erkunden → Planen → Umsetzen → unabhängig Prüfen) und zeigt den Plan im
// Dashboard. Der Plan ist die normale Aufgabenliste (TaskCreate/TaskUpdate),
// damit es keine zweite, konkurrierende Liste gibt.

const PLANER_TEXT = `# Arbeitsweise bei größeren Aufgaben (Plugin „agenten-dashboard“)
Gilt nur für den Hauptagenten, der mit dem Nutzer spricht, nicht für Subagenten.

Schwelle: Eine Aufgabe ist größer, wenn sie mindestens drei getrennte Arbeitsschritte, mehrere Ergebnisse (Dateien, Abschnitte, Varianten) oder Recherche plus Erstellung umfasst. Kleinere Aufgaben erledigst du direkt, ohne dieses Vorgehen.

Bei größeren Aufgaben:
1. Erkunden: Kläre zuerst, was vorliegt (Dateien, Quellen, Vorgaben). Umfangreiche Suche gibst du an Recherche-Subagenten, unabhängige Suchen parallel.
2. Planen: Lege den Plan in der Aufgabenliste an (TaskCreate). Jede Aufgabe bekommt einen kurzen Titel und in der Beschreibung eine Zeile „Fertig wenn: …“ mit einem prüfbaren Kriterium. Setze per TaskUpdate „owner“ auf die Rolle (Recherche, Umsetzung, Prüfung) oder den Agentennamen und „addBlockedBy“ für echte Abhängigkeiten. Schneide Aufgaben so, dass jede einzeln prüfbar ist. Gib nur wirklich unabhängige Teile (getrennte Dateien, Dokumente, Fälle) oder Arbeit, die nicht in einen Kontext passt, an Subagenten. Eine Kette, in der jeder Schritt auf dem vorigen aufbaut, und eng verzahnte Arbeit erledigst du selbst: Übergaben kosten dort Zusammenhang, und Messungen zeigen, dass ein Modell allein hier besser und günstiger ist.
3. Umsetzen: Arbeite in Abhängigkeitsreihenfolge, Unabhängiges parallel. Halte die Status aktuell (in_progress, completed). Jeder Auftrag an einen Subagenten nennt mindestens: Ziel, erwartetes Ausgabeformat, Quellen oder Werkzeuge, die er nutzen soll, und Grenzen (was er nicht tun oder ändern soll). Ohne das arbeiten Subagenten doppelt oder am Ziel vorbei. Starte nur so viele Subagenten, wie die Aufgabe trägt: für eine einzelne Faktenfrage keinen, für einen Vergleich wenige.
4. Prüfen: Zum Schluss prüft ein eigener Subagent mit frischem Kontext (Beschreibung „Prüfen: …“), nie der Agent, der das Ergebnis erstellt hat. Gib ihm die ursprüngliche Anfrage, alle „Fertig wenn“-Zeilen und die Pfade der Ergebnisse, nicht die Selbstauskunft des Erstellers. Der Prüfer arbeitet mit einer Checkliste:
   a) Er erstellt sie zuerst selbst: je „Fertig wenn“-Zeile und je ausdrücklicher Forderung der Anfrage eine Frage, dazu feste Fragen: Ist jeder Teil der Anfrage erledigt? Sind Zahlen, Namen und Zitate belegt und nicht erfunden? Wurde Behauptetes tatsächlich ausgeführt oder geprüft (Code gelaufen, Datei geöffnet, Quelle gelesen)? Stimmen Format, Sprache und Umfang mit der Vorgabe überein? Gibt es Lücken oder Widersprüche?
   b) Jede Frage ist so formuliert, dass sie nur mit Ja oder Nein zu beantworten ist, und prüft genau eine Sache.
   c) Jedes Ja braucht einen Beleg (Datei und Stelle, Zitat, Messwert, Ausgabe). Ein Ja ohne Beleg zählt als Nein. Der Prüfer öffnet die Ergebnisse selbst und führt aus, was sich ausführen lässt.
   d) Vor dem Urteil versucht er, sein vorläufiges „bestanden“ zu widerlegen: Welche Frage hat er vergessen, wo war er großzügig?
   e) Das Urteil folgt der Regel, nicht dem Eindruck: Gibt es ein Nein, lautet es „Mängel“. Er listet jedes Nein mit Grund und Beleg und sagt, was zu ändern ist; sonst „keine Mängel“. Die Ja-Quote ist keine Note.
   Mängel behebst du und lässt erneut prüfen, höchstens zwei Runden. Was danach offen bleibt, nennst du dem Nutzer.

Den Plan legst du dem Nutzer nicht zur Freigabe vor; er sieht ihn im Agenten-Dashboard. Frag nur, wenn die Aufteilung eine echte Entscheidung des Nutzers verlangt.`

function gatekeeperText(mode: GatekeeperMode): string {
  const table =
    mode === 'qualitaet'
      ? '- Nachschlagen (finden, auflisten, abschreiben, umformatieren) → Sonnet, Aufwand mittel, wenn dieser Chat auf Opus läuft; sonst Modell dieses Chats (nie Haiku).\n- Zuarbeit (recherchieren, zusammenfassen, nach Vorgabe erstellen) → Modell dieses Chats.\n- Urteil (planen, prüfen, bewerten, Endergebnis) → Modell dieses Chats, Aufwand hoch.'
      : '- Nachschlagen (finden, auflisten, abschreiben, umformatieren) → Haiku, Aufwand mittel.\n- Zuarbeit (recherchieren, zusammenfassen, viele Dokumente, nach Vorgabe erstellen) → Sonnet, wenn dieser Chat auf Opus läuft; sonst Modell dieses Chats.\n- Urteil (planen, prüfen, bewerten, abwägen, Endergebnis) → Modell dieses Chats, Aufwand hoch.'
  return `# Gatekeeper für Subagenten (Plugin „agenten-dashboard“)
Beim Start eines Subagenten legt ein Gatekeeper Modell und Aufwand nach Aufgabenbereich fest:
${table}
Gibst du beim Start eines Subagenten ausdrücklich ein „model“ an, gilt dein Wert. Nutze das zum Hochstufen: Wirkt ein Ergebnis von Haiku oder Sonnet lückenhaft, oberflächlich oder widersprüchlich, vergib die Aufgabe erneut mit model „opus“, statt es zu übernehmen.
Formuliere die „description“ eines Subagenten so, dass der Aufgabenbereich erkennbar ist, z. B. „Dateien finden: …“, „Quellen recherchieren: …“, „Entwurf schreiben: …“, „Prüfen: …“.`
}

function doneWhen(description: string): string {
  const match = description.match(/fertig wenn:?\s*(.+)/i)
  return match?.[1] ? short(match[1], 120) : ''
}

function upsertTask(list: readonly PlanTask[], task: PlanTask): PlanTask[] {
  return list.some(one => one.id === task.id) ? list.map(one => (one.id === task.id ? task : one)) : [...list, task]
}

// ───────────────────────── Hooks ─────────────────────────

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const stored = await $.store.get(STORE_SETTINGS)
    if (stored && typeof stored === 'object') {
      const value = stored as Partial<DashboardSettings>
      await update($, settings, () => ({
        gatekeeper: isMode(value.gatekeeper) ? value.gatekeeper : DEFAULT_SETTINGS.gatekeeper,
        planer: typeof value.planer === 'boolean' ? value.planer : DEFAULT_SETTINGS.planer,
      }))
    }
    // Ist ein Befehlsname schon vergeben (eigener Skill, anderes Plugin), gehört er dem anderen;
    // der Rest der Mod startet trotzdem, statt mit dem ganzen session.start auszufallen.
    await registerCommand($, { name: 'agenten', description: 'Agenten-Dashboard öffnen' })
    await registerCommand($, {
      name: 'gatekeeper',
      description: 'Gatekeeper: Modell und Aufwand für Subagenten nach Aufgabenbereich (normal, qualitaet oder aus)',
      argumentHint: 'normal | qualitaet | aus',
    })
    await registerCommand($, {
      name: 'planer',
      description: 'Planer-Vorgehen für größere Aufgaben an- oder ausschalten',
      argumentHint: 'an | aus',
    })
    void $.ui.open({ id: PANE, title: TITLE })
    // Nach einem Neuladen: Uhr und Abgleich sofort wieder aufnehmen.
    ensureTicker($)
    void reconcile($)

    return next(e)
  })

  on('command.run', { command: 'agenten' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Agenten-Dashboard geöffnet.' }
  })

  on('command.run', { command: 'gatekeeper' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (!isMode(arg)) {
      const current: DashboardSettings = await read($, settings)
      return { text: `Gatekeeper steht auf „${current.gatekeeper}“. Möglich: /gatekeeper normal | qualitaet | aus` }
    }
    await saveSettings($, { gatekeeper: arg })
    const what =
      arg === 'aus'
        ? 'Subagenten laufen wieder ohne Eingriff.'
        : arg === 'qualitaet'
          ? 'Nachschlagen → Sonnet (bei Opus-Chat, sonst Chat-Modell, nie Haiku), Zuarbeit → Chat-Modell, Urteil → Chat-Modell mit hohem Aufwand.'
          : 'Nachschlagen → Haiku, Zuarbeit → Sonnet (wenn der Chat auf Opus läuft), Urteil → Chat-Modell mit hohem Aufwand.'
    return { text: `Gatekeeper: ${arg}. ${what} Gilt für neue Subagenten und alle künftigen Chats.` }
  })

  on('command.run', { command: 'planer' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg !== 'an' && arg !== 'aus') {
      const current: DashboardSettings = await read($, settings)
      return { text: `Planer ist ${current.planer ? 'an' : 'aus'}. Möglich: /planer an | aus` }
    }
    await saveSettings($, { planer: arg === 'an' })
    return { text: `Planer ${arg}. Gilt spätestens ab dem nächsten Chat.` }
  })

  // Mod 1 + 2: Anweisungen an den Hauptagenten.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const current: DashboardSettings = await read($, settings)
    const mine: { id: string; text: string; scope: 'session' }[] = []
    if (current.gatekeeper !== 'aus') mine.push({ id: 'agenten-dashboard:gatekeeper', text: gatekeeperText(current.gatekeeper), scope: 'session' })
    if (current.planer) mine.push({ id: 'agenten-dashboard:planer', text: PLANER_TEXT, scope: 'session' })
    if (mine.length === 0) return composed

    return { sections: [...composed.sections.filter(one => !one.id.startsWith('agenten-dashboard:')), ...mine] }
  })

  // Dashboard: ein Agent beginnt einen Durchgang.
  on('turn.start', async ($, e, next) => {
    const id = e.agentId ?? MAIN
    if (e.agentId && pendingEffort.has(e.text)) {
      const effort = pendingEffort.get(e.text)
      if (effort) effortByAgent.set(e.agentId, effort)
      pendingEffort.delete(e.text)
    }
    if (id === MAIN && e.text) {
      // Neue Anfrage: Zähler zurücksetzen; ein vollständig erledigter Plan verschwindet.
      await patchAgent($, id, (row, now) => ({
        phase: 'denkt',
        phaseSince: now,
        running: [],
        startedAt: now,
        endedAt: 0,
        tools: 0,
        steps: 0,
        errors: 0,
        last: '',
        task: short(e.text, 160),
        turn: (row?.turn ?? 0) + 1,
      }))
      await update($, plan, list => (list.length > 0 && list.every(t => t.status === 'completed') ? [] : list))
      await addLog($, id, `neue Anfrage: ${short(e.text, 70)}`)
    } else {
      // Fortsetzung (Haupt- oder Subagent): Zähler und Startzeit bleiben.
      await patchAgent($, id, (row, now) => ({
        phase: 'denkt',
        phaseSince: now,
        running: [],
        endedAt: 0,
        turn: (row?.turn ?? 0) + 1,
        ...(row ? {} : { startedAt: now, task: short(e.text, 160) }),
      }))
      if (id === MAIN) await addLog($, id, 'arbeitet weiter')
    }
    ensureTicker($)
    await refreshStatus($)

    return next(e)
  })

  // Dashboard: ein Agent beendet seinen Durchgang.
  on('turn.complete', async ($, e, next) => {
    const id = e.agentId ?? MAIN
    if (e.agentId) {
      strongerModel.delete(e.agentId)
      errorStreak.delete(e.agentId)
      boostLeft.delete(e.agentId)
    }
    const phase: AgentPhase =
      e.reason === 'error' ? 'fehler' : e.reason === 'aborted' ? 'abgebrochen' : id === MAIN ? 'wartet' : 'fertig'
    await patchAgent($, id, (_row, now) => ({ phase, running: [], endedAt: now, phaseSince: now }))
    await addLog($, id, PHASE[phase].word, phase === 'fehler')
    if (id === MAIN) await reconcile($)
    await refreshStatus($)
    $.ui.invalidate('ui.render')

    return next(e)
  })

  // Mod 1: Gatekeeper entscheidet Modell und Aufwand; das Dashboard legt die Agenten-Karte an.
  on('agent.spawn', async ($, e, next) => {
    const current: DashboardSettings = await read($, settings)
    const skip = current.gatekeeper === 'aus' || e.fork || e.isTeammate === true || e.workflow !== undefined || e.resume !== undefined
    const route = skip ? undefined : await decideRoute($, current.gatekeeper, e)

    let rewritten = e
    if (route?.model) {
      rewritten = { ...rewritten, model: route.model }
      if (route.model === 'haiku') {
        const today = new Date(await $.clock.now()).toISOString().slice(0, 10)
        rewritten = { ...rewritten, prompt: e.prompt + haikuBrief(today) }
      }
    }
    if (route?.effort) pendingEffort.set(rewritten.prompt, route.effort)
    const downgraded = route?.model !== undefined && tierOf(route.model) !== tierOf(e.parentModel ?? '') && tierOf(e.parentModel ?? '') !== 'haiku'

    const result = await next(rewritten)

    if (route) {
      await update($, stats, s => ({ checked: s.checked + 1, routedDown: s.routedDown + (route.model ? 1 : 0) }))
    }
    if ('agentId' in result && result.agentId) {
      const id = result.agentId
      if (downgraded) strongerModel.set(id, e.parentModel)
      if (route?.effort) {
        effortByAgent.set(id, route.effort)
        pendingEffort.delete(rewritten.prompt)
      }
      const name = e.description ? short(e.description, 60) : `Subagent ${id.slice(0, 6)}`
      const model = 'model' in result && typeof result.model === 'string' ? modelName(result.model) : ''
      await patchAgent($, id, (row, now) => ({
        name,
        task: short(e.prompt, 160),
        kind: e.subagentType,
        model,
        route: route?.category ? route.reason : '',
        parentId: e.parentAgentId ?? MAIN,
        ...(row ? {} : { phase: 'denkt' as const, phaseSince: now, startedAt: now }),
      }))
      await addLog($, e.parentAgentId ?? MAIN, `startet „${name}“${model ? ` (${model})` : ''}`)
      ensureTicker($)
      await refreshStatus($)
    } else if (route?.effort) {
      pendingEffort.delete(rewritten.prompt)
    }

    return result
  }).catch(($, e, next) => next(e))

  // Jeder Modellaufruf: Dashboard zählt den Denkschritt; Mod 1 setzt den Aufwand des Subagenten.
  // Urteil hebt nur an (eine höhere Einstellung des Chats bleibt), Nachschlagen setzt genau.
  on('turn.step', async function* ($, e, next) {
    // Ohne Warten anstoßen: die Anzeige darf den Modellaufruf weder bremsen noch stören.
    // Das Modell kommt aus dem tatsächlich gesendeten Aufruf, gilt also auch für den Hauptagenten.
    const boosted = e.agentId !== undefined && (boostLeft.get(e.agentId) ?? 0) > 0 ? strongerModel.get(e.agentId) : undefined
    const stepModel = modelName(boosted ?? e.model)
    const stepEffort = typeof e.effort === 'string' ? e.effort : ''
    void patchAgent(
      $,
      e.agentId ?? MAIN,
      (row, now) => {
        if (!row) return {}
        const seen = row.model !== stepModel || row.effort !== stepEffort ? { model: stepModel, effort: stepEffort } : {}
        if (!isActive(row)) return seen
        return row.running.length > 0
          ? { ...seen, steps: row.steps + 1 }
          : { ...seen, steps: row.steps + 1, phase: 'denkt', phaseSince: now }
      },
      false,
    ).catch(() => undefined)
    // Verstärkung: nach mehreren Fehlschlägen in Folge für wenige Schritte das stärkere Modell nehmen.
    let input = e
    const left = e.agentId ? (boostLeft.get(e.agentId) ?? 0) : 0
    const better = e.agentId ? strongerModel.get(e.agentId) : undefined
    if (e.agentId && better && left > 0) {
      input = { ...e, model: better }
      boostLeft.set(e.agentId, left - 1)
      void addLog($, e.agentId, `Verstärkung: ${modelName(better)} hilft (noch ${left - 1} Schritte)`).catch(() => undefined)
    }
    const effort = e.agentId ? effortByAgent.get(e.agentId) : undefined
    if (!effort || input.effort === undefined || input.effort === effort) return yield* next(input)
    if (typeof input.effort === 'number') return yield* next(input)
    if (effort === 'high' && EFFORT_RANK[input.effort] >= EFFORT_RANK.high) return yield* next(input)
    return yield* next({ ...input, effort })
  })

  // Dashboard: jeder Werkzeugaufruf, mit Start und Ende; parallele Aufrufe einzeln.
  on('tool.call', async ($, e, next) => {
    const id = e.agentId ?? MAIN
    const tool = String(e.tool)
    const label = describeCall(tool, e as unknown as Record<string, unknown>)
    const callId = e.tool_use_id
    const wait: RunningCall['wait'] = WAIT_TOOLS.has(tool) ? 'frage' : ''
    let turnAtStart = -1
    await patchAgent(
      $,
      id,
      (row, now) => {
        turnAtStart = row?.turn ?? -1
        const running = [...(row?.running ?? []), { id: callId, tool, label, since: now, wait }]
        // Außerhalb eines Durchgangs (z. B. Aufruf eines anderen Plugins) nicht wieder „aktiv“ setzen.
        if (row && !isActive(row) && !(row.phase === 'wartet' && row.running.some(call => call.wait === 'frage'))) {
          return { running }
        }
        return { running, phase: phaseAfter(running), phaseSince: now, tools: (row?.tools ?? 0) + 1 }
      },
      false,
    )
    await addLog($, id, label)
    ensureTicker($)
    await refreshStatus($)

    let failed = false
    let denied = false
    let aborted = true
    try {
      const ran = await next(e)
      aborted = false
      failed = ran.deny !== undefined || ran.isError === true
      denied = ran.deny !== undefined
      return ran
    } finally {
      // Immer aufräumen, auch wenn der Aufruf abbricht. Gehört der Aufruf zu einem
      // älteren Durchgang, nur aus der Liste nehmen und sonst nichts verändern.
      await patchAgent(
        $,
        id,
        (row, now) => {
          const running = (row?.running ?? []).filter(call => call.id !== callId)
          if (!row || row.turn !== turnAtStart) return { running }
          return {
            running,
            last: aborted ? `${label} (abgebrochen)` : failed ? `${label} (fehlgeschlagen)` : label,
            errors: row.errors + (failed ? 1 : 0),
            ...(isActive(row) || (row.phase === 'wartet' && row.running.some(call => call.wait === 'frage'))
              ? { phase: phaseAfter(running), phaseSince: now }
              : {}),
          }
        },
        false,
      )
      if (strongerModel.has(id)) {
        const streak = failed ? (errorStreak.get(id) ?? 0) + 1 : 0
        errorStreak.set(id, streak)
        if (streak >= BOOST_AFTER_ERRORS && (boostLeft.get(id) ?? 0) === 0) {
          boostLeft.set(id, BOOST_STEPS)
          errorStreak.set(id, 0)
        }
      }
      if (aborted) await addLog($, id, `abgebrochen: ${toolLabel(tool)}`)
      else if (failed) await addLog($, id, denied ? `abgelehnt: ${toolLabel(tool)}` : `Fehler bei: ${toolLabel(tool)}`, true)
      await refreshStatus($)
    }
  }).catch(($, e, next) => next(e))

  // Dashboard: Freigabe angefragt → am Aufruf vermerken (ob ein Mensch gefragt wird oder der Modus
  // selbst entscheidet, verrät die Schnittstelle nicht; deshalb bleibt der Agent „aktiv“).
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (verdict.decision === 'ask' && e.tool_use_id && e.approver !== undefined) {
      const callId = e.tool_use_id
      await patchAgent(
        $,
        e.agentId ?? MAIN,
        (row, now) => {
          if (!row) return {}
          const running = row.running.map(call => (call.id === callId && call.wait === '' ? { ...call, wait: 'freigabe' as const } : call))
          return { running }
        },
        false,
      )
      await refreshStatus($)
    }
    return verdict
  }).catch(($, e, next) => next(e))

  // Mod 2: Plan aus der Aufgabenliste spiegeln.
  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    const task = (ran.result as ToolResultOf<'TaskCreate'> | undefined)?.task
    if (task) {
      const description = task.description ?? e.description
      await update($, plan, list =>
        upsertTask(list, { id: task.id, subject: task.subject, doneWhen: doneWhen(description), status: 'pending', owner: '', blockedBy: [] }),
      )
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    if ((ran.result as ToolResultOf<'TaskUpdate'> | undefined)?.success) {
      await update($, plan, list => {
        if (e.status === 'deleted') return list.filter(one => one.id !== e.taskId)
        const base: PlanTask = list.find(one => one.id === e.taskId) ?? {
          id: e.taskId,
          subject: e.subject ?? `Aufgabe ${e.taskId}`,
          doneWhen: '',
          status: 'pending',
          owner: '',
          blockedBy: [],
        }
        const status: PlanStatus = e.status ?? base.status
        return upsertTask(list, {
          ...base,
          subject: e.subject ?? base.subject,
          doneWhen: e.description ? doneWhen(e.description) || base.doneWhen : base.doneWhen,
          status,
          owner: e.owner ?? base.owner,
          blockedBy: e.addBlockedBy ? [...new Set([...base.blockedBy, ...e.addBlockedBy])] : base.blockedBy,
        })
      })
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TaskList' }, async ($, e, next) => {
    const ran = await next(e)
    const tasks = (ran.result as ToolResultOf<'TaskList'> | undefined)?.tasks
    if (tasks) {
      await update($, plan, list =>
        tasks.map(t => {
          const old = list.find(one => one.id === t.id)
          return { id: t.id, subject: t.subject, doneWhen: old?.doneWhen ?? '', status: t.status, owner: t.owner ?? '', blockedBy: [...t.blockedBy] }
        }),
      )
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      await update($, plan, () =>
        e.todos.map((todo, index) => ({
          id: String(index + 1),
          subject: todo.content,
          doneWhen: '',
          status: todo.status,
          owner: '',
          blockedBy: [],
        })),
      )
    }
    return ran
  }).catch(($, e, next) => next(e))

  // ───────────────────────── Zeichnen ─────────────────────────
  //
  // Aufbau nach gängigen Regeln für Live-Dashboards: oben der Gesamtstatus und die
  // Kennzahlen (wie viele arbeiten), dann je aktivem Agenten eine Karte (Auftrag,
  // was er JETZT tut, seit wann), Erledigtes eingeklappt, unten der Verlauf, neueste
  // Meldung zuerst. Status immer mit Zeichen und Wort, nicht nur mit Farbe. Ein
  // Aktualitätshinweis zeigt, wie frisch die Anzeige ist, und warnt bei Stillstand.

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, agents)
    const entries = await read($, log)
    const tasks = await read($, plan)
    const current: DashboardSettings = await read($, settings)
    const counts: Stats = await read($, stats)
    const now = await $.clock.now()
    const width = Math.max(28, (e.props as { bodyColumns?: number }).bodyColumns ?? 60)
    const inner = width - 4
    const names = new Map(list.map(one => [one.id, one.name]))

    const active = list.filter(isActive)
    const main = list.find(one => one.id === MAIN)
    // Zahlen gelten für die aktuelle Anfrage: Subagenten, die seit ihrem Beginn gestartet sind.
    const since0 = main?.startedAt ?? 0
    const subs = list.filter(one => one.id !== MAIN)
    const thisRequest = subs.filter(one => one.startedAt >= since0 || one.endedAt >= since0 || isActive(one))
    const liveSubs = subs.filter(one => isActive(one) || one.phase === 'wartet').sort((a, b) => b.startedAt - a.startedAt)
    const doneSubs = thisRequest.filter(one => !isActive(one) && one.phase !== 'wartet').sort((a, b) => b.endedAt - a.endedAt)
    const nDone = thisRequest.filter(one => one.phase === 'fertig').length
    const nFailed = thisRequest.filter(one => one.phase === 'fehler').length + (main?.phase === 'fehler' ? 1 : 0)
    const nAborted = thisRequest.filter(one => one.phase === 'abgebrochen').length
    const parallel = active.reduce((sum, one) => sum + one.running.filter(call => call.wait !== 'frage').length, 0)
    const waitingForYou = list.some(one => one.running.some(call => call.wait === 'frage'))
    const newest = Math.max(0, ...list.map(one => one.lastEventAt), ...entries.map(one => one.at))
    const quiet = newest > 0 ? now - newest : 0
    const allThinking = active.length > 0 && active.every(one => one.running.length === 0)

    const overall =
      waitingForYou
        ? { mark: '◐', color: 'warning' as const, text: 'Wartet auf dich (Frage)' }
        : active.length > 0
        ? { mark: '●', color: 'success' as const, text: `Arbeitet · ${active.length} ${active.length === 1 ? 'Agent' : 'Agenten'} aktiv` }
        : main?.phase === 'fehler'
          ? { mark: '✕', color: 'error' as const, text: 'Mit Fehler beendet' }
          : main?.phase === 'wartet'
            ? { mark: '◐', color: 'warning' as const, text: 'Fertig · wartet auf dich' }
            : { mark: '○', color: 'subtle' as const, text: 'Bereit' }

    // Wie viele Agenten dieser Anfrage mit welchem Modell arbeiten (Hauptagent eingeschlossen).
    const mix = new Map<string, number>()
    for (const one of [...(main ? [main] : []), ...thisRequest]) {
      if (one.model) mix.set(one.model, (mix.get(one.model) ?? 0) + 1)
    }
    const modelMix = [...mix.entries()].map(([name, n]) => `${name} ×${n}`).join(' · ')

    const doneTasks = tasks.filter(t => t.status === 'completed').length
    const doneIds = new Set(tasks.filter(t => t.status === 'completed').map(t => t.id))

    const card = (one: AgentRow) => {
      const p = PHASE[one.phase]
      // Stillstand nur melden, wenn der Agent „denkt“: ein langer Befehl ist kein Stillstand.
      const stalled = one.phase === 'denkt' && now - one.lastEventAt > STALL_MS
      const parent = one.parentId && one.parentId !== MAIN ? names.get(one.parentId) : undefined
      const nowLines: { key: string; text: string; color?: 'warning' | 'error' }[] =
        one.running.length > 0
          ? one.running.map(call =>
              call.wait === 'freigabe'
                ? { key: call.id, text: `▶ ${short(call.label, inner - 40)} · Freigabe angefragt · ${since(now - call.since)}`, color: 'warning' as const }
                : call.wait === 'frage'
                  ? { key: call.id, text: `⏳ ${short(call.label, inner - 14)} · ${since(now - call.since)}`, color: 'warning' as const }
                  : { key: call.id, text: `▶ ${short(call.label, inner - 14)} · ${since(now - call.since)}` },
            )
          : one.phase === 'denkt'
            ? [{ key: 'denkt', text: `▶ denkt nach${one.last ? ` (nach: ${short(one.last, inner - 30)})` : ''} · ${since(now - one.phaseSince)}` }]
            : [{ key: 'phase', text: `${p.mark} ${p.word} · seit ${since(now - one.phaseSince)}`, color: one.phase === 'fehler' ? 'error' : undefined }]
      if (stalled) nowLines.push({ key: 'stall', text: `⚠ seit ${since(now - one.lastEventAt)} keine Meldung`, color: 'warning' })
      const meta = [
        `${one.steps} Denkschritte`,
        `${one.tools} Aufrufe`,
        one.errors > 0 ? `${one.errors} Fehler` : '',
        isActive(one) ? `läuft seit ${since(now - one.startedAt)}` : `Dauer ${since((one.endedAt || now) - one.startedAt)}`,
      ]
        .filter(Boolean)
        .join(' · ')

      return (
        <Box key={`card-${one.id}`} flexDirection="column" borderStyle="round" borderColor={p.color} paddingX={1} marginTop={1}>
          <Text wrap="truncate-end">
            <Text color={p.color} bold>
              {p.mark} {p.word.toUpperCase()}
            </Text>
            <Text bold> {short(one.name, Math.max(10, inner - 34))}</Text>
            <Text dimColor> · {one.kind}</Text>
          </Text>
          <Text wrap="truncate-end">
            <Text dimColor>Modell: </Text>
            <Text color={tierColor(one.model)} bold>
              {modelLabel(one)}
            </Text>
          </Text>
          {parent !== undefined && (
            <Text dimColor wrap="truncate-end">
              ↳ beauftragt von {short(parent, inner - 18)}
            </Text>
          )}
          {one.task !== '' && (
            <Text dimColor wrap="truncate-end">
              Auftrag: {short(one.task, inner - 9)}
            </Text>
          )}
          {nowLines.map(line => (
            <Box key={`now-${one.id}-${line.key}`}>
              <Text color={line.color} bold={line.color === undefined} wrap="truncate-end">
                {line.text}
              </Text>
            </Box>
          ))}
          <Text dimColor wrap="truncate-end">
            {meta}
          </Text>
          {one.route !== '' && (
            <Text dimColor wrap="truncate-end">
              Gatekeeper: {one.route}
            </Text>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Text bold wrap="truncate-end">
          <Text color={overall.color}>{overall.mark} </Text>
          {overall.text}
        </Text>
        <Text wrap="truncate-end">
          <Text dimColor>Hauptagent: </Text>
          <Text color={tierColor(main?.model ?? '')} bold>
            {main?.model || 'noch kein Modell gemeldet'}
          </Text>
          {main?.effort ? <Text dimColor> · Aufwand {main.effort}</Text> : null}
        </Text>
        {modelMix !== '' && (
          <Text dimColor wrap="truncate-end">
            Modelle: {modelMix}
          </Text>
        )}
        <Text wrap="truncate-end">
          <Text color="success" bold>
            {active.length}
          </Text>
          <Text dimColor> aktiv · </Text>
          <Text bold>{nDone}</Text>
          <Text dimColor> fertig · </Text>
          <Text color={nFailed > 0 ? 'error' : undefined} bold>
            {nFailed}
          </Text>
          <Text dimColor> Fehler{nAborted > 0 ? ` · ${nAborted} abgebrochen` : ''} · </Text>
          <Text bold>{parallel}</Text>
          <Text dimColor> Aufrufe laufen</Text>
        </Text>
        <Text dimColor wrap="truncate-end">
          {newest === 0
            ? 'Live · noch keine Meldung'
            : allThinking && quiet > STALL_MS
              ? `⚠ Live · letzte Meldung vor ${since(quiet)}: Claude denkt ungewöhnlich lange`
              : `Live · letzte Meldung vor ${since(quiet)} · Zahlen dieser Anfrage`}
        </Text>

        <Box flexDirection="column" marginTop={1}>
          <Text bold>AGENTEN</Text>
          {list.length === 0 && <Text dimColor>Noch nichts passiert. Sobald Claude arbeitet, erscheint es hier.</Text>}
          {main && card(main)}
          {liveSubs.map(one => card(one))}
          {doneSubs.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text dimColor>Erledigt ({doneSubs.length})</Text>
              {doneSubs.slice(0, 6).map(one => (
                <Box key={`done-${one.id}`}>
                  <Text color={one.phase === 'fehler' ? 'error' : undefined} dimColor={one.phase !== 'fehler'} wrap="truncate-end">
                    {PHASE[one.phase].mark} {short(one.name, Math.max(10, inner - 34))}
                    {one.model ? ` · ${one.model}` : ''} · {since((one.endedAt || now) - one.startedAt)} · {one.tools} Aufrufe
                  </Text>
                </Box>
              ))}
              {doneSubs.length > 6 && <Text dimColor>+ {doneSubs.length - 6} weitere</Text>}
            </Box>
          )}
        </Box>

        {tasks.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold wrap="truncate-end">
              PLAN {doneTasks}/{tasks.length} <Text color="success">{bar(doneTasks, tasks.length, Math.min(20, Math.max(5, inner - 16)))}</Text>
            </Text>
            {[...tasks.filter(t => t.status !== 'completed'), ...tasks.filter(t => t.status === 'completed')].slice(0, PLAN_ROWS).map(t => {
              const waiting = t.status === 'pending' && t.blockedBy.some(b => !doneIds.has(b))
              const mark = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '●' : waiting ? '⏸' : '○'
              const color = t.status === 'completed' ? 'subtle' : t.status === 'in_progress' ? 'success' : undefined
              const extra = [
                t.owner,
                waiting
                  ? `wartet auf ${t.blockedBy
                      .filter(b => !doneIds.has(b))
                      .map(b => `#${b}`)
                      .join(', ')}`
                  : '',
                t.doneWhen && t.status !== 'completed' ? `fertig wenn: ${t.doneWhen}` : '',
              ]
                .filter(Boolean)
                .join(' · ')
              return (
                <Box flexDirection="column" key={`plan-${t.id}`}>
                  <Text wrap="truncate-end">
                    <Text color={color}>{mark} </Text>
                    <Text dimColor={t.status === 'completed'} bold={t.status === 'in_progress'}>
                      #{t.id} {short(t.subject, Math.max(10, inner - 6))}
                    </Text>
                  </Text>
                  {extra !== '' && t.status !== 'completed' && (
                    <Text dimColor wrap="truncate-end">
                      {'   '}
                      {short(extra, inner - 3)}
                    </Text>
                  )}
                </Box>
              )
            })}
            {tasks.length > PLAN_ROWS && <Text dimColor>+ {tasks.length - PLAN_ROWS} weitere</Text>}
          </Box>
        )}

        {entries.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>VERLAUF · neueste zuerst</Text>
            {entries
              .slice(-FEED_ROWS)
              .reverse()
              .map((row, index) => (
                <Box key={`log-${row.at}-${index}`}>
                  <Text color={row.isError ? 'error' : undefined} dimColor={!row.isError} wrap="truncate-end">
                    vor {since(now - row.at)} · {short(names.get(row.agentId) ?? 'Subagent', 18)}: {short(row.text, Math.max(10, inner - 30))}
                  </Text>
                </Box>
              ))}
          </Box>
        )}

        <Box marginTop={1}>
          <Text dimColor wrap="truncate-end">
            {current.gatekeeper === 'aus'
              ? 'Gatekeeper aus'
              : `Gatekeeper ${current.gatekeeper}${counts.checked > 0 ? ` (${counts.routedDown} von ${counts.checked} auf kleineres Modell)` : ''}`}{' '}
            · Planer {current.planer ? 'an' : 'aus'}
          </Text>
        </Box>
      </Box>
    )
  })
}

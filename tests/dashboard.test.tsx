import { expect, mock, test } from 'claude-code/testing'
import type { AgentSpawnInput, On } from 'claude-code'

const PANE = {
  plugin: 'agenten-dashboard',
  component: 'Pane',
  requestId: 'agenten-dashboard',
  props: {
    title: 'Agenten',
    isFocused: false,
    bodyColumns: 70,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const NACHSCHLAGEN =
  'nachschlagen: etwas Bestimmtes finden, auflisten, abschreiben, umformatieren oder sortieren; mechanisch, ohne Zusammenfassung, Urteil oder neuen Inhalt'
const ZUARBEIT =
  'zuarbeiten: recherchieren, Quellen sammeln und zusammenfassen, viele Dokumente durchgehen, nach klarer Vorgabe Text, Code oder Daten erstellen oder auswerten'
const URTEIL =
  'urteilen: planen, prüfen, bewerten, abwägen, entscheiden, Strategie, rechtliche oder finanzielle Fragen, kreative Kernarbeit oder das Endergebnis für den Nutzer'

const SPAWN_BASE = {
  tool_use_id: 'tu-1',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-opus-5-5',
  background: false,
  fork: false,
} as const

function spawn(args: { prompt: string; description: string; subagentType: string; model?: string; parentModel?: string }): AgentSpawnInput {
  return { ...SPAWN_BASE, ...args } as AgentSpawnInput
}

function cmd(command: string, args: string) {
  return { command, args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } }
}

const COMPOSE = { model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['desktop' as const], tools: [], outputStyle: null, traits: [] }

const efforts: { agentId?: string; effort?: unknown }[] = []
let agentList: { id: string; status: string }[] = []

// Die Testumgebung kennt setTimeout; die Typen (ohne DOM) nicht.
declare const setTimeout: (fn: () => void, ms: number) => unknown

async function settle() {
  await new Promise<void>(r => setTimeout(r, 20))
}

function turnStart(text: string, agentId?: string) {
  return { text, turnId: `t-${agentId ?? 'main'}`, ...(agentId ? { agentId } : {}) } as never
}
function turnDone(agentId?: string, reason = 'answer') {
  return { answer: '', durationMs: 1, isAborted: reason === 'aborted', turnId: `t-${agentId ?? 'main'}`, reason, ...(agentId ? { agentId } : {}) } as never
}

// model: das Modell, mit dem der Denkschritt tatsächlich läuft (die Mod zeigt es auf der Karte).
async function step($: { turn: { step: (input: never) => AsyncGenerator<unknown, unknown> } }, agentId: string | undefined, current = 'low', model = 'x') {
  efforts.length = 0
  const stream = $.turn.step({ turnId: 't1', index: 0, model, effort: current, messageCount: 1, agentId } as never)
  for await (const _ of stream) {
    // nichts
  }
  return efforts[0]?.effort
}

// Was unter dem Plugin liegt: die Engine, hier nachgestellt.
function engine(on: On, label: string | undefined | Error) {
  const seen: { model?: string; prompt: string }[] = []
  mock.clock(on, { now: Date.UTC(2026, 10, 7, 12) })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('agent.list', () => ({ value: agentList as never }))
  on('model.classify', () => {
    if (label instanceof Error) throw label
    return { value: label }
  })
  on('turn.step', async function* (_, e) {
    efforts.push({ agentId: e.agentId, effort: e.effort })
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] } as never
  })
  on('agent.spawn', (_, e) => {
    seen.push({ model: e.model, prompt: e.prompt })
    return { model: e.model === 'haiku' ? 'claude-haiku-5-5' : e.model === 'sonnet' ? 'claude-sonnet-5-5' : 'claude-opus-5-5', agentId: `sub-${seen.length}` }
  })
  return seen
}

test('Dashboard zeigt Hauptagent, Auftrag und Kennzahlen auf jeder Oberfläche', async ($, on) => {
  engine(on, NACHSCHLAGEN)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start(turnStart('Analysiere die Referenzvideos'))
  await $.tool.call({ tool: 'Read', file_path: '/home/x/bericht.md' })

  for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Arbeitet · 1 Agent aktiv/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Auftrag: Analysiere die Referenzvideos/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /denkt nach \(nach: liest: bericht\.md\)/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Gatekeeper normal/ })).toBeTruthy()
    await ui.unmount()
  }
})

test('Genauigkeit: laufender Aufruf wird angezeigt, danach „denkt nach“', async ($, on) => {
  let release: () => void = () => {}
  const gate = new Promise<void>(r => {
    release = r
  })
  on('tool.call', { tool: 'Bash' }, async () => {
    await gate
    return { result: {} }
  })
  engine(on, NACHSCHLAGEN)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start(turnStart('Baue das Projekt'))
  const call = $.tool.call({ tool: 'Bash', command: 'npm run build' })
  await settle()

  const during = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await during.find({ type: 'Text', text: /▶ führt Befehl aus: npm run build/ })).toBeTruthy()
  expect(await during.find({ type: 'Text', text: /ARBEITET/ })).toBeTruthy()
  expect(await during.find({ type: 'Text', text: /1/ })).toBeTruthy()
  await during.unmount()

  release()
  await call
  const after = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await after.find({ type: 'Text', text: /▶ führt Befehl aus/ })).toBeFalsy()
  expect(await after.find({ type: 'Text', text: /DENKT/ })).toBeTruthy()
  await after.unmount()
})

test('Anzahl: drei Agenten aktiv, einer fertig → zwei aktiv und „Erledigt (1)“', async ($, on) => {
  engine(on, ZUARBEIT)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start(turnStart('Recherche in zwei Teilen'))
  await $.agent.spawn(spawn({ prompt: 'Quellen zu A sammeln', description: 'Quellen recherchieren: A', subagentType: 'general-purpose' }))
  await $.agent.spawn(spawn({ prompt: 'Quellen zu B sammeln', description: 'Quellen recherchieren: B', subagentType: 'general-purpose' }))
  await $.tool.call({ tool: 'WebSearch', query: 'Thema A', agentId: 'sub-1' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Arbeitet · 3 Agenten aktiv/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Quellen recherchieren: A/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Auftrag: Quellen zu B sammeln/ })).toBeTruthy()
  await ui.unmount()

  await $.turn.complete(turnDone('sub-1'))
  const ui2 = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui2.find({ type: 'Text', text: /Arbeitet · 2 Agenten aktiv/ })).toBeTruthy()
  expect(await ui2.find({ type: 'Text', text: /Erledigt \(1\)/ })).toBeTruthy()
  await ui2.unmount()
})

test('Abgleich: ein Subagent, den die Engine als beendet führt, zählt nicht mehr als aktiv', async ($, on) => {
  engine(on, ZUARBEIT)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start(turnStart('Los'))
  await $.agent.spawn(spawn({ prompt: 'Sammle Quellen', description: 'Quellen recherchieren', subagentType: 'general-purpose' }))
  agentList = [{ id: 'sub-1', status: 'completed' }]
  await $.turn.complete(turnDone())
  agentList = []

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Fertig · wartet auf dich/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Erledigt \(1\)/ })).toBeTruthy()
  await ui.unmount()
})

test('Parallele Aufrufe werden einzeln gezeigt und gezählt', async ($, on) => {
  let release: () => void = () => {}
  const gate = new Promise<void>(r => {
    release = r
  })
  on('tool.call', { tool: 'WebFetch' }, async () => {
    await gate
    return { result: {} }
  })
  engine(on, NACHSCHLAGEN)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start(turnStart('Zwei Seiten lesen'))
  const a = $.tool.call({ tool: 'WebFetch', url: 'https://a.example', prompt: 'x' } as never)
  const b = $.tool.call({ tool: 'WebFetch', url: 'https://b.example', prompt: 'x' } as never)
  await settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /a\.example/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /b\.example/ })).toBeTruthy()
  await ui.unmount()
  release()
  await Promise.all([a, b])
})

test('Nachschlagen → Haiku mit Aufwand mittel, Hinweise im Auftrag, Anzeige im Dashboard', async ($, on) => {
  const seen = engine(on, NACHSCHLAGEN)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn(spawn({ prompt: 'Finde alle Dateien zu Rechnungen', description: 'Dateien finden: Rechnungen', subagentType: 'Explore' }))
  expect(seen[0]?.model).toBe('haiku')
  expect(seen[0]?.prompt).toContain('Heute ist 2026-11-07')
  expect(await step($ as never, 'sub-1', 'low', 'claude-haiku-5-5')).toBe('medium')
  expect(await step($ as never, 'sub-1', 'xhigh', 'claude-haiku-5-5')).toBe('medium') // mechanische Arbeit: genau mittel
  expect(await step($ as never, undefined)).toBe('low') // Hauptagent bleibt unberührt

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Dateien finden: Rechnungen/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Haiku 5\.5/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Nachschlagen → Haiku, Aufwand mittel/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /1 von 1 auf kleineres Modell/ })).toBeTruthy()
  await ui.unmount()
})

test('Zuarbeit → Sonnet mit Standard-Aufwand, wenn der Chat auf Opus läuft', async ($, on) => {
  const seen = engine(on, ZUARBEIT)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn(spawn({ prompt: 'Recherchiere Quellen zu regionalem Handel', description: 'Quellen recherchieren', subagentType: 'general-purpose' }))
  expect(seen[0]?.model).toBe('sonnet')
  expect(seen[0]?.prompt).not.toContain('Heute ist')
  expect(await step($ as never, 'sub-1')).toBe('low') // nicht verändert: Sonnet-Standard
})

test('Zuarbeit bleibt auf dem Chat-Modell, wenn der Chat schon auf Sonnet läuft', async ($, on) => {
  const seen = engine(on, ZUARBEIT)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn(spawn({ prompt: 'Fasse die Dokumente zusammen', description: 'Zusammenfassen', subagentType: 'general-purpose', parentModel: 'claude-sonnet-5-5' }))
  expect(seen[0]?.model).toBeUndefined()
})

test('Urteil → Chat-Modell mit Aufwand hoch (Schlüsselwort, ohne Einstufung)', async ($, on) => {
  const seen = engine(on, NACHSCHLAGEN)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn(spawn({ prompt: 'Prüfe den Entwurf gegen die Kriterien', description: 'Prüfen: Entwurf', subagentType: 'general-purpose' }))
  expect(seen[0]?.model).toBeUndefined()
  expect(await step($ as never, 'sub-1')).toBe('high')
  expect(await step($ as never, 'sub-1', 'max')).toBe('max') // höhere Chat-Einstellung bleibt
})

test('Urteil per Einstufung → Chat-Modell mit Aufwand hoch', async ($, on) => {
  const seen = engine(on, URTEIL)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn(spawn({ prompt: 'Welche Variante ist für den Laden besser?', description: 'Varianten vergleichen', subagentType: 'general-purpose' }))
  expect(seen[0]?.model).toBeUndefined()
  expect(await step($ as never, 'sub-1')).toBe('high')
})

test('Ein ausdrücklich gesetztes Modell gilt, Aufwand bleibt unverändert', async ($, on) => {
  const seen = engine(on, NACHSCHLAGEN)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn(spawn({ prompt: 'Dateien finden', description: 'Dateien finden', subagentType: 'Explore', model: 'opus' }))
  expect(seen[0]?.model).toBe('opus')
  expect(await step($ as never, 'sub-1')).toBe('low')
})

test('Modus qualitaet: Nachschlagen → Sonnet, Zuarbeit → Chat-Modell', async ($, on) => {
  const seen = engine(on, NACHSCHLAGEN)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(cmd('gatekeeper', 'qualitaet'))
  await $.agent.spawn(spawn({ prompt: 'Liste die Dateien auf', description: 'Dateien auflisten', subagentType: 'general-purpose' }))
  expect(seen[0]?.model).toBe('sonnet')
})

test('/gatekeeper aus: kein Eingriff', async ($, on) => {
  const seen = engine(on, NACHSCHLAGEN)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(cmd('gatekeeper', 'aus'))
  await $.agent.spawn(spawn({ prompt: 'Liste die Dateien auf', description: 'Dateien auflisten', subagentType: 'general-purpose' }))
  expect(seen[0]?.model).toBeUndefined()
  expect(await step($ as never, 'sub-1')).toBe('low')
})

test('Einstufung unklar → kein Eingriff', async ($, on) => {
  const seen = engine(on, undefined)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn(spawn({ prompt: 'Irgendwas', description: 'Aufgabe', subagentType: 'general-purpose' }))
  expect(seen[0]?.model).toBeUndefined()
})

test('Einstufung wirft einen Fehler → kein Eingriff, Agent startet trotzdem', async ($, on) => {
  const seen = engine(on, new Error('Netz weg'))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const result = await $.agent.spawn(spawn({ prompt: 'Irgendwas', description: 'Aufgabe', subagentType: 'general-purpose' }))
  expect(seen[0]?.model).toBeUndefined()
  expect(result.agentId).toBe('sub-1')
})

test('Chat läuft auf Haiku → kein Eingriff', async ($, on) => {
  const seen = engine(on, NACHSCHLAGEN)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn(spawn({ prompt: 'Dateien finden', description: 'Dateien finden', subagentType: 'Explore', parentModel: 'claude-haiku-5-5' }))
  expect(seen[0]?.model).toBeUndefined()
})

test('Planer: Aufgabenliste erscheint als Plan mit Fortschritt, Rolle und Kriterium', async ($, on) => {
  on('tool.call', { tool: 'TaskCreate' }, (_, e) => ({
    result: { task: { id: e.subject.startsWith('Quellen') ? '1' : '2', subject: e.subject, description: e.description } },
  }))
  on('tool.call', { tool: 'TaskUpdate' }, (_, e) => ({ result: { success: true, taskId: e.taskId, updatedFields: [] } }))
  engine(on, NACHSCHLAGEN)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Quellen suchen', description: 'Fertig wenn: fünf belegte Quellen' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Bericht schreiben', description: 'Fertig wenn: alle Abschnitte gefüllt' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', owner: 'Umsetzung', addBlockedBy: ['1'] })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress', owner: 'Recherche' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /PLAN 0\/2/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Recherche · fertig wenn: fünf belegte Quellen/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Umsetzung · wartet auf #1/ })).toBeTruthy()
  await ui.unmount()

  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
  const ui2 = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui2.find({ type: 'Text', text: /PLAN 1\/2/ })).toBeTruthy()
  expect(await ui2.find({ type: 'Text', text: /wartet auf/ })).toBeFalsy()
  await ui2.unmount()
})

test('Anweisungen landen im Systemprompt und verschwinden, wenn ausgeschaltet', async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'Basis', scope: 'shared' as const }] }))
  engine(on, NACHSCHLAGEN)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const first = await $.prompt.compose(COMPOSE)
  expect(first.sections.map(s => s.id)).toEqual(['intro', 'agenten-dashboard:gatekeeper', 'agenten-dashboard:planer'])
  expect(first.sections[1]?.text).toContain('Nachschlagen')
  expect(first.sections[2]?.text).toContain('wirklich unabhängige Teile')

  await $.command.run(cmd('planer', 'aus'))
  await $.command.run(cmd('gatekeeper', 'aus'))
  const second = await $.prompt.compose(COMPOSE)
  expect(second.sections.map(s => s.id)).toEqual(['intro'])
})

test('Frage an dich: Kopfzeile „Wartet auf dich“, Agent zählt nicht als arbeitend', async ($, on) => {
  let release: () => void = () => {}
  const gate = new Promise<void>(r => {
    release = r
  })
  on('tool.call', { tool: 'AskUserQuestion' }, async () => {
    await gate
    return { result: {} }
  })
  engine(on, NACHSCHLAGEN)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start(turnStart('Plane etwas'))
  const call = $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
  await settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Wartet auf dich/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /⏳ stellt dir eine Frage/ })).toBeTruthy()
  await ui.unmount()
  release()
  await call
})

test('Grep zeigt das Suchmuster, nicht den Ordner', async ($, on) => {
  engine(on, NACHSCHLAGEN)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start(turnStart('Suche'))
  await $.tool.call({ tool: 'Grep', pattern: 'Rechnung', path: '/home/x/src' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /durchsucht: Rechnung/ })).toBeTruthy()
  await ui.unmount()
})

test('Nach dem Ende macht ein später Modellaufruf den Hauptagenten nicht wieder aktiv; unbekannte Agenten erzeugen keine Karte', async ($, on) => {
  engine(on, NACHSCHLAGEN)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start(turnStart('Kurz'))
  await $.turn.complete(turnDone())
  await step($ as never, undefined)
  await $.tool.call({ tool: 'Read', file_path: '/x/y.md', agentId: 'intern-123' } as never)
  await settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Fertig · wartet auf dich/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /intern/ })).toBeFalsy()
  await ui.unmount()
})

test('Belegter Befehlsname (z. B. eigener Skill /planer) verhindert den Start nicht', async ($, on) => {
  let opened = false
  mock.clock(on, { now: Date.UTC(2026, 10, 7, 12) })
  on('command.register', (_, e) => {
    if (e.name === 'planer') throw new Error('"/planer" refused: it is the user\'s /planer')
    return { value: { command: e.name } }
  })
  on('ui.open', () => {
    opened = true
    return { value: { isPlaced: true } }
  })
  on('ui.status', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('agent.list', () => ({ value: [] as never }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await settle()
  expect(opened).toBe(true)
  const r = await $.command.run(cmd('gatekeeper', 'qualitaet') as never)
  expect((r as { text?: string }).text).toContain('Gatekeeper: qualitaet')
})

test('Löschen/Aufräumen geht nie an Haiku, auch wenn als Nachschlagen eingestuft', async ($, on) => {
  const seen = engine(on, NACHSCHLAGEN)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn(spawn({ prompt: 'Lösche alle alten Log-Dateien im Ordner', description: 'Alte Dateien löschen', subagentType: 'general-purpose' }))
  expect(seen[0]?.model).toBe('sonnet')
  expect(seen[0]?.prompt).not.toContain('Heute ist')
})

test('„Planen“ und „rechtliche Frage“ führen ohne Einstufung zu Urteil', async ($, on) => {
  const seen = engine(on, NACHSCHLAGEN)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn(spawn({ prompt: 'Planen: Ablauf für den Umzug', description: 'Planen', subagentType: 'general-purpose' }))
  await $.agent.spawn(spawn({ prompt: 'Kläre die rechtliche Frage zum Vertrag', description: 'Rechtliche Frage', subagentType: 'general-purpose' }))
  expect(seen[0]?.model).toBeUndefined()
  expect(seen[1]?.model).toBeUndefined()
})

test('Migrieren, Veröffentlichen, Publish und Umbenennen gehen nie an Haiku', async ($, on) => {
  const seen = engine(on, NACHSCHLAGEN)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for (const text of ['Migriere die Datenbank', 'Veröffentliche das Paket', 'Publish the release', 'Benenne die Dateien um']) {
    await $.agent.spawn(spawn({ prompt: text, description: text, subagentType: 'general-purpose' }))
  }
  expect(seen.map(one => one.model)).toEqual(['sonnet', 'sonnet', 'sonnet', 'sonnet'])
})

test('Modus qualitaet mit Sonnet-Chat: Nachschlagen bleibt auf dem Chat-Modell, nie Haiku', async ($, on) => {
  const seen = engine(on, NACHSCHLAGEN)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(cmd('gatekeeper', 'qualitaet') as never)
  await $.agent.spawn(spawn({ prompt: 'Finde alle Rechnungen', description: 'Dateien finden', subagentType: 'Explore', parentModel: 'claude-sonnet-5-5' }))
  expect(seen[0]?.model).toBeUndefined()
})
